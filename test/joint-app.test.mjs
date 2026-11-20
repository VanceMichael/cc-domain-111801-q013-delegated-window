import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { collectJoint, handover } from '../src/app.mjs';
import { jointPortalServer } from '../src/portal.mjs';
import { operateJoint } from '../src/joint-operator.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/joint.json', import.meta.url), 'utf8'));

async function freshEnvironment() {
  const source = await fixtureSource(fixture);
  const portal = await jointPortalServer(fixture.jointPortal);
  const directory = await mkdtemp(join(tmpdir(), 'joint-'));
  const archive = await new Archive(directory).start();
  return {
    source, portal, archive, directory,
    client: () => new SourceClient(source.url),
    operator: (record, relations, representative) => operateJoint(portal.url, record, relations, representative),
    cleanup: async () => { archive.close(); await source.close(); await portal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('协作填报只自动办理本账号分支，他方分支留只读待办且不阻断', async () => {
  const env = await freshEnvironment();
  try {
    const result = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    // 双方确认均有效时整单完整；他方分支只是只读，没有待重新确认事项
    assert.equal(result.complete, true);
    const own = result.outcomes.find(item => item.branch === 'B-EXPORT');
    const other = result.outcomes.find(item => item.branch === 'B-FACTORY');
    assert.equal(own.status, 'accepted');
    assert.ok(own.receipt, '本账号分支以门户回执作为受理依据');
    assert.deepEqual(own.confirmedFields, ['contact', 'origin']);
    assert.equal(other.status, 'outside');
    assert.equal(other.pending.length, 0);
    assert.equal(env.portal.receipt('B-FACTORY'), undefined);
    // 资料库按主体范围分别落库，原文与决策都可复查
    const stored = env.archive.records('agent-a');
    assert.equal(stored.length, 2);
    assert.ok(stored.every(item => item.decision.kind === 'joint'));
  } finally { await env.cleanup(); }
});

test('共享字段更正后旧确认失效被登记为待生产商重新确认，出口商分支继续办理', async () => {
  const env = await freshEnvironment();
  try {
    // 第一轮：双方确认均有效，出口商分支完成
    const first = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    assert.equal(first.outcomes.find(item => item.branch === 'B-EXPORT').status, 'accepted');

    // 来源发布修订：共享字段 origin 在生产商分支更正为 VN
    env.source.replace('/window/joint/JDEC1/B-FACTORY', {
      body: { ...fixture.resources['/window/joint/JDEC1/B-FACTORY'].body, origin: 'VN', revision: 2 },
    });
    const second = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    const factory = second.outcomes.find(item => item.branch === 'B-FACTORY');
    const exporter = second.outcomes.find(item => item.branch === 'B-EXPORT');
    assert.equal(factory.status, 'outside');
    const originPending = factory.pending.find(item => item.field === 'origin');
    assert.ok(originPending);
    assert.equal(originPending.awaiting, 'PRODUCER');
    // 无关的出口商分支不受影响，仍可办理
    assert.equal(exporter.status, 'accepted');
    assert.equal(second.complete, false);
  } finally { await env.cleanup(); }
});

test('恢复办理时旧确认不会附在变化后的字段上，交接视图展示效力与待办', async () => {
  const env = await freshEnvironment();
  try {
    await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    env.source.replace('/window/joint/JDEC1/B-EXPORT', {
      body: { ...fixture.resources['/window/joint/JDEC1/B-EXPORT'].body, contact: '李娜', contactName: '李娜', revision: 2 },
    });
    await collectJoint(env.client(), env.archive, 'agent-a', env.operator);

    const view = await handover(env.client(), env.archive, 'agent-a');
    const branch = view.declarations[0].branches.find(item => item.branch === 'B-EXPORT');
    const confirmation = branch.confirmations.find(item => item.subject === 'EXPORTER');
    assert.equal(confirmation.state, 'superseded');
    assert.deepEqual(confirmation.validFields, ['origin']);
    assert.deepEqual(confirmation.invalidFields, ['contact']);
    assert.deepEqual(view.declarations[0].openItems.map(item => item.field), ['contact']);
    // 历次原文仍在，恢复依据的是实际落库历史而不是记忆中的“已确认”
    const stored = env.archive.records('agent-a').filter(item => item.record.branch === 'B-EXPORT');
    assert.equal(stored.length, 2);
  } finally { await env.cleanup(); }
});

test('同名联系人不会被识别为同一法定主体', async () => {
  const env = await freshEnvironment();
  try {
    env.source.replace('/window/joint/JDEC1/B-FACTORY', {
      body: { ...fixture.resources['/window/joint/JDEC1/B-FACTORY'].body },
    });
    const result = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    const exporter = result.outcomes.find(item => item.branch === 'B-EXPORT');
    const factory = result.outcomes.find(item => item.branch === 'B-FACTORY');
    assert.notEqual(exporter.subject, factory.subject);
    assert.equal(factory.subject, 'PRODUCER');
    assert.equal(factory.status, 'outside');
  } finally { await env.cleanup(); }
});

test('确认范围资料未发布时不虚报完成，登记错误并保留其余分支处理', async () => {
  const env = await freshEnvironment();
  try {
    env.source.replace('/window/joint/JDEC1/relations', { status: 404, body: { error: '未发布' } });
    const result = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    assert.equal(result.complete, false);
    assert.equal(result.outcomes[0].status, 'error');
    assert.match(result.outcomes[0].reason, /来源请求未成功|确认范围/);
    assert.equal(env.archive.records('agent-a').length, 0);
  } finally { await env.cleanup(); }
});

test('来源故障导致分支缺件时该分支报错，其他分支照常办理', async () => {
  const env = await freshEnvironment();
  try {
    env.source.fail('/window/joint/JDEC1/B-FACTORY', 503, 1);
    // 第二次仍失败则永久缺件
    env.source.fail('/window/joint/JDEC1/B-FACTORY', 404, 10);
    const result = await collectJoint(env.client(), env.archive, 'agent-a', env.operator);
    const failed = result.outcomes.find(item => item.branch === 'B-FACTORY');
    const exporter = result.outcomes.find(item => item.branch === 'B-EXPORT');
    assert.equal(failed.status, 'error');
    assert.equal(exporter.status, 'accepted');
  } finally { await env.cleanup(); }
});
