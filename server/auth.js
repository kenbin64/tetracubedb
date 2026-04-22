/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TETRACUBEDB — AUTHENTICATION MIDDLEWARE
 * ═══════════════════════════════════════════════════════════════════════════════
 * Bearer token: Authorization: Bearer <client_id>:<api_key>
 * ═══════════════════════════════════════════════════════════════════════════════
 */
'use strict';

const { verifyClient } = require('./store');

/**
 * Parse "Bearer <client_id>:<api_key>" from Authorization header.
 */
function parseBearer(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const colon = token.indexOf(':');
  if (colon < 1) return null;
  return {
    client_id: token.slice(0, colon),
    api_key: token.slice(colon + 1),
  };
}

/**
 * Middleware: authenticate and attach client to req.client
 */
async function requireAuth(req, res, next) {
  const creds = parseBearer(req);
  if (!creds) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const client = await verifyClient(creds.client_id, creds.api_key);
    if (!client) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.client = client;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Auth error' });
  }
}

/**
 * Middleware: require admin flag
 */
function requireAdmin(req, res, next) {
  if (!req.client || !req.client.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Check that client has access to the requested namespace.
 */
function checkNamespace(client, namespace) {
  if (!client) return false;
  if (client.namespaces.includes('*')) return true;
  return client.namespaces.includes(namespace);
}

module.exports = { requireAuth, requireAdmin, checkNamespace };
