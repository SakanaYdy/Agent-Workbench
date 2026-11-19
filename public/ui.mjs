export function element(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const byId = id => document.getElementById(id);
export function evidenceUrl(runId, caseId, step) {
  const params = new URLSearchParams({ run: runId });
  if (caseId) params.set('case', caseId);
  if (step != null) params.set('step', step);
  return '/?' + params;
}
export const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
export const elapsed = value => !Number.isFinite(value) ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
export const kindLabel = kind => ({
  context: '上下文', model: '模型', tool: '工具', state: '状态', compression: '压缩',
  output: '产出', branch: '分支', retry: '重试', tool_request: '工具请求', tool_result: '结果回传'
})[kind] || kind;
export const phaseLabel = phase => ({
  queued: '排队中', running: '运行中', diagnosing: '诊断中', complete: '已完成', failed: '执行失败', cancelled: '已停止'
})[phase] || phase;

export function raw(value) {
  if (typeof value === 'string') return element('p', { className: 'plain-data' }, value);
  return element('pre', { className: 'raw-data' }, JSON.stringify(value, null, 2) || '无数据');
}

export function collapsible(title, content, open = false) {
  return element('details', { className: 'data-box', open }, element('summary', {}, title), content);
}

export function metric(label, value, hint) {
  return element('div', {}, element('dt', {}, label), element('dd', { className: 'tabular' }, value),
    hint ? element('span', { className: 'muted metric-hint' }, hint) : null);
}

export function checkList(evaluation) {
  if (!evaluation) return null;
  return element('ul', { className: 'checks' }, evaluation.checks.map(check =>
    element('li', {}, element('span', { className: check.passed ? 'check-pass' : 'check-fail' }, check.passed ? '通过' : '缺失'),
      element('span', {}, element('code', {}, check.id), ' ', check.text))));
}

export function findDivergence(first, second) {
  const count = Math.max(first.length, second.length);
  for (let index = 0; index < count; index += 1) {
    const left = first[index], right = second[index];
    if (!left || !right || left.kind !== right.kind || left.name !== right.name || left.digest !== right.digest ||
        left.status !== right.status) return { left, right };
  }
  return null;
}

const scoringReasons = {
  execution_response_mismatch: '实际工具返回与官方期望不一致',
  'multi_turn:execution_response_mismatch': '实际工具返回与官方期望不一致',
  irrelevance_error: '该轮应等待或澄清，但发生了工具调用',
  'multi_turn:irrelevance_error:decoder_success': '该轮应等待或澄清，但发生了工具调用',
  'multi_turn:instance_state_mismatch': '最终工具状态与官方期望不一致'
};

export function firstFailure(run) {
  if (run.cases && !run.caseId || !run.evaluation || run.evaluation.success) return null;
  const score = run.evaluation.benchmark;
  if (score?.passed === false) {
    const round = score.failedRound;
    const event = run.events.find(step => step.round === round && step.status === 'error') ||
      run.events.find(step => step.round === round && step.name === 'next_turn') ||
      run.events.find(step => step.round === round);
    const scoring = run.events.find(step => step.name === 'BFCL 官方评分');
    return { title: (round ? `第 ${round} 轮 · ` : '') + 'BFCL 评分未通过',
      observation: scoringReasons[score.reason] || score.reason || '查看官方评分与该轮轨迹。', event, scoring };
  }
  const error = run.events.find(step => step.status === 'error');
  const check = run.evaluation.checks?.find(item => !item.passed);
  if (run.error) return { title: '运行中断', observation: run.error, event: error };
  if (check) return { title: '验收项未通过 · ' + check.id, observation: check.text,
    event: run.events.findLast(step => step.kind === 'output') };
  return null;
}
