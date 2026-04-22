/**
 * gyroid.js — The Gyroid substrate.
 *
 * F(x,y,z) = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x) = 0
 *
 * Triply-periodic minimal surface.  The mathematical engine of TetracubeDB.
 * z = x·y is the Relation Surface (D4 PLANE) — the origin of all tables.
 *
 * Rules:
 *   value(point)   → evaluates F.  Negative = inside.  Positive = outside.
 *   observe(point) → returns a collapsed Observation.
 *   gyroidAddress(ns, table, row, col) → maps a DB coordinate to a gyroid point.
 *
 * This module never iterates, scans, or samples.
 * It only reveals what already exists at the requested point.
 *
 * @module substrate/gyroid
 */

'use strict';

const SURFACE_EPSILON = 1e-3;

// Fibonacci weights for D0–D7 (Fib: 0,1,1,2,3,5,8,13)
const FIB = [0, 1, 1, 2, 3, 5, 8, 13];

// ── Core surface ───────────────────────────────────────────────────────────

/**
 * Evaluate F(x,y,z) at the given point.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function value(x, y, z) {
  return (
    Math.sin(x) * Math.cos(y) +
    Math.sin(y) * Math.cos(z) +
    Math.sin(z) * Math.cos(x)
  );
}

/**
 * Collapse a point — observe what the surface reveals there.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {{ point: {x,y,z}, value: number, inside: boolean, onSurface: boolean }}
 */
function observe(x, y, z) {
  const v = value(x, y, z);
  return {
    point: { x, y, z },
    value: v,
    inside: v < 0,
    onSurface: Math.abs(v) < SURFACE_EPSILON,
  };
}

// ── Dimensional addressing ─────────────────────────────────────────────────

/**
 * Map a TetracubeDB coordinate (namespace, table, row, col) to a gyroid point.
 *
 * Dimensional layers:
 *   D2 LINE  (col)   → x-axis
 *   D3 WIDTH (row)   → y-axis
 *   D4 PLANE (table) → z = x · y  (Relation Surface)
 *   D5 STACK (ns)    → z-axis offset
 *
 * @param {string} ns
 * @param {string} table
 * @param {string|number} row
 * @param {string|number} col
 * @returns {{ x: number, y: number, z: number, plane: number }}
 */
function gyroidAddress(ns, table, row, col) {
  const x = _hashToAngle(String(col));   // D2 LINE
  const y = _hashToAngle(String(row));   // D3 WIDTH
  const plane = x * y;                   // D4 PLANE — z = x·y
  const zOffset = _hashToAngle(ns + '.' + table) * FIB[5]; // D5 STACK
  const z = plane + zOffset;
  return { x, y, z, plane };
}

// ── Fibonacci traversal ────────────────────────────────────────────────────

/**
 * The Fibonacci Directionality Law:
 *   Vertical traversal   (same Fibonacci arm) → multiplicative, frictionless.
 *   Horizontal traversal (cross-arm)          → divisive, resistance cost.
 *
 * Returns the traversal cost between two dimensional levels.
 * @param {number} fromDim  0–7
 * @param {number} toDim    0–7
 * @returns {{ cost: number, direction: 'vertical'|'horizontal' }}
 */
function traversalCost(fromDim, toDim) {
  const delta = toDim - fromDim;
  const direction = Number.isInteger(Math.log(Math.abs(delta || 1)) / Math.log(1.618))
    ? 'vertical'
    : 'horizontal';
  const cost = direction === 'vertical'
    ? FIB[Math.min(Math.abs(delta), 7)]
    : FIB[Math.min(Math.abs(delta), 7)] * 1.618;
  return { cost, direction };
}

// ── Internal ───────────────────────────────────────────────────────────────

/** Map a string key deterministically to an angle in [0, 2π). */
function _hashToAngle(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) >>> 0;
  }
  return (h / 0xFFFFFFFF) * 2 * Math.PI;
}

// ── Export ────────────────────────────────────────────────────────────────

const Gyroid = { value, observe, gyroidAddress, traversalCost, FIB };

// Support both ES module and script tag usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Gyroid;
} else {
  window.Gyroid = Gyroid;
}
