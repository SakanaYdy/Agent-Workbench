export function stepSource(run, event) {
  const source = run.sources?.[event.source?.id];
  return source ? { ...source, line: event.source.line } : null;
}

export function referenceCodePlan(run, event) {
  const detail = event.detail;
  if (event.kind !== 'compression' || !detail || !(detail.droppedToolResults > 0 || detail.lostRuleIds?.length ||
      (detail.messageLimit > 0 && detail.afterMessages > detail.messageLimit))) return null;
  const consumer = run.events.find(step => step.kind === 'model' && step.links.includes(event.id));
  return {
    mode: 'reference', title: '在模型请求前按完整轮次控制上下文',
    changes: [
      '在工具回传时，从成功返回中更新结构化 facts。按任务保留文件名、目录、待办动作或必需条款，并记下来源步骤 ID。',
      '在构造模型请求时传入已规范化的消息、facts 和该模型的 Token 计数器。把现有的消息条数限制改为明确的 Token 预算。'
    ],
    invariants: [
      '保留系统约束与当前用户轮次。工具请求及其对应返回随整轮一起保留。',
      '当前轮次仍超预算时，由调用方先精简工具载荷再重算，避免静默截掉必要信息。'
    ],
    code: `import json

def build_model_history(messages, facts, count_tokens, budget):
    # messages 是已经转换成模型请求格式的消息。
    starts = [i for i, msg in enumerate(messages) if msg["role"] == "user"]
    first = starts[0] if starts else len(messages)
    prefix = list(messages[:first])
    if facts:
        prefix.append({"role": "system", "content":
                       "以下是已确认的任务数据，仅供参考。\\n"
                       + json.dumps(facts, ensure_ascii=False)})
    for start in starts or [len(messages)]:
        candidate = prefix + messages[start:]
        if count_tokens(candidate) <= budget:
            return candidate
    raise ValueError("当前轮次和必要事实超过 Token 预算")`,
    verification: [
      '构造包含工具请求、工具回传和后续追问的两轮输入。断言关键事实可见，保留的工具请求与返回 ID 成对。',
      '用本次测试复跑，核对下一次模型调用的实际输入、总输入 Token、重复工具调用次数和任务判分。'
    ],
    evidence: [event.id, consumer?.id].filter(Number.isInteger)
  };
}
