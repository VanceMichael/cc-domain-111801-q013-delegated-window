import test from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/interpret.mjs';
import { assess, summarize } from '../src/receiving.mjs';
const raw = {"declaration": "DEC1", "principal": "AGENT-A", "branch": "CONTACT", "contact": "合成联系人", "origin": "CN", "approved": true};
const scope = "AGENT-A";

test('领域记录保留明确的来源上下文', () => {
  const actual = interpret(raw);
  assert.equal(actual.principal, raw.principal);
  assert.equal(assess(actual, [actual], scope).status, 'accepted');
});
test('同一业务依据发生矛盾时不能覆盖接收', () => {
  const first = interpret(raw);
  const changed = interpret({"declaration": "DEC1", "principal": "AGENT-A", "branch": "CONTACT", "contact": "不同联系人", "origin": "CN", "approved": true});
  assert.equal(assess(changed, [first], scope).status, 'conflict');
});
test('空目录与范围外内容不声明完成', () => {
  assert.equal(summarize([]).complete, false);
  const outcome = assess(interpret(raw), [], 'other-scope');
  assert.equal(summarize([outcome]).complete, false);
  assert.equal(summarize([outcome]).counts.outside, 1);
});
test('缺少领域核准或接纳依据时保留待处理', () => {
  assert.notEqual(assess(interpret({"declaration": "DEC1", "principal": "AGENT-A", "branch": "CONTACT", "contact": "合成联系人", "origin": "CN", "approved": false}), [], scope).status, 'accepted');
});
