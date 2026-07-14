/**
 * KASTLR Veto Service — shared action logic
 * Both the /action route and the timeout sweep need to append actions,
 * auto-advance through deciders, and compute the resulting turn/deadline
 * state identically. Living in one place means they can't silently drift
 * apart from each other as the engine evolves.
 */

'use strict';

const supabase = require('./supabaseClient');
const vetoEngine = require('./vetoEngine');

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

/**
 * Auto-advance through any decider steps that don't require human input.
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
 * Given the resolved state after an action (and any auto-advanced deciders),
 * compute what the sessions row should be updated to: whose turn it is now,
 * whether the veto is complete, and the new turn deadline (null if complete).
 */
function computeSessionUpdates(afterState, timerSeconds) {
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
    updates.turn_deadline_at = null;
  } else {
    updates.turn_deadline_at = new Date(Date.now() + timerSeconds * 1000).toISOString();
  }
  return updates;
}

module.exports = {
  loadSession,
  loadActions,
  appendAction,
  autoAdvanceDeciders,
  computeSessionUpdates,
};
