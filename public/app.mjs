import { element as h, byId, number, elapsed, kindLabel, phaseLabel, raw, collapsible,
  metric, checkList, findDivergence } from './ui.mjs';
import { TraceGraph, isIssue } from './trace-graph.mjs';
import { createTaskPicker } from './task-catalog.mjs';
import { createBenchmarkPicker } from './benchmark-picker.mjs';
import { createCodeReview } from './code-review.mjs';

const activePhases = new Set(['queued', 'running', 'diagnosing']);
const pendingCodePlans = new Set();
const state = {
  setup: null, history: [], run: null, selected: null, detail: null, detailTab: '',
  generation: 0, detailGeneration: 0, graphRound: null, poll: null,
  query: '', matches: null, issues: false, view: 'trace', explicitSelection: false, caseId: null,
  batchGroup: '', batchPage: 0
};
const searchBox = byId('search');
const graph = new TraceGraph(byId('call-graph'), { onStep: id => selectStep(id, true), onRound: showRound });
const codeReview = createCodeReview(byId('code-review'), request, notify);
let searchTimer;
let compareGeneration = 0;
let uploadGeneration = 0;
let approval = null;
let uploadBusy = false;
const tasksView = createTaskPicker(request, syncUploadButton);
const initialParams = new URLSearchParams(location.search);
const initialBenchmark = initialParams.has('benchmark') ? { suite: initialParams.get('benchmark'),
  mode: initialParams.get('range'), key: initialParams.get('key') } : null;
let selectedBenchmark;
let benchmarkSuites;
const benchmarkPicker = createBenchmarkPicker(byId('upload-benchmark-picker'), request, selection => {
  selectedBenchmark = selection;
  syncUploadButton();
});

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

const runPath = id => '/api/runs/' + id;
function casePath(id, path = '', query = {}) {
  const params = new URLSearchParams(query);
  if (state.caseId) params.set('case', state.caseId);
  const search = params.toString();
  return runPath(id) + path + (search ? '?' + search : '');
}

function notify(message = '', problem = false) {
  const notice = byId('notice');
  notice.hidden = !message;
  notice.classList.toggle('problem', problem);
  notice.textContent = message;
}

function button(label, callback, attributes = {}) {
  return h('button', { type: 'button', onclick: callback, ...attributes }, label);
}

function renderHistory() {
  const picker = byId('run-picker');
  picker.replaceChildren(...state.history.map(run => h('option', { value: run.id },
    run.label + ' · ' + phaseLabel(run.phase) + ' · ' + new Date(run.createdAt).toLocaleTimeString('zh-CN'))));
  picker.disabled = !state.history.length;
  if (state.run) picker.value = state.run.id;
  byId('open-compare').disabled = comparableRuns().length < 2;
}

async function loadHistory() {
  const { runs } = await request('/api/runs');
  state.history = runs;
  renderHistory();
}

function renderHeader(run) {
  byId('empty-state').hidden = true;
  byId('workspace').hidden = false;
  byId('run-label').textContent = run.label;
  for (const tab of byId('views').querySelectorAll('button')) {
    tab.hidden = tab.dataset.view === 'batch' ? !run.cases : Boolean(run.cases && !run.caseId);
  }
  const badge = byId('phase');
  const failedCheck = run.phase === 'complete' && run.evaluation?.success === false;
  badge.textContent = failedCheck ? '评估未通过' : phaseLabel(run.phase);
  badge.dataset.phase = failedCheck ? 'check-failed' : run.phase;
  byId('run-meta').textContent = run.id.slice(0, 8) + ' · ' +
    (run.cases && !run.caseId ? run.cases.length + ' 个测试任务' :
      run.requirement ? run.requirement.name + ' · ' + (run.requirement.benchmark?.name || 'v' + run.requirement.revision) : '固定场景');
  const evaluation = run.evaluation;
  const score = evaluation?.benchmark;
  const ratio = run.cases && !run.caseId && run.benchmark ? (score?.passed ?? 0) + ' / ' + run.cases.length :
    evaluation ? evaluation.passed + ' / ' + evaluation.required : '—';
  byId('metrics').replaceChildren(
    metric(run.benchmark ? '通过题数' : '必需项', ratio),
    metric('总耗时', elapsed(run.durationMs)),
    metric('模型 Token', evaluation?.usageReported ? number(evaluation.inputTokens + evaluation.outputTokens) : '—',
      evaluation?.tokensEstimated ? '估算' : ''),
    metric('工具调用', number(evaluation?.toolCalls))
  );
  byId('run-picker').value = run.id;
  const exportLink = byId('trace-export');
  exportLink.hidden = activePhases.has(run.phase);
  exportLink.href = casePath(run.id, '/export');
}

function matchingSteps() {
  if (!state.query && !state.issues) return [];
  if (state.query && state.matches === null) return [];
  return (state.run?.events || []).filter(event => (!state.issues || isIssue(event)) &&
    (state.matches === null || state.matches.has(event.id)));
}

function renderTrace() {
  const events = state.run?.events || [];
  graph.update({ events, runId: (state.run?.id || '') + ':' + (state.caseId || ''), round: state.graphRound, selected: state.selected,
    matches: state.matches, highlightIssues: state.issues,
    emptyText: activePhases.has(state.run?.phase) ? '等待首个执行步骤…' : '本次运行尚无步骤。'
  });
  const { round, rounds } = graph.layout;
  byId('graph-title').textContent = round === null ? '轮次总览' : '轮次 ' + round;
  byId('graph-back').hidden = round === null || rounds.length <= 1;
  byId('graph-count').textContent = round === null ? rounds.length + ' 轮 · ' + events.length + ' 步' :
    events.filter(event => event.round === round).length + ' 步';
  byId('graph-results').hidden = !state.issues && !state.query;
  const matches = matchingSteps();
  byId('graph-result-count').textContent = state.query && state.matches === null ? '正在搜索…' : matches.length + ' 处匹配';
  byId('graph-prev-result').disabled = !matches.length;
  byId('graph-next-result').disabled = !matches.length;
}

function showRound(round) {
  const events = state.run?.events.filter(event => event.round === round) || [];
  if (!events.length) return;
  state.graphRound = round;
  const target = events.find(event => event.id === state.selected) ||
    matchingSteps().find(event => event.round === round) || events.find(isIssue) || events[0];
  selectStep(target.id, true);
}

function moveMatch(direction) {
  const events = matchingSteps();
  if (!events.length) return;
  const index = events.findIndex(event => event.id === state.selected);
  const next = index < 0 ? (direction > 0 ? 0 : events.length - 1) :
    (index + direction + events.length) % events.length;
  jump(events[next].id);
}

function jump(id) {
  const step = state.run?.events.find(event => event.id === id);
  if (!step) return;
  changeView('trace');
  state.graphRound = step.round;
  selectStep(id, true);
  graph.focusStep(id);
}

function eventLink(id) {
  const event = state.run?.events.find(item => item.id === id);
  if (!event) return null;
  return button('#' + id + ' ' + event.name, () => jump(id), { className: 'evidence-link' });
}

function messages(value) {
  const list = value?.messages;
  if (!Array.isArray(list)) return raw(value);
  return h('div', { className: 'message-list' }, list.map((message, index) => {
    const label = message?.role || '消息';
    const payload = message?.content ?? message;
    const excerpt = (typeof payload === 'string' ? payload : JSON.stringify(payload)).slice(0, 88);
    return collapsible((index + 1) + ' · ' + label + ' · ' + excerpt,
      h('div', {}, raw(payload), eventLink(message?.source)), list.length <= 3 && typeof payload === 'string' && payload.length < 120);
  }));
}

function rulesIn(value) {
  const map = new Map();
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  for (const message of messages) {
    const rules = message?.content?.policies || message?.content?.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule && typeof rule.id === 'string' && typeof rule.text === 'string') map.set(rule.id, rule.text);
    }
  }
  return map;
}

function renderCompression(event) {
  const detail = event.detail || {};
  const before = rulesIn(event.input), after = rulesIn(event.output);
  const required = Array.isArray(detail.requiredRuleIds) ? detail.requiredRuleIds : [];
  const ids = required.length ? required : [...new Set([...before.keys(), ...after.keys()])].slice(0, 8);
  const lostIds = new Set(Array.isArray(detail.lostRuleIds) ? detail.lostRuleIds : []);
  const hasCounts = Number.isFinite(detail.beforeTokens) && Number.isFinite(detail.afterTokens);
  const delta = hasCounts && detail.beforeTokens > 0 ? Math.round((detail.afterTokens / detail.beforeTokens - 1) * 100) : null;
  const segments = (title, entries, afterView) => h('article', { className: 'diff-panel' },
    h('h4', {}, title), ids.length ? h('ul', {}, ids.map(id => {
      const content = entries.get(id);
      const lost = lostIds.has(id) || (before.has(id) && !after.has(id));
      const text = content ?? (afterView && lost ? '摘要中缺少该条款' : '没有结构化条款记录');
      return h('li', { className: lost ? 'lost-rule' : '' }, h('code', {}, id), h('p', {}, text));
    })) : h('div', {}, messages(afterView ? event.output : event.input))
  );
  return h('div', {},
    h('div', { className: 'compression-head' }, h('strong', { className: 'tabular' },
      number(detail.beforeTokens) + ' → ' + number(detail.afterTokens)), ' Token',
      delta != null ? h('span', { className: 'delta' }, (delta > 0 ? '+' : '') + delta + '%') : null),
    h('p', { className: 'muted context-meta' }, detail.strategy || '压缩策略',
      Number.isFinite(detail.thresholdTokens) ? ' · 触发阈值 ' + number(detail.thresholdTokens) + ' Token' : '',
      Number.isFinite(detail.messageLimit) ? ' · 配置上限 ' + detail.messageLimit + ' 条 · 实际保留 ' + detail.afterMessages + ' 条' : ''),
    h('div', { className: 'diff-grid' }, segments('压缩前', before, false), segments('压缩后', after, true)),
    ids.length ? h('div', { className: 'payload-stack' },
      collapsible('完整压缩前消息', messages(event.input)), collapsible('完整压缩后消息', messages(event.output))) : null
  );
}

async function requestCodePlan(path) {
  if (pendingCodePlans.has(path)) return;
  pendingCodePlans.add(path);
  renderInspector();
  const stillSelected = () => path === casePath(state.run?.id, '/events/' + state.selected + '/code-plan');
  try {
    const updated = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (stillSelected()) state.detail = updated;
  } catch (error) {
    if (stillSelected()) notify(error.message, true);
  } finally {
    pendingCodePlans.delete(path);
    if (stillSelected()) renderInspector();
  }
}

function renderCodeReview(detail) {
  const { event, codePlan, source } = detail;
  const path = casePath(state.run.id, '/events/' + event.id + '/code-plan');
  const ready = !activePhases.has(state.run.phase) && (!activePhases.has(state.run.batchPhase) || state.run.benchmark);
  const canGenerate = Boolean(state.setup?.diagnosticEnabled && ready);
  const files = state.run.preflight?.filename ? (state.run.preflight.files ?? []).filter(file => /\.py$/i.test(file)) : [];
  const available = Boolean(codePlan || source || files.length || canGenerate);
  codeReview.update(available ? { key: path, run: state.run.id, source, codePlan, files,
    busy: pendingCodePlans.has(path), canGenerate, onGenerate: () => void requestCodePlan(path),
    sourceUrl: file => runPath(state.run.id) + '/source?' + new URLSearchParams({ file }), evidenceLink: eventLink } : null);
  return available;
}

function renderInspector() {
  const inspector = byId('inspector');
  const diagnostics = byId('diagnostics');
  const stepData = byId('step-data');
  if (!state.detail) {
    inspector.replaceChildren();
    stepData.hidden = true;
    stepData.open = false;
    codeReview.update(null);
    diagnostics.replaceChildren(h('h3', { className: 'diagnostic-title' }, '逐步诊断'),
      h('p', { className: 'muted' }, state.selected ? '正在读取步骤…' : '选择一个节点查看诊断。'));
    return;
  }
  stepData.hidden = false;
  const { event, diagnostic, findings, gateway } = state.detail;
  byId('step-data-caption').textContent = event.kind === 'compression' ? '压缩差异 · 来源与去向 · 原始数据' : '输入与输出 · 来源与去向 · 原始数据';
  const hasCodeReview = renderCodeReview(state.detail);
  const views = [event.kind === 'compression' ? '压缩差异' : '输入与输出', '来源与去向', '原始数据'];
  if (!views.includes(state.detailTab)) state.detailTab = views[0];
  let content;
  if (state.detailTab === '压缩差异') content = renderCompression(event);
  else if (state.detailTab === '原始数据') content = raw(event);
  else if (state.detailTab === '来源与去向') {
    const downstream = state.run.events.filter(item => item.links.includes(event.id));
    content = h('div', { className: 'payload-stack' },
      h('div', { className: 'source-group' }, h('h4', {}, '上游来源'),
        event.links.length ? event.links.map(eventLink) : h('p', { className: 'muted' }, '没有上游链接')),
      h('div', { className: 'source-group' }, h('h4', {}, '下游使用'),
        downstream.length ? downstream.map(item => eventLink(item.id)) : h('p', { className: 'muted' }, '没有下游链接')));
  } else {
    content = h('div', { className: 'payload-stack' },
      collapsible('实际输入', messages(event.input), true),
      collapsible('实际输出', messages(event.output), true));
  }
  inspector.replaceChildren(
    h('div', { className: 'tabs detail-tabs', role: 'group', 'aria-label': '步骤内容' }, views.map(view =>
      button(view, () => {
        state.detailTab = view;
        renderInspector();
        inspector.querySelector('[aria-pressed="true"]')?.focus();
      }, { 'aria-pressed': String(view === state.detailTab) }))),
    content);
  diagnostics.replaceChildren(
    h('div', { className: 'detail-heading' }, h('div', {},
      h('p', { className: 'muted mono' }, '#' + event.id + ' · ' + kindLabel(event.kind)), h('h3', {}, event.name)),
      h('span', { className: 'muted mono' }, elapsed(event.durationMs))),
    h('h3', { className: 'diagnostic-title' }, '逐步诊断'));
  if (!diagnostic) {
    diagnostics.append(h('p', { className: 'muted' }, '正在等待运行证据。'));
    return;
  }
  diagnostics.append(
    h('p', { className: 'diagnostic-source' }, '规则诊断'),
    h('h4', { className: diagnostic.level === 'info' ? '' : 'issue' }, diagnostic.title),
    h('p', {}, diagnostic.observation),
    diagnostic.evidence.length ? h('div', { className: 'source-group' }, h('h4', {}, '关联证据'), diagnostic.evidence.map(eventLink)) : null,
    diagnostic.suggestion ? h('div', { className: 'source-group' }, h('h4', {}, '建议'), h('p', {}, diagnostic.suggestion)) : null
  );
  if (diagnostic.agent) diagnostics.append(h('section', { className: 'agent-analysis' },
    h('p', { className: 'diagnostic-source' }, '模型诊断'),
    h('p', {}, diagnostic.agent.finding), h('p', {}, diagnostic.agent.suggestion),
    diagnostic.agent.evidence.map(eventLink)));
  else if (state.setup?.diagnosticEnabled) diagnostics.append(h('p', { className: 'muted agent-analysis' },
    state.run?.phase === 'diagnosing' ? '正在等待此步骤的模型诊断。' : '此步骤仅有规则诊断。'));
  if (gateway) diagnostics.append(h('p', { className: 'muted review-gateway' },
    (gateway.scope === 'benchmark' ? 'Benchmark 工具网关' : '场景工具网关') + ' · ' + (gateway.decision === 'allow' ? '允许' : '拒绝')));
  if (findings?.length) diagnostics.append(h('section', { className: 'agent-analysis' }, h('h4', {}, '跨维度发现'), reviewFindings(findings)));
  if (hasCodeReview) diagnostics.append(h('a', { href: '#code-review', className: 'text-link review-jump' }, '查看代码对照 ↓'));
}

function renderOutput() {
  const output = byId('output-view');
  if (!state.run) return;
  const score = state.run.evaluation?.benchmark;
  output.replaceChildren(h('section', {}, h('h3', {}, state.run.benchmark ? 'Benchmark 评分' : '场景评估'),
    state.run.error ? h('p', { className: 'issue' }, state.run.error) : null,
    checkList(state.run.evaluation) || h('p', { className: 'muted' }, '运行结束后显示结果。'),
    score?.reason ? h('p', { className: 'muted' }, score.failedRound ? `第 ${score.failedRound} 轮 · ` : '', score.reason) : null,
    score?.missingResultFields?.length ? h('p', { className: 'muted' }, '缺失工具返回字段 · ' + score.missingResultFields.join('、')) : null,
    score?.missingResultReferenceTools?.length ? h('p', { className: 'muted' }, '原版参考工具 · ' + score.missingResultReferenceTools.join('、')) : null,
    score?.differingFields?.length ? h('p', { className: 'muted' }, '状态差异字段 · ' + score.differingFields.join('、')) : null),
  h('section', {}, h('h3', {}, 'Agent 产出'), raw(state.run.output ?? '暂未返回产出')));
}

function analysisFindings(findings) {
  if (!findings.length) return h('p', { className: 'muted' }, '当前证据未识别出明确的优化项。');
  return h('ol', { className: 'analysis-list' }, findings.map(finding =>
    h('li', {}, h('h4', {}, finding.title), h('p', {}, finding.observation),
      h('dl', {}, h('dt', {}, '建议改动'), h('dd', {}, finding.change),
        h('dt', {}, '如何验证'), h('dd', {}, finding.verify)),
      h('div', { className: 'analysis-evidence' }, finding.evidence.map(eventLink)))));
}

const reviewStatus = { observed: '已观察到', potential: '待验证', clear: '已覆盖 · 未发现', uncovered: '未覆盖' };

function reviewFindings(findings) {
  return h('ol', { className: 'analysis-list cross-review-list' }, findings.map(finding => h('li', {},
    h('p', { className: 'muted review-type' }, (finding.area === 'security' ? '安全' : '架构') + ' · ' + reviewStatus[finding.status]),
    h('h4', {}, finding.title), h('p', {}, finding.observation),
    h('dl', {}, h('dt', {}, '建议改动'), h('dd', {}, finding.change), h('dt', {}, '复测条件'), h('dd', {}, finding.verify)),
    h('div', { className: 'analysis-evidence' }, finding.evidence.map(eventLink)))));
}

function renderCrossReview(review) {
  if (!review) return null;
  const { summary, checks, findings } = review;
  return h('section', { className: 'cross-review' }, h('h3', {}, '跨维度审查'),
    h('p', { className: 'muted' }, `安全 ${summary.security} 项 · 架构 ${summary.architecture} 项 · 覆盖 ${summary.covered}/${summary.total} 条检查`),
    findings.length ? reviewFindings(findings) : null,
    collapsible('检查覆盖范围', h('ul', { className: 'cross-review-checks' }, checks.map(check => h('li', {},
      h('strong', {}, check.label), h('span', { className: 'muted' }, reviewStatus[check.status]),
      check.note ? h('small', { className: 'muted' }, check.note) : null))), !findings.length));
}

function renderAnalysis() {
  const container = byId('analysis-view');
  const analysis = state.run?.analysis;
  if (!analysis) {
    container.replaceChildren(h('p', { className: 'muted' }, '等待运行完成后分析。'));
    return;
  }
  const model = analysis.model;
  container.replaceChildren(
    h('section', {}, h('h3', {}, '逐步模型诊断'),
      h('p', { className: 'muted', role: 'status' },
        `${state.run.agentAnalysisCount ?? 0} / ${state.run.events.length} 步已完成模型诊断`,
        state.run.phase === 'diagnosing' ? ' · 分析中' : '')),
    h('section', {},
      h('h3', {}, '整体分析'),
      h('p', { className: 'muted' }, model ? 'DeepSeek · ' + model.name + ' · 分析耗时 ' + elapsed(state.run.analysisDurationMs) :
        state.setup?.diagnosticEnabled ? '模型分析状态见运行通知。' : '在项目 .env 填写 DEEPSEEK_API_KEY 后可启用模型分析。'),
      model ? h('p', { className: 'analysis-summary' }, model.summary) : null,
      model ? analysisFindings(model.findings) : null),
    renderCrossReview(state.run.crossReview),
    h('section', {},
      h('h3', {}, '规则评估'),
      h('p', { className: 'analysis-summary' }, analysis.summary),
      analysisFindings(analysis.findings))
  );
}

function renderRequirement() {
  const target = byId('requirement-view');
  const task = state.run?.requirement || state.setup?.scenario;
  if (!task) { target.replaceChildren(); return; }
  target.replaceChildren(h('h3', {}, task.name, task.revision ? ' · v' + task.revision : ''),
    h('p', { className: 'requirement-text' }, task.task),
    task.benchmark ? h('p', { className: 'muted' }, task.benchmark.name + ' · ' + task.benchmark.group) : null,
    task.criteria?.length ? h('section', {}, h('h4', {}, '验收项'),
      h('ol', {}, task.criteria.map(item => h('li', {}, item)))) : null,
    task.contract?.length ? h('section', { className: 'editor-section' }, h('h4', {}, '工具与产出契约'),
      h('ul', { className: 'contract-list' }, task.contract.map(item => h('li', {}, h('code', {}, item))))) : null,
    task.references?.length ? h('section', { className: 'editor-section' }, h('h4', {}, '研究依据'),
      h('ul', { className: 'editor-sources' }, task.references.map(source => h('li', {},
        h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.name),
        h('small', { className: 'muted' }, source.venue + ' · ' + source.kind))))) : null);
}

function renderBatch() {
  const target = byId('batch-view');
  const run = state.run;
  if (!run?.cases) { target.replaceChildren(); return; }
  const complete = run.cases.filter(item => !activePhases.has(item.phase)).length;
  const reviewed = run.cases.map(item => item.reviewSummary).filter(Boolean);
  const reviewTotal = key => reviewed.reduce((sum, item) => sum + item[key], 0);
  const grouped = run.evaluation?.benchmark?.groups || [];
  const visible = state.batchGroup ? run.cases.filter(item => item.benchmark?.group === state.batchGroup) : run.cases;
  const pageSize = run.benchmark ? 40 : Math.max(1, visible.length);
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  state.batchPage = Math.min(state.batchPage, pages - 1);
  const nodes = visible.slice(state.batchPage * pageSize, (state.batchPage + 1) * pageSize).map(item => {
    const outcome = item.phase === 'complete' ? (item.success ? '通过' : '评估未通过') : phaseLabel(item.phase);
    const level = item.phase === 'failed' || item.phase === 'complete' && !item.success ? 'problem' :
      item.success ? 'success' : 'pending';
    return button([
      h('span', { className: 'batch-card-title' }, h('strong', {}, item.name), h('span', { className: 'batch-state', 'data-level': level }, outcome)),
      h('span', { className: 'batch-card-meta muted' }, item.benchmark?.group || (item.type === 'security' ? '安全' : '功能') + ' · v' + item.revision,
        Number.isFinite(item.required) ? ' · ' + item.passed + '/' + item.required + ' 项' : '',
        item.eventCount ? ' · ' + item.eventCount + ' 步' : '',
        Number.isFinite(item.durationMs) ? ' · ' + elapsed(item.durationMs) : ''),
      item.reviewSummary ? h('span', { className: 'batch-card-meta muted' },
        `安全 ${item.reviewSummary.security} · 架构 ${item.reviewSummary.architecture} · 覆盖 ${item.reviewSummary.covered}/${item.reviewSummary.total}`) : null,
      item.error ? h('span', { className: 'batch-card-error issue' }, item.error) : null
    ], () => selectRun(run.id, undefined, item.id), { className: 'batch-card' });
  });
  const overview = run.evaluation?.benchmark;
  target.replaceChildren(h('div', { className: 'batch-hub' },
    h('h3', {}, run.benchmark?.name || '任务批次'),
    h('span', { className: 'muted' }, complete + ' / ' + run.cases.length + ' 个任务已结束'),
    reviewed.length ? h('span', { className: 'muted' }, `安全发现 ${reviewTotal('security')} · 架构发现 ${reviewTotal('architecture')} · 覆盖 ${reviewTotal('covered')}/${reviewTotal('total')} 条检查`) : null,
    overview ? h('span', { className: 'muted' }, `${overview.passed} 通过 · ${overview.scored} 已评分 · ${overview.errors} 执行错误`) : null),
    grouped.length ? h('div', { className: 'task-filters', role: 'group', 'aria-label': '题目类别' },
      [{ group: '', passed: overview.passed, total: overview.total }, ...grouped].map(item =>
        button((item.group || '全部') + ' · ' + item.passed + '/' + item.total, () => {
          state.batchGroup = item.group;
          state.batchPage = 0;
          renderBatch();
        }, { className: 'button small', 'aria-pressed': String(state.batchGroup === item.group) }))) : null,
    h('div', { className: 'batch-branches' }, nodes),
    pages > 1 ? h('div', { className: 'benchmark-pagination' },
      button('上一页', () => { state.batchPage -= 1; renderBatch(); }, { disabled: state.batchPage === 0 }),
      h('span', {}, state.batchPage + 1 + ' / ' + pages),
      button('下一页', () => { state.batchPage += 1; renderBatch(); }, { disabled: state.batchPage === pages - 1 })) : null);
}

function changeView(view) {
  state.view = view;
  byId('trace-view').hidden = view !== 'trace';
  byId('output-view').hidden = view !== 'output';
  byId('analysis-view').hidden = view !== 'analysis';
  byId('batch-view').hidden = view !== 'batch';
  byId('requirement-view').hidden = view !== 'requirement';
  for (const item of byId('views').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item.dataset.view === view));
  if (view === 'output') renderOutput();
  if (view === 'analysis') renderAnalysis();
  if (view === 'batch') renderBatch();
  if (view === 'requirement') renderRequirement();
}

async function loadDetail() {
  const id = state.run?.id, step = state.selected;
  if (step == null) return;
  const generation = ++state.detailGeneration;
  const inspector = byId('diagnostics').parentElement;
  inspector.setAttribute('aria-busy', 'true');
  try {
    const result = await request(casePath(id, '/events/' + step));
    if (generation !== state.detailGeneration || state.run?.id !== id) return;
    state.detail = result;
    renderInspector();
  } catch (error) {
    if (generation === state.detailGeneration) notify(error.message, true);
  } finally {
    if (generation === state.detailGeneration) inspector.setAttribute('aria-busy', 'false');
  }
}

function selectStep(id, explicit = false) {
  state.explicitSelection ||= explicit;
  state.selected = id;
  state.detail = null;
  state.detailTab = '';
  renderTrace();
  renderInspector();
  void loadDetail();
}

async function refreshRun(id, generation, preferred) {
  try {
    const previous = state.run;
    const current = await request(casePath(id));
    if (state.generation !== generation) return;
    state.run = current;
    renderHeader(current);
    if (current.cases && !state.caseId) changeView('batch');
    const phaseChanged = current.phase !== previous?.phase;
    let selected = preferred != null && current.events.find(event => event.id === preferred);
    if (!selected && !state.explicitSelection && (state.selected == null || (phaseChanged && !activePhases.has(current.phase)))) {
      selected = current.events.find(event => event.kind === 'compression' && isIssue(event)) ||
        current.events.find(event => event.kind === 'compression') || current.events.at(0);
    }
    if (selected && state.selected !== selected.id) {
      if (preferred != null) state.graphRound = selected.round;
      selectStep(selected.id);
    } else {
      const diagnosisArrived = !state.detail?.diagnostic?.agent &&
        current.events.some(event => event.id === state.selected && event.modelDiagnosed);
      if (state.selected != null && (phaseChanged || diagnosisArrived)) void loadDetail();
      renderTrace();
    }
    if (state.view === 'output') renderOutput();
    if (state.view === 'analysis') renderAnalysis();
    if (state.view === 'requirement') renderRequirement();
    if (activePhases.has(current.batchPhase ?? current.phase)) {
      state.poll = setTimeout(() => refreshRun(id, generation), current.benchmark && !current.caseId && current.cases ? 1200 : 430);
    }
    else {
      if (current.error || current.diagnosticError) notify(current.error || current.diagnosticError, Boolean(current.error));
      void loadHistory().catch(error => notify(error.message, true));
    }
  } catch (error) {
    if (state.generation === generation) notify(error.message, true);
  }
}

function selectRun(id, preferred, caseId = null) {
  if (state.run?.id !== id) {
    state.batchGroup = '';
    state.batchPage = 0;
  }
  clearTimeout(state.poll);
  clearTimeout(searchTimer);
  state.generation += 1;
  state.detailGeneration += 1;
  state.run = null;
  state.caseId = caseId;
  state.selected = null;
  state.detail = null;
  state.query = '';
  state.matches = null;
  state.issues = false;
  state.graphRound = null;
  state.explicitSelection = preferred != null;
  searchBox.value = '';
  byId('only-issues').setAttribute('aria-pressed', 'false');
  changeView('trace');
  renderTrace();
  renderInspector();
  void refreshRun(id, state.generation, preferred);
}

async function submitRun(job) {
  const run = await request('/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
  });
  state.history = [run, ...state.history];
  renderHistory();
  notify();
  selectRun(run.id);
}

searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = searchBox.value.trim();
  const run = state.run?.id;
  const generation = state.generation;
  state.query = query;
  state.matches = null;
  renderTrace();
  if (!query || !run) return;
  searchTimer = setTimeout(async () => {
    try {
      const { ids } = await request(casePath(run, '/search', { q: query }));
      if (state.generation === generation && state.run?.id === run && state.query === query) {
        state.matches = new Set(ids);
        renderTrace();
      }
    } catch (error) {
      if (state.generation !== generation || state.run?.id !== run || state.query !== query) return;
      state.matches = new Set();
      renderTrace();
      notify(error.message, true);
    }
  }, 190);
});

byId('only-issues').addEventListener('click', event => {
  state.issues = !state.issues;
  event.currentTarget.setAttribute('aria-pressed', String(state.issues));
  renderTrace();
});
searchBox.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    moveMatch(event.shiftKey ? -1 : 1);
  }
});
byId('graph-back').addEventListener('click', () => { state.graphRound = null; renderTrace(); });
byId('graph-prev-result').addEventListener('click', () => moveMatch(-1));
byId('graph-next-result').addEventListener('click', () => moveMatch(1));

byId('views').addEventListener('click', event => {
  const view = event.target.dataset.view;
  if (view === 'batch' && state.caseId) selectRun(state.run.id);
  else if (view) changeView(view);
});

function encodeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result.split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('无法读取选中的文件')));
    reader.readAsDataURL(file);
  });
}

function resetUpload() {
  uploadGeneration += 1;
  approval = null;
  tasksView.setApproved(false);
  byId('upload-submit').disabled = true;
  byId('upload-check').disabled = !state.setup?.uploadEnabled || !byId('agent-file').files.length;
  byId('preflight-report').hidden = true;
  byId('upload-error').textContent = '';
}

function syncUploadButton() {
  const official = byId('upload-task-source').value === 'benchmark';
  byId('upload-task-options').hidden = official;
  byId('upload-benchmark-picker').hidden = !official;
  byId('upload-submit').disabled = uploadBusy || !approval || !(official ? selectedBenchmark : tasksView.ids().length);
}

byId('upload-task-source').addEventListener('change', syncUploadButton);

byId('agent-file').addEventListener('change', resetUpload);
byId('upload-check').addEventListener('click', async () => {
  resetUpload();
  const generation = uploadGeneration;
  const file = byId('agent-file').files[0];
  const report = byId('preflight-report');
  if (!file || file.size > state.setup.maxPackageBytes) {
    byId('upload-error').textContent = '请选择 500 KB 以内的 .py 或 .zip 文件。';
    return;
  }
  byId('upload-check').disabled = true;
  report.hidden = false;
  report.textContent = '正在静态检查程序包…';
  try {
    const job = { target: 'upload', filename: file.name, packageBase64: await encodeFile(file) };
    const result = await request('/api/preflight', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
    });
    if (generation !== uploadGeneration) return;
    report.replaceChildren(
      h('strong', { className: result.approved ? 'check-pass' : 'check-fail' },
        result.approved ? '预检通过 · ' + result.files.length + ' 个源文件' : '预检未通过'),
      result.findings.length ? h('ul', {}, result.findings.map(item =>
        h('li', {}, item.file + (item.line ? ':' + item.line : ''), ' · ', item.message))) :
        h('p', {}, '可运行这次预检对应的文件。'));
    if (result.approved) {
      approval = { ...job, preflightToken: result.token };
      const [research] = await Promise.all([benchmarkSuites ? Promise.resolve({ suites: benchmarkSuites }) : request('/api/benchmarks'), tasksView.load()]);
      if (generation === uploadGeneration) {
        benchmarkSuites = research.suites;
        if (initialBenchmark) byId('upload-task-source').value = 'benchmark';
        selectedBenchmark = null;
        benchmarkPicker.setSuites(benchmarkSuites, initialBenchmark);
        tasksView.setApproved(true);
      }
    }
  } catch (error) {
    if (generation === uploadGeneration) {
      report.hidden = true;
      byId('upload-error').textContent = error.message;
    }
  } finally {
    if (generation === uploadGeneration) byId('upload-check').disabled = false;
  }
});

byId('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const verified = approval;
  const errorBox = byId('upload-error');
  errorBox.textContent = '';
  if (!verified) {
    errorBox.textContent = '请先完成安全预检。';
    return;
  }
  const official = byId('upload-task-source').value === 'benchmark';
  const selection = official ? selectedBenchmark && { benchmark: selectedBenchmark } : { taskIds: tasksView.ids() };
  if (!selection || selection.taskIds?.length === 0 || uploadBusy) return;
  uploadBusy = true;
  syncUploadButton();
  try {
    await submitRun({ ...verified, label: event.currentTarget.elements.version.value, ...selection });
    byId('upload-dialog').close();
    byId('upload-form').reset();
    resetUpload();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    uploadBusy = false;
    syncUploadButton();
  }
});

function comparableMetric(label, left, right) {
  return h('tr', {}, h('th', { scope: 'row' }, label), h('td', { className: 'tabular' }, left), h('td', { className: 'tabular' }, right));
}

function comparableRuns() {
  return state.history.filter(run => !run.cases && !activePhases.has(run.phase) && run.evaluation);
}

async function renderComparison() {
  const left = byId('compare-a').value, right = byId('compare-b').value;
  const target = byId('compare-body');
  const generation = ++compareGeneration;
  if (left === right) {
    target.replaceChildren(h('p', { className: 'empty-note' }, '请选择两条不同的运行记录。'));
    return;
  }
  target.replaceChildren(h('p', { className: 'empty-note' }, '正在读取版本数据…'));
  try {
    const [first, second] = await Promise.all([request(runPath(left)), request(runPath(right))]);
    if (generation !== compareGeneration) return;
    if (first.scenarioId !== second.scenarioId || (first.requirement?.revision ?? 1) !== (second.requirement?.revision ?? 1)) {
      target.replaceChildren(h('p', { className: 'empty-note' }, '请选择相同需求及版本下的两条运行记录。'));
      return;
    }
    const study = [first, second].map(run => ({
      ...run,
      score: run.evaluation.passed + ' / ' + run.evaluation.required,
      tokens: run.evaluation.usageReported ? number(run.evaluation.inputTokens + run.evaluation.outputTokens) +
        (run.evaluation.tokensEstimated ? '（估算）' : '') : '—',
      compact: run.evaluation.lastCompression
    }));
    const table = h('table', { className: 'compare-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, '指标'), h('th', { scope: 'col' }, 'A'), h('th', { scope: 'col' }, 'B'))),
      h('tbody', {},
        comparableMetric('通过的必需项', study[0].score, study[1].score),
        comparableMetric('端到端耗时', elapsed(first.durationMs), elapsed(second.durationMs)),
        comparableMetric('总 Token', study[0].tokens, study[1].tokens),
        comparableMetric('末轮输入 Token', number(first.evaluation.lastModelInputTokens ?? first.events.findLast(event => event.kind === 'model')?.usage?.inputTokens),
          number(second.evaluation.lastModelInputTokens ?? second.events.findLast(event => event.kind === 'model')?.usage?.inputTokens)),
        comparableMetric('压缩后 Token', number(study[0].compact?.afterTokens), number(study[1].compact?.afterTokens))));
    const divergence = findDivergence(first.events, second.events);
    const actions = [[first, divergence?.left], [second, divergence?.right]].map(([run, step]) =>
      button(run.label + (step ? ' · #' + step.id + ' ' + step.name : ' · 查看轨迹'),
        () => { byId('compare-dialog').close(); selectRun(run.id, step?.id); }, { className: 'evidence-link' }));
    target.replaceChildren(table, h('section', { className: 'source-group' },
      h('h3', {}, divergence ? '首次轨迹差异' : '输入与输出相同'), actions));
  } catch (error) {
    if (generation === compareGeneration) target.replaceChildren(h('p', { className: 'issue' }, error.message));
  }
}

byId('open-compare').addEventListener('click', () => {
  const choices = comparableRuns();
  for (const id of ['compare-a', 'compare-b']) byId(id).replaceChildren(...choices.map(run =>
    h('option', { value: run.id }, run.label + ' · ' + run.id.slice(0, 8))));
  byId('compare-a').value = choices[1].id;
  byId('compare-b').value = choices[0].id;
  byId('compare-dialog').showModal();
  void renderComparison();
});
for (const id of ['compare-a', 'compare-b']) byId(id).addEventListener('change', renderComparison);
for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => byId(close.dataset.close).close());
byId('upload-first').addEventListener('click', () => byId('upload-dialog').showModal());
byId('run-picker').addEventListener('change', event => { notify(); selectRun(event.target.value); });
byId('open-upload').addEventListener('click', () => byId('upload-dialog').showModal());

try {
  const [setup] = await Promise.all([request('/api/setup'), loadHistory()]);
  state.setup = setup;
  resetUpload();
  byId('upload-status').textContent = setup.uploadEnabled
    ? '支持带 run(task, ctx) 入口的可信 .py 或 .zip。安全预检通过后在本机执行。'
    : '当前服务找不到 Python 3.10+。安装 Python 或配置 AGENT_PYTHON 后重启。';
  if (state.history.length) selectRun(state.history[0].id);
  if (initialBenchmark) byId('upload-dialog').showModal();
} catch (error) {
  notify(error.message, true);
}
