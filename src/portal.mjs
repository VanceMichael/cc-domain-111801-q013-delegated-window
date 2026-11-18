import { createServer } from 'node:http';

function escape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); }

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
