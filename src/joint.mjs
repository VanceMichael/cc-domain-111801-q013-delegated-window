// 联合申报协作填报的领域规则。
//
// 核心约束：
// - 法定主体以 subject 编码识别，联系人姓名只用于展示；同名联系人不是同一主体。
// - 确认与“主体 + 分支 + 代表人 + 字段值所在修订”绑定；代表人变更不承接旧确认，
//   字段在确认之后发生变化，旧确认也不能重新附在变化后的字段上。
// - 共享字段更正会使所有确认过该字段的主体确认失效；分支互不影响，无关分支继续可办。
// - 自动化只处理当前账号有权编辑的字段；他方已确认事实受影响时只登记“待谁重新确认”，
//   受托代理不能替别的主体重新签名。

export const FIELDS = ['origin', 'goods', 'packageCount', 'contact'];
export const STATES = Object.freeze({
  VALID: 'valid',
  SUPERSEDED: 'superseded',
  REPRESENTATIVE_CHANGED: 'representative-changed',
  UNVERIFIABLE: 'unverifiable',
});

function fieldValue(record, field) {
  if (!FIELDS.includes(field)) throw new Error('未知字段：' + field);
  if (field === 'contact') return record.contactName;
  return record[field];
}

// 当前账号（代表人）所属的法定主体。代表人身份不按联系人姓名推断。
export function subjectFor(relations, representative) {
  const match = relations.subjects.filter(item => item.representatives.includes(representative));
  if (match.length > 1) throw new Error('代表人同时登记在多个法定主体名下');
  return match[0]?.subject ?? null;
}

// 门户只应开放当前账号可编辑的字段；共享字段若不在该主体 editable 中则只读。
export function editableFields(relations, subject) {
  const entry = relations.subjects.find(item => item.subject === subject);
  return entry ? [...entry.editable] : [];
}

// 来源修订号之后、依据最后一次回读期间发生的字段变化（用于门户并发场景）。
export function changedSince(record, snapshot) {
  const changed = [];
  for (const field of FIELDS) {
    if (snapshot.values[field] !== fieldValue(record, field)) changed.push(field);
  }
  return changed;
}

function changedFields(record, history) {
  // history: 同一主体同分支的既往分支记录（含 revision，按落库顺序），用于核对旧确认。
  const changed = new Set();
  for (const past of history) {
    for (const field of FIELDS) {
      if (fieldValue(past, field) !== fieldValue(record, field)) changed.add(field);
    }
  }
  return changed;
}

// 评估单条历史确认对当前记录的效力。
export function evaluateConfirmation(record, relations, confirmation, history = []) {
  if (confirmation.subject !== record.subject || confirmation.branch !== record.branch) {
    return { ...confirmation, state: STATES.UNVERIFIABLE, reason: '确认不属于当前主体与分支', validFields: [] };
  }
  const entry = relations.subjects.find(item => item.subject === record.subject);
  const currentRepresentative = record.representative;
  if (!entry?.representatives.includes(currentRepresentative)) {
    return { ...confirmation, state: STATES.UNVERIFIABLE, reason: '当前代表人未登记在该法定主体名下', validFields: [] };
  }
  if (confirmation.representative !== currentRepresentative) {
    return { ...confirmation, state: STATES.REPRESENTATIVE_CHANGED, reason: '代表人已变更，旧代表人的确认不承接', validFields: [] };
  }
  if (confirmation.revision > record.revision) {
    return { ...confirmation, state: STATES.UNVERIFIABLE, reason: '确认修订号晚于来源依据，无法核对', validFields: [] };
  }
  // 只能依据实际保存过的历史原文判断字段是否变化；没有历史原文时不得默认旧确认仍然有效。
  const knownRevisions = new Set(history.map(item => item.revision));
  if (!knownRevisions.has(confirmation.revision) && confirmation.revision !== record.revision) {
    return { ...confirmation, state: STATES.UNVERIFIABLE, reason: '缺少确认时的原文，无法核对字段是否变化', validFields: [] };
  }
  // 把确认修订号当时的原文与之后的每一版都纳入对比；任一字段不同即视为已变化。
  const comparable = history.filter(item => item.revision >= confirmation.revision);
  const touched = changedFields(record, comparable);
  const validFields = confirmation.fields.filter(field => !touched.has(field));
  if (validFields.length === confirmation.fields.length) {
    return { ...confirmation, state: STATES.VALID, reason: '确认字段与当前依据一致', validFields };
  }
  return {
    ...confirmation,
    state: STATES.SUPERSEDED,
    reason: validFields.length ? '部分字段在确认后已变化，失效字段须重新确认' : '确认字段在确认后已变化，须重新确认',
    validFields,
    invalidFields: confirmation.fields.filter(field => !validFields.includes(field)),
  };
}

function ownConfirmations(record, relations) {
  return relations.confirmations.filter(item => item.subject === record.subject && item.branch === record.branch);
}

// 评估单个分支当前账号能否自动办理，以及失效确认留下的待办。
// history 为本账号资料库中同一主体同分支的既往分支记录。
export function assessBranch(record, relations, representative, history = []) {
  const subject = subjectFor(relations, representative);
  const base = {
    declaration: record.declaration,
    branch: record.branch,
    subject: record.subject,
    revision: record.revision,
  };
  if (!subject) return { ...base, status: 'outside', reason: '当前代表人不属于任何法定主体，无权办理此联合申报' };
  const inScope = record.subject === subject;
  if (!inScope) {
    // 他方分支不可由本账号办理；但若当前来源更正波及他方确认，仍登记待其重新确认。
    const evaluations = ownConfirmations(record, relations)
      .map(confirmation => evaluateConfirmation(record, relations, confirmation, history));
    const pending = [];
    for (const evaluation of evaluations.filter(item => item.state !== STATES.VALID)) {
      for (const field of (evaluation.invalidFields ?? evaluation.fields)) {
        pending.push({
          subject: evaluation.subject, branch: evaluation.branch, field,
          representative: evaluation.representative, awaiting: evaluation.subject,
          state: evaluation.state, reason: evaluation.reason,
        });
      }
    }
    return {
      ...base, status: 'outside', automatable: false,
      reason: '分支归属其他法定主体，当前账号只读其确认状态',
      evaluations, pending,
    };
  }
  if (!record.approved) return { ...base, status: 'review', reason: '来源分支字段未核准，保留待人工处理' };

  const editable = editableFields(relations, subject);
  const evaluations = ownConfirmations(record, relations)
    .map(confirmation => evaluateConfirmation(record, relations, confirmation, history));

  // 同一修订的来源在不同原文中给出不同事实值，属于矛盾依据，不能自动覆盖。
  const sameRevision = history.find(item => item.revision === record.revision);
  if (sameRevision) {
    const conflict = FIELDS.find(field => fieldValue(sameRevision, field) !== fieldValue(record, field));
    if (conflict) {
      return { ...base, status: 'conflict', reason: '同一修订号的分支事实存在矛盾：' + conflict, evaluations };
    }
  }

  const invalid = evaluations.filter(item => item.state !== STATES.VALID);
  const pending = [];
  for (const evaluation of invalid) {
    const lost = evaluation.invalidFields ?? evaluation.fields;
    for (const field of lost) {
      pending.push({
        subject: evaluation.subject,
        branch: evaluation.branch,
        field,
        representative: evaluation.representative,
        awaiting: evaluation.subject,
        state: evaluation.state,
        reason: evaluation.reason,
      });
    }
  }

  // 来源相对已知历史发生了哪些字段更正。
  const earlier = history.filter(item => item.revision < record.revision);
  const corrections = [...changedFields(record, earlier)];
  const blockedByOther = pending.some(item => item.awaiting !== subject);
  const sharedTouchedByOther = corrections.some(field =>
    relations.shared.includes(field) && !editable.includes(field));

  if (blockedByOther || sharedTouchedByOther) {
    return {
      ...base,
      status: 'review',
      reason: '更正影响他方已确认事实或共享字段，等待相应主体重新确认',
      editable,
      corrections,
      pending,
      evaluations,
      automatable: false,
    };
  }
  if (pending.length > 0) {
    // 待重新确认的是本主体自己：本账号可以通过正常界面重新填报与确认。
    return {
      ...base,
      status: 'accepted',
      reason: '本主体的确认已失效，可由当前账号在门户重新填报确认',
      editable,
      corrections,
      pending,
      evaluations,
      automatable: true,
    };
  }
  return {
    ...base,
    status: 'accepted',
    reason: evaluations.length ? '本主体确认仍然有效，可继续办理' : '本主体尚无确认，当前账号可填报并确认',
    editable,
    corrections,
    pending: [],
    evaluations,
    automatable: true,
  };
}

// 一份联合申报包含多个分支；任一可办分支都不应被其他分支的待办拖住。
export function assessJoint(records, relations, representative, history = []) {
  const branches = records.map(record => {
    const branchHistory = history.filter(item => item.subject === record.subject && item.branch === record.branch);
    return assessBranch(record, relations, representative, branchHistory);
  });
  const actionable = branches.filter(item => item.status === 'accepted');
  const blocked = branches.filter(item => item.status === 'review' || item.status === 'conflict');
  // 他方分支本身不可办理；仅当其携带待重新确认事项时，才作为联合层面的待办暴露。
  const externalPending = branches
    .filter(item => item.status === 'outside' && item.pending?.length)
    .map(item => ({ branch: item.branch, status: 'external-pending', reason: item.reason, pending: item.pending }));
  const complete = actionable.length > 0 && blocked.length === 0 && externalPending.length === 0 &&
    branches.every(item => item.status === 'accepted' || item.status === 'outside');
  return {
    declaration: relations.declaration,
    representative,
    subject: subjectFor(relations, representative),
    complete,
    actionableBranches: actionable.map(item => item.branch),
    blockedBranches: blocked.map(item => ({ branch: item.branch, status: item.status, reason: item.reason })),
    externalPending,
    branches,
  };
}

// 门户回读核对：只核对当前账号有权编辑的字段，回执必须带有受理状态与修订号。
// 绝不根据“点击成功”写出已确认。
export function verifyJointPortal(record, relations, representative, receipt) {
  const subject = subjectFor(relations, representative);
  if (!subject || record.subject !== subject) return { accepted: false, reason: '当前账号无权确认该分支' };
  if (!receipt || receipt.state !== 'received' || !Number.isInteger(receipt.version)) {
    return { accepted: false, reason: '门户没有给出可核对的受理依据' };
  }
  if (receipt.version !== record.revision) {
    return { accepted: false, reason: '受理依据修订号与当前来源不一致（依据已变化）' };
  }
  if (!receipt.values || typeof receipt.values !== 'object') {
    return { accepted: false, reason: '受理依据缺少回读字段' };
  }
  const editable = editableFields(relations, subject);
  for (const field of editable) {
    const expected = fieldValue(record, field);
    if (String(receipt.values[field] ?? '') !== String(expected)) {
      return { accepted: false, reason: '受理依据回读与来源不一致：' + field };
    }
  }
  return {
    accepted: true,
    receipt: receipt.id,
    revision: receipt.version,
    confirmedFields: editable,
    subject,
  };
}

// 交接视图：各主体实际确认过什么、哪些仍有效、哪些待人工处理。
// decisions 为资料库中该申报的历次分支决策（最新在前由调用方保证）。
export function buildHandover(records, relations, representative, decisions = []) {
  const subject = subjectFor(relations, representative);
  const branches = records.map(record => {
    const history = decisions
      .filter(item => item.record?.subject === record.subject && item.record?.branch === record.branch)
      .map(item => item.record);
    const latest = decisions.find(item => item.record?.subject === record.subject && item.record?.branch === record.branch);
    const evaluations = ownConfirmations(record, relations)
      .map(confirmation => evaluateConfirmation(record, relations, confirmation, history));
    return {
      branch: record.branch,
      subject: record.subject,
      revision: record.revision,
      inScope: record.subject === subject,
      editable: record.subject === subject ? editableFields(relations, record.subject) : [],
      confirmations: evaluations.map(item => ({
        subject: item.subject,
        representative: item.representative,
        revision: item.revision,
        fields: item.fields,
        state: item.state,
        validFields: item.validFields,
        invalidFields: item.invalidFields ?? [],
        reason: item.reason,
      })),
      lastDecision: latest ? {
        status: latest.decision.status,
        reason: latest.decision.reason,
        at: latest.decision.at,
        receipt: latest.decision.portal?.id ?? latest.decision.receipt ?? null,
      } : null,
      pendingManual: latest?.decision.pending ?? [],
    };
  });
  return {
    declaration: relations.declaration,
    representative,
    subject,
    generatedAt: new Date().toISOString(),
    branches,
    openItems: branches.flatMap(branch =>
      branch.pendingManual.map(item => ({ branch: branch.branch, ...item }))),
  };
}
