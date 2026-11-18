export function buildRunAnalysis(run) {
  const findings = [];
  const lost = run.events.find(event => event.kind === 'compression' &&
    Array.isArray(event.detail?.lostRuleIds) && event.detail.lostRuleIds.length);
  if (lost) {
    const outcome = run.events.findLast(event => event.kind === 'output');
    findings.push({
      title: '固定保留任务所需的规则',
      observation: `第 ${lost.id} 步压缩后缺少 ${lost.detail.lostRuleIds.join('、')}。`,
      change: '压缩时保留必需规则的编号和原文，把背景说明单独摘要。',
      verify: '固定使用同一份工具数据，检查最终必需项覆盖率与总输入 Token。',
      evidence: [lost.id, outcome?.id].filter(Boolean)
    });
  }

  for (const tool of run.events.filter(event => event.kind === 'tool')) {
    const notes = tool.output?.notes;
    if (!Array.isArray(tool.output?.policies) || typeof notes !== 'string' || notes.length < 160) continue;
    const consumer = run.events.find(event => event.kind === 'model' && event.id > tool.id &&
      JSON.stringify(event.input).includes(notes.slice(0, 100)));
    if (!consumer) continue;
    findings.push({
      title: '先精简进入模型的工具结果',
      observation: `第 ${tool.id} 步的长说明进入了第 ${consumer.id} 步的实际模型输入。规范条款已单独存放在 policies 字段。`,
      change: '原始返回继续保存到轨迹。工具结果回传时保留完整 policies，有需求时再单独读取 notes。工具调用 ID 与结果配对保持完整。',
      verify: '只改回传字段，用同一场景比较末轮输入 Token、必需项覆盖率和工具调用次数。',
      evidence: [tool.id, consumer.id]
    });
    break;
  }

  const overCap = run.events.find(event => event.kind === 'compression' &&
    Number.isInteger(event.detail?.messageLimit) && event.detail.messageLimit > 0 &&
    Number.isInteger(event.detail?.afterMessages) && event.detail.afterMessages > event.detail.messageLimit);
  if (overCap) {
    const { messageLimit, afterMessages } = overCap.detail;
    const consumer = run.events.find(event => event.kind === 'model' && event.id > overCap.id &&
      event.links.includes(overCap.id));
    findings.push({
      title: '为长轮次设置 Token 预算',
      observation: `当前轮次配置上限为 ${messageLimit} 条，实发 ${afterMessages} 条。消息条数不能反映每条工具结果的大小。`,
      change: '先按完整用户轮次裁剪旧历史。当前轮次仍超预算时，精简其中的工具载荷，并保留工具调用和返回的配对。',
      verify: '构造一个长工具结果，检查下一轮的实际输入量、工具调用与结果配对以及必需项覆盖率。',
      evidence: [overCap.id, consumer?.id].filter(Boolean)
    });
  }

  const dropped = run.events.find(event => event.kind === 'compression' && event.detail?.droppedToolResults > 0);
  if (dropped && run.requirement?.benchmark) {
    const consumer = run.events.find(event => event.kind === 'model' && event.links.includes(dropped.id));
    findings.push({
      title: '跨轮保留工具结果中的事实',
      observation: `第 ${dropped.id} 步移除了 ${dropped.detail.droppedToolResults} 条工具返回。后续模型输入可以核对上一轮的结果是否仍可见。`,
      change: '裁剪旧轮前，把用户后续可能引用的工具结果提取为结构化摘要，保留来源步骤。',
      verify: '使用同一道 BFCL 题复测，对照后续模型输入、重复工具调用次数和官方评分。',
      evidence: [dropped.id, consumer?.id].filter(Boolean)
    });
  }

  const failure = run.events.find(event => event.status === 'error');
  if (failure) findings.push({
    title: '修复首个失败步骤',
    observation: `第 ${failure.id} 步执行失败。`,
    change: '从失败步骤读取输入和异常，缩小触发问题的最小用例。',
    verify: '在同一场景里复跑，确认异常消失并核对最终评估。',
    evidence: [failure.id]
  });

  return {
    summary: `任务通过 ${run.evaluation.passed}/${run.evaluation.required} 项。已分析 ${run.events.length} 个步骤。`,
    findings
  };
}
