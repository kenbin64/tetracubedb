'use strict';
/**
 * TetracubeDB — Dimensional Programming Thesis Tests
 *
 * Each test proves one axiom of the model. A failure means the implementation
 * diverges from the thesis and the logic must be corrected — not the test.
 *
 * Axioms under test:
 *   A1. Fibonacci sequence: DIM_FIB = [0,1,1,2,3,5,8,13], ratio → φ
 *   A2. Dimension constants: 8 values, 0–7, named correctly
 *   A3. Domain aliases: D4 is universal — table, frame, face are all PLANE
 *   A4. z = x·y primitive: relationSurface(x,y) === x*y
 *   A5. Gyroid surface: F(x,y,z)=0 for projected points
 *   A6. Newton-Raphson convergence: projectToSurface converges in <32 iterations
 *   A7. Scale invariance: each Dₙ is a POINT of Dₙ₊₁ (promote chain)
 *   A8. Delta-stack model: STACK classifies on delta/seq/timestamp signal
 *   A9. VOLUME ≠ M: VOLUME is measured contents, M is identity
 *   A10. Address determinism: same inputs → same hash always
 *   A11. Neighbor topology: 6 neighbors, all on surface, no content leaked
 *   A12. Knock protocol: nonce makes every token unique; structure is correct
 *   A13. Gyroid surface equation: F = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)
 *   A14. Domain alias table: vertex→edge→face→layers→mesh→object maps D1→D2→D4→D5→D6→D7
 *   A15. O(1) scope change: changing namespace changes coordinate space cleanly
 *   A16. Additive/Multiplicative pattern: LINE=WIDTH=add (same fib=1), PLANE=mul (x·y), VOLUME=add, M=mul (x·y·z)
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  DIM, DIM_NAMES, DIM_FIB, DIM_MODE, GRID_SCALE,
  gyroid, gyroidDz,
  projectToSurface, relationSurface,
  classifyValue, promote,
  hashAddress, geodesicDistance,
  neighborAddresses, knockNeighbor,
  addressToGyroid,
} = require('../gyroid_core.js');

const PHI = (1 + Math.sqrt(5)) / 2;  // 1.6180339...
const EPSILON = 1e-6;

// ─────────────────────────────────────────────────────────────────────────────
// A1. FIBONACCI SEQUENCE
// ─────────────────────────────────────────────────────────────────────────────
describe('A1 — Fibonacci sequence', () => {
  it('DIM_FIB has exactly 8 entries (D0–D7)', () => {
    assert.equal(DIM_FIB.length, 8);
  });

  it('DIM_FIB = [0,1,1,2,3,5,8,13]', () => {
    assert.deepEqual(DIM_FIB, [0, 1, 1, 2, 3, 5, 8, 13]);
  });

  it('each entry is F(n+2) = F(n+1) + F(n) from D2 onward', () => {
    for (let i = 2; i < DIM_FIB.length; i++) {
      assert.equal(
        DIM_FIB[i], DIM_FIB[i - 1] + DIM_FIB[i - 2],
        `DIM_FIB[${i}] should equal DIM_FIB[${i - 1}] + DIM_FIB[${i - 2}]`
      );
    }
  });

  it('consecutive Fibonacci ratios approach φ = 1.618...', () => {
    // D5/D4 = 5/3, D6/D5 = 8/5, D7/D6 = 13/8
    const ratios = [
      DIM_FIB[4] / DIM_FIB[3],   // 3/2 = 1.5
      DIM_FIB[5] / DIM_FIB[4],   // 5/3 = 1.666...
      DIM_FIB[6] / DIM_FIB[5],   // 8/5 = 1.6
      DIM_FIB[7] / DIM_FIB[6],   // 13/8 = 1.625
    ];
    for (const r of ratios) {
      assert.ok(Math.abs(r - PHI) < 0.15,
        `ratio ${r.toFixed(4)} should be within 0.15 of φ (${PHI.toFixed(4)})`);
    }
  });

  it('D7/D6 = 13/8 = 1.625 is the closest ratio to φ in the sequence', () => {
    const ratio = DIM_FIB[7] / DIM_FIB[6];
    assert.ok(Math.abs(ratio - PHI) < 0.007,
      `13/8=${ratio} should be within 0.007 of φ`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2. DIMENSION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
describe('A2 — Dimension constants', () => {
  it('8 named dimensions D0–D7', () => {
    assert.equal(Object.keys(DIM).length, 8);
  });

  it('values are 0–7 in order', () => {
    assert.equal(DIM.VOID, 0);
    assert.equal(DIM.POINT, 1);
    assert.equal(DIM.LINE, 2);
    assert.equal(DIM.WIDTH, 3);
    assert.equal(DIM.PLANE, 4);
    assert.equal(DIM.STACK, 5);
    assert.equal(DIM.VOLUME, 6);
    assert.equal(DIM.M, 7);
  });

  it('DIM_NAMES aligns with DIM values', () => {
    assert.equal(DIM_NAMES[DIM.VOID], 'void');
    assert.equal(DIM_NAMES[DIM.POINT], 'point');
    assert.equal(DIM_NAMES[DIM.LINE], 'line');
    assert.equal(DIM_NAMES[DIM.WIDTH], 'width');
    assert.equal(DIM_NAMES[DIM.PLANE], 'plane');
    assert.equal(DIM_NAMES[DIM.STACK], 'stack');
    assert.equal(DIM_NAMES[DIM.VOLUME], 'volume');
    assert.equal(DIM_NAMES[DIM.M], 'm');
  });

  it('DIM is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(DIM), 'DIM must be frozen');
  });

  it('FRAME does not exist — it was renamed to VOLUME', () => {
    assert.equal(DIM.FRAME, undefined, 'DIM.FRAME should not exist; use DIM.VOLUME');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3. DOMAIN ALIASES — D4 is universal
// ─────────────────────────────────────────────────────────────────────────────
describe('A3 — Domain aliases: table / frame / face are all D4 PLANE', () => {
  it('classifyValue({rows}) → PLANE (data: table)', () => {
    assert.equal(classifyValue({ rows: [1, 2, 3] }), DIM.PLANE);
  });

  it('classifyValue(array-of-objects) → PLANE (animation: frame rows)', () => {
    assert.equal(classifyValue([{ x: 1 }, { x: 2 }]), DIM.PLANE);
  });

  it('classifyValue({columns}) → PLANE (geometry: face columns)', () => {
    assert.equal(classifyValue({ columns: ['v1', 'v2'] }), DIM.PLANE);
  });

  it('D4 Fibonacci weight = 3 regardless of domain alias', () => {
    assert.equal(DIM_FIB[DIM.PLANE], 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4. RELATION SURFACE z = x·y
// ─────────────────────────────────────────────────────────────────────────────
describe('A4 — Relation Surface: z = x·y', () => {
  const cases = [
    [0, 0, 0],
    [1, 1, 1],
    [2, 3, 6],
    [-2, 4, -8],
    [Math.PI, 2, Math.PI * 2],
  ];

  for (const [x, y, expected] of cases) {
    it(`relationSurface(${x}, ${y}) = ${expected}`, () => {
      assert.ok(Math.abs(relationSurface(x, y) - expected) < EPSILON);
    });
  }

  it('z = x·y is the primitive: f(x,y) = x*y for all real x,y', () => {
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        assert.equal(relationSurface(x, y), x * y);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A5. GYROID SURFACE EQUATION
// ─────────────────────────────────────────────────────────────────────────────
describe('A5 — Gyroid: F(x,y,z) = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)', () => {
  it('manual evaluation: F(0,0,0) = 0', () => {
    assert.ok(Math.abs(gyroid(0, 0, 0)) < EPSILON);
  });

  it('F(π/2, 0, 0) = sin(π/2)cos(0) + 0 + 0 = 1', () => {
    const v = gyroid(Math.PI / 2, 0, 0);
    assert.ok(Math.abs(v - 1) < EPSILON, `got ${v}`);
  });

  it('F is triply periodic: F(x,y,z) = F(x+2π,y,z)', () => {
    const pts = [[1, 2, 0.5], [0.3, 1.1, 2.2], [-1, 0.5, 3]];
    for (const [x, y, z] of pts) {
      const diff = Math.abs(gyroid(x, y, z) - gyroid(x + 2 * Math.PI, y, z));
      assert.ok(diff < EPSILON, `periodicity failed at (${x},${y},${z}): diff=${diff}`);
    }
  });

  it('F is symmetric under cyclic permutation (x→y→z→x)', () => {
    // F(x,y,z) = sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)
    // cyclic: F(y,z,x) should equal the same expression cyclically
    const [x, y, z] = [1.1, 2.2, 0.7];
    const f1 = gyroid(x, y, z);
    const f2 = gyroid(y, z, x);
    const f3 = gyroid(z, x, y);
    // All three are the same sum with permuted terms
    assert.ok(Math.abs(f1 - f2) < EPSILON, `cyclic symmetry x→y: ${f1} vs ${f2}`);
    assert.ok(Math.abs(f1 - f3) < EPSILON, `cyclic symmetry x→z: ${f1} vs ${f3}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A6. NEWTON-RAPHSON CONVERGENCE
// ─────────────────────────────────────────────────────────────────────────────
describe('A6 — projectToSurface: Newton-Raphson converges onto F=0', () => {
  const testPoints = [
    [0.5, 0.8],
    [1.2, 2.1],
    [-0.3, 1.7],
    [2.5, -1.0],
    [0, 0],
    [Math.PI, Math.PI],
  ];

  for (const [gx, gy] of testPoints) {
    it(`projects (${gx.toFixed(2)}, ${gy.toFixed(2)}) onto F=0`, () => {
      const { gz, onSurface, residual, iterations } = projectToSurface(gx, gy);
      assert.ok(onSurface,
        `(${gx},${gy}) → gz=${gz.toFixed(6)}: F=${residual.toFixed(2e-7)} not on surface after ${iterations} iters`);
      assert.ok(Math.abs(gyroid(gx, gy, gz)) < 1e-6,
        `F(${gx},${gy},${gz}) = ${gyroid(gx, gy, gz)} should be ~0`);
    });
  }

  it('converges in ≤32 iterations', () => {
    const { iterations } = projectToSurface(1.5, 2.3);
    assert.ok(iterations <= 32, `took ${iterations} iterations`);
  });

  it('z=x·y seed lands near the surface (residual < 2.0)', () => {
    // The seed z=x*y is the Relation Surface — it should be close to F=0
    // This validates the z=x*y→gyroid relationship
    const [gx, gy] = [1.0, 1.0];
    const seed = relationSurface(gx, gy);
    const residualAtSeed = Math.abs(gyroid(gx, gy, seed));
    assert.ok(residualAtSeed < 2.0,
      `Relation Surface seed residual ${residualAtSeed} should be < 2.0 (close to surface)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A7. SCALE INVARIANCE — promote chain D0→D1→...→D7
// ─────────────────────────────────────────────────────────────────────────────
describe('A7 — Scale invariance: each Dₙ is a POINT of Dₙ₊₁', () => {
  it('null → VOID', () => {
    assert.equal(classifyValue(null), DIM.VOID);
  });

  it('scalar → POINT', () => {
    assert.equal(classifyValue(42), DIM.POINT);
    assert.equal(classifyValue('hello'), DIM.POINT);
    assert.equal(classifyValue(true), DIM.POINT);
  });

  it('flat array → LINE (one column)', () => {
    assert.equal(classifyValue([1, 2, 3]), DIM.LINE);
  });

  it('plain object → WIDTH (row record)', () => {
    assert.equal(classifyValue({ username: 'ken', score: 9 }), DIM.WIDTH);
  });

  it('object with rows/columns → PLANE (table/frame/face)', () => {
    assert.equal(classifyValue({ rows: [] }), DIM.PLANE);
    assert.equal(classifyValue({ columns: [] }), DIM.PLANE);
  });

  it('object with seq/delta/timestamp → STACK (delta entry)', () => {
    assert.equal(classifyValue({ seq: 5, delta: { score: 100 } }), DIM.STACK);
    assert.equal(classifyValue({ timestamp: Date.now(), score: 9 }), DIM.STACK);
  });

  it('object with frames/cells → VOLUME (full stack body)', () => {
    assert.equal(classifyValue({ frames: [] }), DIM.VOLUME);
    assert.equal(classifyValue({ cells: [] }), DIM.VOLUME);
  });

  it('object with volume/lattice/namespaces → M (whole object)', () => {
    assert.equal(classifyValue({ volume: [], lattice: true }), DIM.M);
    assert.equal(classifyValue({ namespaces: ['kensgames'] }), DIM.M);
  });

  it('explicit _dim tag overrides inference', () => {
    assert.equal(classifyValue({ _dim: DIM.STACK, data: 'anything' }), DIM.STACK);
    assert.equal(classifyValue({ _dim: DIM.M }), DIM.M);
  });

  it('promote chain: VOID→POINT→LINE→WIDTH→PLANE→STACK→VOLUME→M', () => {
    let val = null;
    const chain = [];

    val = promote(val); chain.push(classifyValue(val));  // POINT
    val = promote(val); chain.push(classifyValue(val));  // LINE
    val = promote(val); chain.push(classifyValue(val));  // WIDTH
    val = promote(val); chain.push(classifyValue(val));  // PLANE
    val = promote(val); chain.push(classifyValue(val));  // STACK
    val = promote(val); chain.push(classifyValue(val));  // VOLUME
    val = promote(val); chain.push(classifyValue(val));  // M

    assert.deepEqual(chain, [
      DIM.POINT, DIM.LINE, DIM.WIDTH, DIM.PLANE,
      DIM.STACK, DIM.VOLUME, DIM.M
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A8. DELTA-STACK MODEL
// ─────────────────────────────────────────────────────────────────────────────
describe('A8 — Delta-stack: append-only, top = current state', () => {
  it('a delta entry (seq) classifies as STACK', () => {
    const delta = { seq: 1, score: 100 };
    assert.equal(classifyValue(delta), DIM.STACK);
  });

  it('delta classifies as STACK regardless of field count', () => {
    // Only changed fields — could be just one
    assert.equal(classifyValue({ seq: 2, health: 50 }), DIM.STACK);
    assert.equal(classifyValue({ delta: true, x: 5 }), DIM.STACK);
  });

  it('a stack with frames classifies as VOLUME (the body, not a delta)', () => {
    const stack = { frames: [{ seq: 0 }, { seq: 1 }], cells: [] };
    assert.equal(classifyValue(stack), DIM.VOLUME);
  });

  it('promoting a STACK produces a VOLUME (delta → body)', () => {
    const delta = { _dim: DIM.STACK, frames: [{ seq: 1 }], seq: 1 };
    const promoted = promote(delta);
    assert.equal(classifyValue(promoted), DIM.VOLUME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A9. VOLUME ≠ M
// ─────────────────────────────────────────────────────────────────────────────
describe('A9 — VOLUME ≠ M: measured contents ≠ whole object', () => {
  it('VOLUME and M have different DIM values', () => {
    assert.notEqual(DIM.VOLUME, DIM.M);
  });

  it('VOLUME = 6, M = 7', () => {
    assert.equal(DIM.VOLUME, 6);
    assert.equal(DIM.M, 7);
  });

  it('{cells:[]} classifies as VOLUME, not M', () => {
    assert.equal(classifyValue({ cells: [1, 2] }), DIM.VOLUME);
    assert.notEqual(classifyValue({ cells: [1, 2] }), DIM.M);
  });

  it('{volume:[]} classifies as M, not VOLUME', () => {
    assert.equal(classifyValue({ volume: [1, 2] }), DIM.M);
    assert.notEqual(classifyValue({ volume: [1, 2] }), DIM.VOLUME);
  });

  it('promoting VOLUME yields M', () => {
    const vol = { _dim: DIM.VOLUME, cells: [] };
    const promoted = promote(vol);
    assert.equal(classifyValue(promoted), DIM.M);
  });

  it('Fibonacci: VOLUME(8) < M(13) — measured extent is less than the whole', () => {
    assert.ok(DIM_FIB[DIM.VOLUME] < DIM_FIB[DIM.M]);
    assert.equal(DIM_FIB[DIM.VOLUME], 8);
    assert.equal(DIM_FIB[DIM.M], 13);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A10. ADDRESS DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────
describe('A10 — Address determinism: same inputs → same hash', () => {
  it('hashAddress is deterministic', () => {
    const h1 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'players');
    const h2 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'players');
    assert.equal(h1, h2);
  });

  it('different namespace → different hash', () => {
    const h1 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'players');
    const h2 = hashAddress('other', DIM.PLANE, 1.5, 2.3, 'players');
    assert.notEqual(h1, h2);
  });

  it('different dim → different hash', () => {
    const h1 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'players');
    const h2 = hashAddress('kensgames', DIM.STACK, 1.5, 2.3, 'players');
    assert.notEqual(h1, h2);
  });

  it('different key → different hash', () => {
    const h1 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'players');
    const h2 = hashAddress('kensgames', DIM.PLANE, 1.5, 2.3, 'scores');
    assert.notEqual(h1, h2);
  });

  it('hash is a 64-char hex string (SHA-256)', () => {
    const h = hashAddress('kensgames', DIM.PLANE, 1.0, 2.0, 'test');
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A11. NEIGHBOR TOPOLOGY — topology public, content private
// ─────────────────────────────────────────────────────────────────────────────
describe('A11 — Neighbor topology: 6 neighbors, all on surface', () => {
  const gx = 1.0, gy = 1.5;
  const gz = projectToSurface(gx, gy).gz;

  it('returns exactly 6 neighbors', () => {
    const neighbors = neighborAddresses(gx, gy, gz);
    assert.equal(neighbors.length, 6);
  });

  it('each neighbor is on the gyroid surface', () => {
    const neighbors = neighborAddresses(gx, gy, gz);
    for (const n of neighbors) {
      const residual = Math.abs(gyroid(n.gx, n.gy, n.gz));
      assert.ok(residual < 0.05,
        `neighbor (dir=${n.direction}) residual ${residual} should be < 0.05`);
    }
  });

  it('directions are the 6 cardinal axes: x+,x-,y+,y-,z+,z-', () => {
    const neighbors = neighborAddresses(gx, gy, gz);
    const dirs = neighbors.map(n => n.direction).sort();
    assert.deepEqual(dirs, ['x+', 'x-', 'y+', 'y-', 'z+', 'z-']);
  });

  it('neighbor objects contain only addresses (gx,gy,gz,direction) — no data', () => {
    const neighbors = neighborAddresses(gx, gy, gz);
    for (const n of neighbors) {
      const keys = Object.keys(n).sort();
      assert.deepEqual(keys, ['direction', 'gx', 'gy', 'gz']);
    }
  });

  it('geodesicDistance between point and its neighbor is > 0', () => {
    const neighbors = neighborAddresses(gx, gy, gz);
    for (const n of neighbors) {
      const d = geodesicDistance({ gx, gy, gz }, n);
      assert.ok(d > 0, `zero distance to neighbor in direction ${n.direction}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A12. KNOCK PROTOCOL — topology public, content private
// ─────────────────────────────────────────────────────────────────────────────
describe('A12 — Knock protocol: nonce uniqueness, structure correctness', () => {
  const [ax, ay, az] = [1.0, 1.5, projectToSurface(1.0, 1.5).gz];
  const [bx, by, bz] = [1.3, 1.5, projectToSurface(1.3, 1.5).gz];

  it('knock token is a 64-char hex SHA-256', () => {
    const { knock } = knockNeighbor(ax, ay, az, bx, by, bz);
    assert.match(knock, /^[0-9a-f]{64}$/);
  });

  it('nonce is a 32-char hex random value', () => {
    const { nonce } = knockNeighbor(ax, ay, az, bx, by, bz);
    assert.match(nonce, /^[0-9a-f]{32}$/);
  });

  it('two knocks to the same neighbor produce different tokens (nonce uniqueness)', () => {
    const k1 = knockNeighbor(ax, ay, az, bx, by, bz).knock;
    const k2 = knockNeighbor(ax, ay, az, bx, by, bz).knock;
    assert.notEqual(k1, k2, 'nonce must make each knock unique');
  });

  it('result contains from and to address objects (no content)', () => {
    const result = knockNeighbor(ax, ay, az, bx, by, bz);
    assert.ok('from' in result && 'to' in result);
    assert.ok('gx' in result.from && 'gy' in result.from && 'gz' in result.from);
    assert.ok('gx' in result.to && 'gy' in result.to && 'gz' in result.to);
    // Must NOT contain any data field
    assert.equal(result.data, undefined);
    assert.equal(result.content, undefined);
    assert.equal(result.value, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A13. GYROID SURFACE EQUATION — manual verification
// ─────────────────────────────────────────────────────────────────────────────
describe('A13 — Gyroid equation is F = sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)', () => {
  it('matches manual computation at several known points', () => {
    const cases = [
      { x: 0, y: 0, z: 0, expected: 0 },
      { x: Math.PI / 2, y: 0, z: 0, expected: 1 },
      { x: 0, y: Math.PI / 2, z: 0, expected: 1 },
      { x: Math.PI, y: Math.PI, z: Math.PI, expected: 0 },
    ];
    for (const { x, y, z, expected } of cases) {
      const manual =
        Math.sin(x) * Math.cos(y) +
        Math.sin(y) * Math.cos(z) +
        Math.sin(z) * Math.cos(x);
      const fn = gyroid(x, y, z);
      assert.ok(Math.abs(fn - manual) < EPSILON,
        `gyroid(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}): fn=${fn} vs manual=${manual}`);
      assert.ok(Math.abs(fn - expected) < EPSILON,
        `expected ${expected}, got ${fn}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A14. DOMAIN ALIAS MAPPING — geometry: vertex→edge→face→layers→mesh→object
// ─────────────────────────────────────────────────────────────────────────────
describe('A14 — Domain alias: 3D mesh maps D1→D2→D4→D5→D6→D7', () => {
  it('vertex = POINT (D1): a single coordinate', () => {
    assert.equal(classifyValue(42), DIM.POINT);           // bare number = coordinate
    assert.equal(classifyValue('v1'), DIM.POINT);          // vertex identifier
  });

  it('edge = LINE (D2): array of two vertex references', () => {
    assert.equal(classifyValue(['v1', 'v2']), DIM.LINE);
  });

  it('face = PLANE (D4): array of vertex objects (polygon)', () => {
    assert.equal(
      classifyValue([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]),
      DIM.PLANE
    );
  });

  it('layers = STACK (D5): delta-sequenced frames', () => {
    assert.equal(classifyValue({ seq: 1, vertices: [1, 2, 3] }), DIM.STACK);
  });

  it('mesh body = VOLUME (D6): collection of cells/frames', () => {
    assert.equal(classifyValue({ cells: [[0, 1, 2], [1, 2, 3]] }), DIM.VOLUME);
  });

  it('object = M (D7): discrete whole with identity', () => {
    assert.equal(classifyValue({ volume: [[0, 1, 2]], namespaces: ['mesh1'] }), DIM.M);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A15. O(1) SCOPE CHANGE — namespace IS the coordinate space
// ─────────────────────────────────────────────────────────────────────────────
describe('A15 — O(1) scope change: namespace change = coordinate space change', () => {
  it('addressToGyroid produces different gx for different namespaces', () => {
    const a = addressToGyroid('kensgames', 'players');
    const b = addressToGyroid('othergame', 'players');
    assert.notEqual(a.gx, b.gx,
      'different namespace must produce different gyroid coordinate');
  });

  it('same namespace+table always lands on the same coordinate (deterministic)', () => {
    const a = addressToGyroid('kensgames', 'players');
    const b = addressToGyroid('kensgames', 'players');
    assert.equal(a.gx, b.gx);
    assert.equal(a.gy, b.gy);
  });

  it('different table within same namespace produces different gy', () => {
    const a = addressToGyroid('kensgames', 'players');
    const b = addressToGyroid('kensgames', 'scores');
    assert.notEqual(a.gy, b.gy);
  });

  it('gz = gx * gy (Relation Surface seed)', () => {
    const { gx, gy, gz } = addressToGyroid('kensgames', 'scores');
    assert.ok(Math.abs(gz - gx * gy) < EPSILON,
      `gz=${gz} should equal gx*gy=${gx * gy}`);
  });

  it('scope change is O(1): no traversal required — just recompute address', () => {
    // Demonstrate: entering "kensgames/players" from "kensgames" requires
    // only addressToGyroid('kensgames','players') — one hash, no iteration.
    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      addressToGyroid('kensgames', 'players');
    }
    const elapsed = Date.now() - start;
    // 10,000 address computations must complete in < 500ms on any hardware
    assert.ok(elapsed < 500,
      `10k addressToGyroid calls took ${elapsed}ms — should be < 500ms`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A16. ADDITIVE / MULTIPLICATIVE PATTERN
// ─────────────────────────────────────────────────────────────────────────────
describe('A16 — Additive/Multiplicative: add·add·MUL·add·add·MUL', () => {
  it('DIM_MODE has 8 entries', () => {
    assert.equal(DIM_MODE.length, 8);
  });

  it('LINE and WIDTH are both additive — addition has no preferred axis', () => {
    assert.equal(DIM_MODE[DIM.LINE], 'add');
    assert.equal(DIM_MODE[DIM.WIDTH], 'add');
  });

  it('LINE has fib=1 and WIDTH has fib=2 (both additive but distinct positions)', () => {
    assert.equal(DIM_FIB[DIM.LINE], 1);
    assert.equal(DIM_FIB[DIM.WIDTH], 2);
  });

  it('PLANE is multiplicative — first axis crossing x·y', () => {
    assert.equal(DIM_MODE[DIM.PLANE], 'mul');
  });

  it('STACK and VOLUME are additive — plane + plane + plane...', () => {
    assert.equal(DIM_MODE[DIM.STACK], 'add');
    assert.equal(DIM_MODE[DIM.VOLUME], 'add');
  });

  it('M is multiplicative — second axis crossing x·y·z (full 3D object)', () => {
    assert.equal(DIM_MODE[DIM.M], 'mul');
  });

  it('only two multiplicative dimensions: D4 PLANE and D7 M', () => {
    const mulDims = DIM_MODE
      .map((mode, d) => ({ d, mode }))
      .filter(({ mode }) => mode === 'mul')
      .map(({ d }) => d);
    assert.deepEqual(mulDims, [DIM.PLANE, DIM.M]);
  });

  it('the pattern is: [void, point, add, add, MUL, add, add, MUL]', () => {
    assert.deepEqual(Array.from(DIM_MODE), [
      'void', 'point', 'add', 'add', 'mul', 'add', 'add', 'mul'
    ]);
  });

  it('z = x·y encodes PLANE as the product of the two additive axes', () => {
    // A LINE of 3 and a WIDTH of 4 multiply to a PLANE of 12
    const line = 3, width = 4;
    const plane = relationSurface(line, width);
    assert.equal(plane, 12);
    // That plane value classifies as POINT (a scalar) — ready to be stacked
    assert.equal(classifyValue(plane), DIM.POINT);
  });

  it('VOLUME is additive stacking — but z=xy warp twists the stack into a saddle', () => {
    // A stack of planes along z where z = x*y is NOT a flat cube;
    // it is a twisted surface. Verify: a point at (2,3) → z=6, F≠0 (not on gyroid);
    // project it and the resulting gz ≠ 6 (the warp has moved it)
    const [x, y] = [2, 3];
    const zFlat = relationSurface(x, y);  // 6 — the unsaddle / flat z
    const { gz: zWarped } = projectToSurface(x, y, zFlat);
    // The gyroid projects to a different z — proving the saddle warp
    assert.ok(Math.abs(zWarped - zFlat) > EPSILON,
      `gyroid projection (${zWarped.toFixed(4)}) should differ from flat z=x·y (${zFlat})`);
  });
});
