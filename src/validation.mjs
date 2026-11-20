export function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('字段缺失或无效：' + name);
  return value;
}
export function decimal(value, name) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('十进制字段无效：' + name);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('数值超出范围：' + name);
  return result;
}
export function integer(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('整数字段无效：' + name);
  return value;
}
export function textList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('字段列表缺失或无效：' + name);
  return value.map(item => text(item, name + '[]'));
}
