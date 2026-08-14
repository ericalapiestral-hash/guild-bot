// 턴 숫자 영역 선택 — 드래그한 사각형을 화면 대비 비율(0~1)로 넘긴다.
'use strict';

const { ipcRenderer } = require('electron');

let displayId = null;
let dragging = false;
let sx = 0;
let sy = 0;

const rect = document.getElementById('rect');

ipcRenderer.on('picker:init', (_e, data) => {
  displayId = data.displayId;
});

document.addEventListener('mousedown', (e) => {
  dragging = true;
  sx = e.clientX;
  sy = e.clientY;
  rect.style.display = 'block';
  update(e);
});

function update(e) {
  const x = Math.min(sx, e.clientX);
  const y = Math.min(sy, e.clientY);
  const w = Math.abs(e.clientX - sx);
  const h = Math.abs(e.clientY - sy);
  rect.style.left = `${x}px`;
  rect.style.top = `${y}px`;
  rect.style.width = `${w}px`;
  rect.style.height = `${h}px`;
  return { x, y, w, h };
}

document.addEventListener('mousemove', (e) => {
  if (dragging) update(e);
});

document.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const { x, y, w, h } = update(e);
  if (w < 6 || h < 6) {
    rect.style.display = 'none';
    return; // 잘못 클릭한 것 — 다시 드래그
  }
  ipcRenderer.send('picker:done', {
    displayId,
    fx: x / window.innerWidth,
    fy: y / window.innerHeight,
    fw: w / window.innerWidth,
    fh: h / window.innerHeight,
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('picker:cancel');
});
