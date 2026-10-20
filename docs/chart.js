'use strict';

// 折れ線グラフ（1系列）。外部ライブラリを使わず SVG で描く（CSP で外部スクリプトを許可していないため）
// ・線 2px、目盛り線は控えめ、最後の点に値を直接表示
// ・指やマウスでなぞると縦線が近い点に吸い付き、値を表示する（キーボードの ← → でも動かせる）
// 色は CSS の --chart-line（明るい配色・暗い配色で別の値）

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// きりのよい目盛り（3〜5本）
function niceTicks(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const fmtShort = (v) => Number(v).toLocaleString('ja-JP', { maximumFractionDigits: v >= 1000 ? 0 : 2 });

// box：描く場所（div）。points：[{ label（横軸・吹き出し用）, v }]。xTicks：目盛りを付ける点の番号と文字 [[i, '1年後'], …]
// fmt：吹き出しと最後の点の値の書式（省略時は fmtAmount）
function drawLineChart(box, points, { xTicks = [], unit = '', title = '', fmt = fmtAmount } = {}) {
  const W = Math.max(280, Math.floor(box.clientWidth || 340));
  const H = 220;
  const pad = { l: 64, r: 16, t: 16, b: 28 };
  const vs = points.map((p) => p.v);
  const ticks = niceTicks(Math.min(...vs), Math.max(...vs));
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const x = (i) => pad.l + (W - pad.l - pad.r) * (points.length === 1 ? 0 : i / (points.length - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - y0) / (y1 - y0));

  const grid = ticks.map((t) => svg('g', {},
    svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'ch-grid' }),
    svg('text', { x: pad.l - 6, y: y(t) + 4, class: 'ch-ylabel', 'text-anchor': 'end' }, fmtShort(t))));
  const xlabels = xTicks.map(([i, txt]) => svg('text', { x: x(i), y: H - 8, class: 'ch-xlabel', 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' }, txt));
  const path = svg('path', { d: points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' '), class: 'ch-line' });
  const last = points[points.length - 1];
  const endDot = svg('circle', { cx: x(points.length - 1), cy: y(last.v), r: 4, class: 'ch-dot' });
  const endLabel = svg('text', { x: x(points.length - 1) - 6, y: y(last.v) - 10, class: 'ch-endlabel', 'text-anchor': 'end' }, fmt(last.v) + (unit ? ' ' + unit : ''));

  const hair = svg('line', { y1: pad.t, y2: H - pad.b, class: 'ch-hair', visibility: 'hidden' });
  const hot = svg('circle', { r: 5, class: 'ch-dot ch-hot', visibility: 'hidden' });
  const hit = svg('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' });
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': title }, ...grid, ...xlabels, path, endDot, endLabel, hair, hot, hit);

  const tip = el('div', { class: 'ch-tip', hidden: '' });
  const wrap = el('div', { class: 'ch-wrap', tabindex: '0', 'aria-label': title + '（← → で月を移動）' }, chart, tip);
  let cur = -1;
  const show = (i) => {
    cur = Math.max(0, Math.min(points.length - 1, i));
    const p = points[cur];
    hair.setAttribute('x1', x(cur)); hair.setAttribute('x2', x(cur)); hair.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', x(cur)); hot.setAttribute('cy', y(p.v)); hot.setAttribute('visibility', 'visible');
    tip.replaceChildren(el('b', {}, fmt(p.v) + (unit ? ' ' + unit : '')), el('span', {}, p.label));
    tip.hidden = false;
    const left = Math.min(Math.max(x(cur) - 70, 0), W - 140);
    tip.style.left = left + 'px';
  };
  const hide = () => { hair.setAttribute('visibility', 'hidden'); hot.setAttribute('visibility', 'hidden'); tip.hidden = true; cur = -1; };
  const nearest = (ev) => {
    const r = chart.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    return Math.round((px - pad.l) / ((W - pad.l - pad.r) / Math.max(1, points.length - 1)));
  };
  hit.addEventListener('pointermove', (ev) => show(nearest(ev)));
  hit.addEventListener('pointerdown', (ev) => show(nearest(ev)));
  hit.addEventListener('pointerleave', hide);
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.preventDefault(); show((cur < 0 ? 0 : cur) + (ev.key === 'ArrowRight' ? 1 : -1)); }
  });
  wrap.addEventListener('blur', hide);
  box.replaceChildren(wrap);
}
