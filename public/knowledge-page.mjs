import { byId, element as h, evidenceUrl } from './ui.mjs';

const state = { categories: {}, entries: [], active: new URLSearchParams(location.search).get('entry'), saving: false };
const statusLabels = { candidate: '待审核', approved: '已审核' };
const confidenceLabels = { observed: '已观察到', potential: '待验证' };
const originLabels = { 'cross-review': '跨维度审查', rule: '轨迹规则', 'scenario-check': '场景验收' };
const category = byId('knowledge-category');
const status = byId('knowledge-status');
const search = byId('knowledge-search');

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '知识库请求失败');
  return body;
}

function notice(message = '', error = false) {
  const node = byId('knowledge-notice');
  node.textContent = message;
  node.classList.toggle('problem', error);
  node.hidden = !message;
}

function selectEntry(id) {
  if (state.active === id) return;
  state.active = id;
  const url = new URL(location.href);
  if (id) url.searchParams.set('entry', id);
  else url.searchParams.delete('entry');
  history.replaceState(null, '', url);
  render();
}

function drawOverview() {
  byId('knowledge-overview').replaceChildren(...Object.entries(state.categories).map(([id, label]) => {
    const entries = state.entries.filter(entry => entry.category === id);
    const approved = entries.filter(entry => entry.status === 'approved').length;
    return h('button', { className: 'knowledge-total', type: 'button', 'aria-pressed': String(category.value === id), onclick: () => {
      category.value = category.value === id ? '' : id;
      render();
    } }, h('span', { className: 'knowledge-total-heading' }, h('strong', {}, label), h('b', { className: 'tabular' }, entries.length)),
    h('progress', { value: approved, max: Math.max(entries.length, 1), 'aria-label': label + '已审核条目' }),
    h('small', { className: 'muted' }, approved + ' 已审核 · ' + (entries.length - approved) + ' 待审核'));
  }));
}

async function review(entry) {
  if (state.saving) return;
  state.saving = true;
  render();
  try {
    const updated = await request('/api/knowledge/' + entry.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: entry.status === 'approved' ? 'candidate' : 'approved' }) });
    state.entries = state.entries.map(item => item.id === updated.id ? updated : item);
    notice(updated.status === 'approved' ? '已审核。后续诊断可参考此条目。' : '已撤回审核。');
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.saving = false;
    render();
  }
}

function drawDetail(entry) {
  const target = byId('knowledge-detail');
  if (!entry) {
    target.replaceChildren(h('p', { className: 'muted' }, state.entries.length ? '没有匹配的经验。' : '运行评测后，命中的规则与跨维度发现会在此生成候选条目。'));
    return;
  }
  const approved = entry.status === 'approved';
  target.replaceChildren(
    h('header', { className: 'knowledge-detail-header' }, h('div', {},
      h('p', { className: 'muted' }, state.categories[entry.category] + ' · ' + statusLabels[entry.status]),
      h('h2', {}, entry.title)),
    h('button', { type: 'button', className: 'button' + (approved ? '' : ' primary'), disabled: state.saving,
      onclick: () => void review(entry) }, approved ? '撤回审核' : '审核通过')),
    h('dl', { className: 'knowledge-fields' }, [
      ['触发信号', entry.signal], ['适用条件', entry.scope], ['处理方法', entry.mitigation], ['复测断言', entry.verification]
    ].map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
    h('section', { className: 'knowledge-sources' },
      h('h3', {}, '来源证据 · ' + entry.sources.length + ' 条'),
      h('p', { className: 'muted' }, '审核状态表示经验可供诊断参考。每条来源单独标记为已观察到或待验证。'),
      h('ul', {}, entry.sources.map(source => h('li', {},
        h('div', { className: 'knowledge-source-heading' }, h('strong', {}, confidenceLabels[source.confidence] || source.confidence),
          h('small', { className: 'muted' }, originLabels[source.origin] + ' · ' + new Date(source.recordedAt).toLocaleString('zh-CN'))),
        h('p', { className: 'muted mono' }, '运行 ' + source.runId.slice(0, 8) + (source.caseId ? ' · 批次子题' : '')),
        h('div', { className: 'analysis-evidence' }, source.steps.map(step => h('a', {
          className: 'evidence-link', href: evidenceUrl(source.runId, source.caseId, step) }, '打开步骤 #' + step))))))));
}

function render() {
  drawOverview();
  const query = search.value.trim().toLocaleLowerCase();
  const visible = state.entries.filter(entry => (!category.value || entry.category === category.value) &&
    (!status.value || entry.status === status.value) && (!query || [entry.title, entry.signal, entry.scope, entry.mitigation, entry.verification]
      .some(value => value.toLocaleLowerCase().includes(query))));
  const chosen = visible.find(entry => entry.id === state.active) || visible[0];
  byId('knowledge-count').textContent = visible.length + ' 条经验';
  byId('knowledge-list').replaceChildren(...visible.map(entry => h('button', { type: 'button', className: 'knowledge-row',
    'aria-current': String(entry.id === chosen?.id), onclick: () => selectEntry(entry.id) },
  h('strong', {}, entry.title), h('small', { className: 'muted' }, state.categories[entry.category] + ' · ' +
    statusLabels[entry.status] + ' · ' + entry.sources.length + ' 条来源'))));
  drawDetail(chosen);
}

category.addEventListener('change', render);
status.addEventListener('change', render);
search.addEventListener('input', render);

try {
  Object.assign(state, await request('/api/knowledge'));
  category.append(...Object.entries(state.categories).map(([id, label]) => h('option', { value: id }, label)));
  notice();
  byId('knowledge-browser').hidden = false;
  render();
} catch (error) {
  notice(error.message, true);
}
