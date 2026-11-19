import { element as h } from './ui.mjs';

export function createBenchmarkPicker(target, request, onSelect) {
  const suiteInput = h('select', { 'aria-label': 'Benchmark 测试集' });
  const modeInput = h('select', { 'aria-label': '测试范围' },
    h('option', { value: 'task' }, '单个原版任务'), h('option', { value: 'selection' }, '选择多道题'),
    h('option', { value: 'group' }, '按题目类别'), h('option', { value: 'suite' }, '整套 Benchmark'));
  const search = h('input', { type: 'search', placeholder: '搜索原题、任务 ID 或类别', 'aria-label': '搜索原版任务' });
  const taskInput = h('select', { 'aria-label': '原版测试任务' });
  const groupInput = h('select', { 'aria-label': '题目类别' });
  const status = h('p', { className: 'muted benchmark-status', role: 'status' });
  const preview = h('p', { className: 'benchmark-preview', role: 'status' });
  const choices = h('div', { className: 'upload-task-options benchmark-selection', 'aria-label': '多题选择' });
  const paging = h('div', { className: 'benchmark-pagination' });
  const tasksField = h('div', { className: 'benchmark-question-picker' }, search, taskInput, choices, paging);
  const groupField = h('label', { className: 'form-field' }, '题目类别', groupInput);
  const selected = new Set();
  let data;
  let page = 0;
  let generation = 0;

  function sync() {
    const mode = modeInput.value;
    tasksField.hidden = mode !== 'task' && mode !== 'selection';
    taskInput.hidden = mode !== 'task';
    choices.hidden = paging.hidden = mode !== 'selection';
    groupField.hidden = mode !== 'group';
    if (!data?.runnable) {
      preview.textContent = '';
      onSelect(null, 0);
      return;
    }
    const selection = { suite: suiteInput.value, mode };
    const item = data.tasks.find(task => task.key === taskInput.value);
    let count;
    if (mode === 'task') {
      selection.key = item?.key;
      count = item ? 1 : 0;
    } else if (mode === 'selection') {
      selection.keys = [...selected];
      count = selected.size;
    } else if (mode === 'group') {
      selection.group = groupInput.value;
      count = data.tasks.filter(task => task.group === selection.group).length;
    } else count = data.tasks.length;
    preview.textContent = mode === 'task' ? item?.title || '' : '已选 ' + count + ' 题';
    onSelect(count ? selection : null, count);
  }

  function drawTasks(preferred = taskInput.value) {
    const query = search.value.trim().toLocaleLowerCase();
    const items = (data?.tasks || []).filter(task => [task.key, task.group, task.title]
      .some(value => value?.toLocaleLowerCase().includes(query)));
    const mode = modeInput.value;
    if (mode === 'task') {
      taskInput.replaceChildren(h('option', { value: '' }, items.length ? '选择一题 · ' + items.length + ' 个匹配' : '无可选任务'),
        ...items.map(item => h('option', { value: item.key }, item.key + ' · ' + item.title.slice(0, 140))));
      taskInput.disabled = !items.length;
      if (items.some(item => item.key === preferred)) taskInput.value = preferred;
    } else if (mode === 'selection') {
      const size = 30;
      const pages = Math.max(1, Math.ceil(items.length / size));
      page = Math.min(page, pages - 1);
      choices.replaceChildren(...items.slice(page * size, (page + 1) * size).map(item =>
        h('label', { className: 'upload-task-option' },
          h('input', { type: 'checkbox', checked: selected.has(item.key), onchange: event => {
            if (event.target.checked) selected.add(item.key);
            else selected.delete(item.key);
            sync();
          } }),
          h('span', {}, h('strong', {}, item.key), h('small', { className: 'muted' }, item.title.slice(0, 160))))));
      if (!items.length) choices.append(h('p', { className: 'muted' }, '没有匹配的题目。'));
      paging.replaceChildren(
        h('button', { className: 'button small', type: 'button', disabled: page === 0, onclick: () => { page -= 1; drawTasks(); } }, '上一页'),
        h('span', {}, (page + 1) + ' / ' + pages),
        h('button', { className: 'button small', type: 'button', disabled: page >= pages - 1, onclick: () => { page += 1; drawTasks(); } }, '下一页'),
        h('button', { className: 'button small', type: 'button', onclick: () => { selected.clear(); drawTasks(); } }, '清空选择'));
    }
    sync();
  }

  async function load(preferred) {
    const ticket = ++generation;
    data = null;
    selected.clear();
    search.value = '';
    page = 0;
    groupInput.replaceChildren();
    drawTasks();
    status.textContent = '正在读取原版任务…';
    try {
      const result = await request('/api/benchmarks/' + suiteInput.value + '/tasks');
      if (ticket !== generation) return;
      data = result;
      const keys = new Set(data.tasks.map(task => task.key));
      for (const key of preferred?.keys || []) if (keys.has(key)) selected.add(key);
      const groups = [...new Set(data.tasks.map(task => task.group))];
      groupInput.replaceChildren(h('option', { value: '' }, '选择题目类别'),
        ...groups.map(group => h('option', { value: group }, group)));
      if (groups.includes(preferred?.group)) groupInput.value = preferred.group;
      status.textContent = [data.tasks.length ? data.suite.scope + ' · ' + data.tasks.length + ' 题' : '',
        data.error, !data.tasks.length ? data.suite.setup : ''].filter(Boolean).join('。');
      drawTasks(preferred?.key);
    } catch (error) {
      if (ticket === generation) status.textContent = error.message;
    }
  }

  suiteInput.addEventListener('change', () => void load());
  modeInput.addEventListener('change', () => drawTasks());
  groupInput.addEventListener('change', sync);
  search.addEventListener('input', () => { page = 0; drawTasks(); });
  taskInput.addEventListener('change', sync);
  target.replaceChildren(h('div', { className: 'benchmark-picker-controls' },
    h('label', { className: 'form-field' }, '测试集', suiteInput), h('label', { className: 'form-field' }, '范围', modeInput)),
    status, groupField, tasksField, preview);

  return {
    setSuites(suites, selection) {
      suiteInput.replaceChildren(...suites.map(suite => h('option', { value: suite.id }, suite.name)));
      if (suites.some(suite => suite.id === selection?.suite)) suiteInput.value = selection.suite;
      modeInput.value = ['group', 'selection', 'suite'].includes(selection?.mode) ? selection.mode : 'task';
      if (suiteInput.value) void load(selection);
    }
  };
}
