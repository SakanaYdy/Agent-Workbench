const list = value => Array.isArray(value) ? value : [];

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function complete(value) {
  return !value || typeof value !== 'object' || value.truncated !== true && Object.values(value).every(complete);
}

function successful(event) {
  return event.status === 'ok' && event.output != null && !event.output?.error && event.output?.retryable !== true &&
    !(typeof event.output === 'string' && /^Error during execution:/i.test(event.output));
}

function structuredRules(payload) {
  if (!Array.isArray(payload?.messages) || !complete(payload)) return null;
  const groups = payload.messages.flatMap(message => [message?.content?.policies, message?.content?.rules].filter(Array.isArray));
  return groups.length ? groups.flat() : null;
}

export function reviewTrajectory(run, task = {}) {
  const events = list(run.events);
  const audit = run.toolAudit ?? {};
  const findings = [];
  const add = (rule, area, status, title, observation, change, verify, evidence, stepId = evidence.at(-1)) => {
    findings.push({ rule, area, status, title, observation, change, verify, evidence, stepId });
  };
  let previous, deniedCovered = false, approvalCovered = false, repeatedCovered = false, compressionCovered = false;
  const verifiedApprovals = new Set(['approved', 'pending', 'denied', 'missing']);
  const securityIds = new Set(list(task.reviewPolicy?.securityRuleIds));
  const taskRequired = new Set(list(task.policies).filter(rule => rule.required).map(rule => rule.id));
  for (const event of events) {
    if (event.kind === 'state' || event.kind === 'output' || event.name === 'next_turn') previous = undefined;
    if (event.kind === 'compression') {
      const before = structuredRules(event.input), after = structuredRules(event.output);
      if (!before || !after) continue;
      const required = before.filter(rule => typeof rule?.id === 'string' && (taskRequired.has(rule.id) || rule.required === true));
      if (!required.length) continue;
      compressionCovered = true;
      const retained = new Set(after.map(rule => rule?.id));
      const lost = [...new Set(required.map(rule => rule.id))].filter(id => !retained.has(id));
      if (!lost.length) continue;
      const next = events.find(step => step.kind === 'model' && step.links.includes(event.id));
      const evidence = [event.id, next?.id].filter(Number.isInteger);
      add('required-context', 'architecture', 'observed', '压缩后缺少必需条款条目',
        '结构化条款在压缩前存在，压缩后缺少 ' + lost.join('、') + '。',
        '在压缩前提取必需条款，保留规则编号和原文，并在请求模型前校验。',
        '复跑同一场景，断言压缩前后的必需条款集合一致。', evidence, event.id);
      if (lost.some(id => securityIds.has(id))) add('required-context', 'security', 'potential', '压缩后缺少结构化的审批约束',
        '结构化条款集合缺少场景标记的审批条款 ' + lost.filter(id => securityIds.has(id)).join('、') + '。工具网关是否仍会执行同样的授权判定需要验证。',
        '把审批状态和执行权限放在独立运行状态中，由工具网关执行前校验。',
        '在本地模拟场景中断言压缩前后授权决定一致。', evidence, event.id);
      continue;
    }
    if (event.kind !== 'tool') continue;
    const gate = audit[event.id];
    if (gate?.decision === 'deny') deniedCovered = true;
    if (gate?.effect === 'write' && gate.approvalRequired === true) {
      approvalCovered ||= verifiedApprovals.has(gate.approval);
      if (gate.decision === 'allow' && gate.approval !== 'approved' && successful(event)) {
        const known = verifiedApprovals.has(gate.approval);
        add('approval-write', 'security', known ? 'observed' : 'potential', '需要审批的写操作已通过网关',
          known ? '已记录审批尚未通过，网关仍允许了写操作并返回成功。' : '网关允许了需要审批的写操作，轨迹未提供可核验的审批状态。',
          '在写操作前按当前资源和动作核对审批状态，缺少有效授权时保持原状态。',
          '覆盖同一操作的未审批和已审批分支，分别断言拒绝与成功。', [event.id]);
      }
    }
    if (!complete(event.input) || !complete(event.output)) { previous = undefined; continue; }
    const allowed = gate?.decision !== 'deny' && successful(event);
    if (allowed) repeatedCovered = true;
    const key = stable([event.round, event.name, event.input ?? {}]);
    const output = allowed ? stable(event.output) : null;
    const same = previous?.key === key && previous.approval === gate?.approval;
    if (same && previous.decision === 'deny' && gate?.decision === 'deny' && previous.ids.length === 1) {
      add('denied-retry', 'architecture', 'observed', '重复提交了已被网关拒绝的请求',
        `同轮次连续提交相同的 ${event.name} 调用，网关两次拒绝。`,
        '将拒绝分支同临时故障分开，结束当前动作分支或等待新的授权状态。',
        '断言拒绝后不再提交相同请求，临时故障仍按原预算重试。', [...previous.ids, event.id]);
    }
    const continueSequence = same && previous.decision === gate?.decision && previous.output === output;
    const ids = continueSequence ? [...previous.ids, event.id].slice(0, 4) : [event.id];
    if (allowed && ids.length === 3) add('repeat-tool', 'architecture', 'potential', '重复工具调用可以检查是否复用结果',
      `同轮次连续三次调用 ${event.name}，参数和可见返回相同，期间未记录工具或状态变化。`,
      '检查调用方是否可在同轮次复用结果，保留需要刷新状态的路径。',
      '对同一场景比较工具调用次数和任务得分，并验证真实状态变化时仍会重新查询。', ids);
    previous = { key, approval: gate?.approval, decision: gate?.decision, output, ids };
  }

  const checks = [
    ['denied-retry', '拒绝后的相同请求', deniedCovered, '未记录网关拒绝，未覆盖拒绝后的重试分支。'],
    ['approval-write', '写操作的审批状态', approvalCovered, '缺少需要审批的写操作或可核验的审批状态。'],
    ['required-context', '压缩保留必需约束', compressionCovered, '未记录可配对检查的压缩前后结构化条款。'],
    ['repeat-tool', '同轮次重复工具调用', repeatedCovered, '未记录参数和返回完整的成功调用。']
  ].map(([id, label, covered, missing]) => {
    const statuses = findings.filter(item => item.rule === id).map(item => item.status);
    return { id, label, covered, status: statuses.includes('observed') ? 'observed' : statuses.includes('potential') ? 'potential' : covered ? 'clear' : 'uncovered',
      note: covered ? '' : missing };
  });
  return { checks, findings, summary: { security: findings.filter(item => item.area === 'security').length,
    architecture: findings.filter(item => item.area === 'architecture').length, covered: checks.filter(item => item.covered).length,
    total: checks.length } };
}
