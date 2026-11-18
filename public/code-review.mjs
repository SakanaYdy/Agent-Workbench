import { element as h } from './ui.mjs';

const pageSize = 120;
const codeLines = text => text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');

function compareLines(original, suggested) {
  function normalized(lines) {
    const nonempty = lines.filter(line => line.trim());
    const indent = nonempty.length ? Math.min(...nonempty.map(line => line.length - line.trimStart().length)) : 0;
    return lines.map(line => line.slice(indent).trimEnd());
  }
  const left = normalized(original);
  const right = normalized(suggested);
  const lengths = left.map(() => new Uint16Array(right.length + 1));
  lengths.push(new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j] ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const removed = new Set(left.keys()), added = new Set(right.keys());
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      removed.delete(i);
      added.delete(j);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i += 1;
    else j += 1;
  }
  return { removed, added };
}

function codeSurface(lines, { start = 1, selected, changes, sign, label }) {
  return h('div', { className: 'review-code-surface', tabindex: '0', 'aria-label': label },
    h('pre', {}, lines.map((line, index) => {
      const number = start + index;
      const changed = Boolean(line.trim() && changes?.has(index));
      return h('span', { className: 'review-code-line', 'data-line': number,
        'data-change': changed ? sign : undefined, 'data-current': number === selected ? 'true' : undefined },
      h('span', { className: 'review-line-number', 'aria-hidden': 'true' }, number),
      h('span', { className: 'review-line-sign', 'aria-hidden': 'true' }, changed ? sign : ''),
      h('code', {}, line || ' '));
    })));
}

function control(label, onclick, attributes = {}) {
  return h('button', { type: 'button', className: 'button small', onclick, ...attributes }, label);
}

export function createCodeReview(root, request, notify) {
  let current;
  let activeRun;
  let view = 'snippet';
  let activeFile;
  let page = 0;
  let focusLine = false;
  const cache = new Map();

  function fileRecord(file) {
    if (!file || !current.files.includes(file)) return null;
    if (cache.has(file)) return cache.get(file);
    const record = { pending: true };
    cache.set(file, record);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    const run = current.run;
    void request(current.sourceUrl(file)).then(
      result => { record.lines = codeLines(result.code); },
      error => { record.error = error.message; }
    ).finally(() => {
      record.pending = false;
      if (current?.run === run && (current.source?.file === file || activeFile === file)) render();
    });
    return record;
  }

  function list(title, items, ordered = false) {
    return h('section', {}, h('h4', {}, title), h(ordered ? 'ol' : 'ul', {}, items.map(item => h('li', {}, item))));
  }

  function copyCode(code) {
    return control('复制建议代码', async event => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
      } catch { notify('复制失败，可选中建议代码手动复制。', true); }
    });
  }

  function openFile(file, line) {
    view = 'file';
    activeFile = file;
    page = Math.floor(((line || 1) - 1) / pageSize);
    focusLine = Boolean(line);
    render();
  }

  function render() {
    const { source, codePlan, files, busy, canGenerate, onGenerate, evidenceLink } = current;
    const relatedFile = source?.file;
    const showingFile = view === 'file';
    const file = showingFile ? activeFile : relatedFile;
    const original = fileRecord(file);
    const exact = original?.lines;
    const snippet = source ? exact && !showingFile ? exact.slice(source.startLine - 1, source.endLine) : codeLines(source.code) : [];
    const suggested = codePlan ? codeLines(codePlan.code) : [];
    const functionName = source?.function?.split('.').at(-1);
    const containsFunction = lines => lines.some(line => line.trimStart().replace(/^async\s+/, '').startsWith(`def ${functionName}(`));
    const comparable = !showingFile && exact && codePlan?.mode === 'source' && functionName &&
      containsFunction(snippet) && containsFunction(suggested);
    const differences = comparable ? compareLines(snippet, suggested) : {};
    const canBrowse = files.length > 0;
    const totalPages = Math.max(1, Math.ceil((exact?.length ?? 0) / pageSize));
    if (showingFile && exact) page = Math.min(page, totalPages - 1);
    const startLine = showingFile ? page * pageSize + 1 : source?.startLine;
    const originalLines = showingFile ? exact?.slice(startLine - 1, startLine - 1 + pageSize) : snippet;
    const previousHeight = !focusLine ? root.querySelector('.review-original .review-code-surface')?.scrollTop : undefined;
    const previousSuggestionHeight = root.querySelector('.review-suggested .review-code-surface')?.scrollTop;

    const sourceSwitcher = canBrowse ? h('div', { className: 'review-switch', role: 'group', 'aria-label': '原始代码范围' },
      control('相关片段', () => { view = 'snippet'; focusLine = true; render(); }, { 'aria-pressed': String(!showingFile) }),
      control('完整文件', () => {
        const chosen = files.includes(relatedFile) ? relatedFile : files[0];
        openFile(chosen, chosen === relatedFile ? source?.line : undefined);
      },
        { 'aria-pressed': String(showingFile) })) : null;
    const filePicker = showingFile && files.length > 1 ? h('select', { className: 'review-file-picker', 'aria-label': '上传包文件',
      onchange: event => openFile(event.target.value, event.target.value === relatedFile ? source?.line : undefined) },
    files.map(name => h('option', { value: name, selected: name === file }, name))) : null;
    const location = showingFile && exact ? `L${startLine}–${Math.min(exact.length, startLine + pageSize - 1)} · 共 ${exact.length} 行` :
      showingFile ? '上传包源码' : source && exact ? `L${source.startLine}–${source.endLine}` : source ? '运行时摘录 · 已脱敏' : '';
    const pagination = showingFile && exact ? h('div', { className: 'review-pagination' },
      totalPages > 1 ? control('上一段', () => { page -= 1; focusLine = true; render(); }, { disabled: page === 0 }) : null,
      totalPages > 1 ? control('下一段', () => { page += 1; focusLine = true; render(); }, { disabled: page + 1 >= totalPages }) : null,
      source && file === relatedFile ? control('定位相关行', () => openFile(file, source.line)) : null) : null;
    const placeholder = showingFile ? original?.pending ? '正在读取上传包源码…' : original?.error || '没有可读取的源码。' :
      canBrowse ? '这一步没有记录源码位置，可切换到完整文件。' : '这条记录没有源码快照。';

    root.replaceChildren(
      h('header', { className: 'review-header' }, h('div', {}, h('h3', { id: 'code-review-title' }, '代码改进'),
        codePlan ? h('p', { className: 'muted' }, codePlan.title) : null),
      h('div', { className: 'review-actions' }, canGenerate ? control(busy ? '正在生成…' : source ? '按源码生成建议' : '生成代码建议', onGenerate, { disabled: busy }) : null,
        codePlan && navigator.clipboard?.writeText ? copyCode(codePlan.code) : null)),
      h('div', { className: 'review-editors' },
        h('section', { className: 'review-editor review-original', 'aria-label': '原始代码' },
          h('div', { className: 'review-editor-head' }, h('h4', {}, '原始代码'), sourceSwitcher),
          file ? h('div', { className: 'review-filebar' }, filePicker || h('code', {}, file), h('span', {}, location)) : null,
          originalLines?.length ? codeSurface(originalLines, { start: startLine, selected: file === relatedFile ? source?.line : null,
            changes: differences.removed, sign: '−', label: '原始代码带行号' }) : h('div', { className: 'review-empty muted' },
            h('p', {}, placeholder), showingFile && original?.error ? control('重试读取', () => { cache.delete(file); render(); }) : null), pagination),
        h('section', { className: 'review-editor review-suggested', 'aria-label': '建议代码' },
          h('div', { className: 'review-editor-head' }, h('h4', {}, '建议代码'),
            codePlan ? h('span', { className: 'review-status' }, codePlan.mode === 'source' ? '建议稿 · 待复测' : '参考实现') : null),
          codePlan ? h('div', { className: 'review-filebar' }, source && codePlan.mode === 'source' ? h('code', {}, source.function) : null, h('span', {}, 'Python')) : null,
          codePlan ? codeSurface(suggested, { start: comparable ? source.startLine : 1, changes: differences.added, sign: '+', label: '建议代码带行号' }) :
            h('p', { className: 'review-empty muted' }, busy ? '正在生成代码建议…' : '当前步骤没有代码建议。'))),
      codePlan ? h('details', { className: 'review-notes', open: root.querySelector('.review-notes')?.open },
        h('summary', {}, '接入位置与复测'), h('div', {}, list('改动步骤', codePlan.changes, true),
          list('行为约束', codePlan.invariants), list('复测条件', codePlan.verification), codePlan.evidence.map(evidenceLink))) : null);
    root.setAttribute('aria-busy', String(busy));
    const viewer = root.querySelector('.review-original .review-code-surface');
    const proposal = root.querySelector('.review-suggested .review-code-surface');
    if (proposal && previousSuggestionHeight) proposal.scrollTop = previousSuggestionHeight;
    if (viewer && focusLine) {
      const line = viewer.querySelector('[data-current=true]');
      viewer.scrollTop = showingFile && line ? line.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 50 : 0;
      focusLine = false;
    } else if (viewer && previousHeight) viewer.scrollTop = previousHeight;
  }

  return {
    update(next) {
      if (next && activeRun !== next.run) {
        activeRun = next.run;
        cache.clear();
      }
      if (!next || current?.key !== next.key) {
        view = 'snippet';
        activeFile = undefined;
        focusLine = false;
      }
      current = next;
      root.hidden = !next;
      if (next) render();
      else root.replaceChildren();
    }
  };
}
