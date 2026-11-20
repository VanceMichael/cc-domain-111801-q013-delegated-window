import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collectJoint, handover } from '../src/app.mjs';
import { jointPortalServer } from '../src/portal.mjs';
import { operateJoint } from '../src/joint-operator.mjs';

// 协作填报演示：
// 1. 出口商账号（agent-a）只办理自己的分支，生产商分支只读；
// 2. 来源发布共享字段 origin 的更正，生产商确认失效，出口商分支继续办理；
// 3. 恢复办理时通过交接视图查看各主体确认的实际效力与待人工事项。
const fixture = JSON.parse(await readFile(new URL('../fixtures/joint.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);
const portal = await jointPortalServer(fixture.jointPortal);
const directory = await mkdtemp(join(tmpdir(), 'joint-window-'));
const archive = await new Archive(directory).start();
const operator = (record, relations, representative) => operateJoint(portal.url, record, relations, representative);
try {
  console.log('== 第一轮：当前依据下的协作填报 ==');
  const first = await collectJoint(new SourceClient(source.url), archive, fixture.representative, operator);
  console.log(JSON.stringify(first, null, 2));

  console.log('== 来源更正共享字段 origin（生产商分支 CN -> VN）==');
  source.replace('/window/joint/JDEC1/B-FACTORY', {
    body: { ...fixture.resources['/window/joint/JDEC1/B-FACTORY'].body, origin: 'VN', revision: 2 },
  });
  const second = await collectJoint(new SourceClient(source.url), archive, fixture.representative, operator);
  console.log(JSON.stringify({ complete: second.complete, counts: second.counts }, null, 2));
  const factory = second.outcomes.find(item => item.branch === 'B-FACTORY');
  console.log('生产商分支待办：', JSON.stringify(factory.pending, null, 2));

  console.log('== 交接视图：各主体确认效力与待人工事项 ==');
  const view = await handover(new SourceClient(source.url), archive, fixture.representative);
  console.log(JSON.stringify(view, null, 2));

  if (second.complete) process.exitCode = 1; // 存在待生产商重新确认事项，整单不应报完成
} finally {
  archive.close();
  await source.close();
  await portal.close();
  await rm(directory, { recursive: true, force: true });
}
