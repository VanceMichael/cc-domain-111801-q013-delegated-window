export function assess(record, previous, scope) {
  if (record.principal !== scope) return { status: 'outside', reason: '不是受托账号所属主体' };
           if (!record.approved) return { status: 'review', reason: '来源字段未核准' };
           const prior = previous.find(item => item.declaration === record.declaration && item.branch === record.branch && item.contact !== record.contact);
           if (prior) return { status: 'conflict', reason: '同一分支联系人存在不同核准值' };
           return { status: 'accepted', key: record.declaration + ':' + record.branch, facts: { declaration: record.declaration, principal: record.principal, branch: record.branch, contact: record.contact } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}

export function verifyPortal(record, receipt) {
  if (!receipt || receipt.state !== 'received' || !receipt.values || !Number.isInteger(receipt.version)) {
    return { accepted: false, reason: '门户没有给出可核对的受理依据' };
  }
  if (receipt.values.declaration !== String(record.declaration)) return { accepted: false, reason: '受理依据中的 declaration 不一致' };
  if (receipt.values.principal !== String(record.principal)) return { accepted: false, reason: '受理依据中的 principal 不一致' };
  if (receipt.values.branch !== String(record.branch)) return { accepted: false, reason: '受理依据中的 branch 不一致' };
  if (receipt.values.contact !== String(record.contact)) return { accepted: false, reason: '受理依据中的 contact 不一致' };
  return { accepted: true, receipt: receipt.id };
}
