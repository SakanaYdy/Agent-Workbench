import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

export const MAX_EVENTS = 500;
const MAX_EVENT_BYTES = 42_000;
const MAX_TRACE_BYTES = 2_500_000;

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value ?? null), 'utf8') / 4);
}

export function createRecorder(run) {
  const started = performance.now();
  let bytes = 0;

  function elapsed() {
    return Math.round(performance.now() - started);
  }

  function recordSource(source) {
    if (!source || !/^[1-9]\d?$/.test(source.id) || typeof source.file !== 'string' || typeof source.function !== 'string' ||
        typeof source.code !== 'string' || Buffer.byteLength(source.code, 'utf8') > 3800 ||
        !Number.isInteger(source.startLine) || !Number.isInteger(source.endLine)) return;
    run.sources ??= {};
    run.sources[source.id] ??= source;
  }

  function recordToolAudit(audit) {
    const event = run.events.at(-1);
    if (!event || event.kind !== 'tool' || event.id !== audit?.eventId || !['allow', 'deny'].includes(audit.decision)) return;
    run.toolAudit ??= {};
    run.toolAudit[event.id] = { decision: audit.decision, scope: audit.scope === 'benchmark' ? 'benchmark' : 'scenario',
      effect: ['read', 'write'].includes(audit.effect) ? audit.effect : undefined,
      approvalRequired: audit.approvalRequired === true || undefined,
      approval: ['approved', 'pending', 'denied', 'missing'].includes(audit.approval) ? audit.approval : undefined };
  }

  function record(event) {
    if (run.events.length >= MAX_EVENTS) throw new Error('达到单次运行的事件上限');
    if (!event || typeof event.kind !== 'string' || typeof event.name !== 'string') {
      throw new Error('轨迹事件需要 kind 和 name');
    }
    const wire = JSON.stringify(event);
    const eventBytes = Buffer.byteLength(wire, 'utf8');
    bytes += eventBytes;
    if (eventBytes > MAX_EVENT_BYTES || bytes > MAX_TRACE_BYTES) throw new Error('轨迹数据超过运行限制');
    const id = run.events.length + 1;
    const links = Array.isArray(event.links) ? [...new Set(event.links.filter(link =>
      Number.isInteger(link) && link > 0 && link < id))].slice(0, 18) : [];
    const duration = Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : 0;
    run.events.push({
      id,
      kind: event.kind.slice(0, 24),
      name: event.name.slice(0, 90),
      round: Number.isSafeInteger(event.round) ? Math.max(event.round, 1) : 1,
      status: event.status === 'error' ? 'error' : 'ok',
      startMs: Number.isFinite(event.startMs) ? Math.max(0, Math.round(event.startMs)) : elapsed(),
      durationMs: duration,
      links,
      input: event.input ?? null,
      output: event.output ?? null,
      usage: event.usage ?? null,
      detail: event.detail ?? null,
      source: Number.isInteger(event.source?.line) && Object.hasOwn(run.sources ?? {}, event.source.id) ? event.source : undefined
    });
    return id;
  }

  async function step(event, work) {
    const startMs = elapsed();
    const start = performance.now();
    try {
      const output = await work();
      const durationMs = performance.now() - start;
      const usage = event.kind === 'model' ? {
        inputTokens: estimateTokens(event.input), outputTokens: estimateTokens(output), estimated: true
      } : null;
      return { output, id: record({ ...event, output, startMs, durationMs, usage }) };
    } catch (error) {
      record({ ...event, startMs, durationMs: performance.now() - start, status: 'error',
        output: { error: error.message } });
      throw error;
    }
  }

  return { record, recordSource, recordToolAudit, step, elapsed };
}

export function traceSummary(event) {
  const { input, output, detail, source, ...summary } = event;
  const peek = output?.summary || output?.error || detail?.strategy;
  const digest = createHash('sha256').update(JSON.stringify([input, output, detail])).digest('hex').slice(0, 16);
  return { ...summary, digest, preview: typeof peek === 'string' ? peek.slice(0, 140) : '' };
}
