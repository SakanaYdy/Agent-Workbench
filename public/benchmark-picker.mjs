import { element as h } from './ui.mjs';

export function createBenchmarkPicker(target, request, onSelect) {
  const suiteInput = h('select', { 'aria-label': 'Benchmark 测试集' });
  const modeInput = h('select', { 'aria-label': '测试范围' },
    h('option', { value: 'task' }, '单个原版任务'), h('option', { value: 'suite' }, '整套 Benchmark'));
  const search = h('input', { type: 'search', placeholder: '搜索原题、任务 ID 或类别', 'aria-label': '搜索原版任务' });
  const taskInput = h('select', { 'aria-label': '原版测试任务' });
  const status = h('p', { className: 'muted benchmark-status', role: 'status' });
  const preview = h('p', { className: 'benchmark-preview' });
  const tasksField = h('div', { className: 'benchmark-question-picker' }, search, taskInput, preview);
  let data;
  let generation = 0;

  function sync() {
    tasksField.hidden = modeInput.value === 'suite';
    const item = data?.tasks.find(task => task.key === taskInput.value);
    preview.textContent = item?.title || '';
    const selection = !data?.runnable ? null : modeInput.value === 'suite'
      ? { suite: suiteInput.value, mode: 'suite' }
      : item ? { suite: suiteInput.value, mode: 'task', key: item.key } : null;
    onSelect(selection);
  }

  function drawTasks(preferred) {
    const query = search.value.trim().toLocaleLowerCase();
    const items = (data?.tasks || []).filter(task => [task.key, task.group, task.title]
      .some(value => value?.toLocaleLowerCase().includes(query)));
    taskInput.replaceChildren(h('option', { value: '' }, items.length ? '选择一题 · ' + items.length + ' 个匹配' : '无可选任务'),
      ...items.map(item => h('option', { value: item.key }, `${item.key} · ${item.title}`.slice(0, 180))));
    taskInput.disabled = !items.length;
    if (items.some(item => item.key === preferred)) taskInput.value = preferred;
    sync();
  }

  async function load(preferred) {
    const ticket = ++generation;
    data = null;
    search.value = '';
    drawTasks();
    status.textContent = '正在读取原版任务…';
    try {
      const result = await request('/api/benchmarks/' + suiteInput.value + '/tasks');
      if (ticket !== generation) return;
      data = result;
      status.textContent = [data.tasks.length ? data.suite.scope + ' · ' + data.tasks.length + ' 题' : '',
        data.error, !data.tasks.length ? data.suite.setup : ''].filter(Boolean).join('。');
      drawTasks(preferred);
    } catch (error) {
      if (ticket === generation) status.textContent = error.message;
    }
  }

  suiteInput.addEventListener('change', () => void load());
  modeInput.addEventListener('change', sync);
  search.addEventListener('input', () => drawTasks(taskInput.value));
  taskInput.addEventListener('change', sync);
  target.replaceChildren(h('div', { className: 'benchmark-picker-controls' },
    h('label', { className: 'form-field' }, '测试集', suiteInput), h('label', { className: 'form-field' }, '范围', modeInput)),
    status, tasksField);

  return {
    setSuites(suites, selection) {
      suiteInput.replaceChildren(...suites.map(suite => h('option', { value: suite.id }, suite.name)));
      if (suites.some(suite => suite.id === selection?.suite)) suiteInput.value = selection.suite;
      modeInput.value = selection?.mode === 'suite' ? 'suite' : 'task';
      if (suiteInput.value) void load(selection?.key);
    }
  };
}
