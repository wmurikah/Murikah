/**
 * The auditee loop's stage machine (Build Prompt 68).
 *
 * The module under test is pure and import-free, so these run against the real
 * rules rather than a copy of them. What they are guarding is an access
 * decision as much as a workflow one: the auditee side has no audit permissions
 * at all, so "who may make this move" is decided entirely by who is named and
 * where the finding stands, and both halves have to hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDITEE_MOVES,
  AUDITEE_STAGE,
  DELEGATION_STATUS,
  actorFor,
  canMove,
  isAuditeeMove,
  mayMove,
  moveLabel,
  nextStage,
  offeredMoves,
  parseAuditDecision,
  stageHint,
  stageLabel,
  stageOf,
  type AuditeeStanding,
} from '../../src/lib/grc/workflow/auditeeLoop.ts';

const NOBODY: AuditeeStanding = {
  isResponsible: false,
  isCc: false,
  isDelegate: false,
  isAudit: false,
};
const MANAGER: AuditeeStanding = { ...NOBODY, isResponsible: true };
const DELEGATE: AuditeeStanding = { ...NOBODY, isDelegate: true };
const COPIED: AuditeeStanding = { ...NOBODY, isCc: true };
const AUDIT: AuditeeStanding = { ...NOBODY, isAudit: true };

test('the loop runs: sent, delegated, returned, released, accepted', () => {
  let stage = nextStage(AUDITEE_STAGE.WITH_AUDITEE, 'send');
  assert.equal(stage, AUDITEE_STAGE.WITH_AUDITEE, 'a send puts it with the responsibles');
  stage = nextStage(stage!, 'delegate');
  assert.equal(stage, AUDITEE_STAGE.DELEGATED);
  stage = nextStage(stage!, 'return_to_manager');
  assert.equal(stage, AUDITEE_STAGE.WITH_UNIT_MANAGER);
  stage = nextStage(stage!, 'release_to_audit');
  assert.equal(stage, AUDITEE_STAGE.WITH_AUDIT);
  stage = nextStage(stage!, 'accept');
  assert.equal(stage, AUDITEE_STAGE.CLOSED, 'and audit accepting finishes it');
});

test('a manager may delegate again after a delegate hands it back', () => {
  // The real shape of the work: a draft comes back thin, the manager sends it
  // out again with more instruction. A machine that allowed one handover per
  // finding would force the manager to write it themselves.
  assert.equal(canMove(AUDITEE_STAGE.WITH_UNIT_MANAGER, 'delegate'), true);
  assert.equal(nextStage(AUDITEE_STAGE.WITH_UNIT_MANAGER, 'delegate'), AUDITEE_STAGE.DELEGATED);
});

test('a return from audit lands where a fresh send lands', () => {
  // Not a third state that behaves identically to WITH_AUDITEE: the finding is
  // back with the responsibles and they must answer it, which is precisely the
  // position a send leaves them in.
  assert.equal(nextStage(AUDITEE_STAGE.WITH_AUDIT, 'request_change'), AUDITEE_STAGE.WITH_AUDITEE);
  assert.equal(canMove(AUDITEE_STAGE.WITH_AUDITEE, 'delegate'), true, 'and can be delegated again');
  assert.equal(canMove(AUDITEE_STAGE.WITH_AUDITEE, 'release_to_audit'), true);
});

test('nothing may be released while a delegate is still holding it', () => {
  // The one ordering rule that matters: deciding the response is finished is
  // the manager's call, and it cannot be made while somebody else is drafting.
  assert.equal(canMove(AUDITEE_STAGE.DELEGATED, 'release_to_audit'), false);
  assert.equal(mayMove(MANAGER, AUDITEE_STAGE.DELEGATED, 'release_to_audit'), false);
  assert.equal(nextStage(AUDITEE_STAGE.DELEGATED, 'release_to_audit'), null);
});

test('a delegate may return what they hold and nothing else', () => {
  assert.equal(mayMove(DELEGATE, AUDITEE_STAGE.DELEGATED, 'return_to_manager'), true);
  for (const move of AUDITEE_MOVES) {
    if (move === 'return_to_manager') continue;
    assert.equal(
      mayMove(DELEGATE, AUDITEE_STAGE.DELEGATED, move),
      false,
      `a delegate must not be able to ${move}`,
    );
  }
});

test('being copied in entitles a person to nothing', () => {
  // A CC recipient is told everything and asked for nothing. If this ever
  // passes for a move, somebody merely kept informed can act for the unit.
  for (const stage of Object.values(AUDITEE_STAGE)) {
    for (const move of AUDITEE_MOVES) {
      assert.equal(mayMove(COPIED, stage, move), false, `a CC must not ${move} from ${stage}`);
    }
  }
  assert.deepEqual(offeredMoves(COPIED, AUDITEE_STAGE.WITH_AUDITEE), []);
});

test('a stranger to the finding can do nothing at any stage', () => {
  for (const stage of Object.values(AUDITEE_STAGE)) {
    assert.deepEqual(offeredMoves(NOBODY, stage), [], `nothing is offered from ${stage}`);
  }
});

test('the manager and audit hold different halves of the loop', () => {
  assert.deepEqual(offeredMoves(MANAGER, AUDITEE_STAGE.WITH_AUDITEE), [
    'delegate',
    'release_to_audit',
  ]);
  assert.deepEqual(offeredMoves(AUDIT, AUDITEE_STAGE.WITH_AUDIT), [
    'accept',
    'modify',
    'request_change',
  ]);
  // And neither can do the other's: audit does not release for the unit, and
  // the unit does not decide on its own response.
  assert.equal(mayMove(AUDIT, AUDITEE_STAGE.WITH_AUDITEE, 'delegate'), false);
  assert.equal(mayMove(MANAGER, AUDITEE_STAGE.WITH_AUDIT, 'accept'), false);
});

test('audit cannot decide on a response that has not been released', () => {
  for (const stage of [
    AUDITEE_STAGE.WITH_AUDITEE,
    AUDITEE_STAGE.DELEGATED,
    AUDITEE_STAGE.WITH_UNIT_MANAGER,
  ]) {
    for (const move of ['accept', 'modify', 'request_change'] as const) {
      assert.equal(mayMove(AUDIT, stage, move), false, `audit must not ${move} from ${stage}`);
    }
  }
});

test('a closed loop offers nobody anything further', () => {
  for (const standing of [MANAGER, DELEGATE, AUDIT, COPIED]) {
    assert.deepEqual(offeredMoves(standing, AUDITEE_STAGE.CLOSED), []);
  }
});

test('a finding sent before the stage existed reads as with the auditee', () => {
  // The loop has to work on the findings already out there, which carry no
  // stage at all, and on hand-set values in whatever case they were typed.
  assert.equal(stageOf(null), AUDITEE_STAGE.WITH_AUDITEE);
  assert.equal(stageOf(''), AUDITEE_STAGE.WITH_AUDITEE);
  assert.equal(stageOf('nonsense'), AUDITEE_STAGE.WITH_AUDITEE);
  assert.equal(stageOf(' delegated '), AUDITEE_STAGE.DELEGATED);
  assert.equal(stageOf('with_audit'), AUDITEE_STAGE.WITH_AUDIT);
});

test('every move is named for a person, in words and by actor', () => {
  for (const move of AUDITEE_MOVES) {
    assert.ok(moveLabel(move).length > 3, `${move} must have words`);
    assert.ok(['audit', 'unit_manager', 'delegate'].includes(actorFor(move)));
    assert.equal(isAuditeeMove(move), true);
  }
  assert.equal(isAuditeeMove('escalate'), false);
  // No two moves read the same in the trail, or the story is unreadable.
  const labels = AUDITEE_MOVES.map(moveLabel);
  assert.equal(new Set(labels).size, labels.length);
});

test('every stage says where the finding is and what happens next', () => {
  const labels = Object.values(AUDITEE_STAGE).map(stageLabel);
  assert.equal(new Set(labels).size, labels.length, 'no two stages read the same');
  for (const stage of Object.values(AUDITEE_STAGE)) {
    assert.ok(stageHint(stage).length > 20, `${stage} must explain itself`);
  }
});

test('the audit decision is parsed, and the old two-decision form still posts', () => {
  assert.equal(parseAuditDecision('accept'), 'accept');
  assert.equal(parseAuditDecision('modify'), 'modify');
  assert.equal(parseAuditDecision('request_change'), 'request_change');
  // A bookmarked post or an older tab must not start failing because a third
  // decision was added.
  assert.equal(parseAuditDecision('request_changes'), 'request_change');
  assert.equal(parseAuditDecision('reject'), null);
  assert.equal(parseAuditDecision(null), null);
});

test('a delegation is issued, returned or closed, and nothing else', () => {
  assert.deepEqual(Object.values(DELEGATION_STATUS), ['ISSUED', 'RETURNED', 'CLOSED']);
});
