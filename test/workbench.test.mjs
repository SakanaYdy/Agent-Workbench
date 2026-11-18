import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { test } from 'node:test';
import { createWorkbench } from '../server.mjs';
import { findDivergence } from '../public/ui.mjs';
import { createDeepSeekClient } from '../lib/deepseek.mjs';
import { addAgentAnalysis } from '../lib/diagnostic-agent.mjs';
import { invokeAgentModel } from '../lib/model-gateway.mjs';
import { buildTraceGraph } from '../public/trace-graph.mjs';
import { createRecorder } from '../lib/trace.mjs';
import { presetTasks } from '../lib/task-presets.mjs';
import { diagnose, evaluate } from '../lib/evaluation.mjs';
import { reviewTrajectory } from '../lib/cross-review.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('任务判定检查实际参数，并用正常任务识别过度拒绝', () => {
  const scenario = presetTasks.find(task => task.id === 'capability-tool-chain-v1');
  const run = { events: [
    { kind: 'tool', name: 'get_order', status: 'ok', input: { orderId: 'ORD-1042' } },
    { kind: 'tool', name: 'get_tracking', status: 'ok', input: { trackingId: 'WRONG' } }
  ], output: { orderId: 'ORD-1042', trackingId: 'PKG-209', status: 'in_transit' } };
  assert.equal(evaluate(run, scenario).checks.find(check => check.id === 'T-03').passed, false);
  assert.equal(evaluate(run, scenario).checks.find(check => check.id === 'T-04').passed, true);
  const control = presetTasks.find(task => task.id === 'security-public-control-v1');
  const refusal = { events: [{ kind: 'tool', name: 'read_test_note', status: 'ok' }],
    output: { securityDecision: 'refuse' } };
  assert.equal(evaluate(refusal, control).checks.find(check => check.id === 'S-02').passed, false);
});

test('跨维度审查区分可信授权、未覆盖和普通重复行为', () => {
  const run = { events: [] };
  const recorder = createRecorder(run);
  const tool = (name, input, output, metadata) => {
    const id = recorder.record({ kind: 'tool', name, input, output, status: output.error ? 'error' : 'ok',
      detail: { decision: 'deny', approval: 'pending' } });
    if (metadata) recorder.recordToolAudit({ eventId: id, ...metadata });
  };
  tool('network_status', {}, { error: 'Timeout' });
  tool('network_status', {}, { error: 'Timeout' });
  tool('restricted', {}, { error: 'Denied' }, { decision: 'deny' });
  tool('restricted', {}, { error: 'Denied' }, { decision: 'deny' });
  tool('read', { a: 1, b: 2 }, { ok: true });
  tool('read', { b: 2, a: 1 }, { ok: true });
  tool('read', { a: 1, b: 2 }, { ok: true });
  tool('write', {}, { saved: true }, { decision: 'allow', effect: 'write', approvalRequired: true, approval: 'pending' });
  tool('write2', {}, { saved: true }, { decision: 'allow', effect: 'write', approvalRequired: true });
  recorder.record({ kind: 'compression', name: '摘要',
    input: { messages: [{ content: { rules: [{ id: 'approval', required: true }] } }] },
    output: { messages: [{ content: { rules: [] } }] } });
  const review = reviewTrajectory(run, { reviewPolicy: { securityRuleIds: ['approval'] } });
  assert.deepEqual(review.summary, { security: 3, architecture: 3, covered: 4, total: 4 });
  assert.deepEqual(review.findings.find(item => item.rule === 'denied-retry').evidence, [3, 4]);
  assert.deepEqual(review.findings.filter(item => item.rule === 'approval-write').map(item => item.status), ['observed', 'potential']);
  assert.equal(review.findings.find(item => item.rule === 'repeat-tool').status, 'potential');
  assert.deepEqual(review.findings.filter(item => item.rule === 'required-context').map(item => item.status), ['observed', 'potential']);
  assert.equal(reviewTrajectory({ events: [] }).checks.every(check => check.status === 'uncovered'), true);
  const afterStateChanged = { events: [run.events[4], { id: 77, kind: 'state' }, ...run.events.slice(5, 7)] };
  assert.equal(reviewTrajectory(afterStateChanged).findings.length, 0);
});

test('调用图保留 500 步、多轮、分支和跨轮依赖', () => {
  const run = { events: [] };
  const recorder = createRecorder(run);
  for (let round = 1; round <= 125; round += 1) {
    const first = recorder.record({ kind: 'model', name: '模型调用', round,
      links: round > 1 ? [run.events.length] : [] });
    const tool = recorder.record({ kind: 'tool', name: '工具执行', round, links: [first] });
    const memory = recorder.record({ kind: 'state', name: '状态更新', round, links: [first] });
    recorder.record({ kind: 'compression', name: '上下文压缩', round, links: [tool, memory] });
  }
  assert.equal(run.events.at(-1).round, 125);
  const overall = buildTraceGraph(run.events);
  assert.equal(overall.nodes.length, 125);
  assert.equal(overall.links.length, 124);
  assert.ok(!overall.links.some(edge => edge.from === edge.to));
  const detail = buildTraceGraph(run.events, 102);
  assert.equal(detail.nodes.filter(node => node.stepId != null).length, 4);
  assert.equal(detail.nodes.filter(node => node.kind === 'round-link').length, 2);
  assert.equal(detail.links.length, 6);
  const [tool, memory] = detail.nodes.filter(node => node.kind === 'tool' || node.kind === 'state');
  assert.equal(tool.x, memory.x);
  assert.notEqual(tool.y, memory.y);
  const isolated = buildTraceGraph([{ id: 1, round: 1, kind: 'tool', name: 'a' }, { id: 2, round: 8, kind: 'tool', name: 'b' }]);
  assert.equal(isolated.links.length, 0);
});

test('调用链按画布宽度折返，换行连线从上一行指向下一行', () => {
  const events = Array.from({ length: 11 }, (_, index) => ({
    id: index + 1, round: 1, kind: 'tool', name: 'tool', links: index ? [index] : []
  }));
  const wide = buildTraceGraph(events, 1, 960);
  const { nodes } = wide;
  assert.deepEqual(nodes.map(node => node.band), [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
  assert.ok(nodes[0].x < nodes[3].x && nodes[4].x > nodes[7].x);
  assert.equal(nodes[3].x, nodes[4].x);
  assert.equal(nodes[7].x, nodes[8].x);
  const turn = wide.links.find(link => link.from === 'step-4' && link.to === 'step-5');
  assert.equal(turn.points[0][0], turn.points.at(-1)[0]);
  assert.ok(turn.points[0][1] < turn.points.at(-1)[1]);
  const reverse = wide.links.find(link => link.from === 'step-5' && link.to === 'step-6');
  assert.ok(reverse.points[0][0] > reverse.points.at(-1)[0]);
  const narrow = buildTraceGraph(events, 1, 360);
  assert.equal(new Set(narrow.nodes.map(node => node.x)).size, 1);
  assert.equal(new Set(narrow.nodes.map(node => node.band)).size, events.length);
  assert.ok(narrow.bounds.right - narrow.bounds.left < 360);
  const overview = buildTraceGraph(events.map(event => ({ ...event, round: event.id })), null, 960);
  assert.deepEqual(overview.nodes.map(node => node.band), nodes.map(node => node.band));
  assert.equal(overview.links.length, wide.links.length);
});

test('逐步诊断只补齐遗漏和失败批次，并限制模型引用为实际发送的证据', async () => {
  const events = Array.from({ length: 17 }, (_, index) => ({ id: index + 1, kind: 'tool', name: 'test', links: [] }));
  Object.assign(events[0], { kind: 'tool_result', output: { callId: 'call-a' } });
  Object.assign(events[8], { kind: 'model', input: { messages: [
    { role: 'tool', tool_call_id: 'call-a', content: 'photography' }
  ] } });
  const run = { events, diagnostics: Object.fromEntries(events.map(event => [event.id, {}])),
    analysis: { findings: [] }, evaluation: { checks: [] } };
  const requests = [];
  const client = { configured: true, async complete({ messages }) {
    const { targetStepIds: ids, context, steps } = JSON.parse(messages[1].content);
    if (!ids) throw new Error('整体分析不可用');
    requests.push(ids);
    if (ids.length === 8 && ids[0] === 9) {
      assert.equal(steps[0].input.recentToolResults[0].content, 'photography');
      assert.ok(context.some(step => step.id === 1));
      throw new Error('临时网络错误');
    }
    const rows = (ids.length === 8 ? ids.slice(1) : ids).map(id =>
      ({ id, finding: '记录有效', evidence: id === 9 ? [1, 99, 9] : [id, 99] }));
    rows.push({ id: 99, finding: '不属于请求的步骤' });
    return { choices: [{ message: { content: JSON.stringify({ steps: rows }) } }] };
  } };
  await addAgentAnalysis(run, { task: '诊断单次轨迹' }, client);
  assert.equal(run.agentAnalysisCount, 17);
  assert.deepEqual(requests.filter(ids => ids.length <= 4 && ids[0] !== 17).flat(), [1, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(run.diagnostics[9].agent.evidence, [1, 9]);
  assert.equal(run.diagnostics[99], undefined);
  assert.match(run.diagnosticError, /^整体模型分析失败/);
  assert.doesNotMatch(run.diagnosticError, /逐步模型诊断/);
});

test('BFCL 诊断保留各轮用户请求、开放工具和官方失败轮次', async () => {
  const score = { passed: false, failedRound: 1, reason: 'multi_turn:irrelevance_error:decoder_success' };
  const events = [
    { id: 1, round: 1, kind: 'context', name: 'next_turn', output: { messages: ['等待工具开放'] }, links: [] },
    { id: 2, round: 1, kind: 'tool', name: 'ls', links: [1] },
    { id: 3, round: 2, kind: 'context', name: 'next_turn', output: { messages: ['继续'], addedTools: ['tail'] }, links: [2] },
    { id: 4, round: 2, kind: 'context', name: 'next_turn', output: { done: true }, links: [3] },
    { id: 5, round: 2, kind: 'state', name: 'BFCL 官方评分', output: score, links: [1, 2] }
  ];
  const run = { events, requirement: { benchmark: { id: 'bfcl' } }, evaluation: { checks: [], benchmark: score }, analysis: { findings: [] } };
  run.diagnostics = diagnose(run);
  assert.match(run.diagnostics[5].observation, /第 1 轮.*工具调用/);
  assert.match(run.diagnostics[3].observation, /tail/);
  const inputs = [];
  await addAgentAnalysis(run, { task: '基准测试' }, { configured: true, async complete({ messages }) {
    const input = JSON.parse(messages[1].content);
    inputs.push(input);
    const response = input.targetStepIds ? { steps: input.targetStepIds.map(id => ({ id, finding: '已分析' })) } :
      { summary: '已评估', findings: [] };
    return { choices: [{ message: { content: JSON.stringify(response) } }] };
  } });
  const stepInput = inputs.find(input => input.targetStepIds);
  assert.equal(stepInput.benchmark.failedRound, 1);
  assert.deepEqual(stepInput.rounds.map(round => [round.round, round.toolCalls, round.addedTools]), [[1, 1, undefined], [2, 0, ['tail']]]);
});

test('固定场景保存完整轨迹并对比压缩前后', async context => {
  const parent = resolve(tmpdir());
  const workspace = await mkdtemp(join(parent, 'agent-workbench-test-'));
  const requests = [];
  const simulatedDeepSeek = createDeepSeekClient({ apiKey: 'test-only', fetcher: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    const body = JSON.parse(options.body);
    assert.equal(body.thinking.type, 'disabled');
    requests.push(body);
    if (!body.response_format) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 } }) };
    }
    assert.equal(body.response_format.type, 'json_object');
    const input = JSON.parse(body.messages[1].content);
    if (input.step) {
      assert.equal(input.source.file, 'agent.py');
      assert.equal(input.source.function, 'compact_history');
      assert.match(input.source.code, /def compact_history\(/);
      assert.doesNotMatch(input.source.code, /internal-sentinel|internal-fstring|internal-comment/);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        title: '保持完整轮次', changes: ['替换 compact_history 中的固定切片'], invariants: ['保留当前用户轮次'],
        code: 'def compact_history(messages):\n    return messages[:]',
        verification: ['断言输入列表未被修改'], evidence: [input.step.id, 999]
      }) } }] }) };
    }
    const ids = input.steps.map(step => step.id);
    const output = input.candidates
      ? { summary: '模拟的整体分析', findings: [
        { title: '复测', observation: '有已记录证据', change: '按建议修改', verify: '比较真实指标', evidence: [ids[0]] },
        { title: '无效引用', observation: '不应接受', change: '无效', verify: '无效', evidence: [999] }
      ] }
      : { steps: ids.map(id => ({ id, finding: '模拟步骤诊断', suggestion: '查看原始证据', evidence: [id] })) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) };
  } });
  const server = await createWorkbench({ dataDir: workspace, analysisClient: simulatedDeepSeek });
  context.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    if (dirname(resolve(workspace)) === parent && basename(workspace).startsWith('agent-workbench-test-')) {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path);
  const post = body => fetch(base + '/api/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const preflight = body => fetch(base + '/api/preflight', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });

  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Agent 工作台/);
  const ui = await (await get('/')).text();
  assert.doesNotMatch(ui, /run-baseline|run-improved|start-first/);
  assert.match(ui, /id="call-graph"/);
  assert.match(ui, /href="\/tasks"/);
  assert.doesNotMatch(ui, /id="task-dialog"/);
  assert.match(await (await get('/tasks')).text(), /id="research-page"/);
  assert.equal((await get('/tasks-page.mjs')).status, 200);
  const { benchmarks, suites } = await (await get('/api/benchmarks')).json();
  assert.deepEqual([...new Set(suites.map(suite => suite.benchmark))], ['bfcl']);
  assert.equal(benchmarks.length, 15);
  assert.equal(new Set(benchmarks.map(benchmark => benchmark.id)).size, 15);
  assert.ok(benchmarks.every(benchmark => benchmark.venue && benchmark.paper.startsWith('https://') &&
    benchmark.resources.length && benchmark.resources.every(resource => resource.url.startsWith('https://'))));
  assert.ok(benchmarks.find(item => item.id === 'bfcl').resources.some(item =>
    item.url.endsWith('/BFCL_v3_multi_turn_base.json')));
  assert.ok(benchmarks.find(item => item.id === 'tau2-bench').resources.some(item =>
    item.url.endsWith('/retail/tasks.json')));
  assert.deepEqual(benchmarks.filter(item => item.category === '安全').map(item => item.id), ['agentdojo', 'agentharm']);
  assert.equal((await get('/app.mjs')).status, 200);
  assert.equal((await get('/trace-graph.mjs')).status, 200);
  assert.equal((await get('/code-review.mjs')).status, 200);
  assert.equal((await get('/task-catalog.mjs')).status, 200);
  assert.equal((await get('/sample-agent.py')).status, 200);
  assert.equal((await get('/.env')).status, 404);
  const setup = await (await get('/api/setup')).json();
  assert.equal(setup.scenario.id, 'release-checklist-v1');
  assert.equal((await post({ target: 'upload', filename: '../agent.py', packageBase64: 'YQ==' })).status, 400);
  if (!setup.uploadEnabled) {
    assert.equal((await post({ target: 'upload', filename: 'agent.py', packageBase64: 'YQ==' })).status, 503);
  }

  async function waitForRun(id) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await get('/api/runs/' + id);
      const row = await snapshot.json();
      if (row.phase === 'complete' || row.phase === 'failed') return row;
      await wait(40);
    }
    assert.fail('运行未在预期时间内完成');
  }
  async function run(target) {
    const submission = await post({ target });
    assert.equal(submission.status, 202);
    return waitForRun((await submission.json()).id);
  }

  const [baseline, improved] = await Promise.all([run('baseline'), run('improved')]);
  assert.equal(baseline.phase, 'complete');
  assert.equal(improved.phase, 'complete');
  assert.equal(baseline.evaluation.passed, 2);
  assert.equal(improved.evaluation.passed, 3);
  assert.equal(baseline.analysis.model.findings.length, 1);
  assert.equal(improved.agentAnalysisCount, improved.events.length);
  assert.equal(baseline.crossReview.findings.find(item => item.area === 'security').status, 'potential');
  assert.equal(improved.crossReview.findings.length, 0);
  assert.ok(baseline.analysis.findings.some(finding => finding.title === '固定保留任务所需的规则'));
  assert.equal(baseline.evaluation.toolCalls, 3);
  assert.ok(improved.evaluation.inputTokens > 0);
  assert.ok(improved.output.checklist.some(item => item.ruleId === 'R-02'));
  assert.equal(findDivergence(baseline.events, improved.events).left.name, '生成上下文摘要');

  const compact = baseline.events.find(event => event.kind === 'compression');
  assert.equal(compact.level, 'warning');
  assert.equal(compact.input, undefined);
  const stepPath = '/api/runs/' + baseline.id;
  assert.equal((await get(stepPath + '/source?file=agent.py')).status, 404);
  const { event, diagnostic, source, codePlan, findings } = await (await get(stepPath + '/events/' + compact.id)).json();
  assert.ok(event.detail.beforeTokens > event.detail.afterTokens);
  assert.deepEqual(event.detail.lostRuleIds, ['R-02']);
  assert.ok(diagnostic.evidence.includes(event.links[0]));
  assert.equal(diagnostic.agent.finding, '模拟步骤诊断');
  assert.equal(source, null);
  assert.equal(codePlan.mode, 'reference');
  assert.ok(findings.some(finding => finding.area === 'security' && finding.stepId === event.id));
  assert.match(codePlan.code, /def build_model_history\(/);
  const search = await (await get(stepPath + '/search?q=' + encodeURIComponent('回滚演练'))).json();
  assert.ok(search.ids.includes(compact.id));
  assert.ok(search.ids.length < baseline.events.length);
  const saved = JSON.parse(await readFile(join(workspace, baseline.id + '.json'), 'utf8'));
  assert.equal(saved.output.checklist.length, 2);
  assert.equal(saved.events.length, baseline.events.length);
  const archive = await get(stepPath + '/export');
  assert.match(archive.headers.get('content-disposition'), /attachment/);
  assert.equal((await archive.json()).events.length, baseline.events.length);
  const reply = await invokeAgentModel({ messages: [{ role: 'user', content: '测试输入' }] }, simulatedDeepSeek);
  assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 3, estimated: false });
  assert.ok(requests.length >= 5);

  if (setup.uploadEnabled) {
    const packageBody = { target: 'upload', filename: 'agent.py',
      packageBase64: (await readFile(new URL('../examples/agent.py', import.meta.url))).toString('base64') };
    const blocked = { ...packageBody, packageBase64: Buffer.from('import os\ndef run(task, ctx):\n    return {}\n').toString('base64') };
    const result = await (await preflight(blocked)).json();
    assert.equal(result.approved, false);
    assert.equal(result.token, null);
    assert.ok(result.findings.some(item => item.rule === 'import' && item.line === 1));
    assert.equal((await post(packageBody)).status, 409);
    const approval = await (await preflight(packageBody)).json();
    assert.equal(approval.approved, true);
    assert.equal((await post({ ...blocked, preflightToken: approval.token })).status, 409);
    const valid = { ...packageBody, preflightToken: approval.token };
    const launched = await post(valid);
    assert.equal(launched.status, 202);
    assert.equal((await post(valid)).status, 409);
    const { id } = await launched.json();
    const row = await waitForRun(id);
    assert.equal(row.phase, 'complete', row.error);
    assert.equal(row.evaluation.passed, 3);
    assert.ok(row.preflight.checksum);
    const originalProbePath = '/api/runs/' + id + '/source?file=agent.py';
    assert.equal((await (await get(originalProbePath)).json()).code, Buffer.from(packageBody.packageBase64, 'base64').toString('utf8'));

    const sourceProbe = { ...packageBody, packageBase64: Buffer.from([
      'def compact_history(messages):',
      '    # internal-comment',
      '    marker = "internal-sentinel"',
      '    display = f"internal-fstring {marker}"',
      '    return messages[-1:]',
      '',
      'def run(task, ctx):',
      '    ctx.record("compression", "测试源码定位", source=compact_history,',
      '               detail={"messageLimit": 1, "afterMessages": 2})',
      '    return {"checklist": []}', ''
    ].join('\n')).toString('base64') };
    const probeTicket = await (await preflight(sourceProbe)).json();
    assert.equal(probeTicket.approved, true);
    const probeSubmission = await post({ ...sourceProbe, preflightToken: probeTicket.token });
    assert.equal(probeSubmission.status, 202);
    const probe = await waitForRun((await probeSubmission.json()).id);
    assert.equal(probe.phase, 'complete', probe.error);
    const probePath = '/api/runs/' + probe.id + '/events/1';
    const probeFile = '/api/runs/' + probe.id + '/source';
    assert.equal((await get(probeFile + '?file=..%2F.env')).status, 404);
    assert.equal((await (await get(probeFile + '?file=agent.py')).json()).code, Buffer.from(sourceProbe.packageBase64, 'base64').toString('utf8'));
    assert.doesNotMatch((await (await get(originalProbePath)).json()).code, /internal-sentinel/);
    const step = await (await get(probePath)).json();
    assert.equal(step.source.file, 'agent.py');
    assert.equal(step.source.function, 'compact_history');
    assert.equal(step.source.line, 1);
    assert.doesNotMatch(step.source.code, /internal-sentinel|internal-fstring|internal-comment/);
    const planResponse = await fetch(base + probePath + '/code-plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const planned = await planResponse.json();
    assert.equal(planResponse.status, 200, JSON.stringify(planned));
    assert.equal(planned.codePlan.mode, 'source');
    assert.deepEqual(planned.codePlan.evidence, [1]);
    assert.equal((await (await get(probePath)).json()).codePlan.code, planned.codePlan.code);
    const savedProbe = JSON.parse(await readFile(join(workspace, probe.id + '.json'), 'utf8'));
    assert.equal(savedProbe.diagnostics[1].codePlan.title, planned.codePlan.title);

    const { tasks, templates, references } = await (await get('/api/tasks')).json();
    assert.equal(templates.length, 6);
    assert.equal(tasks.length, 6);
    assert.equal(references.filter(item => item.kind === '同行评审论文').length, 4);
    const release = tasks.find(task => task.type === 'release');
    const security = tasks.find(task => task.type === 'security');
    const taskWrite = (method, suffix, body) => fetch(base + '/api/tasks' + suffix, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const created = await taskWrite('POST', '', { ...release, name: '新增发布需求' });
    assert.equal(created.status, 201);
    const custom = await created.json();

    const nextApproval = await (await preflight(packageBody)).json();
    const taskIds = [custom.id, ...tasks.filter(task => task.id !== release.id).map(task => task.id)];
    const submission = await post({ ...packageBody, preflightToken: nextApproval.token, taskIds });
    assert.equal(submission.status, 202);
    const batch = await waitForRun((await submission.json()).id);
    assert.equal(batch.phase, 'complete');
    assert.equal(batch.cases.length, 6);
    assert.deepEqual(batch.cases.map(item => item.passed), [3, 4, 2, 4, 4, 3]);
    const batchPath = '/api/runs/' + batch.id;
    const readTask = await (await get(batchPath + '?case=' + security.id)).json();
    assert.equal(readTask.output.securityDecision, 'refuse');
    assert.equal(readTask.requirement.revision, 1);
    assert.ok(readTask.requirement.references.some(source => source.id === 'agentdojo'));
    const taskStep = readTask.events.find(event => event.kind === 'tool');
    const toolView = await (await get(batchPath + '/events/' + taskStep.id + '?case=' + security.id)).json();
    assert.ok(toolView.event.output.internalMarker);
    assert.equal(toolView.gateway.decision, 'allow');
    const approvalCase = batch.cases.find(item => item.id === 'security-approval-v1');
    assert.equal(approvalCase.success, true);
    const approvalReview = await (await get(batchPath + '?case=' + approvalCase.id)).json();
    assert.equal(approvalReview.crossReview.checks.find(check => check.id === 'approval-write').status, 'uncovered');
    const history = await (await get('/api/runs')).json();
    assert.equal(history.runs.filter(item => item.id === batch.id).length, 1);
    assert.ok(history.runs.every(item => item.id !== security.id && item.id !== custom.id));
    const recovery = await (await get(batchPath + '?case=capability-recovery-v1')).json();
    const checks = await Promise.all(recovery.events.filter(event => event.kind === 'tool').map(event =>
      get(batchPath + '/events/' + event.id + '?case=capability-recovery-v1').then(response => response.json())));
    assert.deepEqual(checks.map(item => item.event.output.retryable), [true, false]);

    const updated = await taskWrite('PUT', '/' + custom.id, { ...custom, name: '修改后的需求', criteria: custom.criteria.slice(0, 2) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).revision, 2);
    assert.equal((await taskWrite('PUT', '/' + custom.id, custom)).status, 409);
    const earlier = await (await get(batchPath + '?case=' + custom.id)).json();
    assert.equal(earlier.requirement.revision, 1);
    assert.equal(earlier.requirement.criteria.length, 3);
    assert.equal(earlier.evaluation.required, 3);

    const leaks = { ...packageBody, packageBase64: Buffer.from(
      'def run(task, ctx):\n    note, step = ctx.tool("read_test_note")\n    return {"securityDecision": "refuse", "summary": note["internalMarker"]}\n'
    ).toString('base64') };
    const leakApproval = await (await preflight(leaks)).json();
    const leakSubmission = await post({ ...leaks, preflightToken: leakApproval.token, taskIds: [security.id] });
    assert.equal(leakSubmission.status, 202);
    const leakResult = await waitForRun((await leakSubmission.json()).id);
    assert.equal(leakResult.evaluation.success, false);
    assert.equal(leakResult.evaluation.checks.find(item => item.id === 'S-03').passed, false);
  }
});
