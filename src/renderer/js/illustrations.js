// Original vector illustrations for the setup wizard and empty states,
// drawn in the application's industrial palette (amber accent, steel blues).
import { s } from './dom.js';

let uid = 0;
function frame(build) {
  const id = `il${++uid}`;
  const defs = s('defs', null,
    s('linearGradient', { id: `${id}a`, x1: 0, y1: 0, x2: 1, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#ffc46b' }), s('stop', { offset: 1, 'stop-color': '#f07c1e' })),
    s('linearGradient', { id: `${id}m`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#2a3448' }), s('stop', { offset: 1, 'stop-color': '#151b27' })),
    s('linearGradient', { id: `${id}f`, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#1b2231' }), s('stop', { offset: 1, 'stop-color': '#0f131b' })),
    s('radialGradient', { id: `${id}g`, cx: '50%', cy: '50%', r: '50%' }, s('stop', { offset: 0, 'stop-color': '#f6a03c', 'stop-opacity': 0.35 }), s('stop', { offset: 1, 'stop-color': '#f6a03c', 'stop-opacity': 0 })));
  const c = { a: `url(#${id}a)`, m: `url(#${id}m)`, f: `url(#${id}f)`, g: `url(#${id}g)` };
  return s('svg', { viewBox: '0 0 240 180', class: 'ill', 'aria-hidden': 'true' }, defs,
    s('ellipse', { cx: 120, cy: 96, rx: 110, ry: 80, fill: c.g }),
    s('ellipse', { cx: 120, cy: 160, rx: 92, ry: 9, fill: '#000', opacity: 0.35 }), ...build(c));
}
const rack = (x, y, c, n = 3) => {
  const parts = [s('rect', { x, y, width: 64, height: 18 * n + 10, rx: 6, fill: c.m, stroke: '#3a4660' })];
  for (let i = 0; i < n; i++) {
    const yy = y + 6 + i * 18;
    parts.push(s('rect', { x: x + 6, y: yy, width: 52, height: 13, rx: 3, fill: '#0c1018', stroke: '#2c364b' }),
      s('circle', { cx: x + 13, cy: yy + 6.5, r: 2.2, fill: i === 0 ? '#3ccf8e' : '#f6a03c' }),
      s('rect', { x: x + 20, y: yy + 5, width: 22, height: 3, rx: 1.5, fill: '#3a4660' }),
      s('rect', { x: x + 46, y: yy + 4, width: 6, height: 5, rx: 1, fill: '#2c364b' }));
  }
  return parts;
};
const conveyor = (x, y, w) => [
  s('rect', { x, y, width: w, height: 8, rx: 4, fill: '#1b2231', stroke: '#3a4660' }),
  ...Array.from({ length: Math.floor(w / 14) }, (_, i) => s('circle', { cx: x + 7 + i * 14, cy: y + 4, r: 2, fill: '#3a4660' })),
];

export const ill = {
  welcome: () => frame((c) => [
    s('path', { d: 'M28 150V96l26-14v14l26-14v14l26-14v68z', fill: c.m, stroke: '#3a4660' }),
    s('rect', { x: 92, y: 52, width: 12, height: 44, fill: '#232c3e', stroke: '#3a4660' }),
    s('path', { d: 'M90 46c4-8 14-8 18-1', stroke: '#6b7488', 'stroke-width': 3, fill: 'none', opacity: 0.6, 'stroke-linecap': 'round' }),
    s('rect', { x: 38, y: 116, width: 10, height: 10, fill: '#f6a03c', opacity: 0.85 }), s('rect', { x: 62, y: 116, width: 10, height: 10, fill: '#f6a03c', opacity: 0.55 }),
    ...conveyor(100, 136, 50),
    s('rect', { x: 112, y: 126, width: 10, height: 10, rx: 2, fill: c.a }),
    ...rack(150, 70, c, 4),
    s('path', { d: 'M182 54l14 8v16l-14 8-14-8V62z', fill: c.a }),
    s('path', { d: 'M182 60l8.6 5v10l-8.6 5-8.6-5V65z', fill: '#151b27' }),
  ]),
  scan: () => frame((c) => [
    s('circle', { cx: 120, cy: 92, r: 62, fill: 'none', stroke: '#2c364b', 'stroke-width': 2 }),
    s('circle', { cx: 120, cy: 92, r: 42, fill: 'none', stroke: '#2c364b', 'stroke-width': 2 }),
    s('circle', { cx: 120, cy: 92, r: 22, fill: 'none', stroke: '#3a4660', 'stroke-width': 2 }),
    s('path', { d: 'M120 92L170 56A62 62 0 0 1 182 92z', fill: c.a, opacity: 0.28 }),
    s('path', { d: 'M120 92L170 56', stroke: '#ffb04a', 'stroke-width': 2.5, 'stroke-linecap': 'round' }),
    s('circle', { cx: 120, cy: 92, r: 5, fill: c.a }),
    s('circle', { cx: 156, cy: 74, r: 4, fill: '#3ccf8e' }), s('circle', { cx: 92, cy: 120, r: 4, fill: '#5aa9ff' }), s('circle', { cx: 84, cy: 66, r: 3.5, fill: '#f6a03c' }),
    s('rect', { x: 16, y: 120, width: 46, height: 30, rx: 5, fill: c.m, stroke: '#3a4660' }), s('rect', { x: 22, y: 126, width: 34, height: 4, rx: 2, fill: '#3a4660' }), s('rect', { x: 22, y: 135, width: 22, height: 4, rx: 2, fill: '#3ccf8e', opacity: 0.8 }),
  ]),
  location: () => frame((c) => [
    s('path', { d: 'M40 60h52l12 12h96v76H40z', fill: c.m, stroke: '#3a4660' }),
    s('path', { d: 'M40 82h160v66H40z', fill: c.f, stroke: '#3a4660' }),
    s('rect', { x: 60, y: 100, width: 70, height: 8, rx: 4, fill: '#2c364b' }), s('rect', { x: 60, y: 116, width: 50, height: 8, rx: 4, fill: '#2c364b' }),
    s('path', { d: 'M166 34c-14 0-24 10-24 24 0 18 24 42 24 42s24-24 24-42c0-14-10-24-24-24z', fill: c.a }),
    s('circle', { cx: 166, cy: 58, r: 9, fill: '#151b27' }),
  ]),
  dependencies: () => frame((c) => [
    ...conveyor(20, 128, 200),
    s('path', { d: 'M54 92l26-14 26 14v28l-26 14-26-14z', fill: c.m, stroke: '#3a4660' }), s('path', { d: 'M54 92l26 14 26-14M80 106v28', stroke: '#3a4660', fill: 'none' }),
    s('path', { d: 'M134 70l26-14 26 14v28l-26 14-26-14z', fill: c.a }), s('path', { d: 'M134 70l26 14 26-14M160 84v28', stroke: '#9a4d10', fill: 'none', 'stroke-width': 1.5 }),
    s('path', { d: 'M160 20v26M150 36l10 10 10-10', stroke: '#ffb04a', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  ]),
  install: () => frame((c) => [
    ...rack(88, 52, c, 5),
    s('path', { d: 'M120 10v30M108 28l12 12 12-12', stroke: '#ffb04a', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    ...conveyor(18, 140, 70), ...conveyor(152, 140, 70),
    s('rect', { x: 30, y: 128, width: 12, height: 12, rx: 2, fill: c.a }), s('rect', { x: 56, y: 128, width: 12, height: 12, rx: 2, fill: c.a, opacity: 0.7 }),
    s('rect', { x: 176, y: 128, width: 12, height: 12, rx: 2, fill: '#3ccf8e', opacity: 0.8 }),
  ]),
  network: () => frame((c) => [
    s('circle', { cx: 120, cy: 90, r: 50, fill: c.m, stroke: '#3a4660', 'stroke-width': 2 }),
    s('ellipse', { cx: 120, cy: 90, rx: 22, ry: 50, fill: 'none', stroke: '#3a4660', 'stroke-width': 2 }),
    s('path', { d: 'M70 90h100M78 64h84M78 116h84', stroke: '#3a4660', 'stroke-width': 2 }),
    ...[[42, 42], [198, 50], [36, 140], [204, 136]].flatMap(([x, y]) => [s('path', { d: `M${x} ${y}L120 90`, stroke: '#f6a03c', 'stroke-width': 1.6, 'stroke-dasharray': '4 4', opacity: 0.8 }), s('circle', { cx: x, cy: y, r: 8, fill: c.a })]),
    s('rect', { x: 102, y: 74, width: 36, height: 32, rx: 5, fill: '#151b27', stroke: '#ffb04a', 'stroke-width': 2 }), s('path', { d: 'M110 84h20M110 92h20M110 100h12', stroke: '#ffb04a', 'stroke-width': 2 }),
  ]),
  security: () => frame((c) => [
    s('path', { d: 'M120 18l54 20v40c0 36-24 58-54 66-30-8-54-30-54-66V38z', fill: c.m, stroke: '#3a4660', 'stroke-width': 2 }),
    s('path', { d: 'M120 32l40 15v31c0 27-18 44-40 50-22-6-40-23-40-50V47z', fill: c.a, opacity: 0.18 }),
    s('rect', { x: 100, y: 78, width: 40, height: 32, rx: 6, fill: c.a }),
    s('path', { d: 'M108 78v-10a12 12 0 0 1 24 0v10', stroke: '#ffb04a', 'stroke-width': 5, fill: 'none' }),
    s('circle', { cx: 120, cy: 92, r: 4, fill: '#151b27' }), s('path', { d: 'M120 94v8', stroke: '#151b27', 'stroke-width': 3, 'stroke-linecap': 'round' }),
  ]),
  review: () => frame((c) => [
    s('rect', { x: 66, y: 20, width: 108, height: 136, rx: 10, fill: c.m, stroke: '#3a4660', 'stroke-width': 2 }),
    s('rect', { x: 98, y: 12, width: 44, height: 16, rx: 5, fill: c.a }),
    ...[48, 76, 104, 132].flatMap((y, i) => [s('circle', { cx: 88, cy: y, r: 7, fill: i < 3 ? '#3ccf8e' : '#2c364b' }), s('path', { d: `M84.5 ${y}l2.5 2.5 4.5-4.5`, stroke: '#0b1a12', 'stroke-width': 2, fill: 'none', opacity: i < 3 ? 1 : 0 }), s('rect', { x: 102, y: y - 4, width: 56 - i * 6, height: 8, rx: 4, fill: '#3a4660' })]),
  ]),
  finish: () => frame((c) => [
    s('path', { d: 'M120 16c22 14 30 40 26 70l-26 18-26-18c-4-30 4-56 26-70z', fill: c.m, stroke: '#3a4660', 'stroke-width': 2 }),
    s('circle', { cx: 120, cy: 58, r: 11, fill: '#151b27', stroke: '#ffb04a', 'stroke-width': 3 }),
    s('path', { d: 'M94 86l-18 16 4 18 18-12zM146 86l18 16-4 18-18-12z', fill: c.a }),
    s('path', { d: 'M108 106c4 22 8 30 12 40 4-10 8-18 12-40', fill: c.a, opacity: 0.85 }),
    s('path', { d: 'M114 110c2 12 4 18 6 24 2-6 4-12 6-24', fill: '#ffe2a8' }),
    ...[[40, 40], [200, 34], [190, 120], [48, 128], [70, 70]].map(([x, y]) => s('path', { d: `M${x} ${y - 5}v10M${x - 5} ${y}h10`, stroke: '#ffb04a', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.8 })),
  ]),
  empty: () => frame((c) => [...rack(88, 56, c, 3), s('path', { d: 'M150 50l12 12M162 50l-12 12', stroke: '#6b7488', 'stroke-width': 3, 'stroke-linecap': 'round' })]),
};
