import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canReviewDecision, decisionActions, decisionPayload, decisionReason, decisionReasons, otherReason,
  isComparableOption, reasonLimit, sortDecisionOptions,
} from '../src/pages/dss/managerDecision.ts'

test('each action shows its own reason options with no default', () => {
  for (const action of Object.keys(decisionActions)) {
    assert.equal(decisionReason(action, '', ''), '')
    assert.equal(decisionReasons[action].at(-1), otherReason)
    assert.equal(decisionReason(action, decisionReasons[action][0], ''), decisionReasons[action][0])
  }
  assert.deepEqual(Object.values(decisionReasons).map(reasons => reasons.length), [5, 5, 6])
  assert.equal(decisionReason('REJECT', decisionReasons.APPROVE[0], 'ghi chú'), '')
  assert.equal(decisionReason('', decisionReasons.APPROVE[0], ''), '')
})

test('a custom reason is required and keeps line breaks', () => {
  assert.equal(canReviewDecision('REJECT', decisionReason('REJECT', otherReason, '  \n '), true), false)
  assert.equal(decisionReason('APPROVE', otherReason, '  Đã đối chiếu hồ sơ.\nLịch lấy hàng đã thống nhất.  '),
    'Đã đối chiếu hồ sơ.\nLịch lấy hàng đã thống nhất.')
})

test('preset may include optional notes within the API limit', () => {
  const preset = decisionReasons.REQUEST_RECALCULATION[0]
  assert.equal(decisionReason('REQUEST_RECALCULATION', preset, ' Cập nhật lượt lấy. '), preset + '\nGhi chú · Cập nhật lượt lấy.')
  assert.equal(canReviewDecision('APPROVE', 'x'.repeat(reasonLimit), true), true)
  assert.equal(canReviewDecision('APPROVE', 'x'.repeat(reasonLimit + 1), true), false)
})

test('a blocked option can be rejected or returned for recalculation, and cannot be approved', () => {
  assert.equal(canReviewDecision('APPROVE', 'Đã đối chiếu.', false), false)
  assert.equal(canReviewDecision('REJECT', 'Đã đối chiếu.', false), true)
  assert.equal(canReviewDecision('REQUEST_RECALCULATION', 'Đã đối chiếu.', false), true)
})

test('the API receives the final reason exactly and uses replaces only on approval', () => {
  const reason = 'Lý do\nDòng tiếp theo.'
  for (const outcome of Object.keys(decisionActions)) {
    const payload = decisionPayload('evaluation', outcome, reason, 'previous')
    assert.deepEqual(payload, { evaluation_code: 'evaluation', outcome, reason,
      ...(outcome === 'APPROVE' ? { replaces: 'previous' } : {}) })
  }
  assert.equal('replaces' in decisionPayload('evaluation', 'APPROVE', reason, null), false)
})

test('options sort by approval eligibility and ascending numeric cost', () => {
  const entry = (id, collaborative_cost, allowed) => ({ id, collaborative_cost, approval: { allowed } })
  const rows = [entry('expensive', 110, true), entry('blocked', '1', false), entry('cheapest', '99', true)]
  assert.deepEqual(sortDecisionOptions(rows).map(row => row.id), ['cheapest', 'expensive', 'blocked'])
  assert.equal(rows[0].id, 'expensive')
})

test('an already approved option keeps its place in the comparison without allowing approval again', () => {
  const direct = { collaborative_cost: '172200.00', approval: { allowed: false, code: 'EVALUATION_ALREADY_APPROVED' } }
  const hub = { collaborative_cost: '370500.00', approval: { allowed: true, code: null } }
  assert.equal(sortDecisionOptions([hub, direct])[0], direct)
  assert.equal(isComparableOption(direct), true)
  assert.equal(canReviewDecision('APPROVE', 'Chi phí thấp nhất', direct.approval.allowed), false)
})
