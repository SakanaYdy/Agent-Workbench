import { agentModel, deepSeek } from './deepseek.mjs';

export const liveModelConfigured = deepSeek.configured;

export async function invokeAgentModel({ messages, tools }, client = deepSeek, benchmark = false) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > (benchmark ? 5000 : 120) ||
      (tools != null && (!Array.isArray(tools) || tools.length > (benchmark ? 128 : 30))) ||
      JSON.stringify({ messages, tools }).length > (benchmark ? 500_000 : 32_000)) throw new Error('模型请求超出参数限制');
  const data = await client.complete({ model: agentModel, messages, tools, maxTokens: 2048,
    signal: AbortSignal.timeout(benchmark ? 30_000 : 12_000) });
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('模型未返回消息');
  const usage = data.usage || {};
  return { message: choice.message, finishReason: choice.finish_reason, model: data.model || agentModel,
    usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, estimated: false } };
}
