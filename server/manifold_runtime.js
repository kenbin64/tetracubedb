/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — MANIFOLD-FIRST RUNTIME BASE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module establishes the additive base structure for a manifold-first
 * processor without changing live server behavior yet.
 *
 * Purpose:
 *   - Define canonical manifold object envelopes
 *   - Normalize and validate dimensional metadata
 *   - Build commit / reconcile / session envelopes
 *   - Provide request validators for future authoritative routes
 *
 * This is intentionally domain-neutral. `kensgames.com` is one substrate/client
 * of the manifold; this module defines the authoritative shapes that substrate
 * clients should eventually speak to on `tetracubedb.com`.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const crypto = require('crypto');
const gyroid = require('./gyroid_core');

const DEFAULT_NAMESPACE = 'global';

const MANIFOLD_OBJECT_TYPES = Object.freeze({
  OBJECT: 'object',
  GAME_DEFINITION: 'game_definition',
  SESSION: 'session',
  PLAYER: 'player',
  MOVE: 'move',
  BOARD_STATE: 'board_state',
  UI_STATE: 'ui_state',
  FUNCTION: 'function',
  LENS: 'lens',
  TRANSITION: 'transition',
  COMMIT: 'commit',
});

const MANIFOLD_LENSES = Object.freeze({
  IDENTITY: 'identity',
  LOGIC: 'logic',
  FLOW: 'flow',
  STATE: 'state',
  UI: 'ui',
  SOUND: 'sound',
  COLOR: 'color',
  COMPILED: 'compiled',
});

const REQUIRED_DIMENSIONAL_FIELDS = Object.freeze([
  'level',
  'x',
  'y',
  'z_axis',
  'plane',
  'volume',
  'theta_deg',
  'fib_scale',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFiniteNumber(value, fallback = 0) {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toInteger(value, fallback = 0) {
  const num = toFiniteNumber(value, fallback);
  return Number.isInteger(num) ? num : Math.trunc(num);
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const sortedKeys = Object.keys(value).sort();
  return `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function inferFibScale(level) {
  return gyroid.DIM_FIB[level] !== undefined ? gyroid.DIM_FIB[level] : gyroid.DIM_FIB[gyroid.DIM.M];
}

function normalizeDimensionalMetadata(metadata = {}) {
  const level = Math.max(0, Math.min(toInteger(metadata.level, gyroid.DIM.M), gyroid.DIM.M));

  const x = toFiniteNumber(metadata.x, 0);
  const y = toFiniteNumber(metadata.y, 0);
  const zAxis = toFiniteNumber(
    metadata.z_axis,
    isFiniteNumber(metadata.zAxis) ? metadata.zAxis : gyroid.relationSurface(x, y)
  );

  const plane = normalizeString(metadata.plane, `plane:${level}`);
  const volume = normalizeString(metadata.volume, `volume:${level}`);
  const thetaDeg = toFiniteNumber(
    metadata.theta_deg,
    isFiniteNumber(metadata.thetaDeg) ? metadata.thetaDeg : 0
  );
  const fibScale = toFiniteNumber(metadata.fib_scale, inferFibScale(level));

  const projected = gyroid.projectToSurface(x, y, zAxis);

  return {
    level,
    x,
    y,
    z_axis: zAxis,
    plane,
    volume,
    theta_deg: thetaDeg,
    fib_scale: fibScale,
    relation_z: gyroid.relationSurface(x, y),
    surface_z: projected.gz,
    on_surface: projected.onSurface,
    surface_residual: projected.residual,
    surface_iterations: projected.iterations,
  };
}

function validateDimensionalMetadata(metadata) {
  const errors = [];

  if (!isPlainObject(metadata)) {
    return {
      ok: false,
      errors: ['dimensional_metadata must be an object'],
      normalized: null,
    };
  }

  for (const field of REQUIRED_DIMENSIONAL_FIELDS) {
    if (!(field in metadata)) {
      errors.push(`dimensional_metadata.${field} is required`);
    }
  }

  const normalized = normalizeDimensionalMetadata(metadata);

  if (normalized.level < gyroid.DIM.VOID || normalized.level > gyroid.DIM.M) {
    errors.push(`dimensional_metadata.level must be between ${gyroid.DIM.VOID} and ${gyroid.DIM.M}`);
  }

  if (!Number.isFinite(normalized.fib_scale) || normalized.fib_scale < 0) {
    errors.push('dimensional_metadata.fib_scale must be a finite non-negative number');
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized,
  };
}

function canonicalPayloadFingerprint(payload) {
  return sha256(stableStringify(payload));
}

function canonicalMetadataFingerprint(dimensionalMetadata) {
  return sha256(stableStringify(dimensionalMetadata));
}

function computeObjectId({
  namespace = DEFAULT_NAMESPACE,
  type = MANIFOLD_OBJECT_TYPES.OBJECT,
  payload = null,
  dimensional_metadata = {},
  identity = {},
}) {
  return sha256([
    namespace,
    type,
    canonicalPayloadFingerprint(payload),
    canonicalMetadataFingerprint(dimensional_metadata),
    stableStringify(identity),
  ].join(':'));
}

function normalizeLenses(lenses) {
  if (!Array.isArray(lenses) || lenses.length === 0) {
    return [MANIFOLD_LENSES.IDENTITY];
  }

  const unique = new Set();

  for (const lens of lenses) {
    const normalized = normalizeString(lens);
    if (normalized) unique.add(normalized);
  }

  return unique.size > 0 ? Array.from(unique) : [MANIFOLD_LENSES.IDENTITY];
}

function buildManifoldObject(input = {}) {
  const namespace = normalizeString(input.namespace, DEFAULT_NAMESPACE);
  const type = normalizeString(input.type, MANIFOLD_OBJECT_TYPES.OBJECT);
  const payload = input.payload === undefined ? null : input.payload;
  const identity = isPlainObject(input.identity) ? input.identity : {};
  const lensVector = normalizeLenses(input.lenses);
  const metadataValidation = validateDimensionalMetadata(input.dimensional_metadata || {});

  if (!metadataValidation.ok) {
    const error = new Error(`Invalid dimensional metadata: ${metadataValidation.errors.join('; ')}`);
    error.code = 'INVALID_DIMENSIONAL_METADATA';
    error.details = metadataValidation.errors;
    throw error;
  }

  const dimensionalMetadata = metadataValidation.normalized;
  const ts = toFiniteNumber(input.ts_authoritative, Date.now());
  const objectId = normalizeString(
    input.object_id,
    computeObjectId({
      namespace,
      type,
      payload,
      dimensional_metadata: dimensionalMetadata,
      identity,
    })
  );

  return {
    object_id: objectId,
    namespace,
    type,
    identity,
    lenses: lensVector,
    payload,
    dimensional_metadata: dimensionalMetadata,
    geometry: {
      gx: dimensionalMetadata.x,
      gy: dimensionalMetadata.y,
      gz_relation: dimensionalMetadata.relation_z,
      gz_surface: dimensionalMetadata.surface_z,
      on_surface: dimensionalMetadata.on_surface,
      surface_residual: dimensionalMetadata.surface_residual,
    },
    dimension: {
      level: dimensionalMetadata.level,
      name: gyroid.DIM_NAMES[dimensionalMetadata.level] || 'unknown',
      fib_scale: dimensionalMetadata.fib_scale,
    },
    commit_horizon: normalizeString(input.commit_horizon, ''),
    ts_authoritative: ts,
    created_at: toFiniteNumber(input.created_at, ts),
    updated_at: ts,
  };
}

function buildCommitEnvelope(input = {}) {
  const object = input.object || buildManifoldObject(input);
  const strict = input.strict !== false;
  const tsAuthoritative = toFiniteNumber(input.ts_authoritative, Date.now());

  const commitId = normalizeString(
    input.commit_id,
    sha256([
      object.object_id,
      tsAuthoritative,
      canonicalPayloadFingerprint(object.payload),
      canonicalMetadataFingerprint(object.dimensional_metadata),
    ].join(':'))
  );

  return {
    success: true,
    strict,
    commit_id: commitId,
    object_id: object.object_id,
    namespace: object.namespace,
    type: object.type,
    dimensional_metadata: object.dimensional_metadata,
    ts_authoritative: tsAuthoritative,
    committed: true,
  };
}

function buildStrictError(error, detail, extra = {}) {
  return {
    success: false,
    error,
    detail,
    strict: true,
    ...extra,
  };
}

function buildExecutionEnvelope(input = {}) {
  return {
    namespace: normalizeString(input.namespace, DEFAULT_NAMESPACE),
    function_id: normalizeString(input.function_id, ''),
    gyroid_address: isPlainObject(input.gyroid_address) ? input.gyroid_address : null,
    lens: normalizeString(input.lens, MANIFOLD_LENSES.LOGIC),
    input: input.input === undefined ? null : input.input,
    ts_requested: toFiniteNumber(input.ts_requested, Date.now()),
  };
}

function buildReconcileEnvelope(input = {}) {
  return {
    namespace: normalizeString(input.namespace, DEFAULT_NAMESPACE),
    session_id: normalizeString(input.session_id, ''),
    client_commit_horizon: normalizeString(input.client_commit_horizon, ''),
    authoritative_commit_horizon: normalizeString(input.authoritative_commit_horizon, ''),
    reconcile_required: input.client_commit_horizon !== input.authoritative_commit_horizon,
    ts_authoritative: toFiniteNumber(input.ts_authoritative, Date.now()),
  };
}

function buildSessionEnvelope(sessionId, object, extra = {}) {
  return {
    session_id: normalizeString(sessionId, object && object.object_id ? object.object_id : ''),
    object_id: object ? object.object_id : '',
    namespace: object ? object.namespace : DEFAULT_NAMESPACE,
    type: object ? object.type : MANIFOLD_OBJECT_TYPES.SESSION,
    state: extra.state === undefined ? (object ? object.payload : null) : extra.state,
    dimensional_metadata: object ? object.dimensional_metadata : normalizeDimensionalMetadata({}),
    lenses: object ? object.lenses : [MANIFOLD_LENSES.STATE],
    ts_authoritative: toFiniteNumber(extra.ts_authoritative, Date.now()),
  };
}

function validateCommitRequest(body = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be an object'], normalized: null };
  }

  if (!isPlainObject(body.dimensional_metadata)) {
    errors.push('dimensional_metadata is required');
  }

  const type = normalizeString(body.type, MANIFOLD_OBJECT_TYPES.OBJECT);
  const namespace = normalizeString(body.namespace, DEFAULT_NAMESPACE);

  if (!type) errors.push('type is required');

  let normalized = null;

  if (errors.length === 0) {
    try {
      normalized = {
        namespace,
        type,
        payload: body.payload === undefined ? null : body.payload,
        identity: isPlainObject(body.identity) ? body.identity : {},
        lenses: normalizeLenses(body.lenses),
        dimensional_metadata: normalizeDimensionalMetadata(body.dimensional_metadata),
        strict: body.strict !== false,
        object_id: normalizeString(body.object_id, ''),
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (isPlainObject(body.dimensional_metadata)) {
    const metadataCheck = validateDimensionalMetadata(body.dimensional_metadata);
    if (!metadataCheck.ok) {
      errors.push(...metadataCheck.errors);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized,
  };
}

function validateExecutionRequest(body = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be an object'], normalized: null };
  }

  const functionId = normalizeString(body.function_id);
  if (!functionId) errors.push('function_id is required');

  const normalized = {
    namespace: normalizeString(body.namespace, DEFAULT_NAMESPACE),
    function_id: functionId,
    gyroid_address: isPlainObject(body.gyroid_address) ? body.gyroid_address : null,
    lens: normalizeString(body.lens, MANIFOLD_LENSES.LOGIC),
    input: body.input === undefined ? null : body.input,
  };

  return {
    ok: errors.length === 0,
    errors,
    normalized,
  };
}

function validateReconcileRequest(body = {}) {
  const errors = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['request body must be an object'], normalized: null };
  }

  const normalized = {
    namespace: normalizeString(body.namespace, DEFAULT_NAMESPACE),
    session_id: normalizeString(body.session_id, ''),
    client_commit_horizon: normalizeString(body.client_commit_horizon, ''),
    authoritative_commit_horizon: normalizeString(body.authoritative_commit_horizon, ''),
  };

  if (!normalized.session_id) errors.push('session_id is required');

  return {
    ok: errors.length === 0,
    errors,
    normalized,
  };
}

module.exports = {
  DEFAULT_NAMESPACE,
  MANIFOLD_OBJECT_TYPES,
  MANIFOLD_LENSES,
  REQUIRED_DIMENSIONAL_FIELDS,
  normalizeDimensionalMetadata,
  validateDimensionalMetadata,
  canonicalPayloadFingerprint,
  canonicalMetadataFingerprint,
  computeObjectId,
  buildManifoldObject,
  buildCommitEnvelope,
  buildStrictError,
  buildExecutionEnvelope,
  buildReconcileEnvelope,
  buildSessionEnvelope,
  validateCommitRequest,
  validateExecutionRequest,
  validateReconcileRequest,
};
