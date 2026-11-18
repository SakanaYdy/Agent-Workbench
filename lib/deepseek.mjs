import { readFileSync } from 'node:fs';

const endpoint = 'https://api.deepseek.com/chat/completions';
const supportedKeys = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_AGENT_MODEL', 'DEEPSEEK_ANALYSIS_MODEL']);

function readProjectSettings() {
  let source;
  try {
    source = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const settings = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !supportedKeys.has(match[1])) continue;
    const [, key, value] = match;
    const quoted = value.match(/^(["'])(.*)\1$/);
    settings[key] = quoted ? quoted[2] : value;
  }
  return settings;
}

export function createDeepSeekClient({ apiKey = '', fetcher = globalThis.fetch } = {}) {
  return {
    configured: Boolean(apiKey),
    async complete({ model, messages, tools, json = false, maxTokens, signal }) {
      if (!apiKey) throw new Error('请先在项目 .env 中填写 DEEPSEEK_API_KEY');
      const response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, messages, ...(tools?.length ? { tools } : {}), stream: false,
          thinking: { type: 'disabled' }, max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {})
        })
      });
      if (!response.ok) throw Object.assign(new Error(`DeepSeek 返回 HTTP ${response.status}`), { statusCode: response.status });
      return response.json();
    }
  };
}

const settings = readProjectSettings();
export const agentModel = settings.DEEPSEEK_AGENT_MODEL || 'deepseek-flash';
export const analysisModel = settings.DEEPSEEK_ANALYSIS_MODEL || 'deepseek-flash';
export const deepSeek = createDeepSeekClient({ apiKey: settings.DEEPSEEK_API_KEY });
