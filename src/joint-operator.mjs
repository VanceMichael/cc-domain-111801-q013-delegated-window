import { chromium } from 'playwright';
import { changedSince } from './joint.mjs';

function branchUrl(base, declaration, branch, representative) {
  return base + '/joint/' + encodeURIComponent(declaration) + '/' + encodeURIComponent(branch) +
    '?as=' + encodeURIComponent(representative);
}

async function readSnapshot(page) {
  const raw = JSON.parse(await page.locator('[data-snapshot]').innerText());
  return raw;
}

// 所有办理都通过正常界面完成：打开分支页面、只填写快照中标记可编辑的字段，
// 保存草稿与确认提交分开，每一步之后回读服务端状态；点击成功不视为已确认。
export async function operateJoint(base, record, relations, representative) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const url = branchUrl(base, record.declaration, record.branch, representative);
    await page.goto(url);
    const opening = await readSnapshot(page);
    if (!opening.editable.length) {
      return { ok: false, reason: '当前账号在该分支没有可编辑字段，不能代为填报', snapshot: opening };
    }
    // 只填门户实际开放给本账号的字段，只读控件从不触碰。
    for (const field of opening.editable) {
      const expected = field === 'contact' ? record.contactName : record[field];
      await page.getByRole('textbox', { name: field, exact: true }).fill(String(expected));
    }

    // 保存草稿可能失败（修订冲突或门户故障）；失败时保留可复核状态，不虚报。
    // 写操作成功时门户以 303 重定向回分支页面，因此按 POST 响应判断结果。
    const draftResponsePromise = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().includes('/draft'),
      { timeout: 5000 },
    ).catch(() => null);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    const draftResponse = await draftResponsePromise;
    if (!draftResponse) return { ok: false, reason: '保存草稿没有得到门户响应', snapshot: opening };
    if (draftResponse.status() === 409) {
      await page.getByText('页面依据已变化，请重新核对', { exact: true }).waitFor();
      const current = await readSnapshot(page).catch(() => null);
      const changedFields = current ? changedSince(record, current) : [];
      return { ok: false, reason: '保存草稿时页面依据已变化，需要重新核对后再办', stale: true, changedFields, snapshot: current ?? opening };
    }
    // 写操作成功时门户返回 303 重定向回分支页面；只有该状态代表保存被服务端接受。
    if (draftResponse.status() !== 303) return { ok: false, reason: '保存草稿失败（HTTP ' + draftResponse.status() + '）', snapshot: opening };
    await page.locator('[data-state]').filter({ hasText: '草稿已保存' }).waitFor();

    // 失效提示可能晚到、另一窗口可能在此期间补了共享字段：提交前再回读一次快照。
    const beforeSubmit = await readSnapshot(page);
    const drifted = changedSince(record, beforeSubmit);
    if (drifted.length) {
      return { ok: false, reason: '填写期间门户依据已变化，变化字段：' + drifted.join(','), stale: true, changedFields: drifted, snapshot: beforeSubmit };
    }

    const submitPromise = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().includes('/submit'),
      { timeout: 5000 },
    ).catch(() => null);
    await page.getByRole('button', { name: '确认提交', exact: true }).click();
    const submit = await submitPromise;
    if (!submit) return { ok: false, reason: '确认提交没有得到门户响应', snapshot: beforeSubmit };
    if (submit.status() === 409) {
      await page.getByText('页面依据已变化，请重新核对', { exact: true }).waitFor();
      const current = await readSnapshot(page).catch(() => null);
      const changedFields = current ? changedSince(record, current) : [];
      return { ok: false, reason: '确认提交时页面依据已变化，旧确认不能附在变化后的字段上', stale: true, changedFields, snapshot: current ?? beforeSubmit };
    }
    if (submit.status() !== 303) return { ok: false, reason: '确认提交被门户拒绝（HTTP ' + submit.status() + '）', snapshot: beforeSubmit };

    await page.locator('[data-state]').filter({ hasText: '已受理' }).waitFor();
    const receipt = JSON.parse(await page.locator('[data-receipt]').innerText());
    if (!receipt) return { ok: false, reason: '门户未返回受理回执，点击成功不等于已确认', snapshot: beforeSubmit };
    if (receipt.branch !== record.branch || receipt.identity !== record.declaration) {
      return { ok: false, reason: '回执业务身份与办理分支不匹配', receipt, snapshot: beforeSubmit };
    }
    if (receipt.version !== record.revision) {
      return { ok: false, reason: '回执修订号与来源依据不一致', receipt, stale: true, snapshot: beforeSubmit };
    }
    // 最终回读：回执字段必须与来源事实一致，且只包含本账号有权确认的字段。
    for (const field of opening.editable) {
      const expected = field === 'contact' ? record.contactName : record[field];
      if (String(receipt.values[field] ?? '') !== String(expected)) {
        return { ok: false, reason: '门户回读与来源不一致：' + field, receipt, snapshot: beforeSubmit };
      }
    }
    return { ok: true, receipt, editable: opening.editable, snapshot: beforeSubmit };
  } finally { await browser.close(); }
}
