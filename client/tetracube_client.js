/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — JAVASCRIPT CLIENT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Universal client (Node.js + browser) for TetracubeDB.
 * Used by kensgames.com and any other TetracubeDB tenant.
 *
 * Usage (Node.js):
 *   const TetracubeClient = require('./tetracube_client');
 *   const db = new TetracubeClient({
 *     url:       'https://tetracubedb.com',
 *     clientId:  process.env.TETRACUBE_CLIENT_ID,
 *     apiKey:    process.env.TETRACUBE_API_KEY,
 *     namespace: 'kensgames',
 *   });
 *   await db.set('players', 'user-ken', 'score', 9999);
 *   const row = await db.getRow('players', 'user-ken');
 *
 * Usage (browser — include as <script>):
 *   window.TetracubeClient is available.
 *
 * Dimension reference:
 *   D0 VOID  — null
 *   D1 POINT — scalar
 *   D2 LINE  — array/column
 *   D3 WIDTH — row/record
 *   D4 PLANE — table
 *   D5 STACK — temporal/delta series
 *   D6 FRAME — higher-dimensional object
 * ═══════════════════════════════════════════════════════════════════════════════
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();                   // Node.js
  } else {
    root.TetracubeClient = factory();             // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIM = { VOID: 0, POINT: 1, LINE: 2, WIDTH: 3, PLANE: 4, STACK: 5, FRAME: 6 };

  class TetracubeClient {
    /**
     * @param {object} opts
     * @param {string} opts.url        — TetracubeDB base URL (no trailing slash)
     * @param {string} opts.clientId   — client_id from admin provisioning
     * @param {string} opts.apiKey     — raw api_key from admin provisioning
     * @param {string} opts.namespace  — default namespace for all operations
     * @param {number} [opts.timeout]  — request timeout ms (default 10000)
     */
    constructor(opts = {}) {
      this.url = (opts.url || 'https://tetracubedb.com').replace(/\/$/, '');
      this.clientId = opts.clientId || '';
      this.apiKey = opts.apiKey || '';
      this.namespace = opts.namespace || 'default';
      this.timeout = opts.timeout || 10000;
      this._ws = null;
      this._wsReady = false;
      this._wsQueue = [];
      this._subHandlers = new Map();   // key → Set of handlers
    }

    // ── Auth header ──────────────────────────────────────────────────────────
    get _authHeader() {
      return `Bearer ${this.clientId}:${this.apiKey}`;
    }

    // ── Low-level fetch ──────────────────────────────────────────────────────
    async _fetch(method, path, body = null) {
      const opts = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this._authHeader,
        },
      };
      if (body !== null) opts.body = JSON.stringify(body);

      // Timeout via AbortController
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeout);
      opts.signal = ac.signal;

      try {
        const res = await fetch(`${this.url}${path}`, opts);
        clearTimeout(timer);
        const data = await res.json();
        if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
        return data;
      } catch (e) {
        clearTimeout(timer);
        throw e;
      }
    }

    // ── Namespace shorthand ──────────────────────────────────────────────────
    _ns(ns) { return ns || this.namespace; }

    // ── Cell operations ──────────────────────────────────────────────────────

    /** SET a scalar, object, or any value at namespace/table/row/col */
    async set(table, rowKey, colKey, value, ns) {
      return this._fetch('POST',
        `/v1/cell/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}/${encodeURIComponent(colKey)}`,
        { value }
      );
    }

    /** GET a single cell */
    async get(table, rowKey, colKey, ns) {
      return this._fetch('GET',
        `/v1/cell/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}/${encodeURIComponent(colKey)}`
      );
    }

    /** DELETE a single cell */
    async delete(table, rowKey, colKey, ns) {
      return this._fetch('DELETE',
        `/v1/cell/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}/${encodeURIComponent(colKey)}`
      );
    }

    // ── Row operations (D3 WIDTH) ─────────────────────────────────────────────

    /** Get all columns for a row — returns WIDTH record */
    async getRow(table, rowKey, ns) {
      return this._fetch('GET',
        `/v1/row/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}`
      );
    }

    /** Write an entire row from a plain object { col: value, ... } */
    async setRow(table, rowKey, record, ns) {
      const results = await Promise.all(
        Object.entries(record).map(([col, val]) => this.set(table, rowKey, col, val, ns))
      );
      return results;
    }

    /** Delete all cells for a row */
    async deleteRow(table, rowKey, ns) {
      return this._fetch('DELETE',
        `/v1/row/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}`
      );
    }

    // ── Table operations (D4 PLANE) ───────────────────────────────────────────

    /** Scan a full table — returns PLANE */
    async scanTable(table, opts = {}, ns) {
      const { limit = 100, offset = 0, order = 'updated_at' } = opts;
      const q = `limit=${limit}&offset=${offset}&order=${order}`;
      return this._fetch('GET',
        `/v1/table/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}?${q}`
      );
    }

    // ── Stack operations (D5 temporal) ───────────────────────────────────────

    /** Push a delta onto the temporal stack for a cell */
    async pushDelta(table, rowKey, colKey, delta, ns) {
      return this._fetch('POST',
        `/v1/stack/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}/${encodeURIComponent(colKey)}`,
        { delta }
      );
    }

    /** Read the temporal stack for a cell */
    async readStack(table, rowKey, colKey, opts = {}, ns) {
      const { from = 0, to = null, limit = 100 } = opts;
      let q = `from=${from}&limit=${limit}`;
      if (to !== null) q += `&to=${to}`;
      return this._fetch('GET',
        `/v1/stack/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}/${encodeURIComponent(rowKey)}/${encodeURIComponent(colKey)}?${q}`
      );
    }

    // ── Gyroid query ──────────────────────────────────────────────────────────

    /** Radius query on the gyroid surface — returns FRAME of nearby cells */
    async queryRadius(gx, gy, gz, radius = 0.5, limit = 100, ns) {
      return this._fetch('POST', '/v1/query/radius', {
        namespace: this._ns(ns), gx, gy, gz, radius, limit
      });
    }

    // ── Schema ────────────────────────────────────────────────────────────────

    async getSchema(table, ns) {
      return this._fetch('GET',
        `/v1/schema/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}`
      );
    }

    async setSchema(table, schema, ns) {
      return this._fetch('PUT',
        `/v1/schema/${encodeURIComponent(this._ns(ns))}/${encodeURIComponent(table)}`,
        schema
      );
    }

    // ── Namespace / table listing ─────────────────────────────────────────────

    async listTables(ns) {
      return this._fetch('GET', `/v1/tables/${encodeURIComponent(this._ns(ns))}`);
    }

    async stats() {
      return this._fetch('GET', '/v1/stats');
    }

    // ── WebSocket live subscriptions ──────────────────────────────────────────

    /**
     * Connect WebSocket and authenticate.
     * Returns a Promise that resolves when authenticated.
     */
    connectWS() {
      if (this._ws && this._wsReady) return Promise.resolve();

      return new Promise((resolve, reject) => {
        const wsUrl = this.url.replace(/^http/, 'ws') + '/ws';
        const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
        const ws = new WS(wsUrl);
        this._ws = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', client_id: this.clientId, api_key: this.apiKey }));
        };

        ws.onmessage = (event) => {
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }

          if (msg.type === 'authenticated') {
            this._wsReady = true;
            // Flush queued subscribes
            for (const q of this._wsQueue) ws.send(JSON.stringify(q));
            this._wsQueue = [];
            resolve();
            return;
          }

          if (msg.error && !this._wsReady) {
            reject(new Error(msg.error));
            return;
          }

          // Dispatch to subscribed handlers
          if (msg.event) {
            const { op, row, col } = msg.event;
            // Fire all handlers registered for this exact key or wildcard
            for (const [key, handlers] of this._subHandlers) {
              handlers.forEach(h => h(msg.event, msg.ts));
            }
          }
        };

        ws.onerror = (e) => {
          if (!this._wsReady) reject(e);
        };

        ws.onclose = () => {
          this._wsReady = false;
        };
      });
    }

    /**
     * Subscribe to live changes on a table.
     * @param {string} table
     * @param {function} handler   — called with (event, timestamp)
     * @param {string} [ns]
     */
    async subscribe(table, handler, ns) {
      const namespace = this._ns(ns);
      const key = `${namespace}:${table}`;

      if (!this._subHandlers.has(key)) this._subHandlers.set(key, new Set());
      this._subHandlers.get(key).add(handler);

      const msg = { type: 'subscribe', namespace, table };

      if (this._wsReady) {
        this._ws.send(JSON.stringify(msg));
      } else {
        // Connect first
        if (!this._ws) await this.connectWS();
        else this._wsQueue.push(msg);
      }
    }

    /** Unsubscribe a handler */
    unsubscribe(table, handler, ns) {
      const key = `${this._ns(ns)}:${table}`;
      const handlers = this._subHandlers.get(key);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0 && this._wsReady) {
          this._ws.send(JSON.stringify({ type: 'unsubscribe', namespace: this._ns(ns), table }));
        }
      }
    }

    // ── Dimension constants ───────────────────────────────────────────────────
    static get DIM() { return DIM; }
  }

  return TetracubeClient;
}));
