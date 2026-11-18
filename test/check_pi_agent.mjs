import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createWorkbench } from '../server.mjs';

const packagePath = process.argv[2];
if (!packagePath) throw new Error('请传入 package_pi_agent.py 生成的 ZIP');
const compact = process.argv.includes('--compact-results');
const server = await createWorkbench();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const job = { target: 'upload', filename: basename(packagePath),
  label: compact ? 'pi-agent v0.6.0 · 精简工具返回' : 'pi-agent v0.6.0 · 原始工具返回',
  packageBase64: (await readFile(packagePath)).toString('base64') };

async function post(route, value) {
  const result = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  return { status: result.status, body: await result.json() };
}

async function get(route) {
  const response = await fetch(base + route);
  assert.equal(response.status, 200);
  return response.json();
}

try {
  const approval = await post('/api/preflight', job);
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  assert.equal(approval.body.approved, true, JSON.stringify(approval.body));
  const launch = await post('/api/runs', { ...job, preflightToken: approval.body.token });
  assert.equal(launch.status, 202, JSON.stringify(launch.body));
  const route = '/api/runs/' + launch.body.id;
  let run;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    run = await get(route);
    if (run.phase === 'complete' || run.phase === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(run.phase, 'complete', run.error);
  assert.equal(run.evaluation.passed, 3);
  assert.equal(run.evaluation.modelCalls, 2);
  assert.equal(run.evaluation.toolCalls, 2);
  const details = await Promise.all(run.events.map(item => get(route + '/events/' + item.id)));
  const trims = details.filter(item => item.event.kind === 'compression');
  assert.deepEqual(trims.map(({ event }) => [event.detail.beforeMessages, event.detail.afterMessages]), [[3, 1], [5, 3]]);
  assert.equal(trims[1].diagnostic.level, 'warning');
  const toolResults = details.filter(item => item.event.kind === 'tool_result');
  const finalModel = run.events.filter(item => item.kind === 'model').at(-1);
  assert.equal(toolResults.length, 2);
  assert.ok(toolResults.every(({ diagnostic }) => diagnostic.evidence.includes(finalModel.id) &&
    diagnostic.observation.includes('实际模型输入')));
  assert.ok(details.every(item => item.diagnostic?.title));
  const projected = details.find(({ event }) => event.name === '精简发布规范工具结果');
  assert.equal(Boolean(projected), compact);
  assert.ok(run.analysis.findings.some(finding => finding.title === '为长轮次设置 Token 预算'));
  assert.equal(run.analysis.findings.some(finding => finding.title === '先精简进入模型的工具结果'), !compact);
  if (projected) assert.ok(projected.event.detail.afterTokens < projected.event.detail.beforeTokens);
  console.log(JSON.stringify({
    id: run.id, steps: run.eventCount, passed: run.evaluation.passed, required: run.evaluation.required,
    modelCalls: run.evaluation.modelCalls, toolCalls: run.evaluation.toolCalls,
    estimatedTokens: [run.evaluation.inputTokens, run.evaluation.outputTokens],
    lastModelInputTokens: run.evaluation.lastModelInputTokens, durationMs: run.durationMs,
    analysis: run.analysis,
    compression: trims.map(({ event }) => ({ id: event.id, ...event.detail })),
    diagnostics: details.map(({ event, diagnostic }) =>
      ({ id: event.id, level: diagnostic.level, finding: diagnostic.observation, evidence: diagnostic.evidence }))
  }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
