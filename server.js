/**
 * KASTLR Veto Service
 * Standalone Node/Express + socket.io app. Deployed as its own Railway
 * service, with its own Supabase project. Does not import from, or get
 * imported by, the main KASTLR platform repo.
 *
 * Required env vars (as configured in Railway):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_SECRET             (shared with main platform, for sanctioned sessions only)
 *   SITE_URL                 (origin only, e.g. "https://kastlr.co.za" — NOT a path)
 *   PORT                     (Railway sets this automatically)
 */

'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server: SocketIOServer } = require('socket.io');

const vetoRoutes = require('./vetoRoutes');
const attachVetoSockets = require('./vetoSockets');

const app = express();
const server = http.createServer(app);

// SITE_URL should be an origin (scheme + host [+ port]) with no path —
// browsers never send a path in the Origin header, so a value like
// "https://kastlr.co.za/veto" would never match and silently break CORS
// for legitimate requests from your own site. Normalize defensively here
// in case it's ever set with a trailing path.
function toOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const allowedOrigins = (process.env.SITE_URL || '')
  .split(',')
  .map((o) => toOrigin(o.trim()))
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('WARNING: no valid origins parsed from SITE_URL — all cross-origin requests will be rejected');
}

const corsOptions = {
  origin(origin, callback) {
    // Allow no-origin requests (e.g. server-to-server, curl) and any listed origin.
    // Public embeds from third-party leagues should be added to this list explicitly
    // as they're onboarded — not wildcarded, so embed abuse stays auditable.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by veto-service CORS policy'));
  },
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// Public session creation is the main abuse surface — separate, tighter limiter.
const createSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 new sessions per IP per 15 min is generous for legitimate use, blocks spam farms
  standardHeaders: true,
  legacyHeaders: false,
});

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/veto', globalLimiter);
app.use('/api/veto/sessions', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/') return createSessionLimiter(req, res, next);
  next();
});

app.use('/api/veto', vetoRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'kastlr-veto' }));

const io = new SocketIOServer(server, {
  cors: corsOptions,
});
app.set('io', io);
attachVetoSockets(io);

const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log(`KASTLR Veto Service listening on port ${PORT}`);
});
