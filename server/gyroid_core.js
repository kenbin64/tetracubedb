/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — GYROID CORE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ── Geometric Foundation ────────────────────────────────────────────────────
 *
 *  PRIMITIVE:  z = x · y
 *    The relation surface.  Every table is a plane x·y; z is its height —
 *    the stack of its deltas, sequences, and time-slices.
 *
 *  ROTATION:   z = x·y  rotated 90° → HELIX
 *    A single helix is one column of the lattice: a continuous spiral
 *    threading through all states of one data sequence.
 *
 *  LATTICE:    array of helices → SCHWARTZ DIAMOND GYROID
 *    F(x,y,z) = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0
 *    The full gyroid surface IS the database.  Every cell lives on this
 *    surface.  The topology of the surface encodes the relationships
 *    between all stored values — no separate index needed.
 *
 *  SCALE:      one lattice = one system (e.g. TetracubeDB)
 *    Connecting two systems = adding a new dimension.
 *    The combined lattice is a higher-order gyroid — one interconnected
 *    structure.  The entire internet could be one lattice.
 *
 * ── Privacy / Handshake Model ───────────────────────────────────────────────
 *
 *  Every node on the surface KNOWS THE ADDRESSES of its neighbors
 *  (surface topology is public — computable from the gyroid equation).
 *  Every node does NOT KNOW THE CONTENT of its neighbors.
 *  Content access requires:
 *    1. KNOCK  — caller presents neighbor's surface address
 *    2. HANDSHAKE — owner authenticates and grants a scoped token
 *  This makes the lattice secure by geometry: structure is open,
 *  data is always gated.
 *
 * ── 8 Dimensions (Fibonacci spiral, ratio → φ) ──────────────────────────────
 *
 *  Each dimension Dₙ is a single POINT of Dₙ₊₁.  The series follows
 *  Fibonacci: 0,1,1,2,3,5,8,13,21 — completing at D7=M (≈21, near φ²)
 *
 *   D0 VOID   (0)  — ∅   empty set / null
 *   D1 POINT  (1)  — ·   scalar — one point of LINE
 *
 *   ── ADDITIVE TIER (accumulate points along one axis) ───────────────────
 *   D2 LINE   (1)  — x   array of points  →  x + x + x ...
 *                    Fibonacci weight 1: same as POINT — addition along one direction
 *   D3 WIDTH  (1)  — y   array of points perpendicular to LINE  →  y + y + y ...
 *                    Same Fibonacci weight as LINE (both are 1): width IS just
 *                    a line in another direction — addition has no preferred axis
 *
 *   ── FIRST MULTIPLICATION (x · y → new surface) ──────────────────────────
 *   D4 PLANE  (3)  — x·y  LINE × WIDTH  →  the saddle/flat surface
 *                    NOT an addition: axes are CROSSED, creating a 2D extent
 *                    [z = x·y]  — the relation surface, every table is a PLANE
 *
 *   ── ADDITIVE TIER (accumulate planes along z) ───────────────────────────
 *   D5 STACK  (5)  — z   planes stacked one-by-one along z (delta-by-delta)
 *                    each plane records ONLY what changed; nothing repeated
 *                    top plane = current state; lower planes = history
 *   D6 VOLUME (8)  — the full body formed by all stacked planes
 *                    additive accumulation — but z = x·y warps the stack into
 *                    the saddle/gyroid shape: not a cube — a twisted 3D surface
 *
 *   ── SECOND MULTIPLICATION (x · y · z → whole object) ───────────────────
 *   D7 M     (13)  — x · y · z  — the WHOLE OBJECT: identity, not contents
 *                    the three additive axes are now ALL crossed simultaneously
 *                    atomic and discrete from the outside
 *                    one M = one POINT at the next scale
 *
 * ── Frame-of-Reference Principle ────────────────────────────────────────────
 *
 *  You can only hold ONE scale at a time.  To access contents of an M,
 *  you do not traverse it — you CHANGE SCOPE entirely (knock + handshake).
 *  Inside the new scope, VOID through M resets at that scale.
 *  The outer M is forgotten.  You address the engine; the car is gone.
 *  This is O(1): gyroid-hash the address, knock, enter new coordinate space.
 *
 *  carburetor → [is a POINT in] engine → [is a POINT in] car
 *               → [is a POINT in] parking lot → [is a POINT in] city
 *               → ... → galaxy → universe
 *  The pattern does not break at any scale.
 *  The namespace IS the scope.  Changing namespace = changing scale.
 *
 * ── This module provides ────────────────────────────────────────────────────
 *   1. Gyroid surface evaluation F(x,y,z)
 *   2. Surface projection: given (gx, gy) → find gz on surface
 *   3. Inflection point detection (natural index anchors)
 *   4. Geodesic distance (curve-based range queries)
 *   5. Coordinate hashing (gyroid address → storage key)
 *   6. 8-Dimension classifier
 *   7. Neighbor address discovery (topology — no content)
 *   8. Handshake token generation (knock → auth)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const crypto = require('crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
const TWO_PI = 2 * Math.PI;
const NEWTON_ITERATIONS = 32;
const NEWTON_EPSILON = 1e-10;
const GRID_SCALE = TWO_PI;   // one gyroid unit cell = 2π

// ── Dimension constants ───────────────────────────────────────────────────────
// Fibonacci sequence: 0,1,1,2,3,5,8,13,21  (D7=M closes near φ²≈21)
// Each Dₙ is a single point of Dₙ₊₁
const DIM = Object.freeze({
  VOID: 0,  // ∅   fib:0  — empty set
  POINT: 1,  // ·   fib:1  — scalar, one point of LINE
  LINE: 2,  // x   fib:1  — column, one point of WIDTH
  WIDTH: 3,  // y   fib:2  — row, one point of PLANE
  PLANE: 4,  // x·y fib:3  — table, one point of STACK  (z = x·y)
  STACK: 5,  // z   fib:5  — stack of delta-planes, one point of VOLUME
  //           each new plane records ONLY what changed — nothing that stayed the same
  //           top plane = current state; lower planes = history of how it got there
  VOLUME: 6, // fib:8  — the complete measured body of the stack — one point of M
  //           not the object itself — the aggregate extent of all its planes
  M: 7,  // fib:13 — the WHOLE OBJECT: identity, not contents
  //           atomic and discrete from the outside
  //           one M = one POINT at the next scale
  //           to access contents: forget M, change scope (O(1))
});

const DIM_NAMES = ['void', 'point', 'line', 'width', 'plane', 'stack', 'volume', 'm'];

// Fibonacci weights per dimension (ratio approaches φ = 1.6180...)
// D7=M is F(7)=13.  F(8)=21 is the next lattice (a lattice of M's).
const DIM_FIB = [0, 1, 1, 2, 3, 5, 8, 13];

// Operation type per dimension:
//   'add' — accumulate points along one axis  (same direction, repeated)
//   'mul' — cross two or more axes            (new surface is born)
//
// Pattern:  void · point  [add add] MUL [add add] MUL
//                          LINE WIDTH PLANE STACK VOLUME M
// The two multiplications are D4=PLANE (x·y) and D7=M (x·y·z).
// LINE and WIDTH share fib=1 because addition has no preferred direction.
// VOLUME is additive but its z=x·y warp twists it into the gyroid saddle.
const DIM_MODE = Object.freeze([
  'void',  // D0 VOID
  'point', // D1 POINT
  'add',   // D2 LINE   — x + x + x ...
  'add',   // D3 WIDTH  — y + y + y ...
  'mul',   // D4 PLANE  — x · y  (first cross)
  'add',   // D5 STACK  — plane + plane + plane ...
  'add',   // D6 VOLUME — accumulated planes (z=xy warped)
  'mul',   // D7 M      — x · y · z  (second cross — whole object)
]);

// ── Core gyroid function ──────────────────────────────────────────────────────
/**
 * Evaluates F(x,y,z) = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)
 * Returns 0 on the gyroid surface.
 */
function gyroid(x, y, z) {
  return Math.sin(x) * Math.cos(y)
    + Math.sin(y) * Math.cos(z)
    + Math.sin(z) * Math.cos(x);
}

/**
 * Partial derivative ∂F/∂z
 * Used by Newton-Raphson to project (x,y) → z on the surface.
 */
function gyroidDz(x, y, z) {
  return -Math.sin(y) * Math.sin(z)
    + Math.cos(z) * Math.cos(x);
}

// ── Surface projection: (gx, gy) → gz ────────────────────────────────────────
/**
 * Given coordinates (gx, gy), find the nearest gz such that F(gx, gy, gz) ≈ 0.
 * Uses Newton-Raphson starting from z0 = gx * gy (Relation Surface seed).
 *
 * Returns { gz, onSurface, iterations }
 */
function projectToSurface(gx, gy, z0 = null) {
  // seed: Relation Surface z = x*y, clamped to gyroid cell
  let z = z0 !== null ? z0 : ((gx * gy) % GRID_SCALE);

  let fVal, dfVal;
  let i = 0;

  for (; i < NEWTON_ITERATIONS; i++) {
    fVal = gyroid(gx, gy, z);
    dfVal = gyroidDz(gx, gy, z);

    if (Math.abs(dfVal) < NEWTON_EPSILON) {
      // derivative vanished — step sideways and retry
      z += 0.1;
      continue;
    }

    const step = fVal / dfVal;
    z -= step;

    if (Math.abs(step) < NEWTON_EPSILON) break;
  }

  fVal = gyroid(gx, gy, z);
  return {
    gz: z,
    onSurface: Math.abs(fVal) < 1e-7,
    residual: fVal,
    iterations: i,
  };
}

// ── Relation Surface (fast path) ─────────────────────────────────────────────
/**
 * The simplified "Relation Surface": z = x * y
 * Used as the initial seed and for PLANE → STACK dimensional promotions.
 */
function relationSurface(x, y) {
  return x * y;
}

// ── Inflection point detection ────────────────────────────────────────────────
/**
 * Second derivative ∂²F/∂z² at (x,y,z).
 * Inflection points (where this = 0) become natural index anchors.
 */
function gyroidDzz(x, y, z) {
  return -Math.sin(y) * Math.cos(z)
    - Math.sin(z) * Math.cos(x);
}

/**
 * Find inflection points along the z-axis at (gx, gy) by scanning [0, 2π].
 * Returns array of gz values where ∂²F/∂z² ≈ 0 and F(gx,gy,gz) ≈ 0.
 */
function findInflectionPoints(gx, gy, steps = 64) {
  const inflections = [];
  const dz = GRID_SCALE / steps;

  let prevSign = Math.sign(gyroidDzz(gx, gy, 0));

  for (let i = 1; i <= steps; i++) {
    const z = i * dz;
    const curSign = Math.sign(gyroidDzz(gx, gy, z));
    if (curSign !== prevSign && curSign !== 0) {
      // Sign change → inflection point in this interval; bisect
      let lo = (i - 1) * dz;
      let hi = z;
      for (let j = 0; j < 20; j++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(gyroidDzz(gx, gy, mid)) === prevSign) lo = mid;
        else hi = mid;
      }
      const iz = (lo + hi) / 2;
      if (Math.abs(gyroid(gx, gy, iz)) < 0.3) {   // near-surface filter
        inflections.push(iz);
      }
    }
    prevSign = curSign;
  }
  return inflections;
}

// ── Geodesic distance (curve-based range queries) ────────────────────────────
/**
 * Approximate geodesic distance between two gyroid surface points.
 * Uses Euclidean distance as approximation (true geodesic requires ODE integration).
 * Sufficient for range queries within a single unit cell.
 */
function geodesicDistance(p1, p2) {
  const dx = p1.gx - p2.gx;
  const dy = p1.gy - p2.gy;
  const dz = p1.gz - p2.gz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Coordinate hashing ────────────────────────────────────────────────────────
/**
 * Hash a gyroid address to a deterministic storage key.
 * Format: sha256( namespace + dim + gx_quantized + gy_quantized + key )
 *
 * Quantization: 6 decimal places → stable across floating point noise.
 */
function hashAddress(namespace, dim, gx, gy, key = '') {
  const gz = projectToSurface(gx, gy).gz;
  const qx = gx.toFixed(6);
  const qy = gy.toFixed(6);
  const qz = gz.toFixed(6);
  const raw = `${namespace}:${dim}:${qx}:${qy}:${qz}:${key}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Dimension classifier ──────────────────────────────────────────────────────
/**
 * Infer the TetracubeDB dimension from a JavaScript value.
 */
function classifyValue(val) {
  if (val === null || val === undefined) return DIM.VOID;
  if (typeof val !== 'object' && !Array.isArray(val)) return DIM.POINT;
  if (Array.isArray(val)) {
    // Flat array → LINE; array-of-objects → PLANE row slice
    if (val.length === 0) return DIM.VOID;
    if (typeof val[0] === 'object' && !Array.isArray(val[0])) return DIM.PLANE;
    return DIM.LINE;
  }
  // Object: check for temporal signal
  if ('_dim' in val) return val._dim;
  if ('timestamp' in val || 'seq' in val || 'delta' in val) return DIM.STACK;
  if ('rows' in val || 'columns' in val) return DIM.PLANE;
  if ('frames' in val || 'cells' in val) return DIM.VOLUME;
  if ('volume' in val || 'lattice' in val || 'namespaces' in val) return DIM.M;
  return DIM.WIDTH;    // plain object → row record
}

/**
 * Promote a value to the next dimension.
 * POINT → LINE → WIDTH → PLANE → STACK → VOLUME → M
 */
function promote(val) {
  const d = classifyValue(val);
  switch (d) {
    case DIM.VOID: return 0;
    case DIM.POINT: return [val];
    case DIM.LINE: return { _dim: DIM.WIDTH, values: val };
    case DIM.WIDTH: return { _dim: DIM.PLANE, rows: [val] };
    case DIM.PLANE: return { _dim: DIM.STACK, frames: [val], seq: 0 };
    case DIM.STACK: return { _dim: DIM.VOLUME, cells: [val] };
    case DIM.VOLUME: return { _dim: DIM.M, volume: [val] };
    default: return val;
  }
}

// ── Neighbor address discovery ────────────────────────────────────────────────
/**
 * Return the gyroid surface addresses of the 6 nearest neighbors of a point.
 * TOPOLOGY IS PUBLIC: any node can compute neighbor addresses.
 * CONTENT IS PRIVATE: reading a neighbor requires a handshake.
 *
 * Neighbors are found by stepping ±δ in each of the three gyroid axes
 * and projecting back onto the surface — following the lattice topology.
 *
 * Returns array of { gx, gy, gz, direction } — addresses only, no data.
 */
function neighborAddresses(gx, gy, gz, delta = 0.3) {
  const dirs = [
    { d: 'x+', dx: delta, dy: 0, dz: 0 },
    { d: 'x-', dx: -delta, dy: 0, dz: 0 },
    { d: 'y+', dx: 0, dy: delta, dz: 0 },
    { d: 'y-', dx: 0, dy: -delta, dz: 0 },
    { d: 'z+', dx: 0, dy: 0, dz: delta },
    { d: 'z-', dx: 0, dy: 0, dz: -delta },
  ];
  return dirs.map(({ d, dx, dy, dz }) => {
    const ngx = gx + dx;
    const ngy = gy + dy;
    // project perturbed point back to surface
    const { gz: ngz } = projectToSurface(ngx, ngy, gz + dz);
    return { gx: ngx, gy: ngy, gz: ngz, direction: d };
  });
}

/**
 * Generate a one-time knock token for a neighbor handshake.
 * The knock proves the caller knows the neighbor's surface address
 * without revealing anything about the caller's content.
 *
 * Protocol:
 *   1. Caller computes knock(myAddress, neighborAddress, nonce)
 *   2. Neighbor verifies the gyroid address is valid (on-surface)
 *   3. Neighbor issues a scoped Bearer token if authorized
 *
 * Returns { knock, nonce, address } — present this to the neighbor node.
 */
function knockNeighbor(myGx, myGy, myGz, neighborGx, neighborGy, neighborGz) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const myAddr = `${myGx.toFixed(6)}:${myGy.toFixed(6)}:${myGz.toFixed(6)}`;
  const nbrAddr = `${neighborGx.toFixed(6)}:${neighborGy.toFixed(6)}:${neighborGz.toFixed(6)}`;
  const knock = crypto.createHash('sha256')
    .update(`knock:${myAddr}:${nbrAddr}:${nonce}`)
    .digest('hex');
  return {
    knock,
    nonce,
    from: { gx: myGx, gy: myGy, gz: myGz },
    to: { gx: neighborGx, gy: neighborGy, gz: neighborGz },
  };
}

// ── Gyroid coordinate grid ────────────────────────────────────────────────────
/**
 * Convert a human-readable table/column/row address to gyroid coordinates.
 *
 * Mapping:
 *   namespace → fixed gx anchor (hash-derived)
 *   table     → gy derived from table name hash
 *   row/col   → fractional offsets within the unit cell
 *
 * Returns { gx, gy, gz } with gz computed via Relation Surface.
 */
function addressToGyroid(namespace, table, rowKey = null, colKey = null) {
  const nsHash = _strToAngle(namespace);
  const tblHash = _strToAngle(table);
  const rowOff = rowKey ? _strToAngle(rowKey) / (2 * Math.PI) * 0.1 : 0;
  const colOff = colKey ? _strToAngle(colKey) / (2 * Math.PI) * 0.1 : 0;

  const gx = nsHash + rowOff;
  const gy = tblHash + colOff;
  const gz = relationSurface(gx, gy);   // Relation Surface seed

  return { gx, gy, gz };
}

function _strToAngle(str) {
  // Fast djb2-style hash → angle in [0, 2π)
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0;
  }
  return (h / 0xFFFFFFFF) * GRID_SCALE;
}

// ── Export ────────────────────────────────────────────────────────────────────
module.exports = {
  DIM,
  DIM_NAMES,
  DIM_FIB,
  DIM_MODE,
  GRID_SCALE,
  gyroid,
  gyroidDz,
  gyroidDzz,
  projectToSurface,
  relationSurface,
  findInflectionPoints,
  geodesicDistance,
  hashAddress,
  classifyValue,
  promote,
  addressToGyroid,
  neighborAddresses,
  knockNeighbor,
};
