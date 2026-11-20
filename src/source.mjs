import { text } from './validation.mjs';

export const collectionPath = "/window/agent";
export async function browse(client) {
  const document = await client.get(collectionPath);
  const raw = document.raw;
  const context = text(raw.principal, "principal");
  if (!Array.isArray(raw.declarations)) throw new Error('来源目录结构无效');
  const references = raw.declarations.map(entry => ({
    identity: text(entry.id, 'id'), href: text(entry.href, 'href'), context,
  }));
  if (new Set(references.map(entry => entry.identity)).size !== references.length) throw new Error('目录包含重复来源身份');
  return { context, references };
}
export async function retrieve(client, reference) {
  const document = await client.get(reference.href);
  if (document.raw.declaration !== reference.identity) throw new Error('原文身份与目录引用不符');
  if (document.raw.principal !== reference.context) throw new Error('原文上下文与目录不符');
  return document;
}

// 领取联合申报目录：除分支原文外，还给出确认范围（relations）资料的位置。
// 关联资料可能尚未发布；404/403 由调用方按“未发布”处理，不能自行解释为业务删除。
export async function browseJoint(client, path = '/window/joint') {
  const document = await client.get(path);
  const raw = document.raw;
  if (!Array.isArray(raw.declarations)) throw new Error('联合申报目录结构无效');
  const declarations = raw.declarations.map(entry => ({
    identity: text(entry.id, 'id'),
    href: text(entry.href, 'href'),
    relations: entry.relations ? text(entry.relations, 'relations') : null,
    branches: Array.isArray(entry.branches) ? entry.branches.map(item => ({
      branch: text(item.branch, 'branch'), href: text(item.href, 'branch.href'),
    })) : [],
  }));
  if (new Set(declarations.map(entry => entry.identity)).size !== declarations.length) throw new Error('目录包含重复申报身份');
  return { declarations };
}

export async function retrieveJointRecord(client, href, declaration, branch) {
  const document = await client.get(href);
  if (document.raw.declaration !== declaration) throw new Error('分支原文申报身份不符');
  if (document.raw.branch !== branch) throw new Error('分支原文分支身份不符');
  return document;
}

export async function retrieveRelations(client, href) {
  if (!href) throw new Error('确认范围资料位置缺失');
  const document = await client.get(href);
  return document;
}
