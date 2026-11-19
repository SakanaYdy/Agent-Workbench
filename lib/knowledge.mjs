import { readFile, rename, writeFile } from 'node:fs/promises';

export const knowledgeCategories = { security: '安全', longTask: '长任务', reliability: '工具可靠性' };

// These descriptions are maintained separately from traces and model output.
const topics = {
  'approval-write': { category: 'security', title: '审批约束与写操作',
    signal: '需审批的写操作已放行、等待审批分支未通过，或压缩后丢失审批约束。',
    scope: '有明确审批规则和写操作边界的流程。仅观察到约束丢失时，需要另行验证实际权限判定。',
    mitigation: '将审批状态独立保存，在工具网关写入前校验动作、资源及当前授权状态。',
    verification: '在同一模拟场景分别验证未审批、审批通过及压缩后重试，检查网关判定和资源最终状态。' },
  'external-data-boundary': { category: 'security', title: '不可信工具数据与输出边界',
    signal: '工具数据安全场景中的授权工具或输出边界验收项未通过。',
    scope: 'Agent 需要读取外部内容、摘要或生成报告，且场景定义了工具权限和材料披露范围。',
    mitigation: '区分用户指令与工具数据，使用独立的工具授权和输出字段白名单。',
    verification: '对照安全任务和正常公开数据任务，断言授权动作成功，模拟内部标记未进入产出。' },
  'sensitive-output': { category: 'security', title: '输出披露范围',
    signal: '最终产出包含场景的模拟内部标记。',
    scope: '工具可以读取内部材料，用户看到的结果有单独的披露范围。',
    mitigation: '按用途隔离可供 Agent 处理的数据和可交付字段，在返回边界检查结果。',
    verification: '复跑内部标记场景和公开数据对照，检查模拟内部内容被排除，同时正常摘要仍可读取。' },
  'retain-requirements': { category: 'longTask', title: '压缩时保留必需约束',
    signal: '压缩后缺少可识别的必需条款。',
    scope: '有结构化条款，压缩前后或下一步实际模型输入可核对。',
    mitigation: '将必须保留的条款按稳定编号单独存储，摘要只处理背景信息，构造请求时校验保留项。',
    verification: '复跑同一任务，断言必需条款集合完整，并比较最终验收结果和输入 Token。' },
  'tool-payload-size': { category: 'longTask', title: '精简进入模型的工具结果',
    signal: '工具返回中的长背景说明进入了实际模型输入。',
    scope: '可按字段区分必需结果与可按需取得的长材料。',
    mitigation: '在模型回传中保留必要字段和工具调用 ID，原始返回继续留在轨迹供排查。',
    verification: '核对工具调用与结果配对，复测末轮输入 Token、工具调用次数及验收项通过情况。' },
  'context-budget': { category: 'longTask', title: '为完整轮次设置 Token 预算',
    signal: '一轮内的裁剪结果仍超出代理配置的消息条数。',
    scope: '工具结果大小差异较大，当前用户轮次及调用回传需要成组保留。',
    mitigation: '以模型的输入 Token 预算作为约束，按轮次清理旧历史，并精简当前轮次的大载荷。',
    verification: '用长工具结果复测实际输入量、消息配对，以及必需信息是否仍可见。' },
  'cross-turn-facts': { category: 'longTask', title: '跨轮保留工具事实',
    signal: '多轮任务裁剪了较早的工具返回。',
    scope: '后续请求可能引用较早取得的事实，需先核对实际输入或重新获取的证据。',
    mitigation: '保留必要事实的结构化摘要和来源步骤，根据状态变化更新或重新读取。',
    verification: '复跑原题，检查后续模型输入中的关键事实、重复工具调用次数与判分。' },
  'denied-retry': { category: 'reliability', title: '止住重复的拒绝请求',
    signal: '同轮同参调用连续被网关拒绝。',
    scope: '可区分权限拒绝与临时故障。',
    mitigation: '对稳定的权限拒绝结束当前动作分支，等授权变更后再尝试，保留临时故障重试分支。',
    verification: '分别用拒绝与临时故障复测，断言重复拒绝收敛且可恢复的重试正常。' },
  'repeat-tool': { category: 'reliability', title: '复用同轮稳定的工具结果',
    signal: '同轮连续调用具有相同参数和可见返回，期间未记录到状态变化。',
    scope: '工具语义允许复用，且有明确状态失效边界。',
    mitigation: '按工具名和规范化参数复用当前轮结果，在影响结果的状态更新后失效。',
    verification: '对照工具调用次数和任务得分，并验证状态变化后确实重新读取。' }
};

function signalsFor(run, task = {}) {
  const valid = new Set(run.events.map(step => step.id));
  const matches = new Map();
  function add(id, confidence, origin, steps) {
    if (!Object.hasOwn(topics, id)) return;
    const ids = steps.filter(step => valid.has(step));
    if (!ids.length) return;
    const prior = matches.get(id);
    if (prior?.confidence === 'observed' && confidence === 'potential') return;
    const merged = prior?.confidence === confidence ? [...prior.steps, ...ids] : ids;
    matches.set(id, { id, confidence, origin: prior?.confidence === confidence ? prior.origin : origin,
      steps: [...new Set(merged)].slice(0, 6) });
  }
  for (const finding of run.crossReview?.findings ?? []) {
    const id = finding.rule === 'required-context'
      ? (finding.area === 'security' ? 'approval-write' : 'retain-requirements') : finding.rule;
    add(id, finding.status, 'cross-review', finding.evidence);
  }
  for (const finding of run.analysis?.findings ?? []) {
    add(finding.topic, 'potential', 'rule', finding.evidence);
  }
  const failures = new Set(run.evaluation?.checks?.filter(check => check.passed === false).map(check => check.id));
  const output = run.events.findLast(step => step.kind === 'output');
  if (task?.security && run.output) {
    const steps = [run.events.find(step => step.kind === 'tool' && step.name === task.security.readTool)?.id,
      output?.id];
    if (failures.has('S-02') || failures.has('S-04')) add('external-data-boundary', 'potential', 'scenario-check', steps);
    if (failures.has('S-03')) add('sensitive-output', 'observed', 'scenario-check', steps);
  }
  if ((task?.templateId ?? task?.id) === 'security-approval-v1' && failures.has('S-02') && run.output) {
    const steps = [run.events.find(step => step.kind === 'tool' && step.name === 'read_change_request')?.id, output?.id];
    add('approval-write', 'potential', 'scenario-check', steps);
  }
  return [...matches.values()];
}

export function createKnowledge(file) {
  let records;
  let pending = Promise.resolve();

  async function load() {
    if (records) return records;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.schemaVersion !== 1 || !data.entries || Array.isArray(data.entries) || typeof data.entries !== 'object') {
        throw new Error('知识库格式不受支持');
      }
      records ??= data.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      records ??= {};
    }
    return records;
  }

  function update(change) {
    const operation = pending.then(async () => {
      const next = { ...await load() };
      const result = change(next);
      if (result === undefined) return;
      await writeFile(file + '.tmp', JSON.stringify({ schemaVersion: 1, entries: next }, null, 2), 'utf8');
      await rename(file + '.tmp', file);
      records = next;
      return result;
    });
    pending = operation.catch(() => {});
    return operation;
  }

  return {
    async list() {
      const entries = await load();
      return Object.keys(topics).filter(id => Object.hasOwn(entries, id))
        .map(id => ({ ...topics[id], ...entries[id], id }))
        .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    },
    async collect(run, task, { runId, caseId }) {
      const signals = signalsFor(run, task);
      if (!signals.length) return;
      return update(next => {
        const saved = [];
        const timestamp = new Date().toISOString();
        for (const { id, ...evidence } of signals) {
          const entry = next[id] ?? { ...topics[id], status: 'candidate', createdAt: timestamp, sources: [] };
          if (entry.sources.some(source => source.runId === runId && source.caseId === caseId)) continue;
          next[id] = { ...entry, updatedAt: timestamp, sources: [{ runId, caseId, ...evidence, recordedAt: timestamp },
            ...entry.sources].slice(0, 40) };
          saved.push(id);
        }
        return saved.length ? saved : undefined;
      });
    },
    async review(id, status) {
      if (!['candidate', 'approved'].includes(status)) throw Object.assign(new Error('无效的审核状态'), { status: 400 });
      return update(next => {
        if (!Object.hasOwn(topics, id) || !Object.hasOwn(next, id)) {
          throw Object.assign(new Error('找不到知识条目'), { status: 404 });
        }
        next[id] = { ...next[id], status, reviewedAt: status === 'approved' ? new Date().toISOString() : null };
        return { ...topics[id], ...next[id], id };
      });
    },
    async match(run, task) {
      const entries = await load();
      return signalsFor(run, task).filter(item => entries[item.id]?.status === 'approved')
        .sort((first, second) => Number(second.confidence === 'observed') - Number(first.confidence === 'observed'))
        .slice(0, 3).map(({ id, steps }) => {
          const { title, scope, mitigation, verification } = topics[id];
          return { id, title, scope, mitigation, verification, steps };
        });
    }
  };
}
