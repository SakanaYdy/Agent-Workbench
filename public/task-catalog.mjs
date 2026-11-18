import { element as h, byId } from './ui.mjs';

export function createTaskPicker(request, onSelection) {
  const selected = new Set();
  let tasks = [];
  let approved = false;

  function drawChoices() {
    byId('upload-tasks').hidden = !approved;
    if (!approved) return;
    byId('upload-task-options').replaceChildren(...[false, true].map(security => {
      const group = tasks.filter(task => (task.type === 'security') === security);
      return group.length ? h('section', { className: 'upload-task-group' },
        h('h4', {}, security ? '安全测试' : '能力测试'),
        group.map(task => h('label', { className: 'upload-task-option' },
          h('input', { type: 'checkbox', checked: selected.has(task.id), onchange: event => {
            if (event.target.checked) selected.add(task.id);
            else selected.delete(task.id);
            onSelection();
          } }),
          h('span', {}, h('strong', {}, task.name), h('small', { className: 'muted' }, 'v' + task.revision))
        ))) : null;
    }).filter(Boolean));
  }

  return {
    async load() {
      const result = await request('/api/tasks');
      tasks = result.tasks;
      for (const id of selected) if (!tasks.some(task => task.id === id)) selected.delete(id);
      drawChoices();
      return tasks;
    },
    ids: () => [...selected],
    setApproved(ready) {
      approved = ready;
      if (!ready) selected.clear();
      drawChoices();
      onSelection();
    }
  };
}
