import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { jointPortalServer } from '../src/portal.mjs';
import { operateJoint } from '../src/joint-operator.mjs';
import { interpretJoint, interpretRelations } from '../src/interpret.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/joint.json', import.meta.url), 'utf8'));
const records = fixture.jointPortal.records.map(interpretJoint);
const relations = interpretRelations(fixture.jointPortal.relations);
const exporter = records.find(item => item.branch === 'B-EXPORT');
const factory = records.find(item => item.branch === 'B-FACTORY');

test('门户只向当前账号开放可编辑字段，他方字段只读', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(portal.url + '/joint/JDEC1/B-EXPORT?as=agent-a');
    const snapshot = JSON.parse(await page.locator('[data-snapshot]').innerText());
    assert.deepEqual(snapshot.editable, ['contact', 'origin']);
    assert.ok(snapshot.readonlyFields.includes('goods'));
    const goods = page.getByRole('textbox', { name: 'goods', exact: true });
    assert.equal(await goods.getAttribute('readonly'), '');
    // 服务端同样强制：直接 POST 只读字段必须被拒绝
    const forbidden = await fetch(portal.url + '/joint/JDEC1/B-EXPORT/draft?as=agent-a', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'version=1&goods=越权填报',
    });
    assert.equal(forbidden.status, 403);
  } finally { await browser.close(); await portal.close(); }
});

test('受托代理不能替其他主体签名：跨分支提交被拒绝', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(portal.url + '/joint/JDEC1/B-FACTORY?as=agent-a');
    const snapshot = JSON.parse(await page.locator('[data-snapshot]').innerText());
    assert.deepEqual(snapshot.editable, []);
    const response = await page.getByRole('button', { name: '保存草稿', exact: true }).click().then(() => null).catch(() => null);
    assert.equal(response, null);
  } finally { await browser.close(); await portal.close(); }
});

test('正常录入后以门户最终回读作为受理依据', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  try {
    const result = await operateJoint(portal.url, exporter, relations, 'agent-a');
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.editable, ['contact', 'origin']);
    const receipt = portal.receipt('B-EXPORT');
    assert.equal(receipt.id, result.receipt.id);
    assert.equal(receipt.representative, 'agent-a');
    assert.ok(portal.accesses.some(entry => entry.operation === 'submit'));
  } finally { await portal.close(); }
});

test('保存草稿遇到修订冲突时不虚报成功，返回待重新核对', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const promise = operateJoint(portal.url, exporter, relations, 'agent-a');
    // 在自动化填写期间，另一窗口合法修订了同一分支
    await new Promise(resolve => setTimeout(resolve, 150));
    portal.revise('B-EXPORT', { contact: '陈晨' });
    const result = await promise.finally(() => browser.close());
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.match(result.reason, /依据已变化/);
    assert.equal(portal.receipt('B-EXPORT'), undefined);
  } finally { await portal.close(); }
});

test('失效提示晚到：另一窗口在填写期间补了共享字段，提交前回读阻断', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    // 门户确认面板初始显示生产商确认有效
    const initial = await browser.newPage();
    await initial.goto(portal.url + '/joint/JDEC1/B-FACTORY?as=agent-a');
    assert.equal(JSON.parse(await initial.locator('[data-snapshot]').innerText()).confirmations[0].state, 'valid');
    await initial.close();

    // 自动化开始按当前依据办理出口商分支；办理期间另一窗口更正了共享字段 origin
    const promise = operateJoint(portal.url, exporter, relations, 'agent-a');
    await new Promise(resolve => setTimeout(resolve, 120));
    portal.revise('B-EXPORT', { origin: 'VN' });
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.stale, true);
    assert.ok(result.changedFields.includes('origin'));
    assert.equal(portal.receipt('B-EXPORT'), undefined);

    // 恢复办理：依据回读已经是新值，任何旧页面提交都会被修订号挡下
    const stale = await browser.newPage();
    await stale.goto(portal.url + '/joint/JDEC1/B-EXPORT?as=agent-a');
    const replayed = await fetch(portal.url + '/joint/JDEC1/B-EXPORT/submit?as=agent-a', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'version=1&origin=VN&contact=' + encodeURIComponent('张伟'),
    });
    assert.equal(replayed.status, 409);
    await stale.close();
  } finally { await browser.close(); await portal.close(); }
});

test('共享字段更正后门户确认面板显示生产商确认失效，出口商分支仍可办理', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    portal.revise('B-FACTORY', { origin: 'VN' });
    const page = await browser.newPage();
    await page.goto(portal.url + '/joint/JDEC1/B-FACTORY?as=agent-a');
    const panel = page.locator('[data-confirmation]').filter({ hasText: 'PRODUCER' });
    await panel.locator('[data-confirmation-state]').filter({ hasText: '确认失效' }).waitFor();
    const snapshot = JSON.parse(await page.locator('[data-snapshot]').innerText());
    assert.equal(snapshot.confirmations.find(item => item.subject === 'PRODUCER').state, 'superseded');
    // 出口商分支不受影响
    const own = await operateJoint(portal.url, exporter, relations, 'agent-a');
    assert.equal(own.ok, true);
  } finally { await browser.close(); await portal.close(); }
});

test('门户保存故障时自动化返回阻断状态而不是写出已确认', async () => {
  const portal = await jointPortalServer(fixture.jointPortal);
  try {
    portal.fail('draft', 503, 1);
    const result = await operateJoint(portal.url, exporter, relations, 'agent-a');
    assert.equal(result.ok, false);
    assert.match(result.reason, /保存草稿失败/);
    assert.equal(portal.receipt('B-EXPORT'), undefined);
  } finally { await portal.close(); }
});

test('代表人变更后门户显示旧代表人确认不承接，新账号须重新确认', async () => {
  const switched = structuredClone(fixture.jointPortal);
  switched.relations.subjects[0].representatives = ['agent-a2'];
  switched.records[0] = { ...switched.records[0], representative: 'agent-a2' };
  const portal = await jointPortalServer(switched);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(portal.url + '/joint/JDEC1/B-EXPORT?as=agent-a2');
    const panel = page.locator('[data-confirmation]').filter({ hasText: 'EXPORTER' });
    await panel.locator('[data-confirmation-state]').filter({ hasText: '代表人变更' }).waitFor();
    const snapshot = JSON.parse(await page.locator('[data-snapshot]').innerText());
    assert.equal(snapshot.confirmations[0].state, 'representative-changed');
  } finally { await browser.close(); await portal.close(); }
});
