/**
 * KASTLR Veto Service — socket.io wiring
 * One room per session ("veto:{sessionId}"). Clients join after resolving
 * their token via GET /api/veto/sessions/token/:token. All state changes
 * are pushed by vetoRoutes.js via req.app.get('io'); this file only owns
 * connection/room lifecycle.
 */

'use strict';

function attachVetoSockets(io) {
  io.on('connection', (socket) => {
    socket.on('veto:join', ({ sessionId }) => {
      if (!sessionId) return;
      socket.join(`veto:${sessionId}`);
    });

    socket.on('veto:leave', ({ sessionId }) => {
      if (!sessionId) return;
      socket.leave(`veto:${sessionId}`);
    });
  });
}

module.exports = attachVetoSockets;
