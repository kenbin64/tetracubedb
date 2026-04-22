/**
 * kernel.js — Browser-side Manifold Kernel.
 *
 * This is the singleton runtime for tetracubedb.com in the browser.
 * It mirrors the server's dimensional model through the REST + WebSocket API.
 *
 * Responsibilities (what the kernel DOES):
 *   - Spawn substrates (register them by name)
 *   - Route observations to the correct substrate
 *   - Register and transition entities
 *   - Dispatch events to observers
 *   - Provide the TetracubeDB client API
 *
 * Rules (what the kernel NEVER does):
 *   - No iteration.  No loops over state.  No polling.
 *   - No computation.  The substrate computes.  The kernel routes.
 *   - No collapsing points.  Only observers do that.
 *   - No global mutable state outside this singleton.
 *
 * Usage:
 *   <script src="/substrate/gyroid.js"></script>
 *   <script src="/js/kernel.js"></script>
 *   Kernel.observe({x, y, z})
 *   Kernel.register(entity)
 *   Kernel.addObserver(fn)
 *
 * @module kernel
 */

'use strict';

(function (root) {
  if (root.Kernel) return; // singleton guard — already mounted

  // ── Substrate registry ───────────────────────────────────────────────────
  // Substrates are keyed by name.  Each exposes { value, observe }.
  const _substrates = new Map();

  // Mount the gyroid as the default substrate.
  // Gyroid must be loaded before kernel.js (via <script src="/substrate/gyroid.js">).
  function _mountDefaultSubstrate() {
    if (root.Gyroid) {
      _substrates.set('gyroid', root.Gyroid);
    }
  }

  // ── Entity registry ───────────────────────────────────────────────────────
  // Entities: apps, games, UI panels — any dimensional object.
  const _entities = new Map();

  // ── Observer list ──────────────────────────────────────────────────────────
  const _observers = [];

  function _dispatch(event) {
    for (const fn of _observers) {
      try { fn(event); } catch (e) { console.error('[Kernel] observer error:', e); }
    }
  }

  // ── WebSocket subscription ────────────────────────────────────────────────
  let _ws = null;
  let _wsReady = false;

  function _connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    _ws = new WebSocket(url);

    _ws.addEventListener('open', () => {
      _wsReady = true;
      _dispatch({ type: 'ws:connected' });
    });

    _ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        _dispatch({ type: 'ws:message', payload: msg });
      } catch (_) { /* non-JSON frame, ignore */ }
    });

    _ws.addEventListener('close', () => {
      _wsReady = false;
      _dispatch({ type: 'ws:disconnected' });
      // Reconnect after 3s — one retry policy, no polling loop
      setTimeout(_connectWS, 3000);
    });

    _ws.addEventListener('error', (e) => {
      _dispatch({ type: 'ws:error', payload: e });
    });
  }

  // ── REST API ──────────────────────────────────────────────────────────────
  const API_BASE = '/v1';

  async function _api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error || 'API error'), { detail: json });
    return json;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Observe a point on the default (gyroid) substrate.
   * Returns the collapsed Observation synchronously from the local substrate.
   * Also writes the observation event to all registered observers.
   *
   * @param {{ x: number, y: number, z: number }} point
   * @returns {Observation}
   */
  function observe(point) {
    const substrate = _substrates.get('gyroid');
    if (!substrate) throw new Error('[Kernel] gyroid substrate not mounted');
    const result = substrate.observe(point.x, point.y, point.z);
    _dispatch({ type: 'observe', payload: result });
    return result;
  }

  /**
   * Register a game or app as a dimensional entity.
   *
   * @param {{ id: string, substrateName?: string, state: {x,y,z}, meta?: object }} entity
   */
  function register(entity) {
    if (!entity.id) throw new Error('[Kernel] entity.id required');
    _entities.set(entity.id, { substrateName: 'gyroid', ...entity });
    _dispatch({ type: 'entity:register', payload: entity });
  }

  /**
   * Transition an entity to a new dimensional state.
   * Follows Fibonacci Directionality Law (see substrate/gyroid.js).
   *
   * @param {string} id
   * @param {{ x: number, y: number, z: number }} nextState
   * @returns {Entity}
   */
  function transition(id, nextState) {
    const entity = _entities.get(id);
    if (!entity) throw new Error(`[Kernel] unknown entity "${id}"`);
    const from = entity.state;
    entity.state = nextState;
    _dispatch({ type: 'entity:transition', payload: { id, from, to: nextState } });
    return entity;
  }

  function getEntity(id) { return _entities.get(id); }
  function listEntities() { return Array.from(_entities.values()); }

  function addObserver(fn) { _observers.push(fn); }
  function removeObserver(fn) {
    const i = _observers.indexOf(fn);
    if (i > -1) _observers.splice(i, 1);
  }

  // ── DB cell access (proxied through /v1) ──────────────────────────────────

  function getCell(ns, table, row, col) {
    return _api('GET', `/cell/${ns}/${table}/${row}/${col}`);
  }

  function setCell(ns, table, row, col, value) {
    return _api('POST', `/cell/${ns}/${table}/${row}/${col}`, { value });
  }

  function getRow(ns, table, row) {
    return _api('GET', `/row/${ns}/${table}/${row}`);
  }

  function getTable(ns, table) {
    return _api('GET', `/table/${ns}/${table}`);
  }

  function pushStack(ns, table, row, col, delta) {
    return _api('POST', `/stack/${ns}/${table}/${row}/${col}`, delta);
  }

  function readStack(ns, table, row, col) {
    return _api('GET', `/stack/${ns}/${table}/${row}/${col}`);
  }

  function stats() {
    return _api('GET', '/../stats'); // /v1/../stats → /stats
  }

  // ── Manifest loader ───────────────────────────────────────────────────────
  // Loads /manifold.app.json, fetches each entity's manifold.entity.json,
  // registers all entities, then dispatches kernel:entities:loaded.
  // Adding a new game requires only a JSON file + one line in manifold.app.json.

  async function loadManifest(manifestPath) {
    const path = manifestPath || '/manifold.app.json';
    let app;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
      app = await res.json();
    } catch (e) {
      _dispatch({ type: 'manifest:error', payload: e });
      return;
    }

    const fetches = (app.entities || []).map(async (entry) => {
      try {
        const res = await fetch(entry.path);
        if (!res.ok) return null;
        const entity = await res.json();
        // Compute gyroid state from entity dimensions (z = x*y is the rule)
        const x = entity.dimension ? entity.dimension.x : 1;
        const y = entity.dimension ? entity.dimension.y : 1;
        const z = entity.dimension ? entity.dimension.z : (x * y);
        register({ id: entity.entity, meta: entity, state: { x, y, z } });
        return entity;
      } catch (_) { return null; }
    });

    await Promise.all(fetches);
    _dispatch({ type: 'kernel:entities:loaded', payload: listEntities() });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  function _boot() {
    _mountDefaultSubstrate();
    _connectWS();
    _dispatch({ type: 'kernel:ready' });
  }

  // ── Expose singleton ──────────────────────────────────────────────────────

  const Kernel = {
    // Substrate
    observe,
    // Entities
    register, transition, getEntity, listEntities,
    // Manifest
    loadManifest,
    // Observers
    addObserver, removeObserver,
    // DB access
    getCell, setCell, getRow, getTable, pushStack, readStack, stats,
    // Internals (read-only access for debugging)
    get substrates() { return _substrates; },
    get entities() { return _entities; },
    get wsReady() { return _wsReady; },
  };

  root.Kernel = Kernel;

  // Boot when DOM is ready (substrate script must already be loaded)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot, { once: true });
  } else {
    _boot();
  }

}(window));
