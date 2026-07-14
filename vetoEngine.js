/**
 * KASTLR Veto Engine
 * Pure logic — no DB, no sockets, no side effects. Given a ruleset and the
 * action history so far, tells you what happens next. This is the single
 * source of truth for veto sequencing; the Express routes and socket layer
 * are just thin wrappers around this.
 */

'use strict';

const crypto = require('crypto');

// --- Veto structure definitions ------------------------------------------
// A "structure" is the actual step sequence used to reach a given ruleset's
// outcome. Ruleset (bo1/bo2/bo3/bo5) = HOW MANY maps get decided.
// Structure = THE SEQUENCE used to decide them. These are independent knobs:
// a session picks a ruleset AND a structure for that ruleset.
//
// "isStandard: true" = shown first / pre-selected in any UI. Only add a new
// structure here once its convention is independently verified — do not
// invent esports "standards" that aren't actually documented as such.

const STRUCTURES = {
  bo1: {
    standard: {
      label: 'Standard',
      isStandard: true,
      steps: [
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        // 7th map (last remaining) auto-resolves as decider
      ],
    },
    ept: {
      label: 'ESL Pro Tour (EPT)',
      isStandard: false,
      steps: [
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        // 1-2-2-1 pattern; last remaining map auto-resolves as decider
      ],
    },
  },
  bo2: {
    standard: {
      label: 'Standard',
      isStandard: true,
      steps: [
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'ban' },
        // 2 maps remain, both played, in order left
      ],
    },
  },
  bo3: {
    standard: {
      label: 'Standard',
      isStandard: true,
      steps: [
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'pick' },
        { actor: 'team_b', action: 'pick' },
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        // 1 map remains = decider
      ],
    },
  },
  bo5: {
    standard: {
      label: 'Standard',
      isStandard: true,
      steps: [
        { actor: 'team_a', action: 'ban' },
        { actor: 'team_b', action: 'ban' },
        { actor: 'team_a', action: 'pick' },
        { actor: 'team_b', action: 'pick' },
        { actor: 'team_a', action: 'pick' },
        { actor: 'team_b', action: 'pick' },
        // 1 map remains = decider
      ],
    },
  },
};

function getSteps(ruleset, structure = 'standard') {
  const rulesetStructures = STRUCTURES[ruleset];
  if (!rulesetStructures) throw new Error(`Unknown ruleset: ${ruleset}`);
  const structureDef = rulesetStructures[structure];
  if (!structureDef) throw new Error(`Unknown structure "${structure}" for ruleset ${ruleset}`);
  return structureDef.steps;
}

// For UI dropdowns: list available structures for a ruleset, standard first.
function listStructures(ruleset) {
  const rulesetStructures = STRUCTURES[ruleset];
  if (!rulesetStructures) throw new Error(`Unknown ruleset: ${ruleset}`);
  return Object.entries(rulesetStructures)
    .map(([key, def]) => ({ key, label: def.label, isStandard: def.isStandard }))
    .sort((a, b) => (b.isStandard === true) - (a.isStandard === true));
}

const VALID_TIMERS = [25, 30, 60];

/**
 * Compute the hash-chained integrity hash for a single action row.
 * Deterministic given the same inputs — used both when writing a new
 * action and when independently verifying the chain later.
 */
function computeActionHash({ sessionId, sequenceNo, actor, actionType, map, side, prevActionHash }) {
  const payload = [
    sessionId,
    sequenceNo,
    actor,
    actionType,
    map || '',
    side || '',
    prevActionHash || 'GENESIS',
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Verify an entire action history's hash chain is intact (tamper-evidence check).
 * Returns { valid: boolean, brokenAtSequence: number|null }
 */
function verifyActionChain(sessionId, actionHistory) {
  let prevHash = null;
  const sorted = [...actionHistory].sort((a, b) => a.sequence_no - b.sequence_no);
  for (const action of sorted) {
    const expected = computeActionHash({
      sessionId,
      sequenceNo: action.sequence_no,
      actor: action.actor,
      actionType: action.action_type,
      map: action.map,
      side: action.side,
      prevActionHash: prevHash,
    });
    if (expected !== action.action_hash) {
      return { valid: false, brokenAtSequence: action.sequence_no };
    }
    prevHash = action.action_hash;
  }
  return { valid: true, brokenAtSequence: null };
}

/**
 * Given a ruleset, the full map pool, and the action history so far,
 * determine the next required step (or that the veto is complete).
 *
 * mapPool: string[] — full pool at veto start (e.g. 7 Active Duty maps)
 * actionHistory: array of { actor, action_type, map, side } in sequence order
 */
function resolveNextStep(ruleset, mapPool, actionHistory, structure = 'standard') {
  const steps = getSteps(ruleset, structure);
  const usedMaps = new Set(
    actionHistory.filter((a) => a.map).map((a) => a.map)
  );
  const remaining = mapPool.filter((m) => !usedMaps.has(m));

  const banPickActions = actionHistory.filter(
    (a) => a.action_type === 'ban' || a.action_type === 'pick'
  );

  // bo2 special case: exactly 5 steps consumed, 2 maps remain, both are played — no decider step
  if (ruleset === 'bo2' && banPickActions.length >= steps.length) {
    if (remaining.length !== 2) {
      throw new Error(`bo2 expected 2 remaining maps, found ${remaining.length}`);
    }
    return {
      complete: true,
      result: {
        maps: [
          { map: remaining[0], sidePickBy: 'coinflip_winner' },
          { map: remaining[1], sidePickBy: 'coinflip_loser' },
        ],
      },
    };
  }

  // bo1/bo3/bo5: once all defined steps are consumed, exactly 1 map remains = decider
  if (banPickActions.length >= steps.length) {
    if (remaining.length !== 1) {
      throw new Error(
        `${ruleset} expected exactly 1 remaining map after defined steps, found ${remaining.length}`
      );
    }
    // Side pick on decider: whoever did NOT get the last ban chooses side
    const lastBan = [...banPickActions].reverse().find((a) => a.action_type === 'ban');
    const lastBanActor = lastBan ? lastBan.actor : null;
    const sidePickBy =
      lastBanActor === 'team_a' ? 'team_b' : lastBanActor === 'team_b' ? 'team_a' : null;

    return {
      complete: false,
      pendingDecider: true,
      map: remaining[0],
      nextAction: { actor: 'system', action: 'decider' },
      sidePickBy, // who chooses side once decider is confirmed
    };
  }

  // Otherwise, return the next scripted step
  const step = steps[banPickActions.length];
  let sidePickBy = null;
  if (step.action === 'pick') {
    // Standard convention: opponent of picker chooses side on picked maps
    sidePickBy = step.actor === 'team_a' ? 'team_b' : 'team_a';
  }

  return {
    complete: false,
    pendingDecider: false,
    nextAction: step,
    remainingMapCount: remaining.length,
    sidePickBy,
  };
}

/**
 * Resolve an auto-action on timer expiry. Standard behaviour: auto-ban a
 * random remaining map (mirrors Valve's own Premier veto timeout handling).
 * For 'pick' steps on timeout, auto-picks a random remaining map instead.
 */
function resolveTimeoutAction(ruleset, mapPool, actionHistory, structure = 'standard') {
  const next = resolveNextStep(ruleset, mapPool, actionHistory, structure);
  if (next.complete || next.pendingDecider) {
    throw new Error('No timeout action applicable — veto already at decider/complete');
  }
  const usedMaps = new Set(actionHistory.filter((a) => a.map).map((a) => a.map));
  const remaining = mapPool.filter((m) => !usedMaps.has(m));
  const randomMap = remaining[Math.floor(Math.random() * remaining.length)];

  return {
    actor: next.nextAction.actor,
    action_type: 'timeout_auto',
    map: randomMap,
    underlyingAction: next.nextAction.action, // 'ban' or 'pick' — what it stood in for
  };
}

function isValidTimer(seconds) {
  return VALID_TIMERS.includes(seconds);
}

module.exports = {
  STRUCTURES,
  VALID_TIMERS,
  getSteps,
  listStructures,
  computeActionHash,
  verifyActionChain,
  resolveNextStep,
  resolveTimeoutAction,
  isValidTimer,
};
