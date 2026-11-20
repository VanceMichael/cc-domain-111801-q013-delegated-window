import { text, integer, textList } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (typeof raw.approved !== 'boolean' || !/^[A-Z]{2}$/.test(raw.origin ?? '')) throw new Error('申报授权或原产地无效');
  return { declaration: text(raw.declaration, 'declaration'), principal: text(raw.principal, 'principal'), branch: text(raw.branch, 'branch'), contact: text(raw.contact, 'contact'), origin: raw.origin, approved: raw.approved };
}

// 联合申报的分支记录：法定主体身份以 subject 编码为准，联系人姓名只是展示字段，
// 同名联系人不构成相同法定主体。
export function interpretJoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('联合申报记录不是对象');
  if (typeof raw.approved !== 'boolean') throw new Error('分支字段核准标记无效');
  const record = {
    declaration: text(raw.declaration, 'declaration'),
    branch: text(raw.branch, 'branch'),
    subject: text(raw.subject, 'subject'),
    representative: text(raw.representative, 'representative'),
    contact: text(raw.contact, 'contact'),
    origin: text(raw.origin, 'origin'),
    goods: text(raw.goods, 'goods'),
    packageCount: text(raw.packageCount, 'packageCount'),
    approved: raw.approved,
    revision: integer(raw.revision, 'revision'),
    contactName: text(raw.contactName ?? raw.contact, 'contactName'),
  };
  return record;
}

// 解释各主体核准字段与确认范围。结构中同时给出门户可编辑范围（editable）、
// 共享字段（shared）以及已记录的确认（confirmations）。
export function interpretRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('确认范围资料不是对象');
  const declaration = text(raw.declaration, 'declaration');
  const shared = textList(raw.shared, 'shared');
  const subjects = [];
  if (!Array.isArray(raw.subjects)) throw new Error('主体范围缺失或无效');
  for (const item of raw.subjects) {
    if (!item || typeof item !== 'object') throw new Error('主体范围条目不是对象');
    const subject = {
      subject: text(item.subject, 'subject'),
      representatives: textList(item.representatives, 'representatives'),
      editable: textList(item.editable, 'editable'),
    };
    if (subject.editable.some(field => field.includes('.'))) throw new Error('可编辑字段名不合法');
    subjects.push(subject);
  }
  const confirmations = [];
  if (!Array.isArray(raw.confirmations)) throw new Error('确认清单缺失或无效');
  for (const item of raw.confirmations) {
    if (!item || typeof item !== 'object') throw new Error('确认条目不是对象');
    confirmations.push({
      subject: text(item.subject, 'confirmation.subject'),
      branch: text(item.branch, 'confirmation.branch'),
      representative: text(item.representative, 'confirmation.representative'),
      fields: textList(item.fields, 'confirmation.fields'),
      revision: integer(item.revision, 'confirmation.revision'),
    });
  }
  const known = new Set(subjects.map(item => item.subject));
  for (const item of confirmations) {
    if (!known.has(item.subject)) throw new Error('确认引用了未登记的法定主体：' + item.subject);
  }
  return { declaration, shared, subjects, confirmations };
}
