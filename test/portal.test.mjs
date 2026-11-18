import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { portalServer } from '../src/portal.mjs';
import { operate } from '../src/operator.mjs';
import { verifyPortal } from '../src/receiving.mjs';
import { interpret } from '../src/interpret.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const raw = Object.values(fixture.portal.records)[0];

test('浏览器正常录入后回读实际受理内容', async () => {
  const portal = await portalServer(fixture.portal);
  try {
    const receipt = await operate(portal.url, interpret(raw));
    assert.equal(receipt.identity, raw.declaration);
    assert.equal(portal.receipt(raw.declaration).id, receipt.id);
    assert.ok(portal.accesses.some(entry => entry.operation === 'draft'));
    assert.ok(portal.accesses.some(entry => entry.operation === 'submit'));
  } finally { await portal.close(); }
});

test('旧页面依据不能覆盖人工合法修订', async () => {
  const portal = await portalServer(fixture.portal);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(portal.url + '/portal/' + raw.declaration);
    portal.revise(raw.declaration, { operatorNote: '现场已补正' });
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('页面依据已变化，请重新核对', { exact: true }).waitFor();
    assert.equal(portal.receipt(raw.declaration), undefined);
  } finally { await browser.close(); await portal.close(); }
});

test('页面点击成功不能替代领域受理核对', () => {
  const record = interpret(raw);
  const values = Object.fromEntries(Object.entries(record).map(([name, value]) => [name, String(value)]));
  const valid = { id: 'RC', state: 'received', version: 1, values };
  assert.equal(verifyPortal(record, valid).accepted, true);
  assert.equal(verifyPortal(record, { ...valid, state: 'draft' }).accepted, false);
  assert.equal(verifyPortal(record, { ...valid, values: { ...values, declaration: 'different' } }).accepted, false);
  assert.equal(verifyPortal(record, { ...valid, values: { ...values, principal: 'different' } }).accepted, false);
  assert.equal(verifyPortal(record, { ...valid, values: { ...values, branch: 'different' } }).accepted, false);
  assert.equal(verifyPortal(record, { ...valid, values: { ...values, contact: 'different' } }).accepted, false);
});
