import { element as h, byId } from './ui.mjs';
import { createBenchmarkPicker } from './benchmark-picker.mjs';

const editor = byId('requirement-editor');
const field = name => editor.elements.namedItem(name);
const drafts = new Map();
let catalog = { tasks: [], templates: [], references: [] };
let runnableSuites = [];
const benchmarkPicker = createBenchmarkPicker(byId('benchmark-picker'), request, selected => {
  const link = byId('benchmark-upload-link');
  link.hidden = !selected;
  if (selected) {
    const params = new URLSearchParams({ benchmark: selected.suite, range: selected.mode });
    if (selected.key) params.set('key', selected.key);
    if (selected.group) params.set('group', selected.group);
    if (selected.keys) sessionStorage.setItem('benchmark-selection', JSON.stringify(selected.keys));
    link.href = '/?' + params;
  }
});
let benchmarks = [];
let current = null;
let filter = 'all';
let saving = false;

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

function kind(task) {
  return task.type === 'security' ? '安全' : '能力';
}

function draftKey() {
  return current?.id || 'new';
}

function error(message = '') {
  const alert = byId('requirements-error');
  alert.textContent = message;
  alert.hidden = !message;
}

function showMode(mode) {
  byId('catalog-page').hidden = mode !== 'catalog';
  byId('research-page').hidden = mode !== 'research';
  for (const button of byId('requirement-tabs').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  if (mode === 'research') {
    const url = new URL(location.href);
    url.searchParams.delete('task');
    history.replaceState(null, '', url);
  }
}

function drawList() {
  const query = byId('task-search').value.trim().toLocaleLowerCase();
  const tasks = catalog.tasks.filter(task => {
    const inCategory = filter === 'all' || (filter === 'security' ? task.type === 'security' : task.type !== 'security');
    return inCategory && [task.name, task.task, task.focus, ...task.references.map(source => source.name)]
      .join(' ').toLocaleLowerCase().includes(query);
  });
  byId('task-count').textContent = tasks.length + ' / ' + catalog.tasks.length;
  byId('requirement-list').replaceChildren(...(tasks.length ? tasks.map(task =>
    h('button', {
      type: 'button', className: 'requirement-item', 'data-task-id': task.id,
      'aria-current': String(task.id === current?.id), onclick: () => selectTask(task)
    }, h('strong', {}, task.name), h('span', { className: 'requirement-item-meta' },
      h('small', { className: 'task-kind', 'data-type': task.type }, kind(task)),
      h('small', { className: 'muted mono' }, 'v' + task.revision),
      drafts.has(task.id) ? h('small', { className: 'issue' }, '未保存') : null)
    )) : [h('p', { className: 'empty-note' }, '没有匹配的测试需求。')]));
}

function sourceLink(source) {
  return h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', className: 'research-link' }, source.name);
}

function drawTaskSections(template) {
  const editable = template?.type === 'release';
  byId('editable-criteria').hidden = !editable;
  const fixed = byId('fixed-criteria');
  fixed.hidden = editable || !template;
  if (!fixed.hidden) fixed.replaceChildren(h('h3', {}, '自动验收项'),
    h('ol', { className: 'editor-criteria' }, template.criteria.map(item => h('li', {}, item))));
  const contract = byId('task-contract');
  contract.hidden = !template?.contract?.length;
  if (!contract.hidden) contract.replaceChildren(h('h3', {}, '工具与产出契约'),
    h('ul', { className: 'contract-list' }, template.contract.map(item => h('li', {}, h('code', {}, item)))));
  const sources = byId('task-sources');
  sources.hidden = !template?.references?.length;
  if (!sources.hidden) {
    sources.replaceChildren(h('h3', {}, '研究依据'), template.focus ? h('p', { className: 'muted' }, template.focus) : null,
      h('ul', { className: 'editor-sources' }, template.references.map(source =>
        h('li', {}, sourceLink(source), h('small', { className: 'muted' }, source.venue + ' · ' + source.kind)))));
  }
}

function selectTask(task, templateId) {
  current = task;
  showMode('catalog');
  editor.hidden = false;
  byId('task-loading').hidden = true;
  byId('save-status').textContent = '';
  const draft = drafts.get(draftKey());
  const template = task || catalog.templates.find(item => item.id === (draft?.templateId || templateId)) || catalog.templates[0];
  field('name').value = draft?.name ?? task?.name ?? '';
  field('task').value = draft?.task ?? template?.task ?? '';
  field('criteria').value = draft?.criteria ?? (template?.criteria || []).join('\n');
  field('templateId').value = task?.templateId || template?.id || '';
  byId('template-field').hidden = Boolean(task);
  byId('editor-title').textContent = task ? '编辑需求' : '新增需求';
  byId('editor-meta').textContent = task ? kind(task) + ' · 版本 ' + task.revision :
    (template ? kind(template) + ' · 从模板创建' : '');
  const url = new URL(location.href);
  if (task) url.searchParams.set('task', task.id);
  else url.searchParams.delete('task');
  history.replaceState(null, '', url);
  drawTaskSections(template);
  drawList();
}

function rememberDraft() {
  drafts.set(draftKey(), { name: field('name').value, task: field('task').value,
    criteria: field('criteria').value, templateId: field('templateId').value });
}

function drawResearch() {
  const category = byId('benchmark-category').value;
  const query = byId('benchmark-search').value.trim().toLocaleLowerCase();
  const visible = benchmarks.filter(benchmark => (!category || benchmark.category === category) &&
    [benchmark.name, benchmark.venue, benchmark.scope, benchmark.category, ...benchmark.resources.map(resource => resource.label)]
      .join(' ').toLocaleLowerCase().includes(query));
  byId('benchmark-count').textContent = visible.length + ' / ' + benchmarks.length;
  const cards = visible.map(benchmark => {
    return h('article', { className: 'research-card' },
      h('span', { className: 'research-meta muted' }, benchmark.category + ' · ' + benchmark.venue),
      h('h3', {}, benchmark.name), h('p', {}, benchmark.scope),
      h('dl', { className: 'benchmark-details' },
        h('dt', {}, '评分'), h('dd', {}, benchmark.scoring),
        h('dt', {}, '运行条件'), h('dd', {}, benchmark.environment)),
      h('div', { className: 'research-tasks' },
        runnableSuites.some(suite => suite.benchmark === benchmark.id) ? h('button', { type: 'button', className: 'button small',
          onclick: () => {
            benchmarkPicker.setSuites(runnableSuites, { suite: runnableSuites.find(suite => suite.benchmark === benchmark.id).id });
            byId('benchmark-run-panel').scrollIntoView({ block: 'start' });
          } }, '选择原题') : null,
        h('a', { className: 'evidence-link', href: benchmark.paper, target: '_blank', rel: 'noopener noreferrer' }, '发表论文'),
        benchmark.resources.map(resource => h('a', {
          className: 'evidence-link', href: resource.url, target: '_blank', rel: 'noopener noreferrer'
        }, resource.label))));
  });
  byId('research-list').replaceChildren(...(cards.length ? cards : [h('p', { className: 'empty-note' }, '没有匹配的 Benchmark。')]));
}

async function load() {
  const [tasks, references] = await Promise.all([request('/api/tasks'), request('/api/benchmarks')]);
  catalog = tasks;
  benchmarks = references.benchmarks;
  runnableSuites = references.suites;
  byId('benchmark-run-panel').hidden = !runnableSuites.length;
  benchmarkPicker.setSuites(runnableSuites);
  field('templateId').replaceChildren(...catalog.templates.map(template =>
    h('option', { value: template.id }, template.name)));
  byId('new-task').disabled = !catalog.templates.length;
  for (const category of new Set(benchmarks.map(item => item.category))) {
    byId('benchmark-category').append(h('option', { value: category }, category));
  }
  drawResearch();
}

byId('requirement-tabs').addEventListener('click', event => {
  const mode = event.target.dataset.mode;
  if (mode) showMode(mode);
});
byId('task-filters').addEventListener('click', event => {
  if (!event.target.dataset.filter) return;
  filter = event.target.dataset.filter;
  for (const button of byId('task-filters').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  drawList();
});
byId('task-search').addEventListener('input', drawList);
byId('benchmark-search').addEventListener('input', drawResearch);
byId('benchmark-category').addEventListener('change', drawResearch);
byId('new-task').addEventListener('click', () => { selectTask(null); field('name').focus(); });
editor.addEventListener('input', () => {
  rememberDraft();
  byId('save-status').textContent = '有未保存的修改';
  drawList();
});
field('templateId').addEventListener('change', () => {
  const template = catalog.templates.find(item => item.id === field('templateId').value);
  field('task').value = template?.task || '';
  field('criteria').value = (template?.criteria || []).join('\n');
  byId('editor-meta').textContent = template ? kind(template) + ' · 从模板创建' : '';
  drawTaskSections(template);
  rememberDraft();
});
editor.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  error();
  saving = true;
  const key = draftKey();
  const previous = current;
  const save = byId('save-task');
  save.disabled = true;
  const editableFields = ['name', 'task', 'criteria', 'templateId'].map(field);
  for (const input of editableFields) input.disabled = true;
  byId('save-status').textContent = '正在保存…';
  try {
    const saved = await request('/api/tasks' + (previous ? '/' + previous.id : ''), {
      method: previous ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: field('name').value, templateId: field('templateId').value,
        task: field('task').value, revision: previous?.revision,
        criteria: field('criteria').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) })
    });
    drafts.delete(key);
    const index = catalog.tasks.findIndex(task => task.id === saved.id);
    if (index >= 0) catalog.tasks[index] = saved;
    else catalog.tasks.push(saved);
    if (draftKey() === key) {
      selectTask(saved);
      byId('save-status').textContent = '已保存 v' + saved.revision;
    } else drawList();
  } catch (cause) {
    error(cause.message);
    byId('save-status').textContent = '保存失败';
  } finally {
    saving = false;
    save.disabled = false;
    for (const input of editableFields) input.disabled = false;
  }
});

try {
  await load();
  const id = new URLSearchParams(location.search).get('task');
  const first = catalog.tasks.find(task => task.id === id) || catalog.tasks[0] || null;
  selectTask(first);
  if (!id) showMode('research');
} catch (cause) {
  error(cause.message);
  byId('task-loading').hidden = true;
}
