'use strict';

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateSessionTokens() {
  return {
    teamAToken: generateToken(),
    teamBToken: generateToken(),
    spectatorToken: generateToken(),
  };
}

module.exports = { generateToken, generateSessionTokens };
