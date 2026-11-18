import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (typeof raw.approved !== 'boolean' || !/^[A-Z]{2}$/.test(raw.origin ?? '')) throw new Error('申报授权或原产地无效');
           return { declaration: text(raw.declaration, 'declaration'), principal: text(raw.principal, 'principal'), branch: text(raw.branch, 'branch'), contact: text(raw.contact, 'contact'), origin: raw.origin, approved: raw.approved };
}
