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
 * Determine whether a side-pick is currently owed before anything else can
 * happen. This is checked FIRST on every call — a pick or a decider map is
 * not "done" until its side has been chosen, and the veto cannot advance
 * past that point.
 *
 * ruleset matters here because bo1/bo3/bo5 use the "whoever didn't get the
 * last ban" convention for decider side-picks, while bo2 has TWO decider-like
 * maps (no bans left to reference) and uses the coinflip winner/loser instead.
 * The coinflip action's `actor` field IS the winner — see appendAction call
 * sites in vetoRoutes.js, which write the winning team as the actor rather
 * than 'system', specifically so this stays self-contained in the ledger
 * with no need to cross-reference the sessions table.
 */
function findPendingSidePick(ruleset, steps, actionHistory) {
  let pending = null; // { map, kind: 'pick'|'decider', pickerActor? }
  let consumedCount = 0;

  for (const a of actionHistory) {
    if (a.action_type === 'ban' || a.action_type === 'pick' || a.action_type === 'timeout_auto') {
      const stepDef = steps[consumedCount];
      const wasPickStep = stepDef ? stepDef.action === 'pick' : false;
      if (a.action_type === 'pick' || (a.action_type === 'timeout_auto' && wasPickStep)) {
        pending = { map: a.map, kind: 'pick', pickerActor: a.actor };
      }
      consumedCount++;
    } else if (a.action_type === 'decider') {
      pending = { map: a.map, kind: 'decider' };
    } else if (a.action_type === 'side_pick' || (a.action_type === 'timeout_auto' && a.side)) {
      if (pending && pending.map === a.map) pending = null;
    }
  }

  if (!pending) return null;

  if (pending.kind === 'pick') {
    const sidePickBy = pending.pickerActor === 'team_a' ? 'team_b' : 'team_a';
    return { map: pending.map, sidePickBy, nextAction: { actor: sidePickBy, action: 'side_pick' } };
  }

  // Decider side-pick
  if (ruleset === 'bo2') {
    const deciderCountBeforeThis = actionHistory.filter((a) => a.action_type === 'decider').length - 1;
    const coinflipAction = actionHistory.find((a) => a.action_type === 'coinflip');
    const winner = coinflipAction ? coinflipAction.actor : null;
    const loser = winner === 'team_a' ? 'team_b' : winner === 'team_b' ? 'team_a' : null;
    const sidePickBy = deciderCountBeforeThis === 0 ? winner : loser;
    return { map: pending.map, sidePickBy, nextAction: { actor: sidePickBy, action: 'side_pick' } };
  }

  // bo1/bo3/bo5: whoever did NOT get the last ban chooses side on the decider
  const lastBan = [...actionHistory].reverse().find((a) => a.action_type === 'ban' || (a.action_type === 'timeout_auto' && !a.side));
  const lastBanActor = lastBan ? lastBan.actor : null;
  const sidePickBy = lastBanActor === 'team_a' ? 'team_b' : lastBanActor === 'team_b' ? 'team_a' : null;
  return { map: pending.map, sidePickBy, nextAction: { actor: sidePickBy, action: 'side_pick' } };
}

/**
 * Given a ruleset, the full map pool, and the action history so far,
 * determine the next required step — a ban/pick, a side-pick, an
 * auto-resolving decider, or that the veto is complete.
 *
 * mapPool: string[] — full pool at veto start (e.g. 7 Active Duty maps)
 * actionHistory: array of { actor, action_type, map, side } in sequence order
 */
function resolveNextStep(ruleset, mapPool, actionHistory, structure = 'standard') {
  const steps = getSteps(ruleset, structure);
  const usedMaps = new Set(actionHistory.filter((a) => a.map).map((a) => a.map));
  const remaining = mapPool.filter((m) => !usedMaps.has(m));

  // Highest priority: an owed side-pick blocks everything else
  const pendingSide = findPendingSidePick(ruleset, steps, actionHistory);
  if (pendingSide) {
    return { complete: false, pendingDecider: false, pendingSidePick: true, ...pendingSide };
  }

  const stepConsuming = actionHistory.filter(
    (a) => a.action_type === 'ban' || a.action_type === 'pick' || a.action_type === 'timeout_auto'
  );

  // All scripted ban/pick steps consumed — whatever's left resolves as decider(s).
  // bo1/bo3/bo5: exactly 1 map left, 1 decider. bo2: 2 maps left, 2 sequential deciders.
  if (stepConsuming.length >= steps.length) {
    if (remaining.length === 0) {
      return { complete: true };
    }
    const map = remaining[0];
    return {
      complete: false,
      pendingDecider: true,
      pendingSidePick: false,
      nextAction: { actor: 'system', action: 'decider' },
      map,
    };
  }

  // Otherwise, the next scripted ban/pick step
  const step = steps[stepConsuming.length];
  return {
    complete: false,
    pendingDecider: false,
    pendingSidePick: false,
    nextAction: step,
    remainingMapCount: remaining.length,
  };
}

/**
 * Resolve an auto-action on timer expiry. Standard behaviour: auto-ban/pick a
 * random remaining map (mirrors Valve's own Premier veto timeout handling),
 * or auto-pick a random side if the timeout occurs during a side-pick.
 */
function resolveTimeoutAction(ruleset, mapPool, actionHistory, structure = 'standard') {
  const next = resolveNextStep(ruleset, mapPool, actionHistory, structure);
  if (next.complete || next.pendingDecider) {
    throw new Error('No timeout action applicable — veto already at decider/complete');
  }

  if (next.pendingSidePick) {
    const side = Math.random() < 0.5 ? 'ct' : 't';
    return {
      actor: next.sidePickBy,
      action_type: 'timeout_auto',
      map: next.map,
      side,
    };
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
