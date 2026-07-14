/**
 * KASTLR Veto Service — handoff token verification
 *
 * This is the single, deliberate seam between the main KASTLR platform and
 * this standalone service. The main app (Railway, existing repo) mints one
 * of these when an admin/captain starts a veto for a KASTLR-sanctioned
 * match, and passes it as a URL param into this service's frontend.
 *
 * This service ONLY verifies the signature — it never calls back into the
 * main platform's API or database. If the signature and expiry check out,
 * the claims inside are trusted as-is.
 *
 * Shared secret: ADMIN_SECRET env var on THIS service, set identically on
 * the main platform's Railway service as well (as its own separate env var,
 * even though it happens to share the same name — the two are unrelated
 * secrets on unrelated services; only the value that gets copied across
 * both matters). Rotate by updating both env vars together.
 *
 * Token format: base64url(JSON payload) + "." + hmac-sha256 signature (hex)
 * Deliberately not a full JWT library dependency — this is a narrow,
 * single-purpose token and a minimal implementation is easier to audit.
 */

'use strict';

const crypto = require('crypto');

const SECRET = process.env.ADMIN_SECRET;
const MAX_AGE_SECONDS = 5 * 60; // handoff tokens are single-use-intent, short-lived

if (!SECRET) {
  // Fail loudly at boot rather than silently accepting unverifiable tokens later
  throw new Error('ADMIN_SECRET env var is required for veto-service to start');
}

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verify a handoff token. Returns the decoded claims object if valid,
 * or throws with a descriptive reason if not.
 *
 * Expected claims shape:
 * { matchId: string, team: 'team_a'|'team_b', steamId: string, issuedAt: number (unix seconds) }
 */
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Malformed handoff token');
  }
  const [payload, sig] = token.split('.');

  // Buffer.from(str, 'hex') silently truncates at the first invalid hex
  // character instead of throwing — so a malformed/tampered sig with a
  // valid-hex prefix followed by garbage would otherwise decode to the
  // same bytes as a shorter valid signature. Reject anything that isn't
  // exactly 64 lowercase hex characters (sha256 hex digest length) before
  // ever touching Buffer.from.
  if (!/^[0-9a-f]{64}$/.test(sig || '')) {
    throw new Error('Invalid handoff token signature');
  }

  const expectedSig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid handoff token signature');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed handoff token payload');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!claims.issuedAt || nowSeconds - claims.issuedAt > MAX_AGE_SECONDS) {
    throw new Error('Handoff token expired');
  }
  if (!claims.matchId || !claims.team || !claims.steamId) {
    throw new Error('Handoff token missing required claims');
  }

  return claims;
}

module.exports = { sign, verify, MAX_AGE_SECONDS };
