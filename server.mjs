import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRecorder, traceSummary } from './lib/trace.mjs';
import { runDemo } from './lib/demo.mjs';
import { evaluate, diagnose } from './lib/evaluation.mjs';
import { addAgentAnalysis, diagnosticConfigured, generateCodePlan } from './lib/diagnostic-agent.mjs';
import { referenceCodePlan, stepSource } from './lib/code-advice.mjs';
import { buildRunAnalysis } from './lib/run-analysis.mjs';
import { reviewTrajectory } from './lib/cross-review.mjs';
import { detectPython, executePackage, preflightPackage, readPackageSource } from './lib/local-runner.mjs';
import { liveModelConfigured } from './lib/model-gateway.mjs';
import { createTaskCatalog, describeTask } from './lib/tasks.mjs';
import { officialBenchmarks } from './lib/benchmarks.mjs';
import { createBenchmarkRuns } from './lib/benchmark-runs.mjs';

const base = fileURLToPath(new URL('.', import.meta.url));
const scenario = JSON.parse(await readFile(join(base, 'shared', 'scenario.json'), 'utf8'));
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const allowedSources = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript; charset=utf-8']],
  ['/ui.mjs', ['public/ui.mjs', 'text/javascript; charset=utf-8']],
  ['/trace-graph.mjs', ['public/trace-graph.mjs', 'text/javascript; charset=utf-8']],
  ['/code-review.mjs', ['public/code-review.mjs', 'text/javascript; charset=utf-8']],
  ['/task-catalog.mjs', ['public/task-catalog.mjs', 'text/javascript; charset=utf-8']],
  ['/benchmark-picker.mjs', ['public/benchmark-picker.mjs', 'text/javascript; charset=utf-8']],
  ['/tasks', ['public/tasks.html', 'text/html; charset=utf-8']],
  ['/tasks/', ['public/tasks.html', 'text/html; charset=utf-8']],
  ['/tasks-page.mjs', ['public/tasks-page.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/sample-agent.py', ['examples/agent.py', 'text/x-python; charset=utf-8']]
]);
const labels = { baseline: '基线 · 通用摘要', improved: '改进 · 保留强制规则' };
const activePhases = new Set(['queued', 'running', 'diagnosing']);
const analysisModes = new Set(['score', 'failed', 'full']);

function packageChecksum(filename, bytes) {
  return createHash('sha256').update(filename).update('\0').update(bytes).digest('hex');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function parseBody(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
    throw httpError(415, '请求需要 application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 750_000) chunks.push(chunk);
  }
  if (size > 750_000) throw httpError(413, '提交包超过上传限制');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, '无法解析请求数据'); }
}

function validateJob(body) {
  if (!body || typeof body !== 'object') throw httpError(400, '缺少执行参数');
  if (Object.hasOwn(labels, body.target)) return { target: body.target, label: labels[body.target] };
  if (body.target !== 'upload') throw httpError(400, '未知运行类型');
  const { filename, packageBase64 } = body;
  if (typeof filename !== 'string' || filename.length > 120 || /[/\\\0]/.test(filename) || !/\.(py|zip)$/i.test(filename) ||
      typeof packageBase64 !== 'string' || !packageBase64.length || packageBase64.length > 686_000 ||
      packageBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(packageBase64)) {
    throw httpError(400, '请选择 500 KB 以内的 .py 或 .zip 文件');
  }
  const bytes = Buffer.from(packageBase64, 'base64');
  if (bytes.length > 512_000 || bytes.toString('base64') !== packageBase64) throw httpError(400, '上传包无效或过大');
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 70) : filename;
  if (body.taskIds !== undefined && (!Array.isArray(body.taskIds) || !body.taskIds.length ||
      body.taskIds.some(id => typeof id !== 'string') || new Set(body.taskIds).size !== body.taskIds.length)) {
    throw httpError(400, '请选择不同的测试需求');
  }
  if (body.benchmark && body.taskIds !== undefined || body.retestOf && (body.benchmark || body.taskIds !== undefined)) {
    throw httpError(400, '请选择单一任务来源');
  }
  const analysisMode = body.analysisMode ?? 'full';
  if (!analysisModes.has(analysisMode)) throw httpError(400, '未知的分析范围');
  const retestOf = body.retestOf;
  if (retestOf !== undefined && (!retestOf || typeof retestOf.runId !== 'string' || !idPattern.test(retestOf.runId) ||
      retestOf.caseId !== undefined && (typeof retestOf.caseId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(retestOf.caseId)))) {
    throw httpError(400, '无效的复测来源');
  }
  return { target: 'upload', label, filename, packageBase64, benchmark: body.benchmark, analysisMode, retestOf,
    checksum: packageChecksum(filename, bytes),
    preflightToken: typeof body.preflightToken === 'string' ? body.preflightToken : '',
    taskIds: body.taskIds || [scenario.id] };
}

function briefCase(item) {
  return { id: item.requirement.id, name: item.requirement.name, type: item.requirement.type,
    revision: item.requirement.revision, phase: item.phase, durationMs: item.durationMs, error: item.error,
    eventCount: item.eventCount ?? item.events.length, passed: item.evaluation?.passed, required: item.evaluation?.required,
    benchmark: item.requirement.benchmark, benchmarkScore: item.evaluation?.benchmark,
    success: item.evaluation?.success, reviewSummary: item.crossReview?.summary ?? item.reviewSummary,
    analysisStatus: item.analysisStatus };
}

function buildCrossReview(item, task) {
  if (!item.evaluation || item.cases) return null;
  if (!task && !['complete', 'failed'].includes(item.phase)) return item.crossReview ?? null;
  try {
    if (task || !item.crossReview) item.crossReview = reviewTrajectory(item, task);
    return item.crossReview;
  }
  catch (error) {
    console.error('跨维度审查失败', error.message);
    return null;
  }
}

function header(run, includeCases = true) {
  return { id: run.id, label: run.label, target: run.target, scenarioId: run.scenarioId, phase: run.phase,
    createdAt: run.createdAt, durationMs: run.durationMs, evaluation: run.evaluation, error: run.error,
    eventCount: run.cases ? run.cases.reduce((sum, item) => sum + (item.eventCount ?? item.events.length), 0) : run.events.length,
    agentAnalysisCount: run.agentAnalysisCount ?? 0,
    cases: includeCases ? run.cases?.map(briefCase) : run.cases ? [] : undefined,
    caseCount: run.cases?.length, benchmark: run.benchmark,
    diagnosticError: run.diagnosticError, preflight: run.preflight, requirement: run.requirement,
    analysisMode: run.analysisMode, analysisStatus: run.analysisStatus, stopRequested: run.stopRequested, retestOf: run.retestOf };
}

function evaluateBatch(cases) {
  const complete = cases.filter(item => item.evaluation);
  const sum = key => complete.reduce((total, item) => total + item.evaluation[key], 0);
  return {
    passed: sum('passed'), required: sum('required'), success: complete.length === cases.length &&
      complete.every(item => item.evaluation.success),
    modelCalls: sum('modelCalls'), toolCalls: sum('toolCalls'), inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'), usageReported: complete.some(item => item.evaluation.usageReported),
    tokensEstimated: complete.some(item => item.evaluation.tokensEstimated)
  };
}

function benchmarkSummary(cases) {
  const grouped = new Map();
  for (const item of cases) {
    const group = item.requirement.benchmark.group;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(item);
  }
  function summarize(items) {
    const scored = items.map(item => item.evaluation?.benchmark).filter(Boolean);
    return { total: items.length, scored: scored.length, passed: scored.filter(score => score.passed).length,
      errors: items.filter(item => item.phase === 'failed').length };
  }
  return { ...summarize(cases), groups: [...grouped].map(([group, items]) => ({ group, ...summarize(items) })) };
}

export async function createWorkbench({ dataDir = join(base, 'data'), analysisClient,
  benchmarkDir = resolve(process.env.BENCHMARK_DATA_DIR || join(dataDir, 'benchmarks')) } = {}) {
  await mkdir(dataDir, { recursive: true });
  const ongoing = new Map();
  const cached = new Map();
  const python = await detectPython();
  const modelAnalysisEnabled = analysisClient?.configured ?? diagnosticConfigured;
  const catalog = await createTaskCatalog(join(dataDir, 'tasks.json'), scenario);
  const benchmarks = createBenchmarkRuns(benchmarkDir, python);
  const tickets = new Map();
  const pendingCodePlans = new Set();
  const packageDir = join(dataDir, 'packages');
  let checking = 0;

  function requirePython() {
    if (!python) throw httpError(503, '未找到本地 Python 3.10+，请安装解释器或设置 AGENT_PYTHON。');
  }

  async function storePackage(job) {
    await mkdir(packageDir, { recursive: true, mode: 0o700 });
    const target = join(packageDir, job.checksum);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, Buffer.from(job.packageBase64, 'base64'), { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function packageSource(run, file) {
    const { filename, checksum, files } = run.preflight ?? {};
    if (!filename || !/^[0-9a-f]{64}$/.test(checksum || '')) throw httpError(404, '这条记录没有上传包快照');
    if (!file || !/\.py$/i.test(file) || !files?.includes(file)) throw httpError(404, '找不到此运行中的 Python 源码文件');
    requirePython();
    const bytes = await readFile(join(packageDir, checksum)).catch(error => {
      if (error.code === 'ENOENT') throw httpError(404, '上传包快照已不可用');
      throw error;
    });
    if (packageChecksum(filename, bytes) !== checksum) throw httpError(409, '源码快照和运行记录的校验值不一致');
    const code = await readPackageSource(python, { filename, packageBase64: bytes.toString('base64') }, file);
    return { file, code };
  }

  function pruneTickets() {
    for (const [token, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(token);
    if (tickets.size >= 24) tickets.delete(tickets.keys().next().value);
  }

  function remember(run) {
    cached.delete(run.id);
    cached.set(run.id, run);
    if (cached.size > 12) cached.delete(cached.keys().next().value);
  }

  async function loadRun(id) {
    if (!idPattern.test(id)) return null;
    if (ongoing.has(id)) return ongoing.get(id);
    if (cached.has(id)) return cached.get(id);
    try {
      const run = JSON.parse(await readFile(join(dataDir, `${id}.json`), 'utf8'));
      if (run.cases && activePhases.has(run.phase)) {
        run.phase = 'cancelled';
        for (const item of run.cases) finishInterruptedCase(item);
        run.error = '工作台重启，已结束的题目可继续查看。';
      }
      if (run.evaluation && !run.cases) run.analysis ||= buildRunAnalysis(run);
      remember(run);
      return run;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function finishInterruptedCase(item) {
    if (!activePhases.has(item.phase)) return;
    item.phase = item.evaluation ? (item.error ? 'failed' : 'complete') : 'cancelled';
    if (item.analysisStatus === 'pending' || item.analysisStatus === 'running') item.analysisStatus = 'cancelled';
  }

  function locateCase(run, caseId) {
    const record = caseId ? run.cases?.find(entry => entry.requirement.id === caseId) : run;
    if (!record) throw httpError(404, '找不到该批次中的任务');
    const archive = record.archived ? join(dataDir, run.id, `${record.requirement.id}.json`) : null;
    return { record, archive };
  }

  async function loadCase({ record, archive }) {
    if (!archive) return record;
    const item = JSON.parse(await readFile(archive, 'utf8'));
    return { ...item, phase: record.phase, analysisStatus: record.analysisStatus ?? item.analysisStatus };
  }

  async function selectRetest(reference) {
    const baseRun = await loadRun(reference.runId);
    if (!baseRun) throw httpError(404, '找不到原始运行');
    const source = await loadCase(locateCase(baseRun, reference.caseId));
    if (!source.requirement || !source.evaluation || !['complete', 'failed'].includes(source.phase)) {
      throw httpError(409, '请选择已结束且有评估结果的单题记录');
    }
    const { requirement } = source;
    if (requirement.benchmark) {
      return benchmarks.select({ suite: requirement.benchmark.id, mode: 'task', key: requirement.benchmark.key });
    }
    if (source.taskSnapshot) return { tasks: [source.taskSnapshot] };
    const [current] = catalog.select([requirement.id]);
    if (current.revision !== requirement.revision) throw httpError(409, '此旧记录缺少当时的需求快照，当前需求版本已变更。');
    return { tasks: [current] };
  }

  async function executeCase(run, job, task) {
    run.phase = 'running';
    const recorder = createRecorder(run);
    let benchmark;
    try {
      if (task.benchmark) benchmark = await benchmarks.open(task);
      run.output = job.target === 'upload'
        ? await executePackage(python, recorder, benchmark?.scenario ?? task, job, benchmark)
        : await runDemo(recorder, task, job.target);
      if (!run.events.some(event => event.kind === 'output')) {
        recorder.record({ kind: 'output', name: '返回最终产出', output: run.output,
          round: run.events.at(-1)?.round, links: [run.events.at(-1)?.id] });
      }
      if (benchmark) {
        run.benchmarkScore = await benchmark.score();
        const final = run.events.at(-1);
        const failedRound = run.benchmarkScore.failedRound;
        const diverged = run.events.filter(event => event.round === failedRound && (event.kind === 'tool' || event.name === 'next_turn'));
        const evidence = [diverged[0]?.id, ...diverged.slice(-3).map(event => event.id), final?.id];
        recorder.record({ kind: 'state', name: 'BFCL 官方评分', round: final?.round, links: evidence, output: run.benchmarkScore });
      }
    } catch (error) {
      run.error = error.message.slice(0, 600);
    } finally { benchmark?.close(); }
    run.durationMs = recorder.elapsed();
    const analysisStarted = performance.now();
    run.evaluation = evaluate(run, task);
    run.diagnostics = diagnose(run);
    run.analysis = buildRunAnalysis(run);
    buildCrossReview(run, task);
    run.analysisDurationMs = Math.round(performance.now() - analysisStarted);
    const requested = job.analysisMode !== 'score' && (job.analysisMode !== 'failed' || !run.evaluation.success);
    run.analysisStatus = !requested ? 'skipped' : !modelAnalysisEnabled ? 'unconfigured' : 'pending';
    run.phase = run.analysisStatus === 'pending' ? 'diagnosing' : run.error ? 'failed' : 'complete';
  }

  async function diagnoseCase(item, task) {
    const started = performance.now();
    item.analysisStatus = 'running';
    await addAgentAnalysis(item, task, analysisClient);
    item.analysisDurationMs += Math.round(performance.now() - started);
    item.analysisStatus = item.diagnosticError ? 'partial' : 'done';
    item.phase = item.error ? 'failed' : 'complete';
  }

  async function writeRecord(file, record) {
    await writeFile(`${file}.tmp`, JSON.stringify(record), 'utf8');
    await rename(`${file}.tmp`, file);
  }

  function saveRun(run, phase) {
    return writeRecord(join(dataDir, `${run.id}.json`), { ...run, phase });
  }

  async function execute(run, job, tasks) {
    let finalPhase;
    if (run.cases) {
      run.phase = 'running';
      const caseDir = run.benchmark ? join(dataDir, run.id) : null;
      if (caseDir) await mkdir(caseDir);
      await saveRun(run, run.phase);

      async function checkpoint(index, item) {
        if (caseDir) {
          await writeRecord(join(caseDir, `${item.requirement.id}.json`), item);
          run.cases[index] = { requirement: item.requirement, phase: item.phase, error: item.error,
            durationMs: item.durationMs, eventCount: item.events.length, evaluation: item.evaluation,
            reviewSummary: item.crossReview?.summary, analysisStatus: item.analysisStatus, archived: true };
        }
        run.evaluation = evaluateBatch(run.cases);
        if (caseDir) run.evaluation.benchmark = benchmarkSummary(run.cases);
        await saveRun(run, run.phase);
      }

      for (const [index, item] of run.cases.entries()) {
        if (run.stopRequested) break;
        try {
          await executeCase(item, job, tasks[index]);
        } catch (error) {
          item.error = error.message.slice(0, 600);
          item.phase = 'failed';
          item.evaluation ||= evaluate(item, tasks[index]);
        }
        await checkpoint(index, item);
      }
      run.phase = 'diagnosing';
      for (let index = 0; index < run.cases.length && !run.stopRequested; index += 1) {
        const record = run.cases[index];
        if (record.analysisStatus !== 'pending') continue;
        const item = await loadCase(locateCase(run, record.requirement.id));
        if (run.stopRequested) break;
        record.analysisStatus = 'running';
        await diagnoseCase(item, tasks[index]);
        await checkpoint(index, item);
      }
      if (run.stopRequested) run.cases.forEach(finishInterruptedCase);
      run.durationMs = run.cases.reduce((sum, item) => sum + (item.durationMs || 0), 0);
      finalPhase = run.stopRequested ? 'cancelled' : 'complete';
    } else {
      await executeCase(run, job, tasks[0]);
      if (run.analysisStatus === 'pending') await diagnoseCase(run, tasks[0]);
      finalPhase = run.phase;
      run.phase = 'diagnosing';
    }
    try {
      await saveRun(run, finalPhase);
      run.phase = finalPhase;
    } catch {
      run.error ||= '运行已结束，保存记录失败。本次记录仅在当前进程中可读。';
      run.phase = 'failed';
    } finally {
      remember(run);
      ongoing.delete(run.id);
    }
  }

  async function route(request, response) {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i.test(request.headers.host || '')) {
      throw httpError(403, '本地执行服务只接受本机地址请求');
    }
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (request.method === 'GET' && allowedSources.has(path)) {
      const [file, mime] = allowedSources.get(path);
      const content = await readFile(join(base, file));
      response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache',
        ...(path === '/sample-agent.py' ? { 'Content-Disposition': 'attachment; filename="agent.py"' } : {}) });
      response.end(content);
      return;
    }
    if (request.method === 'GET' && path === '/api/setup') {
      sendJson(response, 200, { scenario: { id: scenario.id, name: scenario.name, task: scenario.task },
        uploadEnabled: Boolean(python), diagnosticEnabled: modelAnalysisEnabled,
        liveModelEnabled: liveModelConfigured, maxPackageBytes: 512_000 });
      return;
    }
    if (request.method === 'GET' && path === '/api/tasks') {
      sendJson(response, 200, { tasks: catalog.list(), templates: catalog.templates(), references: catalog.references });
      return;
    }
    if (request.method === 'GET' && path === '/api/benchmarks') {
      sendJson(response, 200, { benchmarks: officialBenchmarks, suites: benchmarks.suites });
      return;
    }
    const benchmarkMatch = path.match(/^\/api\/benchmarks\/([a-z0-9-]+)\/tasks$/);
    if (request.method === 'GET' && benchmarkMatch) {
      sendJson(response, 200, await benchmarks.catalog(benchmarkMatch[1]));
      return;
    }
    if (request.method === 'POST' && path === '/api/tasks') {
      sendJson(response, 201, await catalog.save(await parseBody(request)));
      return;
    }
    const taskMatch = path.match(/^\/api\/tasks\/([a-z0-9-]+)$/);
    if (request.method === 'PUT' && taskMatch) {
      sendJson(response, 200, await catalog.save(await parseBody(request), taskMatch[1]));
      return;
    }
    if (request.method === 'POST' && path === '/api/preflight') {
      requirePython();
      const job = validateJob(await parseBody(request));
      if (job.target !== 'upload') throw httpError(400, '安全预检需要一个上传程序包');
      if (checking >= 2) throw httpError(429, '预检执行器正忙，请稍后重试');
      checking += 1;
      try {
        const report = await preflightPackage(python, job);
        pruneTickets();
        const token = report.approved ? randomUUID() : null;
        const checkedAt = new Date().toISOString();
        if (token) tickets.set(token, { checksum: job.checksum, files: report.files,
          checkedAt, expires: Date.now() + 10 * 60_000 });
        sendJson(response, 200, { ...report, checkedAt, token });
      } catch (error) {
        throw httpError(422, error.message);
      } finally {
        checking -= 1;
      }
      return;
    }
    if (request.method === 'POST' && path === '/api/runs') {
      if (ongoing.size >= 2) throw httpError(429, '执行器正忙，请等当前任务完成。');
      const job = validateJob(await parseBody(request));
      let preflight;
      let ticket;
      if (job.target === 'upload') {
        requirePython();
        ticket = tickets.get(job.preflightToken);
        if (!ticket || ticket.expires <= Date.now() || ticket.checksum !== job.checksum) {
          throw httpError(409, '执行前需要对同一份文件完成安全预检');
        }
        preflight = { checkedAt: ticket.checkedAt, files: ticket.files, checksum: ticket.checksum, filename: job.filename };
      }
      const selection = job.retestOf ? await selectRetest(job.retestOf) : job.benchmark ? await benchmarks.select(job.benchmark) : null;
      const tasks = selection?.tasks || (job.target === 'upload' ? catalog.select(job.taskIds) : [scenario]);
      if (ticket) await storePackage(job);
      if (ongoing.size >= 2) throw httpError(429, '执行器正忙，请等当前任务完成。');
      if (ticket) {
        if (tickets.get(job.preflightToken) !== ticket || ticket.expires <= Date.now()) throw httpError(409, '安全预检已使用或过期');
        tickets.delete(job.preflightToken);
      }
      const batch = tasks.length > 1 || Boolean(job.benchmark && job.benchmark.mode !== 'task');
      const run = { id: randomUUID(), label: job.label, target: job.target, scenarioId: tasks.length === 1 ? tasks[0].id : undefined,
        phase: 'queued', createdAt: new Date().toISOString(), events: [], diagnostics: {}, preflight,
        retestOf: job.retestOf, analysisMode: job.analysisMode ?? 'full',
        benchmark: selection?.suite ? { id: selection.suite.id, name: selection.suite.name, mode: job.benchmark?.mode ?? 'task' } : undefined };
      if (!batch && job.target === 'upload') {
        run.requirement = describeTask(tasks[0]);
        if (!run.benchmark) run.taskSnapshot = tasks[0];
      }
      if (batch) run.cases = tasks.map(task => ({
        requirement: describeTask(task), taskSnapshot: task.benchmark ? undefined : task,
        phase: 'queued', events: [], diagnostics: {}
      }));
      ongoing.set(run.id, run);
      sendJson(response, 202, header(run, !run.benchmark));
      void execute(run, job, tasks).catch(error => {
        run.error = error.message.slice(0, 600);
        run.phase = 'failed';
        remember(run);
        ongoing.delete(run.id);
      });
      return;
    }
    const stopRoute = path.match(/^\/api\/runs\/([a-f0-9-]+)\/stop$/);
    if (request.method === 'POST' && stopRoute) {
      await parseBody(request);
      const run = ongoing.get(stopRoute[1]);
      if (!run?.cases || !run.cases.some(item => activePhases.has(item.phase))) {
        throw httpError(409, '没有可停止的批次');
      }
      run.stopRequested = true;
      sendJson(response, 202, { stopRequested: true });
      return;
    }
    if (request.method === 'GET' && path === '/api/runs') {
      const names = await readdir(dataDir);
      const ids = [...new Set([...ongoing.keys(), ...cached.keys(), ...names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))])];
      const rows = (await Promise.all(ids.map(loadRun))).filter(Boolean).map(run => header(run, !run.benchmark));
      rows.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
      sendJson(response, 200, { runs: rows.slice(0, 60) });
      return;
    }
    const planRoute = request.method === 'POST' && path.endsWith('/code-plan');
    const runPath = planRoute ? path.slice(0, -'/code-plan'.length) : path;
    const match = runPath.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(events)\/(\d+)|\/(export|search|source))?$/);
    if (match && (request.method === 'GET' || planRoute && match[2])) {
      if (planRoute) await parseBody(request);
      const run = await loadRun(match[1]);
      if (!run) throw httpError(404, '找不到这次运行');
      if (match[4] === 'source') {
        sendJson(response, 200, await packageSource(run, url.searchParams.get('file')));
        return;
      }
      const caseId = url.searchParams.get('case');
      const located = locateCase(run, caseId);
      const { archive } = located;
      let item = planRoute ? located.record : await loadCase(located);
      if (match[2]) {
        const index = Number(match[3]) - 1;
        let event;
        if (planRoute) {
          if (!modelAnalysisEnabled) throw httpError(503, '请先配置 DeepSeek 模型分析');
          if (!['complete', 'failed'].includes(item.phase) || !archive && ongoing.has(run.id)) {
            throw httpError(409, '运行结束后可生成代码建议');
          }
          const lock = archive || run.id;
          if (pendingCodePlans.has(lock)) throw httpError(409, '该条运行记录正在生成代码建议');
          pendingCodePlans.add(lock);
          try {
            if (archive) item = await loadCase(located);
            event = item.events[index];
            if (!event) throw httpError(404, '找不到这个步骤');
            buildCrossReview(item);
            const previous = item.diagnostics[event.id];
            const codePlan = await generateCodePlan(item, event, item.requirement?.task || scenario.task, analysisClient)
              .catch(error => { throw httpError(502, error.message); });
            item.diagnostics[event.id] = { ...previous, codePlan };
            try {
              if (archive) await writeRecord(archive, item);
              else {
                await saveRun(run, run.phase);
                remember(run);
              }
            } catch (error) {
              if (previous) item.diagnostics[event.id] = previous;
              else delete item.diagnostics[event.id];
              throw error;
            }
          } finally { pendingCodePlans.delete(lock); }
        } else event = item.events[index];
        if (!event) throw httpError(404, '找不到这个步骤');
        const diagnostic = item.diagnostics[event.id] || null;
        sendJson(response, 200, { event, diagnostic, source: stepSource(item, event),
          gateway: item.toolAudit?.[event.id], findings: buildCrossReview(item)?.findings.filter(finding => finding.stepId === event.id) ?? [],
          codePlan: diagnostic?.codePlan ?? referenceCodePlan(item, event) });
      } else if (match[4] === 'search') {
        const query = (url.searchParams.get('q') || '').trim().slice(0, 130).toLocaleLowerCase();
        const ids = item.events.filter(event => [event.id, event.kind, event.name, JSON.stringify(event.input),
          JSON.stringify(event.output), JSON.stringify(event.detail)].join(' ').toLocaleLowerCase().includes(query)).map(event => event.id);
        sendJson(response, 200, { ids });
      } else if (match[4] === 'export') {
        const suffix = caseId ? '-' + item.requirement.id.replace(/[^a-z0-9-]/gi, '-') : '';
        response.setHeader('Content-Disposition', `attachment; filename="trace-${run.id.slice(0, 8)}${suffix}.json"`);
        sendJson(response, 200, caseId ? { ...item, runId: run.id, caseId, analysisMode: run.analysisMode, preflight: run.preflight } : run);
      } else {
        const detail = header(run, !caseId || !run.benchmark);
        if (caseId) Object.assign(detail, briefCase(item), {
          id: run.id, label: item.requirement.name, caseId, batchPhase: run.phase, scenarioId: caseId,
          error: item.error, evaluation: item.evaluation, requirement: item.requirement, diagnosticError: item.diagnosticError,
          agentAnalysisCount: item.agentAnalysisCount ?? 0
        });
        sendJson(response, 200, { ...detail, output: item.output, analysis: item.analysis, crossReview: buildCrossReview(item),
          analysisDurationMs: item.analysisDurationMs,
          events: item.events.map(event => ({ ...traceSummary(event), modelDiagnosed: Boolean(item.diagnostics[event.id]?.agent),
            level: item.diagnostics[event.id]?.level ||
            (event.status === 'error' ? 'error' : 'info') })) });
      }
      return;
    }
    throw httpError(404, '找不到请求的路径');
  }

  return createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    route(request, response).catch(error => {
      if (response.headersSent) return response.destroy();
      sendJson(response, error.status || 500, { error: error.status ? error.message : '服务请求失败' });
      if (!error.status) console.error(error.message);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  const server = await createWorkbench();
  const host = '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  server.listen(port, host, () => console.log(`Local: http://${host}:${server.address().port}`));
}
