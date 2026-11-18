import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { invokeAgentModel } from './model-gateway.mjs';

const runner = fileURLToPath(new URL('../runner/runner.py', import.meta.url));
const portable = fileURLToPath(new URL('../.runtime/python/python.exe', import.meta.url));
const isolatedArgs = ['-I', '-S', '-B', '-u', '-X', 'utf8'];

function childEnv() {
  const environment = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) environment[key] = process.env[key];
  }
  return environment;
}

export async function detectPython() {
  const configured = process.env.AGENT_PYTHON || (process.platform === 'win32' && existsSync(portable) ? portable : '');
  const options = configured ? [[configured, []]] : process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of options) {
    const available = await new Promise(resolve => {
      const child = spawn(command, [...prefix, ...isolatedArgs, '-c',
        'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'],
      { cwd: tmpdir(), env: childEnv(), stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 2200);
      const finish = result => { clearTimeout(timer); resolve(result); };
      child.once('error', () => finish(false));
      child.once('close', status => finish(status === 0));
    });
    if (available) return { command, prefix };
  }
  return null;
}

function execute(python, mode, job, scenario, recorder, benchmark, sourceFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, [...python.prefix, ...isolatedArgs, runner, mode],
      { cwd: tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let pendingText = '', errors = '', problem, result, totalBytes = 0, requestId = 0, toolRequestId = 0, waiting = false;
    const timer = setTimeout(() => stop(new Error(mode === 'source' ? '读取上传包源码超时' : mode === 'preflight' ? '安全预检超时' : '单题执行超时')),
      mode !== 'run' ? 8000 : benchmark ? 360_000 : 30_000);

    function stop(error) {
      if (problem) return;
      problem = error;
      child.kill();
    }

    function respond(id, work, tool = false) {
      waiting = true;
      void Promise.resolve().then(work).then(
        reply => ({ id, reply, decision: tool ? 'allow' : undefined }),
        error => ({ id, error: error.message.slice(0, 300), decision: tool ? error.gatewayDecision : undefined })
      ).then(payload => {
        waiting = false;
        if (!problem && !child.stdin.destroyed) child.stdin.write(JSON.stringify(payload) + '\n');
      });
    }

    function handle(line) {
      if (!line.trim()) return;
      const item = JSON.parse(line);
      if (result) throw new Error('执行器在结果返回后发送了更多数据');
      if (item.type === 'error') throw new Error(String(item.message).slice(0, 500));
      if (mode === 'preflight' && item.type === 'preflight') {
        if (!item.report || typeof item.report.approved !== 'boolean') throw new Error('预检报告格式不正确');
        result = item.report;
      } else if (mode === 'source' && item.type === 'original-source' && typeof item.code === 'string') {
        result = { code: item.code };
      } else if (mode === 'run' && item.type === 'event') {
        recorder.record(item.event);
      } else if (mode === 'run' && item.type === 'source') {
        recorder.recordSource(item.source);
      } else if (mode === 'run' && item.type === 'tool-audit') {
        recorder.recordToolAudit(item.audit);
        totalBytes -= Buffer.byteLength(line, 'utf8') + 1;
      } else if (mode === 'run' && item.type === 'result') {
        if (!item.output || typeof item.output !== 'object' || Array.isArray(item.output)) {
          throw new Error('run(task, ctx) 必须返回 JSON 对象');
        }
        result = item.output;
      } else if (mode === 'run' && item.type === 'model-request') {
        if (waiting || ++requestId > (benchmark ? 120 : 8) || item.id !== requestId) throw new Error('模型请求顺序或次数超出限制');
        respond(item.id, () => invokeAgentModel(item, undefined, Boolean(benchmark)));
      } else if (mode === 'run' && item.type === 'benchmark-tool' && benchmark?.tool) {
        if (waiting || ++toolRequestId > 350 || item.id !== toolRequestId || typeof item.name !== 'string' || item.name.length > 150 ||
          !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) throw new Error('无效的 Benchmark 工具请求');
        respond(item.id, () => benchmark.tool(item.name, item.arguments), true);
      } else throw new Error('执行器返回了未知的消息');
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (problem) return;
      totalBytes += Buffer.byteLength(chunk);
      pendingText += chunk;
      try {
        let at;
        while ((at = pendingText.indexOf('\n')) !== -1) {
          handle(pendingText.slice(0, at));
          pendingText = pendingText.slice(at + 1);
        }
      } catch (error) { stop(error); }
      if (totalBytes > (mode === 'source' ? 18_200_000 : benchmark ? 30_000_000 : 2_800_000)) stop(new Error('执行输出超过限制'));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-800); });
    child.stdin.on('error', () => {});
    child.once('error', () => { problem ||= new Error('无法启动本地 Python 解释器'); });
    child.once('close', status => {
      clearTimeout(timer);
      if (problem) return reject(problem);
      if (status !== 0) return reject(new Error(errors.trim() || `执行器退出状态 ${status}`));
      try {
        if (pendingText.trim()) handle(pendingText);
        if (!result) throw new Error('执行器没有返回数据');
        resolve(result);
      } catch (error) { reject(error); }
    });
    const envelope = JSON.stringify({ filename: job.filename, packageBase64: job.packageBase64, scenario, sourceFile }) + '\n';
    if (mode !== 'run') child.stdin.end(envelope);
    else child.stdin.write(envelope);
  });
}

export function preflightPackage(python, job) {
  return execute(python, 'preflight', job);
}

export async function readPackageSource(python, job, file) {
  const result = await execute(python, 'source', job, undefined, undefined, undefined, file);
  return result.code;
}

export function executePackage(python, recorder, scenario, job, benchmark) {
  return execute(python, 'run', job, scenario, recorder, benchmark);
}
