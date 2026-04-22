/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — MAIN SERVER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Express REST API + WebSocket live-subscription server
 * Runs on port 4747 (configurable via PORT env var)
 *
 * REST Endpoints:
 *
 *   POST   /v1/cell/:ns/:table/:row/:col   — set cell
 *   GET    /v1/cell/:ns/:table/:row/:col   — get cell
 *   DELETE /v1/cell/:ns/:table/:row/:col   — delete cell
 *   GET    /v1/row/:ns/:table/:row         — get full row (D3 WIDTH)
 *   DELETE /v1/row/:ns/:table/:row         — delete row
 *   GET    /v1/table/:ns/:table            — scan table (D4 PLANE)
 *   POST   /v1/stack/:ns/:table/:row/:col  — push delta (D5 STACK)
 *   GET    /v1/stack/:ns/:table/:row/:col  — read stack
 *   POST   /v1/query/radius               — gyroid radius query
 *   GET    /v1/schema/:ns/:table           — get schema
 *   PUT    /v1/schema/:ns/:table           — set schema
 *   GET    /v1/namespaces                  — list namespaces
 *   GET    /v1/tables/:ns                  — list tables in namespace
 *   GET    /v1/stats                       — DB stats
 *
 *   Admin (requires is_admin flag):
 *   POST   /admin/clients                  — create API client
 *   GET    /admin/clients                  — list clients
 *   GET    /admin/gyroid/surface           — evaluate gyroid surface
 *   GET    /admin/gyroid/inflections       — find inflection points
 *
 * WebSocket /ws
 *   Clients subscribe to namespace/table changes and receive real-time push.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');

const store = require('./store');
const gyroid = require('./gyroid_core');
const processor = require('./processor');
const { requireAuth, requireAdmin, checkNamespace } = require('./auth');
const {
  DEFAULT_NAMESPACE,
  MANIFOLD_OBJECT_TYPES,
  buildManifoldObject,
  buildCommitEnvelope,
  buildExecutionEnvelope,
  buildReconcileEnvelope,
  buildSessionEnvelope,
  buildStrictError,
  validateCommitRequest,
  validateExecutionRequest,
  validateReconcileRequest,
} = require('./manifold_runtime');

const app = express();
const PORT = parseInt(process.env.PORT || '4747', 10);

function parseRequestedNamespace(req) {
  if (typeof req.query.namespace === 'string' && req.query.namespace.trim() !== '') {
    return req.query.namespace.trim();
  }
  if (req.body && typeof req.body.namespace === 'string' && req.body.namespace.trim() !== '') {
    return req.body.namespace.trim();
  }
  return null;
}

function resolveNamespaceCandidates(client, requestedNamespace) {
  if (requestedNamespace) return [requestedNamespace];
  if (!client) return [DEFAULT_NAMESPACE];

  if (client.namespaces.includes('*')) {
    const namespaces = store.listNamespaces().map((entry) => entry.namespace);
    return namespaces.length > 0 ? namespaces : [DEFAULT_NAMESPACE];
  }

  return client.namespaces.length > 0 ? client.namespaces : [DEFAULT_NAMESPACE];
}

function findFirstExistingRow(tableName, rowKey, namespaceCandidates) {
  for (const namespace of namespaceCandidates) {
    const row = store.getRow(namespace, tableName, rowKey);
    if (row) return { namespace, row };
  }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '4mb' }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['https://kensgames.com', 'https://www.kensgames.com',
      'https://tetracubedb.com', 'http://localhost:3000', 'http://localhost'],
  credentials: true,
}));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tetracubedb', ts: Date.now() });
});

// ── Manifold-first authoritative routes ──────────────────────────────────────

app.post('/v1/objects/commit', requireAuth, (req, res) => {
  const validation = validateCommitRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json(buildStrictError(
      'INVALID_COMMIT_REQUEST',
      validation.errors.join('; '),
      { errors: validation.errors }
    ));
  }

  const namespace = validation.normalized.namespace || DEFAULT_NAMESPACE;
  if (!checkNamespace(req.client, namespace)) {
    return res.status(403).json(buildStrictError(
      'NAMESPACE_NOT_PERMITTED',
      'Namespace not permitted',
      { namespace }
    ));
  }

  try {
    const object = buildManifoldObject(validation.normalized);
    const commitEnvelope = buildCommitEnvelope({
      object,
      strict: validation.normalized.strict,
      ts_authoritative: Date.now(),
    });

    store.setCell(namespace, 'manifold_objects', object.object_id, 'type', object.type);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'identity', object.identity);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'lenses', object.lenses);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'payload', object.payload);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'dimensional_metadata', object.dimensional_metadata);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'geometry', object.geometry);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'dimension', object.dimension);
    store.setCell(namespace, 'manifold_objects', object.object_id, 'commit_horizon', commitEnvelope.commit_id);

    store.setCell(namespace, 'manifold_commits', commitEnvelope.commit_id, 'object_id', object.object_id);
    store.setCell(namespace, 'manifold_commits', commitEnvelope.commit_id, 'namespace', namespace);
    store.setCell(namespace, 'manifold_commits', commitEnvelope.commit_id, 'type', object.type);
    store.setCell(namespace, 'manifold_commits', commitEnvelope.commit_id, 'dimensional_metadata', commitEnvelope.dimensional_metadata);
    store.setCell(namespace, 'manifold_commits', commitEnvelope.commit_id, 'ts_authoritative', commitEnvelope.ts_authoritative);

    if (object.type === MANIFOLD_OBJECT_TYPES.SESSION) {
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'object_id', object.object_id);
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'type', object.type);
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'state', object.payload);
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'lenses', object.lenses);
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'dimensional_metadata', object.dimensional_metadata);
      store.setCell(namespace, 'manifold_sessions', object.object_id, 'commit_horizon', commitEnvelope.commit_id);
    }

    notifySubscribers(namespace, 'manifold_objects', {
      op: 'commit',
      object_id: object.object_id,
      commit_id: commitEnvelope.commit_id,
      type: object.type,
      dimensional_metadata: object.dimensional_metadata,
    });

    return res.status(201).json({
      ...commitEnvelope,
      object,
    });
  } catch (error) {
    const code = error.code === 'INVALID_DIMENSIONAL_METADATA' ? 400 : 500;
    return res.status(code).json(buildStrictError(
      error.code || 'MANIFOLD_COMMIT_FAILED',
      error.message,
      error.details ? { errors: error.details } : {}
    ));
  }
});

app.get('/v1/objects/:id', requireAuth, (req, res) => {
  const requestedNamespace = parseRequestedNamespace(req);
  if (requestedNamespace && !checkNamespace(req.client, requestedNamespace)) {
    return res.status(403).json(buildStrictError(
      'NAMESPACE_NOT_PERMITTED',
      'Namespace not permitted',
      { namespace: requestedNamespace }
    ));
  }

  const found = findFirstExistingRow(
    'manifold_objects',
    req.params.id,
    resolveNamespaceCandidates(req.client, requestedNamespace)
  );

  if (!found) {
    return res.status(404).json(buildStrictError(
      'OBJECT_NOT_FOUND',
      `No manifold object found for id ${req.params.id}`
    ));
  }

  try {
    const object = buildManifoldObject({
      namespace: found.namespace,
      object_id: req.params.id,
      type: found.row.type,
      identity: found.row.identity,
      lenses: found.row.lenses,
      payload: found.row.payload,
      dimensional_metadata: found.row.dimensional_metadata,
      commit_horizon: found.row.commit_horizon,
    });

    return res.json(object);
  } catch (error) {
    return res.status(500).json(buildStrictError(
      'OBJECT_RECONSTRUCTION_FAILED',
      error.message
    ));
  }
});

app.post('/v1/functions/execute', requireAuth, async (req, res) => {
  const validation = validateExecutionRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json(buildStrictError(
      'INVALID_EXECUTION_REQUEST',
      validation.errors.join('; '),
      { errors: validation.errors }
    ));
  }

  const namespace = validation.normalized.namespace || DEFAULT_NAMESPACE;
  if (!checkNamespace(req.client, namespace)) {
    return res.status(403).json(buildStrictError(
      'NAMESPACE_NOT_PERMITTED',
      'Namespace not permitted',
      { namespace }
    ));
  }

  const execution = buildExecutionEnvelope(validation.normalized);
  const emit = (ens, etbl, ev) => notifySubscribers(ens, etbl, ev);
  const results = await processor.invoke(
    namespace,
    'functions',
    execution.function_id,
    execution.lens,
    execution.input,
    req.client,
    emit
  );

  return res.json({
    success: true,
    strict: true,
    execution,
    results,
    ts_authoritative: Date.now(),
  });
});

app.post('/v1/reconcile', requireAuth, (req, res) => {
  const validation = validateReconcileRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json(buildStrictError(
      'INVALID_RECONCILE_REQUEST',
      validation.errors.join('; '),
      { errors: validation.errors }
    ));
  }

  const namespace = validation.normalized.namespace || DEFAULT_NAMESPACE;
  if (!checkNamespace(req.client, namespace)) {
    return res.status(403).json(buildStrictError(
      'NAMESPACE_NOT_PERMITTED',
      'Namespace not permitted',
      { namespace }
    ));
  }

  const horizonCell = store.getCell(namespace, 'manifold_sessions', validation.normalized.session_id, 'commit_horizon');
  const stateCell = store.getCell(namespace, 'manifold_sessions', validation.normalized.session_id, 'state');

  const envelope = buildReconcileEnvelope({
    ...validation.normalized,
    authoritative_commit_horizon: horizonCell ? horizonCell.value : validation.normalized.authoritative_commit_horizon,
    ts_authoritative: Date.now(),
  });

  return res.json({
    ...envelope,
    state: stateCell ? stateCell.value : null,
  });
});

app.get('/v1/sessions/:id', requireAuth, (req, res) => {
  const requestedNamespace = parseRequestedNamespace(req);
  if (requestedNamespace && !checkNamespace(req.client, requestedNamespace)) {
    return res.status(403).json(buildStrictError(
      'NAMESPACE_NOT_PERMITTED',
      'Namespace not permitted',
      { namespace: requestedNamespace }
    ));
  }

  const found = findFirstExistingRow(
    'manifold_sessions',
    req.params.id,
    resolveNamespaceCandidates(req.client, requestedNamespace)
  );

  if (!found) {
    return res.status(404).json(buildStrictError(
      'SESSION_NOT_FOUND',
      `No authoritative session found for id ${req.params.id}`
    ));
  }

  try {
    const objectRow = store.getRow(found.namespace, 'manifold_objects', req.params.id);
    const object = buildManifoldObject({
      namespace: found.namespace,
      object_id: req.params.id,
      type: (objectRow && objectRow.type) || found.row.type || MANIFOLD_OBJECT_TYPES.SESSION,
      identity: objectRow ? objectRow.identity : {},
      lenses: found.row.lenses || (objectRow ? objectRow.lenses : []),
      payload: found.row.state !== undefined ? found.row.state : (objectRow ? objectRow.payload : null),
      dimensional_metadata: found.row.dimensional_metadata || (objectRow ? objectRow.dimensional_metadata : null) || {
        level: 7,
        x: 0,
        y: 0,
        z_axis: 0,
        plane: 'plane:7',
        volume: 'volume:7',
        theta_deg: 0,
        fib_scale: 13,
      },
      commit_horizon: found.row.commit_horizon || (objectRow ? objectRow.commit_horizon : ''),
    });

    return res.json(buildSessionEnvelope(req.params.id, object, {
      state: found.row.state !== undefined ? found.row.state : object.payload,
      ts_authoritative: Date.now(),
    }));
  } catch (error) {
    return res.status(500).json(buildStrictError(
      'SESSION_RECONSTRUCTION_FAILED',
      error.message
    ));
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/v1/stats', requireAuth, (_req, res) => {
  res.json(store.dbStats());
});

// ── Cell endpoints ────────────────────────────────────────────────────────────

// SET cell
app.post('/v1/cell/:ns/:table/:row/:col', requireAuth, async (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'body.value required' });

  const result = store.setCell(ns, table, row, col, value);
  const emit = (ens, etbl, ev) => notifySubscribers(ens, etbl, ev);
  const processed = await processor.invoke(ns, table, row, col, value, req.client, emit);
  notifySubscribers(ns, table, { op: 'set', row, col, value, ...result });
  res.json({ ok: true, ...result, processed });
});

// PROCESS — explicitly invoke processor pipeline without storing
app.post('/v1/process/:ns/:table/:row/:col', requireAuth, async (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });
  const { value } = req.body;
  const emit = (ens, etbl, ev) => notifySubscribers(ens, etbl, ev);
  const results = await processor.invoke(ns, table, row, col, value, req.client, emit);
  res.json({ ok: true, results });
});

// GET cell
app.get('/v1/cell/:ns/:table/:row/:col', requireAuth, (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const cell = store.getCell(ns, table, row, col);
  if (!cell) return res.status(404).json({ error: 'Not found' });
  res.json(cell);
});

// DELETE cell
app.delete('/v1/cell/:ns/:table/:row/:col', requireAuth, (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const deleted = store.deleteCell(ns, table, row, col);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  notifySubscribers(ns, table, { op: 'delete', row, col });
  res.json({ ok: true });
});

// ── Row endpoints ─────────────────────────────────────────────────────────────

// GET row (D3 WIDTH)
app.get('/v1/row/:ns/:table/:row', requireAuth, (req, res) => {
  const { ns, table, row } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const record = store.getRow(ns, table, row);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

// DELETE row
app.delete('/v1/row/:ns/:table/:row', requireAuth, (req, res) => {
  const { ns, table, row } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const n = store.deleteRow(ns, table, row);
  notifySubscribers(ns, table, { op: 'delete_row', row, cells_deleted: n });
  res.json({ ok: true, deleted: n });
});

// ── Table endpoints ───────────────────────────────────────────────────────────

// SCAN table (D4 PLANE)
app.get('/v1/table/:ns/:table', requireAuth, (req, res) => {
  const { ns, table } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const opts = {
    limit: Math.min(parseInt(req.query.limit || '100', 10), 10000),
    offset: parseInt(req.query.offset || '0', 10),
    orderBy: req.query.order || 'updated_at',
  };
  res.json(store.scanTable(ns, table, opts));
});

// ── Stack endpoints (D5 temporal) ─────────────────────────────────────────────

// PUSH delta
app.post('/v1/stack/:ns/:table/:row/:col', requireAuth, async (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const { delta } = req.body;
  if (delta === undefined) return res.status(400).json({ error: 'body.delta required' });

  const result = store.pushDelta(ns, table, row, col, delta);
  const emit = (ens, etbl, ev) => notifySubscribers(ens, etbl, ev);
  await processor.invoke(ns, table, row, col, delta, req.client, emit);
  notifySubscribers(ns, table, { op: 'push_delta', row, col, ...result });
  res.json({ ok: true, ...result });
});

// READ stack
app.get('/v1/stack/:ns/:table/:row/:col', requireAuth, (req, res) => {
  const { ns, table, row, col } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });

  const opts = {
    from: parseInt(req.query.from || '0', 10),
    to: req.query.to ? parseInt(req.query.to, 10) : null,
    limit: Math.min(parseInt(req.query.limit || '100', 10), 5000),
  };
  res.json(store.readStack(ns, table, row, col, opts));
});

// ── Gyroid query ──────────────────────────────────────────────────────────────

// Radius query on gyroid surface
app.post('/v1/query/radius', requireAuth, (req, res) => {
  const { namespace, gx, gy, gz, radius = 0.5, limit = 100 } = req.body;
  if (!namespace || gx === undefined || gy === undefined || gz === undefined) {
    return res.status(400).json({ error: 'namespace, gx, gy, gz required' });
  }
  if (!checkNamespace(req.client, namespace)) return res.status(403).json({ error: 'Namespace not permitted' });

  res.json(store.queryRadius(namespace, gx, gy, gz, radius, Math.min(limit, 1000)));
});

// ── Schema ────────────────────────────────────────────────────────────────────

app.get('/v1/schema/:ns/:table', requireAuth, (req, res) => {
  const { ns, table } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });
  const schema = store.getSchema(ns, table);
  if (!schema) return res.status(404).json({ error: 'No schema defined' });
  res.json(schema);
});

app.put('/v1/schema/:ns/:table', requireAuth, (req, res) => {
  const { ns, table } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });
  store.setSchema(ns, table, req.body);
  res.json({ ok: true });
});

// ── Namespace / table listing ─────────────────────────────────────────────────

app.get('/v1/namespaces', requireAuth, (req, res) => {
  if (!req.client.is_admin) return res.status(403).json({ error: 'Admin only' });
  res.json(store.listNamespaces());
});

app.get('/v1/tables/:ns', requireAuth, (req, res) => {
  const { ns } = req.params;
  if (!checkNamespace(req.client, ns)) return res.status(403).json({ error: 'Namespace not permitted' });
  res.json(store.listTables(ns));
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// Create API client
app.post('/admin/clients', requireAuth, requireAdmin, async (req, res) => {
  const { name, namespaces = ['*'], is_admin = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = await store.createClient(name, namespaces, is_admin);
  res.status(201).json({
    ok: true,
    ...result,
    note: 'Store the api_key securely — it will not be shown again',
  });
});

// List clients
app.get('/admin/clients', requireAuth, requireAdmin, (_req, res) => {
  res.json(store.listClients());
});

// Gyroid surface evaluation
app.get('/admin/gyroid/surface', requireAuth, requireAdmin, (req, res) => {
  const gx = parseFloat(req.query.gx || '1');
  const gy = parseFloat(req.query.gy || '1');
  const z0 = req.query.z0 ? parseFloat(req.query.z0) : null;
  const result = gyroid.projectToSurface(gx, gy, z0);
  res.json({
    gx, gy,
    ...result,
    F: gyroid.gyroid(gx, gy, result.gz),
    relation_surface_z: gyroid.relationSurface(gx, gy),
  });
});

// List registered manifold functions
app.get('/admin/functions', requireAuth, requireAdmin, (_req, res) => {
  res.json(processor.listFunctions());
});

// Gyroid inflection points
app.get('/admin/gyroid/inflections', requireAuth, requireAdmin, (req, res) => {
  const gx = parseFloat(req.query.gx || '1');
  const gy = parseFloat(req.query.gy || '1');
  const steps = parseInt(req.query.steps || '64', 10);
  const pts = gyroid.findInflectionPoints(gx, gy, Math.min(steps, 256));
  res.json({ gx, gy, inflections: pts, count: pts.length });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

// subscriptions: Map<"ns:table", Set<ws>>
const _subs = new Map();

function notifySubscribers(ns, table, event) {
  const key = `${ns}:${table}`;
  const sockets = _subs.get(key);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify({ event, ts: Date.now() });
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(msg); } catch (_) { /* ignore disconnected clients */ }
    }
  }
}

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws._subscriptions = new Set();

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return ws.send(JSON.stringify({ error: 'Invalid JSON' })); }

      // Authenticate on subscribe
      if (msg.type === 'auth') {
        if (!msg.client_id || !msg.api_key) {
          return ws.send(JSON.stringify({ error: 'client_id and api_key required' }));
        }
        const { verifyClient } = require('./store');
        const client = await verifyClient(msg.client_id, msg.api_key);
        if (!client) return ws.send(JSON.stringify({ error: 'Invalid credentials' }));
        ws._client = client;
        return ws.send(JSON.stringify({ ok: true, type: 'authenticated', name: client.name }));
      }

      if (!ws._client) {
        return ws.send(JSON.stringify({ error: 'Not authenticated — send auth message first' }));
      }

      if (msg.type === 'subscribe') {
        const { namespace, table } = msg;
        if (!namespace || !table) return ws.send(JSON.stringify({ error: 'namespace and table required' }));
        if (!checkNamespace(ws._client, namespace)) {
          return ws.send(JSON.stringify({ error: 'Namespace not permitted' }));
        }
        const key = `${namespace}:${table}`;
        if (!_subs.has(key)) _subs.set(key, new Set());
        _subs.get(key).add(ws);
        ws._subscriptions.add(key);
        return ws.send(JSON.stringify({ ok: true, type: 'subscribed', namespace, table }));
      }

      if (msg.type === 'unsubscribe') {
        const key = `${msg.namespace}:${msg.table}`;
        const subs = _subs.get(key);
        if (subs) subs.delete(ws);
        ws._subscriptions.delete(key);
        return ws.send(JSON.stringify({ ok: true, type: 'unsubscribed' }));
      }

      // Pass-through write operations over WebSocket
      if (msg.type === 'set') {
        const { namespace, table, row, col, value } = msg;
        if (!checkNamespace(ws._client, namespace)) {
          return ws.send(JSON.stringify({ error: 'Namespace not permitted' }));
        }
        const result = store.setCell(namespace, table, row, col, value);
        notifySubscribers(namespace, table, { op: 'set', row, col, value, ...result });
        return ws.send(JSON.stringify({ ok: true, type: 'set', ...result }));
      }

      ws.send(JSON.stringify({ error: `Unknown message type: ${msg.type}` }));
    });

    ws.on('close', () => {
      // Clean up subscriptions
      for (const key of ws._subscriptions || []) {
        const subs = _subs.get(key);
        if (subs) subs.delete(ws);
      }
    });
  });

  return wss;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  // Ensure at least one admin client exists; print key if freshly created
  const existing = store.listClients();
  if (existing.length === 0) {
    console.log('[boot] No clients found — creating bootstrap admin client...');
    const result = await store.createClient('bootstrap-admin', ['*'], true);
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║  TETRACUBEDB BOOTSTRAP ADMIN CLIENT CREATED           ║');
    console.log('║  Save these credentials — the key is shown ONCE ONLY  ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  client_id : ${result.client_id.padEnd(39)} ║`);
    console.log(`║  api_key   : ${result.api_key.slice(0, 39).padEnd(39)} ║`);
    if (result.api_key.length > 39) {
      console.log(`║             ${result.api_key.slice(39).padEnd(39)} ║`);
    }
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('');
  }

  const server = http.createServer(app);
  setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`[tetracubedb] Manifold Database listening on port ${PORT}`);
    console.log(`[tetracubedb] Gyroid surface: sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0`);
    console.log(`[tetracubedb] z = x*y  (Relation Surface / Dimension 5 seed)`);
    const stats = store.dbStats();
    console.log(`[tetracubedb] ${stats.cells} cells | ${stats.stacks} stack frames | ${stats.clients} clients`);
  });
}

bootstrap().catch(err => {
  console.error('[tetracubedb] Fatal startup error:', err);
  process.exit(1);
});
