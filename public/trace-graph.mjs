import { element as h, elapsed, kindLabel } from './ui.mjs';

const eventWidth = 166;
const eventHeight = 65;
const columnGap = 55;
const rowGap = 28;
const bandGap = 72;
const graphPadding = 24;
const defaultWidth = 960;
const maxRows = 4;
const roundKey = round => 'round-' + round;
const stepKey = id => 'step-' + id;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function isIssue(event) {
  return event.level === 'warning' || event.level === 'error' || event.status === 'error';
}

function groupByRound(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.round)) groups.set(event.round, []);
    groups.get(event.round).push(event);
  }
  return groups;
}

function columnsForWidth(width) {
  return Math.max(1, Math.floor((width - graphPadding * 2 + columnGap) / (eventWidth + columnGap)));
}

function foldColumns(nodes, columnLimit) {
  const columns = new Map();
  for (const node of nodes) {
    if (!columns.has(node.column)) columns.set(node.column, []);
    columns.get(node.column).push(node);
  }
  const ordered = [...columns.entries()].sort(([a], [b]) => a - b);
  const width = Math.min(ordered.length, columnLimit) * (eventWidth + columnGap) - columnGap;
  const bands = [];
  let top = 0;
  for (let offset = 0; offset < ordered.length; offset += columnLimit) {
    const row = ordered.slice(offset, offset + columnLimit);
    const height = Math.max(...row.map(([, entries]) => entries.length)) * (eventHeight + rowGap) - rowGap;
    const band = bands.length;
    bands.push({ top, bottom: top + height });
    for (const [index, [, entries]] of row.entries()) {
      const slot = band % 2 ? columnLimit - 1 - index : index;
      const stack = entries.length * (eventHeight + rowGap) - rowGap;
      for (const [rowIndex, node] of entries.entries()) {
        node.band = band;
        node.x = slot * (eventWidth + columnGap) + (eventWidth - node.width) / 2;
        node.y = top + (height - stack + eventHeight - node.height) / 2 + rowIndex * (eventHeight + rowGap);
      }
    }
    top += height + bandGap;
  }
  return { bands, width };
}

export function buildTraceGraph(events, requestedRound = null, viewportWidth = defaultWidth) {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const groups = groupByRound(ordered);
  const rounds = [...groups.keys()].sort((a, b) => a - b);
  const round = groups.has(requestedRound) ? requestedRound : rounds.length === 1 ? rounds[0] : null;
  const steps = new Map(ordered.map(event => [event.id, event]));
  const nodes = [];
  const edges = new Map();
  const register = (from, to, arched = false) => {
    if (from !== to) edges.set(from + ':' + to, { from, to, arched });
  };

  function roundNode(id, kind) {
    const members = groups.get(id);
    const issues = members.filter(isIssue).length;
    return {
      id: roundKey(id), round: id, kind, title: '轮次 ' + id,
      subtitle: members.length + ' 步' + (issues ? ' · ' + issues + ' 处异常' : ''),
      width: kind === 'round' ? 152 : 138, height: 62,
      members, issue: issues > 0
    };
  }

  if (round === null) {
    const positions = new Map(rounds.map((id, index) => [id, index]));
    for (const [index, id] of rounds.entries()) {
      nodes.push({ ...roundNode(id, 'round'), column: index });
    }
    for (const event of ordered) {
      for (const id of event.links || []) {
        const upstream = steps.get(id);
        if (upstream && upstream.round !== event.round) {
          register(roundKey(upstream.round), roundKey(event.round),
            Math.abs(positions.get(upstream.round) - positions.get(event.round)) > 1);
        }
      }
    }
  } else {
    const columns = new Map();
    const occupied = new Map();
    const adjacent = new Set();
    for (const event of groups.get(round)) {
      const parents = (event.links || []).filter(id => columns.has(id));
      let column = Math.max(0, ...parents.map(id => columns.get(id) + 1));
      while ((occupied.get(column)?.length || 0) >= maxRows) column += 1;
      columns.set(event.id, column);
      if (!occupied.has(column)) occupied.set(column, []);
      occupied.get(column).push(event);
      for (const id of event.links || []) {
        const upstream = steps.get(id);
        if (!upstream) continue;
        if (upstream.round === round) register(stepKey(id), stepKey(event.id));
        else {
          adjacent.add(upstream.round);
          register(roundKey(upstream.round), stepKey(event.id));
        }
      }
    }
    for (const event of ordered) {
      if (event.round === round) continue;
      for (const id of event.links || []) {
        if (!columns.has(id)) continue;
        adjacent.add(event.round);
        register(stepKey(id), roundKey(event.round));
      }
    }
    for (const [column, entries] of occupied) {
      for (const event of entries) {
        nodes.push({
          id: stepKey(event.id), round, stepId: event.id, kind: event.kind, title: event.name,
          subtitle: kindLabel(event.kind) + ' · ' + elapsed(event.durationMs),
          column,
          width: eventWidth, height: eventHeight, members: [event], issue: isIssue(event)
        });
      }
    }
    const neighbors = [...adjacent].sort((a, b) => a - b);
    const left = neighbors.filter(id => id < round);
    const right = neighbors.filter(id => id > round);
    const end = Math.max(...occupied.keys()) + 1;
    for (const [side, direction] of [[left, -1], [right, 1]]) {
      for (const [index, id] of side.entries()) {
        const column = Math.floor(index / maxRows);
        nodes.push({
          ...roundNode(id, 'round-link'),
          column: direction < 0 ? -1 - column : end + column
        });
      }
    }
  }
  const geometry = foldColumns(nodes, columnsForWidth(viewportWidth));
  nodes.sort((a, b) => a.column - b.column || a.y - b.y);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const links = [...edges.values()].map(link => {
    const from = byId.get(link.from), to = byId.get(link.to);
    const points = routeLink(from, to, geometry).filter(([x, y], index, all) =>
      !index || x !== all[index - 1][0] || y !== all[index - 1][1]);
    return { ...link, secondary: link.arched || Math.abs(from.column - to.column) > 1, points };
  });
  const bounds = { left: 0, top: 0, right: 1, bottom: 1 };
  function include(x, y) {
    bounds.left = Math.min(bounds.left, x);
    bounds.top = Math.min(bounds.top, y);
    bounds.right = Math.max(bounds.right, x);
    bounds.bottom = Math.max(bounds.bottom, y);
  }
  for (const node of nodes) {
    include(node.x, node.y);
    include(node.x + node.width, node.y + node.height);
  }
  for (const link of links) for (const [x, y] of link.points) include(x, y);
  return { round, rounds, nodes, links, bounds };
}

function routeLink(from, to, { bands, width }) {
  const source = bands[from.band], target = bands[to.band];
  const sameBand = from.band === to.band;
  const nearby = Math.abs(from.column - to.column) === 1;
  const downward = from.band < to.band;
  const fromCenter = from.x + from.width / 2, toCenter = to.x + to.width / 2;
  const fromY = from.y + from.height / 2, toY = to.y + to.height / 2;
  const fromSide = sign => from.x + (sign > 0 ? from.width : 0);
  const toSide = sign => to.x + (sign > 0 ? to.width : 0);
  const rightward = fromCenter < toCenter ? 1 : -1;

  if (sameBand && nearby) {
    const start = fromSide(rightward), end = toSide(-rightward);
    const mid = (start + end) / 2;
    return [[start, fromY], [mid, fromY], [mid, toY], [end, toY]];
  }

  if (!sameBand && nearby) {
    const start = downward ? from.y + from.height : from.y;
    const end = downward ? to.y : to.y + to.height;
    const clear = downward ? from.y + from.height >= source.bottom - 2 && to.y <= target.top + 2 :
      from.y <= source.top + 2 && to.y + to.height >= target.bottom - 2;
    if (clear) return [[fromCenter, start], [toCenter, end]];
    const sign = fromCenter > width / 2 ? 1 : -1;
    const outside = sign > 0 ? width + 14 : -14;
    return [[fromSide(sign), fromY], [outside, fromY], [outside, toY], [toSide(sign), toY]];
  }

  const start = fromSide(rightward), end = toSide(-rightward);
  const exit = start + rightward * 16, entry = end - rightward * 16;
  const leaveY = sameBand || !downward ? source.top - 22 : source.bottom + 22;
  const arriveY = sameBand ? leaveY : downward ? target.top - 22 : target.bottom + 22;
  const between = Math.abs(from.band - to.band) > 1 ?
    [[-14, leaveY], [-14, arriveY]] : [[entry, leaveY]];
  return [[start, fromY], [exit, fromY], [exit, leaveY], ...between,
    [entry, arriveY], [entry, toY], [end, toY]];
}

export class TraceGraph {
  constructor(root, { onStep, onRound }) {
    this.root = root;
    this.onStep = onStep;
    this.onRound = onRound;
    this.viewport = root.querySelector('[data-graph-viewport]');
    this.stage = root.querySelector('[data-graph-stage]');
    this.canvas = root.querySelector('[data-graph-edges]');
    this.minimap = root.querySelector('[data-graph-minimap]');
    this.mapCanvas = this.minimap.querySelector('canvas');
    this.empty = root.querySelector('[data-graph-empty]');
    this.scaleLabel = root.querySelector('[data-graph-scale]');
    this.camera = { x: 0, y: 0, scale: 1 };
    this.layout = buildTraceGraph([]);
    this.nodes = new Map();
    this.buttons = new Map();
    this.frame = null;
    this.drag = null;

    for (const button of root.querySelectorAll('[data-graph-zoom]')) {
      button.addEventListener('click', () => this.zoomAt(button.dataset.graphZoom === '1' ? 1.25 : 0.8));
    }
    root.querySelector('[data-graph-fit]').addEventListener('click', () => this.fit());
    this.viewport.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = this.viewport.getBoundingClientRect();
        this.zoomAt(event.deltaY > 0 ? 0.88 : 1.14, event.clientX - rect.left, event.clientY - rect.top);
      } else this.scroll(event);
    }, { passive: false });
    this.viewport.addEventListener('keydown', event => this.onKey(event));
    this.viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.viewport.dataset.dragging = 'true';
      this.viewport.setPointerCapture(event.pointerId);
    });
    this.viewport.addEventListener('pointermove', event => {
      if (this.drag?.id !== event.pointerId) return;
      this.pan(event.clientX - this.drag.x, event.clientY - this.drag.y);
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
    });
    this.viewport.addEventListener('lostpointercapture', () => {
      this.drag = null;
      delete this.viewport.dataset.dragging;
    });
    this.minimap.addEventListener('click', event => {
      if (!this.mapTransform) return;
      if (!event.detail) return this.center(this.nodes.get(this.selectedKey));
      const rect = this.mapCanvas.getBoundingClientRect();
      const { x, y, scale } = this.mapTransform;
      const { left, right, top, bottom } = this.layout.bounds;
      if (this.camera.scale < 0.48) this.camera.scale = 0.9;
      this.centerOn(clamp((event.clientX - rect.left - x) / scale, left, right),
        clamp((event.clientY - rect.top - y) / scale, top, bottom));
    });
    new ResizeObserver(() => {
      if (this.lastUpdate && this.viewport.clientWidth &&
          columnsForWidth(this.viewport.clientWidth) !== this.columnLimit) this.update(this.lastUpdate);
      if (this.needsFraming && this.viewport.clientWidth > 0) this.frameInitial();
      this.requestDraw();
    }).observe(this.viewport);
  }

  update(options) {
    this.lastUpdate = options;
    const { events, round, runId, selected, matches, highlightIssues, emptyText } = options;
    const width = this.viewport.clientWidth || defaultWidth;
    const columnLimit = columnsForWidth(width);
    const reflow = this.columnLimit !== columnLimit;
    this.columnLimit = columnLimit;
    const viewKey = runId + ':' + round;
    const signature = viewKey + ':' + JSON.stringify(events.map(event =>
      [event.id, event.round, event.name, event.kind, event.links, event.level, event.status, event.durationMs]));
    const previousRound = this.layout.round;
    const reset = this.viewKey !== viewKey || !this.layout.nodes.length;
    this.viewKey = viewKey;
    if (reflow || this.signature !== signature) {
      this.signature = signature;
      const focused = this.stage.contains(document.activeElement) ? document.activeElement.dataset.nodeId : null;
      this.layout = buildTraceGraph(events, round, width);
      this.nodes = new Map(this.layout.nodes.map(node => [node.id, node]));
      this.renderNodes();
      if (focused) this.buttons.get(focused)?.focus({ preventScroll: true });
    }
    const selectedEvent = events.find(event => event.id === selected);
    this.selectedKey = this.layout.round === null ? roundKey(selectedEvent?.round) : stepKey(selected);
    const search = matches instanceof Set;
    for (const [id, button] of this.buttons) {
      const node = this.nodes.get(id);
      const match = node.members.some(event => (!highlightIssues || isIssue(event)) && (!search || matches.has(event.id)));
      button.setAttribute('aria-current', String(id === this.selectedKey));
      button.dataset.emphasis = highlightIssues || search ? (match ? 'match' : 'dim') : 'normal';
    }
    this.empty.textContent = emptyText;
    this.empty.hidden = this.layout.nodes.length > 0;
    this.minimap.disabled = !this.layout.nodes.length;
    if (reset || reflow || previousRound !== this.layout.round) {
      this.needsFraming = true;
      if (this.viewport.clientWidth > 0) this.frameInitial();
    }
    this.requestDraw();
  }

  renderNodes() {
    this.buttons = new Map(this.layout.nodes.map(node => {
      const button = h('button', { type: 'button', className: 'graph-node',
        'data-kind': node.kind, 'data-node-id': node.id, 'data-issue': String(node.issue),
        'aria-label': (node.stepId ? '步骤 ' + node.stepId + '，' : '') + node.title + '，' + node.subtitle,
        title: node.title,
        onclick: event => {
          if (node.stepId != null) this.onStep(node.stepId);
          else this.onRound(node.round);
          if (!event.detail) this.buttons.get(this.selectedKey)?.focus({ preventScroll: true });
        },
        onfocus: () => this.reveal(node)
      }, h('span', { className: 'graph-node-dot', 'aria-hidden': 'true' }),
      h('span', { className: 'graph-node-content' },
        h('span', { className: 'graph-node-title' }, node.title),
        h('span', { className: 'graph-node-meta' }, node.stepId ? '#' + node.stepId + ' · ' + node.subtitle : node.subtitle)),
      node.stepId == null ? h('span', { className: 'graph-node-arrow', 'aria-hidden': 'true' }, '↗') : null);
      for (const [key, value] of Object.entries({ left: node.x, top: node.y, width: node.width, height: node.height })) {
        button.style[key] = value + 'px';
      }
      return [node.id, button];
    }));
    this.stage.replaceChildren(...this.buttons.values());
  }

  onKey(event) {
    if (event.target !== this.viewport) return;
    const translations = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
    if (Object.hasOwn(translations, event.key)) this.pan(...translations[event.key]);
    else if (event.key === '+' || event.key === '=') this.zoomAt(1.25);
    else if (event.key === '-') this.zoomAt(0.8);
    else if (event.key.toLowerCase() === 'f') this.fit();
    else return;
    event.preventDefault();
  }

  minScale() {
    const { left, right, top, bottom } = this.layout.bounds;
    return Math.max(0.002, Math.min(
      (this.viewport.clientWidth - 44) / Math.max(1, right - left),
      (this.viewport.clientHeight - 44) / Math.max(1, bottom - top)
    ));
  }

  frameInitial() {
    this.needsFraming = false;
    if (!this.layout.nodes.length) return;
    if (this.minScale() >= 0.67) this.fit();
    else {
      const { left, right, top, bottom } = this.layout.bounds;
      const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
      this.camera.scale = Math.min(1, Math.max(0.1, (width - graphPadding * 2) / (right - left)));
      const { scale } = this.camera;
      const selected = this.nodes.get(this.selectedKey);
      const firstY = graphPadding - top * scale;
      const lastY = Math.min(firstY, height - graphPadding - bottom * scale);
      this.camera.x = (width - (left + right) * scale) / 2;
      this.camera.y = selected ? clamp(height / 2 - (selected.y + selected.height / 2) * scale, lastY, firstY) : firstY;
    }
  }

  fit() {
    if (!this.layout.nodes.length || !this.viewport.clientWidth) return;
    const { left, right, top, bottom } = this.layout.bounds;
    this.camera.scale = Math.min(1, this.minScale());
    this.centerOn((left + right) / 2, (top + bottom) / 2);
  }

  focusStep(id) {
    const position = this.nodes.get(stepKey(id));
    if (position) this.reveal(position, true);
  }

  reveal(node, readable = false) {
    const { x, y, scale } = this.camera;
    if (readable && scale < 0.6) {
      this.camera.scale = 0.9;
      return this.center(node);
    }
    if (node.x * scale + x < 12 || (node.x + node.width) * scale + x > this.viewport.clientWidth - 12 ||
        node.y * scale + y < 12 || (node.y + node.height) * scale + y > this.viewport.clientHeight - 12) this.center(node);
  }

  center(node) {
    if (node) this.centerOn(node.x + node.width / 2, node.y + node.height / 2);
  }

  centerOn(x, y) {
    this.camera.x = this.viewport.clientWidth / 2 - x * this.camera.scale;
    this.camera.y = this.viewport.clientHeight / 2 - y * this.camera.scale;
    this.requestDraw();
  }

  pan(x, y) {
    const { scale } = this.camera;
    const { left, right, top, bottom } = this.layout.bounds;
    this.camera.x = clamp(this.camera.x + x, 38 - right * scale, this.viewport.clientWidth - 38 - left * scale);
    this.camera.y = clamp(this.camera.y + y, 38 - bottom * scale, this.viewport.clientHeight - 38 - top * scale);
    this.requestDraw();
  }

  scroll(event) {
    if (!this.layout.nodes.length || !event.deltaY) return;
    const { top, bottom } = this.layout.bounds;
    const { y, scale } = this.camera;
    const min = this.viewport.clientHeight - graphPadding - bottom * scale;
    const max = graphPadding - top * scale;
    if (min >= max) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1;
    const next = clamp(y - event.deltaY * unit, min, max);
    if (next === y) return;
    event.preventDefault();
    this.camera.y = next;
    this.requestDraw();
  }

  zoomAt(factor, x = this.viewport.clientWidth / 2, y = this.viewport.clientHeight / 2) {
    if (!this.layout.nodes.length) return;
    const camera = this.camera;
    const old = camera.scale;
    camera.scale = clamp(old * factor, Math.min(0.2, this.minScale()), 2);
    camera.x = x - (x - camera.x) * camera.scale / old;
    camera.y = y - (y - camera.y) * camera.scale / old;
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame === null) this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    if (!width || !height) return;
    const { x, y, scale } = this.camera;
    this.stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.stage.dataset.compact = String(scale < 0.48);
    this.scaleLabel.textContent = (scale < 0.1 ? (scale * 100).toFixed(1) : Math.round(scale * 100)) + '%';
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      for (const link of this.layout.links) this.drawLink(ctx, link, width, height);
    }
    this.drawMinimap(width, height);
  }

  drawLink(ctx, link, width, height) {
    const { scale, x, y } = this.camera;
    const { points } = link;
    if (points.every(([px]) => px * scale + x < -30) || points.every(([px]) => px * scale + x > width + 30) ||
        points.every(([, py]) => py * scale + y < -30) || points.every(([, py]) => py * scale + y > height + 30)) return;
    const active = link.from === this.selectedKey || link.to === this.selectedKey;
    ctx.strokeStyle = active ? '#625bc3' : '#a2afc7';
    ctx.lineWidth = (active ? 2.1 : 1.25) / Math.max(0.3, scale);
    ctx.setLineDash(link.secondary ? [5 / scale, 4 / scale] : []);
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (let index = 1; index < points.length - 1; index += 1) {
      const [px, py] = points[index];
      const before = [points[index - 1][0] - px, points[index - 1][1] - py];
      const after = [points[index + 1][0] - px, points[index + 1][1] - py];
      const previousLength = Math.hypot(...before), nextLength = Math.hypot(...after);
      const bend = Math.min(11, previousLength / 2, nextLength / 2);
      ctx.lineTo(px + before[0] * bend / previousLength, py + before[1] * bend / previousLength);
      ctx.quadraticCurveTo(px, py, px + after[0] * bend / nextLength, py + after[1] * bend / nextLength);
    }
    const [endX, endY] = points.at(-1);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    if (scale < 0.2 || points.length < 2) return;
    const [lastX, lastY] = points.at(-2);
    const angle = Math.atan2(endY - lastY, endX - lastX);
    const radius = 6 / Math.max(scale, 0.7);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(endX - radius * Math.cos(angle - 0.5), endY - radius * Math.sin(angle - 0.5));
    ctx.lineTo(endX, endY);
    ctx.lineTo(endX - radius * Math.cos(angle + 0.5), endY - radius * Math.sin(angle + 0.5));
    ctx.stroke();
  }

  drawMinimap(width, height) {
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    const w = this.mapCanvas.width, h = this.mapCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.layout.nodes.length) return;
    const { left, right, top, bottom } = this.layout.bounds;
    const scale = Math.min((w - 10) / (right - left), (h - 10) / (bottom - top));
    const x = (w - (right + left) * scale) / 2, y = (h - (bottom + top) * scale) / 2;
    this.mapTransform = { x, y, scale };
    for (const node of this.layout.nodes) {
      ctx.fillStyle = node.id === this.selectedKey ? '#675dcc' : node.issue ? '#bd672e' : '#a4aeca';
      ctx.fillRect(x + node.x * scale, y + node.y * scale, Math.max(1, node.width * scale), Math.max(1, node.height * scale));
    }
    const focusX = x - this.camera.x * scale / this.camera.scale;
    const focusY = y - this.camera.y * scale / this.camera.scale;
    const focusWidth = width * scale / this.camera.scale, focusHeight = height * scale / this.camera.scale;
    const l = clamp(focusX, 1, w - 1), t = clamp(focusY, 1, h - 1);
    const r = clamp(focusX + focusWidth, 1, w - 1), b = clamp(focusY + focusHeight, 1, h - 1);
    ctx.strokeStyle = '#625bc3';
    ctx.strokeRect(l, t, Math.max(0, r - l), Math.max(0, b - t));
  }
}
