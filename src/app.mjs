import { browse, retrieve, browseJoint, retrieveJointRecord, retrieveRelations } from './source.mjs';
import { interpret, interpretJoint, interpretRelations } from './interpret.mjs';
import { assess, summarize, verifyPortal } from './receiving.mjs';
import { assessJoint, verifyJointPortal, buildHandover } from './joint.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      const prior = archive.records(scope).filter(item => item.decision.status === 'accepted').map(item => item.record);
      const decision = assess(record, prior, scope);
      if (operator && decision.status === 'accepted') {
        const portal = await operator(record);
        const confirmation = verifyPortal(record, portal);
        decision.portal = portal;
        if (!confirmation.accepted) { decision.status = 'review'; decision.reason = confirmation.reason; }
      }
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

// 联合申报协作填报：
// 1. 领取分支原文与确认范围资料并分别保存；
// 2. 领域评估只在当前账号有权办理的分支上自动操作；
// 3. 他方已确认事实受影响时只登记待重新确认，无关分支继续办理；
// 4. 门户结果以最终回读为准，点击成功不会写出“已确认”。
export async function collectJoint(client, archive, representative, operator) {
  const catalog = await browseJoint(client);
  const outcomes = [];
  for (const entry of catalog.declarations) {
    let relationsDocument = null;
    let relationsError = null;
    if (entry.relations) {
      try {
        relationsDocument = await retrieveRelations(client, entry.relations);
      } catch (error) {
        relationsError = error;
      }
    }
    if (!relationsDocument) {
      outcomes.push({ declaration: entry.identity, status: 'error', reason: relationsError?.message ?? '确认范围资料未发布，不能开始协作填报' });
      continue;
    }
    const relationsDigest = await archive.preserve(relationsDocument);
    const relations = interpretRelations(relationsDocument.raw);
    const records = [];
    const retrievalErrors = [];
    for (const branchRef of entry.branches) {
      try {
        const document = await retrieveJointRecord(client, branchRef.href, entry.identity, branchRef.branch);
        const digest = await archive.preserve(document);
        const record = interpretJoint(document.raw);
        records.push({ record, digest });
      } catch (error) {
        retrievalErrors.push({ branch: branchRef.branch, reason: error.message });
      }
    }
    for (const failure of retrievalErrors) {
      outcomes.push({ declaration: entry.identity, branch: failure.branch, status: 'error', reason: failure.reason });
    }
    const history = archive.records(representative)
      .filter(item => item.decision?.kind === 'joint' && item.record?.declaration === entry.identity)
      .map(item => item.record);
    const assessment = assessJoint(records.map(item => item.record), relations, representative, history);

    for (const branchAssessment of assessment.branches) {
      const carried = records.find(item => item.record.branch === branchAssessment.branch);
      if (!carried) continue;
      const { record, digest } = carried;
      const decision = {
        kind: 'joint',
        status: branchAssessment.status,
        reason: branchAssessment.reason,
        at: new Date().toISOString(),
        revision: record.revision,
        subject: record.subject,
        editable: branchAssessment.editable ?? [],
        corrections: branchAssessment.corrections ?? [],
        pending: branchAssessment.pending ?? [],
        evaluations: branchAssessment.evaluations ?? [],
        relationsDigest,
      };
      // 仅对当前账号有权办理且领域判断可自动处理的分支调用可见操作。
      if (operator && branchAssessment.status === 'accepted' && branchAssessment.automatable) {
        try {
          const portalResult = await operator(record, relations, representative);
          decision.operation = portalResult.ok ? 'submitted' : 'blocked';
          if (portalResult.ok) {
            const confirmation = verifyJointPortal(record, relations, representative, portalResult.receipt);
            decision.portal = portalResult.receipt;
            if (!confirmation.accepted) {
              decision.status = 'review';
              decision.reason = confirmation.reason;
            } else {
              decision.receipt = confirmation.receipt;
              decision.confirmedFields = confirmation.confirmedFields;
            }
          } else {
            decision.status = 'review';
            decision.reason = portalResult.reason;
            decision.changedFields = portalResult.changedFields ?? [];
          }
        } catch (error) {
          decision.status = 'error';
          decision.reason = '门户操作中断：' + error.message;
        }
      }
      const key = entry.identity + ':' + record.branch;
      archive.put(representative, key, digest, record, decision);
      outcomes.push({ declaration: entry.identity, branch: record.branch, digest, ...decision });
    }
  }
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  // 他方分支只读待办（pending）同样意味着整单尚未全部办结，不能仅凭本账号分支成功就报完成。
  const externalPending = outcomes.some(item => item.status === 'outside' && item.pending?.length > 0);
  const complete = outcomes.length > 0 && !externalPending &&
    outcomes.every(item => item.status === 'accepted' || item.status === 'outside');
  return { representative, complete, counts, outcomes };
}

// 恢复办理时的交接视图：基于资料库中实际落库的决策与最新来源重建，
// 旧确认不会被重新附在变化后的字段上（效力由领域规则按原文历史重新判定）。
export async function handover(client, archive, representative) {
  const catalog = await browseJoint(client);
  const views = [];
  for (const entry of catalog.declarations) {
    if (!entry.relations) continue;
    let relationsDocument;
    try {
      relationsDocument = await retrieveRelations(client, entry.relations);
    } catch {
      continue;
    }
    const relations = interpretRelations(relationsDocument.raw);
    const records = [];
    for (const branchRef of entry.branches) {
      try {
        const document = await retrieveJointRecord(client, branchRef.href, entry.identity, branchRef.branch);
        records.push(interpretJoint(document.raw));
      } catch {
        // 缺件分支跳过，不凭空构造记录
      }
    }
    const decisions = archive.records(representative)
      .filter(item => item.decision?.kind === 'joint' && item.record?.declaration === entry.identity);
    views.push(buildHandover(records, relations, representative, decisions));
  }
  return { representative, generatedAt: new Date().toISOString(), declarations: views };
}
