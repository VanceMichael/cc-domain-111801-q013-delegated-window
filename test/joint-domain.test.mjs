import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretJoint, interpretRelations } from '../src/interpret.mjs';
import {
  STATES, subjectFor, editableFields, changedSince,
  evaluateConfirmation, assessBranch, assessJoint, verifyJointPortal, buildHandover,
} from '../src/joint.mjs';

const relations = interpretRelations({
  declaration: 'JDEC1',
  shared: ['origin'],
  subjects: [
    { subject: 'EXPORTER', representatives: ['agent-a'], editable: ['contact', 'origin'] },
    { subject: 'PRODUCER', representatives: ['agent-b'], editable: ['goods', 'packageCount'] },
  ],
  confirmations: [
    { subject: 'EXPORTER', branch: 'B-EXPORT', representative: 'agent-a', fields: ['origin', 'contact'], revision: 1 },
    { subject: 'PRODUCER', branch: 'B-FACTORY', representative: 'agent-b', fields: ['origin', 'goods'], revision: 1 },
  ],
});

function branch(overrides = {}) {
  return interpretJoint({
    declaration: 'JDEC1', branch: 'B-EXPORT', subject: 'EXPORTER',
    representative: 'agent-a', contact: '张伟', contactName: '张伟',
    origin: 'CN', goods: '标准件', packageCount: '120', approved: true, revision: 1,
    ...overrides,
  });
}
const factory = (overrides = {}) => branch({
  branch: 'B-FACTORY', subject: 'PRODUCER', representative: 'agent-b',
  contact: '王芳', contactName: '王芳', goods: '组件', packageCount: '60', ...overrides,
});

test('门户只开放当前账号所属主体的可编辑字段', () => {
  assert.equal(subjectFor(relations, 'agent-a'), 'EXPORTER');
  assert.equal(subjectFor(relations, 'unknown'), null);
  assert.deepEqual(editableFields(relations, 'EXPORTER'), ['contact', 'origin']);
  assert.deepEqual(editableFields(relations, 'PRODUCER'), ['goods', 'packageCount']);
});

test('同名联系人不构成相同法定主体，分支按主体编码隔离', () => {
  const exporter = branch({ contactName: '同名联系人' });
  const producer = factory({ contactName: '同名联系人' });
  assert.notEqual(exporter.subject, producer.subject);
  const assessment = assessBranch(producer, relations, 'agent-a');
  assert.equal(assessment.status, 'outside');
});

test('未核准分支保留人工处理，不自动填报', () => {
  const assessment = assessBranch(branch({ approved: false }), relations, 'agent-a');
  assert.equal(assessment.status, 'review');
  assert.match(assessment.reason, /未核准/);
});

test('修订一致且确认有效时可继续办理', () => {
  const assessment = assessBranch(branch(), relations, 'agent-a');
  assert.equal(assessment.status, 'accepted');
  assert.equal(assessment.evaluations[0].state, STATES.VALID);
});

test('本主体字段更正后旧确认失效，但可由本账号重新确认', () => {
  const old = branch();
  const next = branch({ contactName: '李娜', revision: 2 });
  const assessment = assessBranch(next, relations, 'agent-a', [old]);
  assert.equal(assessment.status, 'accepted');
  assert.equal(assessment.automatable, true);
  assert.equal(assessment.evaluations[0].state, STATES.SUPERSEDED);
  assert.deepEqual(assessment.evaluations[0].validFields, ['origin']);
  assert.deepEqual(assessment.evaluations[0].invalidFields, ['contact']);
  assert.deepEqual(assessment.pending.map(item => item.awaiting), ['EXPORTER']);
});

test('共享字段更正使生产商确认失效，出口商账号只能登记待其重新确认', () => {
  const oldFactory = factory();
  const nextFactory = factory({ origin: 'VN', revision: 2 });
  const assessment = assessBranch(nextFactory, relations, 'agent-b', [oldFactory]);
  // 生产商自己的 goods 确认仍有效，origin 失效；origin 对生产商只读，不能代签
  assert.equal(assessment.status, 'review');
  assert.equal(assessment.automatable, false);
  const originPending = assessment.pending.find(item => item.field === 'origin');
  assert.ok(originPending);
  assert.equal(originPending.awaiting, 'PRODUCER');
  assert.match(assessment.reason, /共享字段|重新确认/);
});

test('出口商办理自己分支时，生产商分支的待办不阻断无关分支', () => {
  const oldFactory = factory();
  const nextFactory = factory({ origin: 'VN', revision: 2 });
  const joint = assessJoint([branch(), nextFactory], relations, 'agent-a', [oldFactory]);
  // 自己的分支照常可办
  assert.deepEqual(joint.actionableBranches, ['B-EXPORT']);
  assert.equal(joint.blockedBranches.length, 0);
  // 他方分支不可代办，但其失效确认作为联合层面的待办保留
  const factoryView = joint.branches.find(item => item.branch === 'B-FACTORY');
  assert.equal(factoryView.status, 'outside');
  assert.equal(joint.externalPending[0].branch, 'B-FACTORY');
  assert.deepEqual(joint.externalPending[0].pending.map(item => item.field), ['origin']);
  assert.equal(joint.complete, false);
});

test('代表人变更不承接旧代表人的确认', () => {
  const switched = branch({ representative: 'agent-a2', revision: 2 });
  const relations2 = interpretRelations({
    ...relations,
    subjects: [
      { subject: 'EXPORTER', representatives: ['agent-a2'], editable: ['contact', 'origin'] },
      relations.subjects[1],
    ],
  });
  const assessment = assessBranch(switched, relations2, 'agent-a2', [branch()]);
  const evaluation = assessment.evaluations.find(item => item.state === STATES.REPRESENTATIVE_CHANGED);
  assert.ok(evaluation);
  assert.match(evaluation.reason, /代表人/);
});

test('缺少确认时原文不能假定旧确认仍有效', () => {
  const next = branch({ contactName: '赵磊', revision: 3 });
  // 只有 revision 1 的原文，确认挂在 revision 2，无法核对中间是否变化
  const confirmation = { ...relations.confirmations[0], revision: 2 };
  const evaluation = evaluateConfirmation(next, relations, confirmation, [branch()]);
  assert.equal(evaluation.state, STATES.UNVERIFIABLE);
});

test('同一修订号出现矛盾事实时冲突挂起，不覆盖旧依据', () => {
  const old = branch();
  const conflicting = branch({ contactName: '另一人' });
  const assessment = assessBranch(conflicting, relations, 'agent-a', [old]);
  assert.equal(assessment.status, 'conflict');
});

test('回读只核对当前账号可编辑字段，点击成功不等于已确认', () => {
  const record = branch();
  const values = { contact: '张伟', origin: 'CN' };
  const ok = verifyJointPortal(record, relations, 'agent-a', { id: 'RC-1', state: 'received', version: 1, values });
  assert.equal(ok.accepted, true);
  assert.deepEqual(ok.confirmedFields, ['contact', 'origin']);
  assert.equal(verifyJointPortal(record, relations, 'agent-a', { id: 'RC', state: 'received', version: 2, values }).accepted, false);
  assert.equal(verifyJointPortal(record, relations, 'agent-a', { id: 'RC', state: 'draft', version: 1, values }).accepted, false);
  assert.equal(verifyJointPortal(record, relations, 'agent-b', { id: 'RC', state: 'received', version: 1, values }).accepted, false);
  assert.equal(
    verifyJointPortal(record, relations, 'agent-a', { id: 'RC', state: 'received', version: 1, values: { ...values, origin: 'JP' } }).accepted,
    false,
  );
});

test('回读期间依据被另一窗口改动可被差异检测发现', () => {
  const record = branch({ contactName: '陈晨', revision: 2 });
  const snapshot = { values: { contact: '张伟', origin: 'CN', goods: '标准件', packageCount: '120' } };
  assert.deepEqual(changedSince(record, snapshot), ['contact']);
});

test('交接视图展示各主体实际确认、仍有效部分与待人工事项', () => {
  const old = branch();
  const next = branch({ contactName: '李娜', revision: 2 });
  const decision = {
    record: next,
    decision: {
      status: 'accepted', reason: '本主体的确认已失效，可由当前账号在门户重新填报确认', at: '2026-11-19T10:00:00.000Z',
      pending: [{ subject: 'EXPORTER', branch: 'B-EXPORT', field: 'contact', awaiting: 'EXPORTER', state: STATES.SUPERSEDED, reason: 'x' }],
      portal: { id: 'RC-2' },
    },
  };
  const handover = buildHandover([next], relations, 'agent-a', [decision, { record: old, decision: { status: 'accepted', reason: '', at: '2026-11-19T09:00:00.000Z' } }]);
  const view = handover.branches[0];
  assert.equal(view.lastDecision.receipt, 'RC-2');
  assert.equal(view.confirmations[0].state, STATES.SUPERSEDED);
  assert.deepEqual(view.confirmations[0].validFields, ['origin']);
  assert.deepEqual(handover.openItems.map(item => item.field), ['contact']);
});
