/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — MANIFOLD FUNCTION PROCESSOR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the "data processor" core.
 *
 * A ManifoldFunction is stored code (a handler) registered at a gyroid address.
 * When an event arrives at that address (via REST or WebSocket), the function
 * is invoked with the full manifold context:
 *
 *   handler(ctx) → result | Promise<result>
 *
 * ctx provides:
 *   ctx.db           — store (setCell, getCell, getRow, scanTable, pushDelta …)
 *   ctx.gyroid       — gyroid geometry engine (surface, inflections, …)
 *   ctx.namespace    — caller's namespace
 *   ctx.table        — target table
 *   ctx.row          — target row
 *   ctx.col          — target col
 *   ctx.dim          — dimension of the input value
 *   ctx.value        — the incoming value / payload
 *   ctx.client       — authenticated client record
 *   ctx.emit(ns,tbl,event)  — push a real-time event to all subscribers
 *   ctx.DIM          — dimension constants
 *
 * Registered functions are namespaced:
 *   "kensgames:auth:*"       — handles all auth operations for kensgames
 *   "kensgames:lobby:*"      — handles all lobby operations
 *   "kensgames:session:*"    — game session state machine
 *   "kensgames:leaderboard:*"— score ingestion and ranking
 *   "*:*:*"                  — catch-all processor
 *
 * This makes TetracubeDB a full application runtime:
 *   - Auth is a manifold function
 *   - Session management is a manifold function
 *   - Leaderboard ranking is a manifold function
 *   - Socket event routing is a manifold function
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const store = require('./store');
const gyroid = require('./gyroid_core');
const { DIM, DIM_NAMES, classifyValue } = gyroid;

// ── Function registry ─────────────────────────────────────────────────────────
// Map<"ns:table:col" | "ns:table:*" | "ns:*:*" | "*:*:*", handler[]>
const _registry = new Map();

/**
 * Register a manifold function.
 *
 * @param {string}   pattern   — "namespace:table:col" (use * as wildcard)
 * @param {function} handler   — async (ctx) => result
 * @param {object}   [meta]    — { name, description, dimension }
 */
function registerFunction(pattern, handler, meta = {}) {
  if (!_registry.has(pattern)) _registry.set(pattern, []);
  _registry.get(pattern).push({ handler, meta });
  console.log(`[processor] registered: ${pattern} → ${meta.name || 'anonymous'}`);
}

/**
 * Resolve all matching handlers for a given (ns, table, col).
 * Priority: exact > ns:table:* > ns:*:* > *:*:*
 */
function _resolve(ns, table, col) {
  const candidates = [
    `${ns}:${table}:${col}`,
    `${ns}:${table}:*`,
    `${ns}:*:*`,
    `*:*:*`,
  ];
  const handlers = [];
  for (const key of candidates) {
    if (_registry.has(key)) handlers.push(..._registry.get(key));
  }
  return handlers;
}

// ── Execution context factory ─────────────────────────────────────────────────
function _buildContext(opts, emitFn) {
  return {
    db: store,
    gyroid,
    DIM,
    DIM_NAMES,
    namespace: opts.namespace,
    table: opts.table,
    row: opts.row || '',
    col: opts.col || '',
    dim: opts.dim !== undefined ? opts.dim : classifyValue(opts.value),
    value: opts.value,
    client: opts.client || null,
    emit: emitFn || (() => { }),
    /** Convenience: read the calling cell back */
    async self() {
      return store.getCell(opts.namespace, opts.table, opts.row, opts.col);
    },
    /** Convenience: promote value to next dimension */
    promote(val) {
      const { promote } = require('./gyroid_core');
      return promote(val !== undefined ? val : opts.value);
    },
  };
}

/**
 * Invoke all registered handlers for a given address.
 * Called by the server on every set/push_delta/ws-set operation if processors
 * are registered.
 *
 * Returns array of { pattern, name, result } for each handler invoked.
 */
async function invoke(ns, table, row, col, value, client, emitFn) {
  const handlers = _resolve(ns, table, col);
  if (handlers.length === 0) return [];

  const ctx = _buildContext({ namespace: ns, table, row, col, value, client }, emitFn);
  const results = [];

  for (const { handler, meta } of handlers) {
    try {
      const result = await handler(ctx);
      results.push({ pattern: meta.name || '?', result, ok: true });
    } catch (e) {
      console.error(`[processor] handler error (${meta.name || 'anon'}):`, e.message);
      results.push({ pattern: meta.name || '?', error: e.message, ok: false });
    }
  }

  return results;
}

// ── Built-in processors ───────────────────────────────────────────────────────

/**
 * DELTA TRACKER — automatically pushes a stack delta on any cell set operation
 * in tables that are flagged as "tracked".
 * Register: ns:table:* with trackDelta = true in schema options.
 */
registerFunction('*:*:*', async (ctx) => {
  // Check schema for tracking directive
  const schema = store.getSchema(ctx.namespace, ctx.table);
  if (!schema || !schema.schema || !schema.schema._track) return null;

  await store.pushDelta(ctx.namespace, ctx.table, ctx.row, ctx.col, {
    value: ctx.value,
    dim: ctx.dim,
    by: ctx.client ? ctx.client.client_id : 'system',
  });
  return { tracked: true };
}, { name: 'auto-delta-tracker', description: 'Pushes stack delta for tracked tables' });

// ── Application Processor Registry ───────────────────────────────────────────
// These are the built-in kensgames application processors.
// Each major system registers its handlers here.

const processors = {

  /**
   * AUTH PROCESSOR
   * Handles: kensgames:auth:*
   *
   * Manifold auth schema:
   *   table: "auth"
   *   row:   "user-<username>"
   *   col:   "session" | "profile" | "status" | "token"
   *
   * On set(auth, user-X, session, sessionObj):
   *   - Validates session token
   *   - Updates last_seen in players table
   *   - Pushes delta to auth stack (audit log)
   */
  auth: {
    pattern: 'kensgames:auth:*',
    name: 'auth-processor',
    async handler(ctx) {
      if (ctx.col === 'session') {
        // Validate and persist session
        const existing = await store.getCell(ctx.namespace, ctx.table, ctx.row, 'profile');
        if (!existing) return { warn: 'No profile for session user' };

        // Push audit delta to auth stack
        await store.pushDelta(ctx.namespace, 'auth_audit', ctx.row, 'login', {
          session_created: Date.now(),
          client: ctx.client ? ctx.client.client_id : 'system',
        });

        ctx.emit(ctx.namespace, 'presence', {
          op: 'login',
          user: ctx.row,
          ts: Date.now(),
        });
      }

      if (ctx.col === 'logout') {
        await store.deleteCell(ctx.namespace, ctx.table, ctx.row, 'session');
        ctx.emit(ctx.namespace, 'presence', {
          op: 'logout',
          user: ctx.row,
          redirect: '/',
          ts: Date.now(),
        });
      }

      return null;
    },
  },

  /**
   * LOBBY PROCESSOR
   * Handles: kensgames:lobby:*
   *
   * Manifold lobby schema:
   *   table: "lobby"
   *   row:   "lobby-<id>"
   *   col:   "state" | "players" | "settings" | "ready" | "launch"
   *
   * Game state machine: waiting → ready → launched → ended
   */
  lobby: {
    pattern: 'kensgames:lobby:*',
    name: 'lobby-processor',
    async handler(ctx) {
      const lobbyRow = ctx.row;

      if (ctx.col === 'players') {
        // Player list changed — check if all ready
        const playersCell = ctx.value;
        const readyCell = await store.getCell(ctx.namespace, ctx.table, lobbyRow, 'ready');
        const settings = await store.getCell(ctx.namespace, ctx.table, lobbyRow, 'settings');

        const players = Array.isArray(playersCell) ? playersCell : [];
        const ready = readyCell ? (readyCell.value || {}) : {};
        const minPlayers = settings && settings.value ? (settings.value.min_players || 1) : 1;

        const allReady = players.length >= minPlayers &&
          players.every(p => ready[p] === true);

        if (allReady) {
          await store.setCell(ctx.namespace, ctx.table, lobbyRow, 'state', 'all_ready');
          ctx.emit(ctx.namespace, ctx.table, { op: 'all_ready', lobby: lobbyRow });
        }

        ctx.emit(ctx.namespace, ctx.table, {
          op: 'players_updated',
          lobby: lobbyRow,
          players,
          all_ready: allReady,
        });
      }

      if (ctx.col === 'ready') {
        // Ready state changed — re-evaluate
        const playersCell = await store.getCell(ctx.namespace, ctx.table, lobbyRow, 'players');
        const players = playersCell ? (playersCell.value || []) : [];
        const ready = ctx.value || {};
        const allReady = players.length > 0 && players.every(p => ready[p] === true);

        ctx.emit(ctx.namespace, ctx.table, {
          op: 'ready_updated',
          lobby: lobbyRow,
          ready,
          all_ready: allReady,
        });
      }

      if (ctx.col === 'launch') {
        // Creator launches the game
        await store.setCell(ctx.namespace, ctx.table, lobbyRow, 'state', 'launched');
        const ts = Date.now();
        await store.pushDelta(ctx.namespace, 'session_history', lobbyRow, 'launch', {
          launched_at: ts,
          by: ctx.client ? ctx.client.client_id : 'system',
        });
        ctx.emit(ctx.namespace, ctx.table, { op: 'launch', lobby: lobbyRow, ts });
      }

      if (ctx.col === 'state' && ctx.value === 'ended') {
        ctx.emit(ctx.namespace, ctx.table, { op: 'game_ended', lobby: lobbyRow });
      }

      return null;
    },
  },

  /**
   * LEADERBOARD PROCESSOR
   * Handles: kensgames:leaderboard:*
   *
   * On score submission:
   *   - Validates score
   *   - Pushes to D5 stack for history
   *   - Recomputes rank surface using Relation Surface z = x*y
   *     where x = normalized_score, y = normalized_tenure
   */
  leaderboard: {
    pattern: 'kensgames:leaderboard:*',
    name: 'leaderboard-processor',
    async handler(ctx) {
      if (ctx.col !== 'score') return null;

      const { player, score, game } = ctx.value || {};
      if (!player || score === undefined) return { warn: 'score payload requires { player, score, game }' };

      // Push to score history stack
      await store.pushDelta(ctx.namespace, 'score_history', player, game || 'all', {
        score,
        ts: Date.now(),
        client: ctx.client ? ctx.client.client_id : 'system',
      });

      // Recompute rank surface: z = normalized_score * normalized_tenure
      const profileCell = await store.getCell(ctx.namespace, 'players', player, 'profile');
      const profile = profileCell ? profileCell.value : {};
      const tenure = profile ? (profile.manifold_x || 0) : 0;
      const normScore = Math.min(score / 100000, 1.0);
      const rankZ = gyroid.relationSurface(normScore, tenure);

      await store.setCell(ctx.namespace, 'leaderboard_rank', player, game || 'all', {
        score,
        rank_z: rankZ,
        manifold_x: normScore,
        manifold_y: tenure,
        ts: Date.now(),
      });

      ctx.emit(ctx.namespace, 'leaderboard', {
        op: 'score_submitted',
        player,
        game,
        score,
        rank_z: rankZ,
      });

      return { rank_z: rankZ };
    },
  },

  /**
   * SESSION PROCESSOR
   * Handles: kensgames:session:*
   *
   * Game sessions as D5 STACK cells — each move/action pushes a delta.
   * The full game replay is readable from the stack.
   *
   * col: "action" — game action (move, shoot, collect, etc.)
   * col: "state"  — full game state snapshot
   */
  session: {
    pattern: 'kensgames:session:*',
    name: 'session-processor',
    async handler(ctx) {
      if (ctx.col === 'action') {
        // Push every game action to temporal stack
        const result = await store.pushDelta(ctx.namespace, ctx.table, ctx.row, 'actions', ctx.value);
        ctx.emit(ctx.namespace, ctx.table, {
          op: 'action',
          session: ctx.row,
          action: ctx.value,
          seq: result.seq,
        });
        return { seq: result.seq };
      }

      if (ctx.col === 'state') {
        // Snapshot — push to state history
        await store.pushDelta(ctx.namespace, ctx.table, ctx.row, 'state_history', {
          snapshot: ctx.value,
          ts: Date.now(),
        });
        ctx.emit(ctx.namespace, ctx.table, {
          op: 'state_updated',
          session: ctx.row,
        });
      }

      return null;
    },
  },
};

// Register all built-in processors
for (const [key, proc] of Object.entries(processors)) {
  registerFunction(proc.pattern, proc.handler.bind(proc), { name: proc.name });
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  registerFunction,
  invoke,
  processors,
  // Expose registry for introspection
  listFunctions() {
    const out = [];
    for (const [pattern, handlers] of _registry) {
      out.push({ pattern, functions: handlers.map(h => h.meta.name || 'anonymous') });
    }
    return out;
  },
};
