import { chromium } from 'playwright';

export async function operate(base, record) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(base + '/portal/' + encodeURIComponent(record.declaration));
    for (const [name, value] of Object.entries(record)) {
      if (value !== null && typeof value !== 'object') await page.getByRole('textbox', { name, exact: true }).fill(String(value));
    }
    await Promise.all([page.waitForURL('**/portal/*'), page.getByRole('button', { name: '保存草稿', exact: true }).click()]);
    await page.locator('[data-state]').filter({ hasText: '草稿已保存' }).waitFor();
    await page.getByRole('button', { name: '确认提交', exact: true }).click();
    await page.locator('[data-state]').filter({ hasText: '已受理' }).waitFor();
    const receipt = JSON.parse(await page.locator('[data-receipt]').innerText());
    if (receipt.identity !== record.declaration) throw new Error('门户回执业务身份不匹配');
    for (const [name, value] of Object.entries(record)) {
      if (value !== null && typeof value !== 'object' && receipt.values[name] !== String(value)) throw new Error('门户回读与来源不一致：' + name);
    }
    return receipt;
  } finally { await browser.close(); }
}
