import { estimateTokens } from './trace.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runDemo(recorder, scenario, variant) {
  const { step, record } = recorder;
  const request = [{ role: 'user', content: scenario.task }];
  const setup = record({ kind: 'context', name: '组装初始上下文', input: { task: scenario.task }, output: { messages: request } });
  const plan = await step({ kind: 'model', name: '选择查询工具', input: { messages: request }, links: [setup] }, async () => {
    await wait(80);
    return { toolCalls: [{ name: 'get_changes' }, { name: 'read_policy' }] };
  });
  const changes = await step({ kind: 'tool', name: 'get_changes · 查询变更', input: { release: scenario.change.release }, links: [plan.id] }, async () => {
    await wait(35);
    return scenario.change;
  });
  const policy = await step({ kind: 'tool', name: 'read_policy · 读取规范', input: { subject: 'release' }, links: [plan.id] }, async () => {
    await wait(45);
    return { policies: scenario.policies, notes: '历史说明与附件索引。'.repeat(32) };
  });
  const before = [
    ...request,
    { role: 'tool', source: changes.id, content: changes.output },
    { role: 'tool', source: policy.id, content: policy.output }
  ];
  const state = record({ kind: 'state', name: '将工具返回写入消息', round: 2, links: [changes.id, policy.id],
    input: { previousMessages: request.length }, output: { messages: before } });
  const digest = await step({ kind: 'model', name: '生成上下文摘要', round: 2, links: [state],
    input: { messages: before, strategy: variant === 'baseline' ? '通用摘要' : '保留强制规则' } }, async () => {
    await wait(60);
    const rules = policy.output.policies.filter(rule => rule.required && (variant !== 'baseline' || rule.id !== 'R-02'));
    return { summary: rules.map(rule => rule.text).join(' '), rules };
  });
  const after = [...request, { role: 'context_summary', source: digest.id, content: digest.output }];
  const requiredRuleIds = policy.output.policies.filter(rule => rule.required).map(rule => rule.id);
  const retainedRuleIds = digest.output.rules.map(rule => rule.id);
  const lostRuleIds = requiredRuleIds.filter(id => !retainedRuleIds.includes(id));
  const compact = record({
    kind: 'compression', name: '压缩上下文', round: 2, links: [policy.id, state, digest.id],
    input: { messages: before }, output: { messages: after, summary: digest.output.summary },
    detail: { strategy: variant === 'baseline' ? '通用摘要' : '保留强制规则', thresholdTokens: 300,
      beforeTokens: estimateTokens(before), afterTokens: estimateTokens(after),
      requiredRuleIds, retainedRuleIds, lostRuleIds }
  });
  const owner = await step({ kind: 'tool', name: 'lookup_owner · 查询负责人', round: 3,
    input: { file: scenario.change.files[0] }, links: [changes.id] }, async () => {
    await wait(28);
    return { owner: scenario.owner };
  });
  const messages = [...after, { role: 'tool', source: owner.id, content: owner.output }];
  const context = record({ kind: 'context', name: '组装最终模型输入', round: 3,
    input: { messageCount: messages.length }, output: { messages }, links: [compact, owner.id] });
  const completion = await step({ kind: 'model', name: '生成发布检查清单', round: 3,
    input: { messages }, links: [context] }, async () => {
    await wait(95);
    const rules = messages.find(message => message.role === 'context_summary').content.rules;
    return {
      summary: `${scenario.change.release} 发布检查清单`,
      checklist: rules.map(rule => ({ ruleId: rule.id, action: rule.text })),
      owner: owner.output.owner
    };
  });
  record({ kind: 'output', name: '返回最终产出', round: 3, output: completion.output, links: [completion.id] });
  return completion.output;
}
