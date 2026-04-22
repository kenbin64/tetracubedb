/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — PERSISTENT MANIFOLD STORE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SQLite-backed persistent storage layer.
 * Data is addressed by gyroid coordinates derived from (namespace, table, key).
 *
 * Schema:
 *
 *   manifold_cells — core data store
 *     addr_hash   TEXT  PK    — sha256 of gyroid address
 *     namespace   TEXT        — client/tenant identifier
 *     table_name  TEXT        — logical table name
 *     row_key     TEXT        — row identifier
 *     col_key     TEXT        — column identifier (nullable for row-level)
 *     dim         INTEGER     — TetracubeDB dimension (0-6)
 *     gx, gy, gz  REAL        — gyroid coordinates
 *     value_json  TEXT        — JSON-serialized value
 *     created_at  INTEGER     — unix epoch
 *     updated_at  INTEGER     — unix epoch
 *
 *   manifold_stacks — temporal/delta series (D5: STACK)
 *     id          INTEGER PK AUTOINCREMENT
 *     addr_hash   TEXT        — foreign key to manifold_cells
 *     seq         INTEGER     — sequence / timestamp index
 *     delta_json  TEXT        — the delta snapshot at this seq point
 *     recorded_at INTEGER
 *
 *   manifold_clients — registered API clients
 *     id          INTEGER PK AUTOINCREMENT
 *     client_id   TEXT  UNIQUE
 *     client_key  TEXT        — bcrypt-hashed API key
 *     name        TEXT
 *     namespaces  TEXT        — JSON array of permitted namespaces
 *     created_at  INTEGER
 *     last_seen   INTEGER
 *
 *   manifold_schema — logical schema declarations
 *     namespace   TEXT
 *     table_name  TEXT
 *     schema_json TEXT        — column definitions, types, etc.
 *     updated_at  INTEGER
 *     PRIMARY KEY (namespace, table_name)
 *
 * DB location: DATA_DIR env var or /var/lib/tetracubedb/tetracube.db
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');

const { DIM, DIM_NAMES, classifyValue, addressToGyroid, hashAddress } = require('./gyroid_core');

// ── DB path — survives deploys by living OUTSIDE the app directory ───────────
const DATA_DIR = process.env.DATA_DIR || '/var/lib/tetracubedb';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'tetracube.db');

let _db = null;

function db() {
  if (_db) return _db;

  // Ensure data directory exists with correct permissions
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o750 });
    console.log(`[store] Created data directory: ${DATA_DIR}`);
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -32000');    // 32 MB page cache
  _db.pragma('temp_store = MEMORY');

  _initSchema(_db);
  console.log(`[store] TetracubeDB open at ${DB_PATH}`);
  return _db;
}

// ── Schema ────────────────────────────────────────────────────────────────────
function _initSchema(d) {
  d.exec(`
    -- Core manifold cell store
    CREATE TABLE IF NOT EXISTS manifold_cells (
      addr_hash   TEXT    PRIMARY KEY,
      namespace   TEXT    NOT NULL,
      table_name  TEXT    NOT NULL,
      row_key     TEXT    NOT NULL DEFAULT '',
      col_key     TEXT    NOT NULL DEFAULT '',
      dim         INTEGER NOT NULL DEFAULT 1,
      gx          REAL    NOT NULL DEFAULT 0.0,
      gy          REAL    NOT NULL DEFAULT 0.0,
      gz          REAL    NOT NULL DEFAULT 0.0,
      value_json  TEXT    NOT NULL DEFAULT 'null',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_cells_ns_tbl
      ON manifold_cells (namespace, table_name);
    CREATE INDEX IF NOT EXISTS idx_cells_ns_tbl_row
      ON manifold_cells (namespace, table_name, row_key);
    CREATE INDEX IF NOT EXISTS idx_cells_gyroid
      ON manifold_cells (gx, gy, gz);
    CREATE INDEX IF NOT EXISTS idx_cells_dim
      ON manifold_cells (dim);

    -- Temporal/delta stack (D5: STACK)
    CREATE TABLE IF NOT EXISTS manifold_stacks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      addr_hash   TEXT    NOT NULL,
      seq         INTEGER NOT NULL DEFAULT 0,
      delta_json  TEXT    NOT NULL DEFAULT '{}',
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (addr_hash) REFERENCES manifold_cells(addr_hash) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stacks_addr_seq
      ON manifold_stacks (addr_hash, seq);

    -- Registered API clients
    CREATE TABLE IF NOT EXISTS manifold_clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT    UNIQUE NOT NULL,
      client_key  TEXT    NOT NULL,
      name        TEXT    NOT NULL DEFAULT '',
      namespaces  TEXT    NOT NULL DEFAULT '["*"]',
      is_admin    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Logical schema declarations
    CREATE TABLE IF NOT EXISTS manifold_schema (
      namespace   TEXT    NOT NULL,
      table_name  TEXT    NOT NULL,
      schema_json TEXT    NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (namespace, table_name)
    );

    -- Gyroid inflection index (for range queries along surface curves)
    CREATE TABLE IF NOT EXISTS gyroid_index (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace   TEXT    NOT NULL,
      table_name  TEXT    NOT NULL,
      gx          REAL    NOT NULL,
      gy          REAL    NOT NULL,
      gz          REAL    NOT NULL,
      inflection  REAL    NOT NULL,
      addr_hash   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gyroid_ns_tbl
      ON gyroid_index (namespace, table_name, gz);
  `);
}

// ── Cell CRUD ─────────────────────────────────────────────────────────────────

/**
 * SET — write a value at (namespace, table, rowKey, colKey)
 * Computes gyroid coordinates automatically.
 * Returns the gyroid address.
 */
function setCell(namespace, table, rowKey, colKey, value) {
  const d = db();
  const dim = classifyValue(value);
  const { gx, gy, gz } = addressToGyroid(namespace, table, rowKey, colKey);
  const addr = hashAddress(namespace, dim, gx, gy, `${rowKey}:${colKey}`);
  const json = JSON.stringify(value);

  const upsert = d.prepare(`
    INSERT INTO manifold_cells
      (addr_hash, namespace, table_name, row_key, col_key, dim, gx, gy, gz, value_json,
       created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, unixepoch(), unixepoch())
    ON CONFLICT(addr_hash) DO UPDATE SET
      value_json = excluded.value_json,
      dim        = excluded.dim,
      updated_at = unixepoch()
  `);
  upsert.run(addr, namespace, table, rowKey || '', colKey || '', dim, gx, gy, gz, json);
  return { addr, gx, gy, gz, dim };
}

/**
 * GET — retrieve a value at (namespace, table, rowKey, colKey)
 */
function getCell(namespace, table, rowKey, colKey) {
  const d = db();
  const { gx, gy, gz } = addressToGyroid(namespace, table, rowKey, colKey);
  const dim = DIM.POINT; // scan both dim variants
  const addr = hashAddress(namespace, dim, gx, gy, `${rowKey}:${colKey}`);

  // Try direct hash first
  let row = d.prepare('SELECT * FROM manifold_cells WHERE addr_hash = ?').get(addr);

  // Fallback: scan by (namespace, table, row_key, col_key)
  if (!row) {
    row = d.prepare(`
      SELECT * FROM manifold_cells
      WHERE namespace=? AND table_name=? AND row_key=? AND col_key=?
      ORDER BY updated_at DESC LIMIT 1
    `).get(namespace, table, rowKey || '', colKey || '');
  }

  if (!row) return null;
  return {
    ...row,
    value: JSON.parse(row.value_json),
    dim_name: DIM_NAMES[row.dim] || 'unknown',
  };
}

/**
 * GET ROW — retrieve all columns for a row (D3: WIDTH)
 */
function getRow(namespace, table, rowKey) {
  const d = db();
  const rows = d.prepare(`
    SELECT * FROM manifold_cells
    WHERE namespace=? AND table_name=? AND row_key=?
    ORDER BY col_key ASC
  `).all(namespace, table, rowKey);

  if (!rows.length) return null;

  const record = { _row: rowKey, _dim: DIM.WIDTH };
  for (const row of rows) {
    if (row.col_key) {
      record[row.col_key] = JSON.parse(row.value_json);
    }
  }
  record._gyroid = { gx: rows[0].gx, gy: rows[0].gy, gz: rows[0].gz };
  return record;
}

/**
 * SCAN TABLE — return all rows as a D4 PLANE
 */
function scanTable(namespace, table, opts = {}) {
  const d = db();
  const { limit = 1000, offset = 0, orderBy = 'updated_at' } = opts;

  const safeOrder = ['updated_at', 'created_at', 'row_key', 'gx', 'gy', 'gz'].includes(orderBy)
    ? orderBy : 'updated_at';

  const rows = d.prepare(`
    SELECT * FROM manifold_cells
    WHERE namespace=? AND table_name=?
    ORDER BY ${safeOrder} DESC
    LIMIT ? OFFSET ?
  `).all(namespace, table, limit, offset);

  const total = d.prepare(`
    SELECT COUNT(*) as n FROM manifold_cells
    WHERE namespace=? AND table_name=?
  `).get(namespace, table).n;

  return {
    _dim: DIM.PLANE,
    namespace,
    table,
    total,
    rows: rows.map(r => ({ ...r, value: JSON.parse(r.value_json) })),
  };
}

/**
 * DELETE — remove a cell
 */
function deleteCell(namespace, table, rowKey, colKey) {
  const d = db();
  const result = d.prepare(`
    DELETE FROM manifold_cells
    WHERE namespace=? AND table_name=? AND row_key=? AND col_key=?
  `).run(namespace, table, rowKey || '', colKey || '');
  return result.changes > 0;
}

/**
 * DELETE ROW — remove all cells for a row
 */
function deleteRow(namespace, table, rowKey) {
  const d = db();
  const result = d.prepare(`
    DELETE FROM manifold_cells WHERE namespace=? AND table_name=? AND row_key=?
  `).run(namespace, table, rowKey);
  return result.changes;
}

// ── Stack operations (D5: temporal) ──────────────────────────────────────────

/**
 * PUSH DELTA — append a temporal snapshot to a cell's stack
 */
function pushDelta(namespace, table, rowKey, colKey, delta) {
  const d = db();
  const cell = getCell(namespace, table, rowKey, colKey);
  if (!cell) {
    // Auto-create the cell as a STACK type
    setCell(namespace, table, rowKey, colKey, { _dim: DIM.STACK, frames: [], seq: 0 });
  }

  const { gx, gy, gz } = addressToGyroid(namespace, table, rowKey, colKey);
  const addr = hashAddress(namespace, DIM.STACK, gx, gy, `${rowKey}:${colKey}`);

  // Insert addr into manifold_cells if needed
  const existing = d.prepare('SELECT addr_hash FROM manifold_cells WHERE addr_hash=?').get(addr);
  if (!existing) {
    d.prepare(`
      INSERT OR IGNORE INTO manifold_cells
        (addr_hash, namespace, table_name, row_key, col_key, dim, gx, gy, gz, value_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(addr, namespace, table, rowKey || '', colKey || '', DIM.STACK, gx, gy, gz,
      JSON.stringify({ _dim: DIM.STACK, seq: 0 }));
  }

  const maxSeq = d.prepare(`
    SELECT COALESCE(MAX(seq),0) as s FROM manifold_stacks WHERE addr_hash=?
  `).get(addr).s;

  d.prepare(`
    INSERT INTO manifold_stacks (addr_hash, seq, delta_json, recorded_at)
    VALUES (?, ?, ?, unixepoch())
  `).run(addr, maxSeq + 1, JSON.stringify(delta));

  return { addr, seq: maxSeq + 1, gz };
}

/**
 * READ STACK — retrieve temporal series for a cell
 */
function readStack(namespace, table, rowKey, colKey, opts = {}) {
  const d = db();
  const { from = 0, to = null, limit = 100 } = opts;
  const { gx, gy } = addressToGyroid(namespace, table, rowKey, colKey);
  const addr = hashAddress(namespace, DIM.STACK, gx, gy, `${rowKey}:${colKey}`);

  let query = 'SELECT * FROM manifold_stacks WHERE addr_hash=? AND seq >= ?';
  const params = [addr, from];
  if (to !== null) { query += ' AND seq <= ?'; params.push(to); }
  query += ' ORDER BY seq ASC LIMIT ?';
  params.push(limit);

  const frames = d.prepare(query).all(...params);
  return {
    _dim: DIM.STACK,
    addr,
    frames: frames.map(f => ({ seq: f.seq, delta: JSON.parse(f.delta_json), at: f.recorded_at })),
  };
}

// ── Client management ─────────────────────────────────────────────────────────

async function createClient(name, namespaces = ['*'], isAdmin = false) {
  const d = db();
  const client_id = crypto.randomBytes(12).toString('hex');
  const rawKey = crypto.randomBytes(32).toString('hex');
  const hashedKey = await bcrypt.hash(rawKey, 12);

  d.prepare(`
    INSERT INTO manifold_clients (client_id, client_key, name, namespaces, is_admin)
    VALUES (?,?,?,?,?)
  `).run(client_id, hashedKey, name, JSON.stringify(namespaces), isAdmin ? 1 : 0);

  return { client_id, api_key: rawKey };   // Return raw key ONCE — never stored in plain
}

async function verifyClient(client_id, api_key) {
  const d = db();
  const row = d.prepare('SELECT * FROM manifold_clients WHERE client_id=?').get(client_id);
  if (!row) return null;

  const ok = await bcrypt.compare(api_key, row.client_key);
  if (!ok) return null;

  d.prepare('UPDATE manifold_clients SET last_seen=unixepoch() WHERE client_id=?')
    .run(client_id);

  return {
    client_id: row.client_id,
    name: row.name,
    namespaces: JSON.parse(row.namespaces),
    is_admin: row.is_admin === 1,
  };
}

function getClient(client_id) {
  const d = db();
  const row = d.prepare('SELECT client_id, name, namespaces, is_admin, created_at, last_seen FROM manifold_clients WHERE client_id=?').get(client_id);
  if (!row) return null;
  return { ...row, namespaces: JSON.parse(row.namespaces) };
}

function listClients() {
  const d = db();
  return d.prepare('SELECT client_id, name, namespaces, is_admin, created_at, last_seen FROM manifold_clients ORDER BY created_at DESC').all()
    .map(r => ({ ...r, namespaces: JSON.parse(r.namespaces) }));
}

// ── Schema registry ───────────────────────────────────────────────────────────

function setSchema(namespace, table, schema) {
  db().prepare(`
    INSERT INTO manifold_schema (namespace, table_name, schema_json, updated_at)
    VALUES (?,?,?,unixepoch())
    ON CONFLICT(namespace, table_name) DO UPDATE SET
      schema_json = excluded.schema_json,
      updated_at  = unixepoch()
  `).run(namespace, table, JSON.stringify(schema));
}

function getSchema(namespace, table) {
  const row = db().prepare('SELECT * FROM manifold_schema WHERE namespace=? AND table_name=?')
    .get(namespace, table);
  if (!row) return null;
  return { ...row, schema: JSON.parse(row.schema_json) };
}

// ── Namespace operations ──────────────────────────────────────────────────────

function listTables(namespace) {
  return db().prepare(`
    SELECT table_name, COUNT(*) as cell_count, MAX(updated_at) as last_updated
    FROM manifold_cells WHERE namespace=?
    GROUP BY table_name ORDER BY table_name ASC
  `).all(namespace);
}

function listNamespaces() {
  return db().prepare(`
    SELECT namespace, COUNT(DISTINCT table_name) as tables, COUNT(*) as cells
    FROM manifold_cells GROUP BY namespace ORDER BY namespace ASC
  `).all();
}

// ── Gyroid range query ────────────────────────────────────────────────────────

/**
 * Query cells within a gyroid surface radius (geodesic ball query).
 * Finds all cells near the gyroid point (gx, gy, gz) within `radius` units.
 */
function queryRadius(namespace, gx, gy, gz, radius = 0.5, limit = 100) {
  const d = db();
  // Bounding box pre-filter, then geodesic distance filter in JS
  const rows = d.prepare(`
    SELECT * FROM manifold_cells
    WHERE namespace=?
      AND gx BETWEEN ? AND ?
      AND gy BETWEEN ? AND ?
      AND gz BETWEEN ? AND ?
    LIMIT ?
  `).all(namespace,
    gx - radius, gx + radius,
    gy - radius, gy + radius,
    gz - radius, gz + radius,
    limit * 3   // over-fetch for JS filter
  );

  const results = rows
    .filter(r => {
      const dx = r.gx - gx, dy = r.gy - gy, dz = r.gz - gz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
    })
    .slice(0, limit)
    .map(r => ({ ...r, value: JSON.parse(r.value_json) }));

  return { _dim: DIM.FRAME, center: { gx, gy, gz }, radius, results };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function dbStats() {
  const d = db();
  return {
    cells: d.prepare('SELECT COUNT(*) as n FROM manifold_cells').get().n,
    stacks: d.prepare('SELECT COUNT(*) as n FROM manifold_stacks').get().n,
    clients: d.prepare('SELECT COUNT(*) as n FROM manifold_clients').get().n,
    schemas: d.prepare('SELECT COUNT(*) as n FROM manifold_schema').get().n,
    db_path: DB_PATH,
    data_dir: DATA_DIR,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  db,
  setCell,
  getCell,
  getRow,
  scanTable,
  deleteCell,
  deleteRow,
  pushDelta,
  readStack,
  createClient,
  verifyClient,
  getClient,
  listClients,
  setSchema,
  getSchema,
  listTables,
  listNamespaces,
  queryRadius,
  dbStats,
};
