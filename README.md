# KASTLR Veto Service

Standalone map-veto engine. Runs as its own Railway service with its own
Supabase project. **Not** part of the main `kastlr-comp-za` repo or
deployment — it can go down, scale, or get rebuilt independently without
touching the league platform.

## Deployment (new, separate from existing infra)

1. New GitHub repo: `kasltrapp/kastlr-veto` (or similar — separate from `KASTLR-Client`).
2. New Railway service (new project, or new service within the same Railway
   org — but its own deploy, its own env vars, its own domain).
3. New Supabase project — run `migrations/001_veto_system.sql` against it.
   Do not point this at the existing KASTLR Supabase project.
4. Env vars on the Railway service (already configured):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_SECRET` — shared with the main platform under a distinct var name
     there (e.g. `VETO_ADMIN_SECRET`) for sanctioned-session handoff only.
     Not the same secret as the main platform's own `ADMIN_SECRET` — same
     name here by convenience, unrelated purpose, don't cross-wire the two.
   - `SITE_URL` — origin only, e.g. `https://kastlr.co.za` (no path)

## The one integration point with the main platform

This service never queries the main KASTLR Supabase project or calls the
main platform's API. The only thing that crosses the boundary is a signed,
short-lived **handoff token**, minted by the *main platform* when a captain
starts a veto for a KASTLR-sanctioned match.

Add this small utility to the main platform (does not require pulling in
this service's code — just mirrors `handoffToken.js`'s `sign()` logic with
the shared secret, stored on the main platform as `VETO_ADMIN_SECRET`):

```js
// main platform: lib/vetoHandoff.js (illustrative — adapt to existing conventions)
const crypto = require('crypto');
function signVetoHandoff({ matchId, team, steamId }) {
  const payload = Buffer.from(JSON.stringify({
    matchId, team, steamId, issuedAt: Math.floor(Date.now() / 1000),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.VETO_ADMIN_SECRET)
    .update(payload).digest('hex');
  return `${payload}.${sig}`;
}
```

The admin panel's "Start Veto" button (for sanctioned matches only) calls
this, then redirects the captain to:
`https://kastlr.co.za/veto/session?handoff=<token>&api=<veto-service-url>`

## Frontend

Not built yet (next step). Plan: a small static bundle hosted at
`kastlr.co.za/veto/*` on the existing DirectAdmin hosting, sharing the main
site's CSS for visual consistency, calling this service's API directly
(cross-origin, per `VETO_ALLOWED_ORIGINS`). No server-side rendering
dependency on the main Node app.

## Files in this scratch build

- `migrations/001_veto_system.sql` — schema for the standalone Supabase project
- `vetoEngine.js` — pure ruleset/structure engine (bo1/2/3/5, Standard + EPT
  structures), hash-chained tamper-evident action ledger
- `vetoTokens.js` — anonymous captain/spectator link tokens (public sessions)
- `handoffToken.js` — the one verified seam with the main platform (sanctioned sessions)
- `supabaseClient.js` — client for this service's own Supabase project
- `vetoRoutes.js` — Express API (session create, action submit, coinflip, public results ledger)
- `vetoSockets.js` — socket.io room wiring for real-time captain/spectator sync
- `server.js` — app entry point, CORS allow-list, rate limiting
