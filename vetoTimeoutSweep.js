/**
 * KASTLR Veto Service — turn timeout sweep
 * Runs on an interval inside this always-on Node process (not a serverless
 * function, so this is safe — the process doesn't sleep between requests).
 * Finds any active session whose turn_deadline_at has passed and resolves
 * it automatically, using the exact same resolveTimeoutAction logic proven
 * out in the engine's dry-runs. This is what makes the timer real rather
 * than cosmetic: it fires even if every browser tab watching is closed.
 */

'use strict';

const supabase = require('./supabaseClient');
const vetoEngine = require('./vetoEngine');
const { loadActions, appendAction, autoAdvanceDeciders, computeSessionUpdates } = require('./vetoCore');

const SWEEP_INTERVAL_MS = 3000;

async function sweepOnce(io) {
  const { data: expiredSessions, error } = await supabase
    .from('veto_sessions')
    .select('*')
    .eq('status', 'active')
    .lt('turn_deadline_at', new Date().toISOString());

  if (error) {
    console.error('Timeout sweep query failed:', error.message);
    return;
  }
  if (!expiredSessions || expiredSessions.length === 0) return;

  for (const session of expiredSessions) {
    try {
      await resolveExpiredSession(session, io);
    } catch (err) {
      console.error(`Timeout sweep failed for session ${session.id}:`, err.message);
    }
  }
}

async function resolveExpiredSession(session, io) {
  const { data: poolRow } = await supabase
    .from('veto_pool_templates')
    .select('maps')
    .eq('id', session.pool_template_id)
    .single();

  const actions = await loadActions(session.id);
  const next = vetoEngine.resolveNextStep(session.ruleset, poolRow.maps, actions, session.veto_structure);

  // Nothing to time out (already resolved by another sweep tick, or a decider is pending)
  if (next.complete || next.pendingDecider) return;

  const timeoutResult = vetoEngine.resolveTimeoutAction(session.ruleset, poolRow.maps, actions, session.veto_structure);
  const steamId = timeoutResult.actor === 'team_a' ? session.team_a_steam_id : session.team_b_steam_id;

  await appendAction(session, {
    actor: timeoutResult.actor,
    actionType: 'timeout_auto',
    map: timeoutResult.map,
    side: timeoutResult.side || null,
    steamId,
  });

  const { state: afterState } = await autoAdvanceDeciders(
    session, session.ruleset, poolRow.maps, session.veto_structure
  );

  const updates = computeSessionUpdates(afterState, session.timer_seconds);
  await supabase.from('veto_sessions').update(updates).eq('id', session.id);

  io.to(`veto:${session.id}`).emit('veto:update', { type: 'timeout', nextState: afterState });
  console.log(`Session ${session.id}: turn timed out, auto-resolved (${timeoutResult.action_type})`);
}

function startTimeoutSweep(io) {
  setInterval(() => {
    sweepOnce(io).catch((err) => console.error('Timeout sweep error:', err.message));
  }, SWEEP_INTERVAL_MS);
  console.log(`Timeout sweep started (every ${SWEEP_INTERVAL_MS}ms)`);
}

module.exports = { startTimeoutSweep };
