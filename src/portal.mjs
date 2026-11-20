import { createServer } from 'node:http';
import { interpretRelations } from './interpret.mjs';
import { STATES, subjectFor, editableFields } from './joint.mjs';

function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); }

function renderState(state) {
  return state === 'valid' ? '仍有效'
    : state === STATES.SUPERSEDED ? '依据变化，确认失效'
      : state === STATES.REPRESENTATIVE_CHANGED ? '代表人变更，旧确认不承接'
        : '无法核对，需重新确认';
}

// 联合申报门户：按分支打开，表单只渲染当前代表人账号可编辑的字段；
// 他方字段与共享只读字段可见但不可写。确认面板展示各主体确认的实际效力。
export async function jointPortalServer(configuration) {
  const records = structuredClone(configuration.records);
  const relations = interpretRelations(configuration.relations);
  const fieldOrder = configuration.fieldOrder ?? ['origin', 'goods', 'packageCount', 'contact'];
  const versions = new Map(records.map(record => [record.branch, configuration.version ?? record.revision ?? 1]));
  const lastChanged = new Map(records.map(record => [record.branch, new Map(fieldOrder.map(field => [field, record.revision ?? 1]))]));
  const drafts = new Map();
  const receipts = new Map();
  const accesses = [];
  const faults = new Map();

  function snapshot(branch, representative) {
    const record = records.find(item => item.branch === branch);
    const version = versions.get(branch);
    const subject = subjectFor(relations, representative);
    const editable = subject ? editableFields(relations, subject) : [];
    const canEdit = subject === record.subject;
    const values = Object.fromEntries(fieldOrder.map(field => [field, record[field] ?? '']));
    const confirmations = relations.confirmations
      .filter(item => item.branch === branch)
      .map(item => {
        const changedAfter = item.fields.filter(field => (lastChanged.get(branch)?.get(field) ?? 1) > item.revision);
        const representativeChanged = !relations.subjects
          .find(entry => entry.subject === item.subject)?.representatives.includes(item.representative);
        const state = representativeChanged ? STATES.REPRESENTATIVE_CHANGED
          : changedAfter.length ? STATES.SUPERSEDED : STATES.VALID;
        return { ...item, state, changedFields: changedAfter };
      });
    return {
      branch, version, subject: record.subject, representative,
      editable: canEdit ? editable : [], readonlyFields: fieldOrder.filter(field => !(canEdit && editable.includes(field))),
      values, confirmations,
      receipt: receipts.get(branch)?.version === version ? receipts.get(branch) : null,
    };
  }

  const server = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const match = /^\/joint\/([^/]+)\/([^/]+?)(?:\/(draft|submit))?$/.exec(path);
      if (!match) { response.writeHead(404); response.end('资料不存在'); return; }
      const declaration = decodeURIComponent(match[1]);
      const branch = decodeURIComponent(match[2]);
      const record = records.find(item => item.declaration === declaration && item.branch === branch);
      if (!record || declaration !== relations.declaration) { response.writeHead(404); response.end('资料不存在'); return; }
      const representative = url.searchParams.get('as') ?? '';
      const operation = match[3] ?? 'view';
      accesses.push({ method: request.method, declaration, branch, operation, representative });
      const fault = faults.get(operation);
      if (fault?.remaining > 0) {
        fault.remaining -= 1;
        response.writeHead(fault.status); response.end('门户暂时不可用'); return;
      }
      const version = versions.get(branch);
      const subject = subjectFor(relations, representative);

      if (request.method === 'POST') {
        let body = '';
        for await (const part of request) { body += part; if (body.length > 65536) throw new Error('表单过大'); }
        const input = new URLSearchParams(body);
        if (!subject || subject !== record.subject) {
          response.writeHead(403); response.end('当前账号无权编辑该分支，受托代理不能替其他主体签名'); return;
        }
        if (Number(input.get('version')) !== version) {
          // 冲突页同样给出当前快照与提示文本，供自动化回读实际依据而不是凭点击判断。
          const current = snapshot(branch, representative);
          response.writeHead(409, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><html lang="zh"><body><p>页面依据已变化，请重新核对</p><pre data-snapshot>' +
            escape(JSON.stringify(current)) + '</pre></body></html>');
          return;
        }
        const allowed = editableFields(relations, subject);
        // 只读控件会随表单回显；仅当回传值试图改动当前记录时才拒绝，
        // 与当前依据一致的回显不构成越权写入，真正的篡改仍被挡下。
        for (const key of input.keys()) {
          if (key === 'version') continue;
          if (!allowed.includes(key) && String(record[key] ?? '') !== String(input.get(key) ?? '')) {
            response.writeHead(403); response.end('字段对当前账号只读：' + key); return;
          }
        }
        const values = Object.fromEntries(allowed.map(field => [field, input.get(field) ?? record[field] ?? '']));
        if (operation === 'draft') {
          drafts.set(branch, { version, values, representative });
        } else if (operation === 'submit') {
          const draft = drafts.get(branch);
          if (!draft || draft.version !== version || draft.representative !== representative) {
            const current = snapshot(branch, representative);
            response.writeHead(409, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><html lang="zh"><body><p>页面依据已变化，请重新核对</p><pre data-snapshot>' +
              escape(JSON.stringify(current)) + '</pre></body></html>');
            return;
          }
          const receipt = {
            id: 'RC-' + declaration + '-' + branch + '-' + version,
            identity: declaration, branch, version, state: 'received',
            subject, representative, values: { ...record, ...values },
          };
          receipts.set(branch, receipt);
          drafts.delete(branch);
        } else { response.writeHead(405); response.end('操作不支持'); return; }
        response.writeHead(303, { location: '/joint/' + encodeURIComponent(declaration) + '/' + encodeURIComponent(branch) + '?as=' + encodeURIComponent(representative) });
        response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }

      const view = snapshot(branch, representative);
      const draft = drafts.get(branch);
      const shownValues = draft?.version === version ? { ...view.values, ...draft.values } : view.values;
      const inputs = fieldOrder.map(field => {
        const canEdit = view.editable.includes(field);
        const shared = relations.shared.includes(field) ? '（共享字段）' : '';
        if (canEdit) {
          return '<label>' + escape(field) + shared + '<input name="' + escape(field) + '" aria-label="' + escape(field) + '" value="' + escape(shownValues[field] ?? '') + '"></label>';
        }
        return '<label>' + escape(field) + shared + '<input name="' + escape(field) + '" aria-label="' + escape(field) + '" value="' + escape(shownValues[field] ?? '') + '" readonly></label>';
      }).join('');
      const panels = view.confirmations.map(item =>
        '<fieldset data-confirmation data-state="' + escape(item.state) + '"><legend>主体 ' + escape(item.subject) + ' 的确认</legend>' +
        '<p>代表人：' + escape(item.representative) + '；修订：' + item.revision + '；字段：' + escape(item.fields.join(',')) + '</p>' +
        '<p data-confirmation-state>' + renderState(item.state) + (item.changedFields.length ? '（失效字段：' + escape(item.changedFields.join(',')) + '）' : '') + '</p></fieldset>').join('');
      // 提交成功后草稿即被消费；当前版本仍有草稿时显示草稿态，否则以回执为准。
      const stateText = draft && draft.version === version ? '草稿已保存' : view.receipt ? '已受理' : '未办理';
      const base = '/joint/' + encodeURIComponent(declaration) + '/' + encodeURIComponent(branch);
      response.writeHead(200);
      response.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>联合申报门户</title></head><body>' +
        '<h1>联合申报 ' + escape(declaration) + ' / 分支 ' + escape(branch) + '</h1>' +
        '<p>当前账号：' + escape(representative || '（未指定）') + '；法定主体：' + escape(subject ?? '无') + '</p>' +
        '<p data-state>' + stateText + '</p>' +
        '<form method="post" action="' + base + '/draft?as=' + encodeURIComponent(representative) + '">' +
        '<input type="hidden" name="version" value="' + version + '">' + inputs + '<button>保存草稿</button></form>' +
        '<form method="post" action="' + base + '/submit?as=' + encodeURIComponent(representative) + '">' +
        '<input type="hidden" name="version" value="' + version + '"><button>确认提交</button></form>' +
        panels +
        '<pre data-snapshot>' + escape(JSON.stringify(view)) + '</pre>' +
        '<pre data-receipt>' + escape(view.receipt ? JSON.stringify(view.receipt) : '') + '</pre></body></html>');
    } catch (error) { response.writeHead(400); response.end('页面请求失败：' + error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    accesses,
    snapshot(branch, representative) { return structuredClone(snapshot(branch, representative)); },
    receipt(branch) { return structuredClone(receipts.get(branch)); },
    fail(operation, status = 503, remaining = 1) { faults.set(operation, { status, remaining }); },
    // 模拟人工/另一窗口的合法修订：修订号递增并登记每个变化字段的最后变更修订。
    revise(branch, changes) {
      const record = records.find(item => item.branch === branch);
      const touched = new Map(lastChanged.get(branch));
      for (const [field, value] of Object.entries(changes)) {
        if (record[field] !== value) { record[field] = value; touched.set(field, versions.get(branch) + 1); }
      }
      versions.set(branch, versions.get(branch) + 1);
      lastChanged.set(branch, touched);
    },
    close() { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); },
  };
}

// 既有单条资料门户，保持原有界面与行为。
export async function portalServer(configuration) {
  const records = structuredClone(configuration.records);
  const versions = new Map(Object.keys(records).map(identity => [identity, configuration.version ?? 1]));
  const drafts = new Map();
  const receipts = new Map();
  const accesses = [];
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const path = new URL(request.url, 'http://localhost').pathname;
      const match = /^\/portal\/([^/]+)(?:\/(draft|submit))?$/.exec(path);
      if (!match || !Object.hasOwn(records, decodeURIComponent(match[1]))) { response.writeHead(404); response.end('资料不存在'); return; }
      const identity = decodeURIComponent(match[1]);
      const record = records[identity];
      accesses.push({ method: request.method, identity, operation: match[2] ?? 'view' });
      const version = versions.get(identity);
      if (request.method === 'POST') {
        let body = '';
        for await (const part of request) { body += part; if (body.length > 65536) throw new Error('表单过大'); }
        const input = new URLSearchParams(body);
        if (Number(input.get('version')) !== version) { response.writeHead(409); response.end('页面依据已变化，请重新核对'); return; }
        const values = Object.fromEntries(input);
        if (match[2] === 'draft') drafts.set(identity, { version, values });
        else if (match[2] === 'submit') {
          const draft = drafts.get(identity);
          if (!draft || draft.version !== version) { response.writeHead(409); response.end('尚无与当前依据一致的草稿'); return; }
          const receipt = { id: 'RC-' + identity + '-' + version, identity, version, values: draft.values, state: 'received' };
          receipts.set(identity, receipt);
        } else { response.writeHead(405); response.end('操作不支持'); return; }
        response.writeHead(303, { location: '/portal/' + encodeURIComponent(identity) }); response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const draft = drafts.get(identity);
      const values = draft?.version === version ? draft.values : record;
      const inputs = Object.entries(record).filter(([, value]) => !Array.isArray(value) && (typeof value !== 'object' || value === null)).map(([name, value]) =>
        '<label>' + escape(name) + '<input name="' + escape(name) + '" aria-label="' + escape(name) + '" value="' + escape(values[name] ?? value) + '"></label>').join('');
      const relations = Array.isArray(record.associations) ? record.associations.map((item, index) => '<fieldset><legend>关联实物 ' + escape(item.id) + '</legend><label>关联归属<input name="relation-' + index + '" value="' + escape(item.owner ?? '') + '"></label><label>去向<select name="disposition-' + index + '"><option>待确认</option><option>接纳</option><option>消耗</option><option>留样</option><option>回收</option></select></label></fieldset>').join('') : '';
      const receipt = receipts.get(identity);
      const state = receipt?.version === version ? '已受理' : receipt ? '依据变化，原确认失效' : draft ? '草稿已保存' : '未办理';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>合作资料门户</title></head><body><h1>资料办理</h1><p data-state>' + state + '</p><form method="post" action="/portal/' + encodeURIComponent(identity) + '/draft"><input type="hidden" name="version" value="' + version + '">' + inputs + relations + '<button>保存草稿</button></form><form method="post" action="/portal/' + encodeURIComponent(identity) + '/submit"><input type="hidden" name="version" value="' + version + '"><button>确认提交</button></form><pre data-receipt>' + escape(receipt && receipt.version === version ? JSON.stringify(receipt) : '') + '</pre></body></html>');
    } catch (error) { response.writeHead(400); response.end('页面请求失败：' + error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, accesses,
    revise(identity, changes) { Object.assign(records[identity], structuredClone(changes)); versions.set(identity, versions.get(identity) + 1); },
    receipt(identity) { return structuredClone(receipts.get(identity)); },
    close() { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); },
  };
}
