/**
 * KASTLR Veto Service — API routes
 *
 * Two entry paths into the same engine:
 *  - Sanctioned:  session created with a verified handoff token (from the
 *                 main KASTLR platform). Captain identity comes from the
 *                 token's claims, not from any login this service manages.
 *  - Public:      session created anonymously. Captain identity is just
 *                 "whoever holds the link" — that's the entire point of
 *                 the free/frictionless tool.
 *
 * This module never talks to the main KASTLR platform's database or API.
 */

'use strict';

const express = require('express');
const supabase = require('./supabaseClient');
const vetoEngine = require('./vetoEngine');
const handoffToken = require('./handoffToken');
const { generateSessionTokens } = require('./vetoTokens');

const router = express.Router();

// --- Helpers ---------------------------------------------------------------

async function getActivePool(game) {
  const { data, error } = await supabase
    .from('veto_pool_templates')
    .select('*')
    .eq('game', game)
    .eq('is_active', true)
    .single();
  if (error || !data) throw new Error(`No active map pool configured for game "${game}"`);
  return data;
}

async function loadSession(sessionId) {
  const { data, error } = await supabase
    .from('veto_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (error || !data) throw new Error('Session not found');
  return data;
}

async function loadActions(sessionId) {
  const { data, error } = await supabase
    .from('veto_actions')
    .select('*')
    .eq('session_id', sessionId)
    .order('sequence_no', { ascending: true });
  if (error) throw new Error('Failed to load session actions');
  return data || [];
}

function resolveActorFromToken(session, token) {
  if (token === session.team_a_token) return 'team_a';
  if (token === session.team_b_token) return 'team_b';
  if (token === session.spectator_token) return 'spectator';
  return null;
}

async function appendAction(session, { actor, actionType, map, side, steamId }) {
  const actions = await loadActions(session.id);
  const sequenceNo = actions.length;
  const prevActionHash = actions.length ? actions[actions.length - 1].action_hash : null;
  const actionHash = vetoEngine.computeActionHash({
    sessionId: session.id,
    sequenceNo,
    actor,
    actionType,
    map,
    side,
    prevActionHash,
  });

  const { data, error } = await supabase
    .from('veto_actions')
    .insert({
      session_id: session.id,
      sequence_no: sequenceNo,
      actor,
      action_type: actionType,
      map: map || null,
      side: side || null,
      steam_id: steamId || null,
      prev_action_hash: prevActionHash,
      action_hash: actionHash,
    })
    .select()
    .single();

  if (error) throw new Error('Failed to write veto action');
  return data;
}

// --- Routes ------------------------------------------------------------

/**
 * Create a new veto session.
 * Public: body = { ruleset, structure, timerSeconds, teamAName, teamBName, game }
 * Sanctioned: body additionally includes { handoffToken, matchId } — this service
 * verifies the token independently; it does not fetch anything from KASTLR's platform.
 */
router.post('/sessions', async (req, res) => {
  try {
    const {
      ruleset, structure = 'standard', timerSeconds = 25,
      teamAName, teamBName, game = 'cs2',
      handoffToken: rawHandoffToken,
    } = req.body;

    if (!['bo1', 'bo2', 'bo3', 'bo5'].includes(ruleset)) {
      return res.status(400).json({ error: 'Invalid ruleset' });
    }
    if (!vetoEngine.isValidTimer(timerSeconds)) {
      return res.status(400).json({ error: 'Invalid timer (must be 25, 30, or 60)' });
    }
    vetoEngine.getSteps(ruleset, structure); // throws if structure invalid for this ruleset
    if (!teamAName || !teamBName) {
      return res.status(400).json({ error: 'Both team names are required' });
    }

    const pool = await getActivePool(game);
    const tokens = generateSessionTokens();

    let isKastlrSanctioned = false;
    let kastlrMatchId = null;
    let teamASteamId = null;
    let teamBSteamId = null;
    let expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h TTL for public sessions

    if (rawHandoffToken) {
      // Sanctioned session — verify signature, trust claims, no callback to main platform
      const claims = handoffToken.verify(rawHandoffToken);
      isKastlrSanctioned = true;
      kastlrMatchId = claims.matchId;
      expiresAt = null; // sanctioned sessions don't expire
      if (claims.team === 'team_a') teamASteamId = claims.steamId;
      if (claims.team === 'team_b') teamBSteamId = claims.steamId;
    }

    const { data: session, error } = await supabase
      .from('veto_sessions')
      .insert({
        is_kastlr_sanctioned: isKastlrSanctioned,
        kastlr_match_id: kastlrMatchId,
        pool_template_id: pool.id,
        ruleset,
        veto_structure: structure,
        team_a_name: teamAName,
        team_b_name: teamBName,
        team_a_token: tokens.teamAToken,
        team_b_token: tokens.teamBToken,
        spectator_token: tokens.spectatorToken,
        team_a_steam_id: teamASteamId,
        team_b_steam_id: teamBSteamId,
        timer_seconds: timerSeconds,
        status: 'pending',
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      sessionId: session.id,
      teamALink: `/veto/session/${tokens.teamAToken}`,
      teamBLink: `/veto/session/${tokens.teamBToken}`,
      spectatorLink: `/veto/session/${tokens.spectatorToken}`,
      resultsLink: `/veto/results/${session.id}`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Resolve a captain/spectator token into full session state + the engine's
 * computed next step. This is what the frontend polls/subscribes to.
 */
router.get('/sessions/token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { data: session, error } = await supabase
      .from('veto_sessions')
      .select('*')
      .or(`team_a_token.eq.${token},team_b_token.eq.${token},spectator_token.eq.${token}`)
      .single();
    if (error || !session) return res.status(404).json({ error: 'Session not found' });

    const role = resolveActorFromToken(session, token);
    const pool = await supabase.from('veto_pool_templates').select('maps').eq('id', session.pool_template_id).single();
    const actions = await loadActions(session.id);

    let nextStep = null;
    if (session.status !== 'complete') {
      try {
        nextStep = vetoEngine.resolveNextStep(session.ruleset, pool.data.maps, actions, session.veto_structure);
      } catch {
        nextStep = null;
      }
    }

    res.json({ session, role, actions, nextStep });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Perform a coinflip to determine ban/pick order. Server-generated,
 * logged as its own ledger entry — never decided client-side.
 *
 * The winning team is recorded as the action's `actor` (not 'system') so
 * the ledger is self-describing: anyone reading the action history later
 * (including the engine itself, for bo2's decider side-pick attribution)
 * can see who won without cross-referencing the sessions table.
 */
router.post('/sessions/:id/coinflip', async (req, res) => {
  try {
    const session = await loadSession(req.params.id);
    if (session.coinflip_winner) {
      return res.status(400).json({ error: 'Coinflip already performed for this session' });
    }
    const winner = Math.random() < 0.5 ? 'team_a' : 'team_b';
    await appendAction(session, { actor: winner, actionType: 'coinflip', map: null, side: null });

    const { data: updated, error } = await supabase
      .from('veto_sessions')
      .update({ coinflip_winner: winner, current_turn: winner, status: 'active' })
      .eq('id', session.id)
      .select()
      .single();
    if (error) throw error;

    req.app.get('io').to(`veto:${session.id}`).emit('veto:update', { type: 'coinflip', winner });
    res.json({ winner, session: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Auto-advance through any decider steps that don't require human input.
 * A decider map is "auto-locked" the instant only one map (or, for bo2,
 * one of the final two) remains — no captain chooses it, so it's written
 * immediately rather than waiting on a request that will never come.
 * Stops as soon as the next state needs a real human action (a side-pick,
 * or the veto is complete).
 */
async function autoAdvanceDeciders(session, ruleset, mapPool, structure) {
  let actions = await loadActions(session.id);
  let state = vetoEngine.resolveNextStep(ruleset, mapPool, actions, structure);
  let guard = 0;
  while (state.pendingDecider && guard++ < 10) {
    const deciderAction = await appendAction(session, {
      actor: 'system', actionType: 'decider', map: state.map, side: null,
    });
    actions = [...actions, deciderAction];
    state = vetoEngine.resolveNextStep(ruleset, mapPool, actions, structure);
  }
  return { actions, state };
}

/**
 * Submit a ban, pick, or side-pick. Server is sole authority: resolves the
 * current engine state itself to determine what kind of input is expected
 * right now, validates the token maps to the correct actor for that input,
 * writes it, then auto-advances through any decider(s) that follow before
 * returning the resulting state.
 */
router.post('/sessions/:id/action', async (req, res) => {
  try {
    const { token, map, side } = req.body;
    const session = await loadSession(req.params.id);
    const actor = resolveActorFromToken(session, token);

    if (!actor || actor === 'spectator') {
      return res.status(403).json({ error: 'Invalid token for this action' });
    }
    if (session.status === 'complete') {
      return res.status(400).json({ error: 'Veto already complete' });
    }

    const { data: poolRow } = await supabase
      .from('veto_pool_templates')
      .select('maps')
      .eq('id', session.pool_template_id)
      .single();
    const actions = await loadActions(session.id);
    const next = vetoEngine.resolveNextStep(session.ruleset, poolRow.maps, actions, session.veto_structure);

    if (next.pendingDecider) {
      return res.status(409).json({ error: 'Decider is auto-resolving, please refresh' });
    }

    let newAction;
    const steamId = actor === 'team_a' ? session.team_a_steam_id : session.team_b_steam_id;

    if (next.pendingSidePick) {
      if (next.sidePickBy !== actor) {
        return res.status(403).json({ error: `Not your side to pick — waiting on ${next.sidePickBy}` });
      }
      if (side !== 'ct' && side !== 't') {
        return res.status(400).json({ error: 'side must be "ct" or "t"' });
      }
      newAction = await appendAction(session, {
        actor, actionType: 'side_pick', map: next.map, side, steamId,
      });
    } else {
      if (next.nextAction.actor !== actor) {
        return res.status(403).json({ error: `Not your turn — waiting on ${next.nextAction.actor}` });
      }
      if (!poolRow.maps.includes(map)) {
        return res.status(400).json({ error: 'Invalid map for this pool' });
      }
      newAction = await appendAction(session, {
        actor, actionType: next.nextAction.action, map, side: null, steamId,
      });
    }

    const { actions: finalActions, state: afterState } = await autoAdvanceDeciders(
      session, session.ruleset, poolRow.maps, session.veto_structure
    );

    let currentTurn;
    if (afterState.complete) {
      currentTurn = 'complete';
    } else if (afterState.pendingSidePick) {
      currentTurn = afterState.sidePickBy;
    } else {
      currentTurn = afterState.nextAction.actor;
    }

    const updates = { current_turn: currentTurn };
    if (afterState.complete) {
      updates.status = 'complete';
      updates.completed_at = new Date().toISOString();
    }
    await supabase.from('veto_sessions').update(updates).eq('id', session.id);

    req.app.get('io').to(`veto:${session.id}`).emit('veto:update', {
      type: 'action', action: newAction, finalActions, nextState: afterState,
    });
    res.json({ action: newAction, actions: finalActions, nextState: afterState });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Public, permanent, read-only ledger view. This IS the "publicly searchable
 * trusted record" — no auth required to view, tamper-evidence verified live.
 */
router.get('/results/:id', async (req, res) => {
  try {
    const session = await loadSession(req.params.id);
    const actions = await loadActions(session.id);
    const chainCheck = vetoEngine.verifyActionChain(session.id, actions);
    res.json({ session, actions, integrity: chainCheck });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get('/pools/:game', async (req, res) => {
  try {
    const pool = await getActivePool(req.params.game);
    res.json(pool);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get('/structures/:ruleset', (req, res) => {
  try {
    res.json(vetoEngine.listStructures(req.params.ruleset));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
