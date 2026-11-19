import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../runner/benchmark_runtime.py', import.meta.url));
const suite = { id: 'bfcl', benchmark: 'bfcl', name: 'BFCL v3 多轮', scope: '全部 5 个原版多轮类别',
  setup: 'data/benchmarks/bfcl 放置 BFCL 官方源码发布包 2025.7.9' };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function startRuntime(python, args, timeoutMs) {
  const env = {};
  for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name] != null) env[name] = process.env[name];
  }
  const child = spawn(python.command, [...python.prefix, '-I', '-B', '-u', '-X', 'utf8', script, ...args],
    { cwd: tmpdir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let failure;
  const timer = setTimeout(() => {
    failure = new Error('BFCL 运行器超时');
    child.kill();
  }, timeoutMs);
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('error', () => { failure = new Error('无法启动 BFCL Python'); });
  child.once('close', () => clearTimeout(timer));

  return {
    async read(expected) {
      const line = await lines.next();
      if (line.done) throw failure || new Error('BFCL 运行器提前结束');
      const message = JSON.parse(line.value);
      if (message.type === 'error') throw new Error(message.error);
      if (message.type !== expected) throw new Error('BFCL 运行器返回了意外消息');
      return message;
    },
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    close() { clearTimeout(timer); reader.close(); child.kill(); }
  };
}

export function createBenchmarkRuns(home, python) {
  const root = join(home, 'bfcl');
  const configured = process.env.BENCHMARK_BFCL_PYTHON;
  const runtimePython = configured ? { command: configured, prefix: [] } : python;
  let pending;

  async function loadCatalog() {
    if (!runtimePython) throw new Error('未找到可用的 Python 解释器');
    const runtime = startRuntime(runtimePython, ['bfcl-list', root], 20_000);
    try {
      const { tasks } = await runtime.read('catalog');
      if (tasks.length !== 1000 || new Set(tasks.map(item => item.key)).size !== tasks.length) {
        throw new Error('BFCL v3 多轮发布数据缺失或含重复 ID');
      }
      return tasks;
    } finally { runtime.close(); }
  }

  function entriesFor(id) {
    if (id !== suite.id) throw httpError(404, '找不到该 Benchmark 测试集');
    pending ||= loadCatalog().catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  }

  return {
    suites: [suite],
    async catalog(id) {
      const entries = entriesFor(id);
      try {
        return { suite, tasks: await entries, runnable: true };
      } catch (error) {
        return { suite, tasks: [], runnable: false, error: '原版数据未就绪。' + error.message };
      }
    },
    async select(selection) {
      if (!selection || !['task', 'group', 'selection', 'suite'].includes(selection.mode) ||
          selection.mode === 'task' && typeof selection.key !== 'string' ||
          selection.mode === 'group' && typeof selection.group !== 'string' ||
          selection.mode === 'selection' && (!Array.isArray(selection.keys) || !selection.keys.length ||
            selection.keys.length > 1000 || selection.keys.some(key => typeof key !== 'string') ||
            new Set(selection.keys).size !== selection.keys.length)) {
        throw httpError(400, '请选择单题、指定题目、题目类别或整套 Benchmark');
      }
      const entries = await entriesFor(selection.suite).catch(error => {
        throw httpError(503, '原版数据未就绪。' + error.message);
      });
      const keys = new Set(selection.mode === 'selection' ? selection.keys : [selection.key]);
      const selected = entries.filter(item => selection.mode === 'suite' || (selection.mode === 'group'
        ? item.group === selection.group : keys.has(item.key)));
      if (!selected.length || selection.mode === 'selection' && selected.length !== keys.size) {
        throw httpError(404, '找不到所选原版任务或类别');
      }
      return { suite, tasks: selected.map(entry => ({
        id: 'benchmark-bfcl-' + createHash('sha256').update(entry.key).digest('hex').slice(0, 16), type: 'benchmark',
        name: entry.key, task: entry.title, benchmark: { id: suite.id, name: suite.name, key: entry.key, group: entry.group }
      })) };
    },
    async open(task) {
      const { group, key } = task.benchmark;
      const scenario = { id: task.id, task: 'Use next_turn to read the first user turn.', benchmark: task.benchmark };
      const runtime = startRuntime(runtimePython, ['bfcl-run', root, group, key], 420_000);
      try { await runtime.read('ready'); } catch (error) { runtime.close(); throw error; }
      return { scenario, close: runtime.close, async tool(name, args) {
        if (name === 'score') throw new Error('评分只由工作台发起');
        runtime.send({ name, arguments: args });
        const reply = await runtime.read('reply');
        if (reply.error) throw Object.assign(new Error(reply.error), { gatewayDecision: reply.decision });
        return reply.output;
      }, async score() {
        runtime.send({ name: 'score', arguments: {} });
        const { type, ...score } = await runtime.read('score');
        return score;
      } };
    }
  };
}
