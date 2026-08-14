// 오버레이 렌더러 — 빌드 선택, 단계 표시, 턴 OCR 자동 진행.
'use strict';

const { ipcRenderer } = require('electron');
const path = require('node:path');
const { flatten, nextIndexForTurn } = require('../lib/steps');

// ─────────────────────────────── 상태

const state = {
  builds: [],
  tab: '공성전',
  buildId: null,
  picks: {}, // 변형 선택 (그룹 인덱스 → 변형 인덱스)
  steps: [], // 펼쳐진 단계 목록
  index: 0, // 현재 단계
  auto: false,
  region: null, // { displayId, fx, fy, fw, fh }
  lastTurn: null,
  pendingTurn: null, // 같은 값이 두 번 연속 읽혀야 반영 (오인식 방어)
};

const $ = (id) => document.getElementById(id);

// ─────────────────────────────── 빌드 목록

async function loadBuilds({ firstRun = false } = {}) {
  const r = await ipcRenderer.invoke('builds:load');
  if (!r.ok) {
    showEmpty(r.error, true);
    state.builds = [];
    renderTabs();
    return;
  }
  hideEmpty();
  state.builds = r.builds.filter((b) => b.stepCount > 0);
  renderTabs();

  if (!firstRun) {
    // 도감 갱신 재로드 — 전투 중일 수 있으니 선택·변형·진행 위치를 지키면서 데이터만 바꾼다
    const kept = currentBuild();
    if (kept) {
      state.steps = flatten(kept.groups, state.picks);
      state.index = Math.min(state.index, Math.max(0, state.steps.length - 1));
      state.lastTurn = null; // 다음 인식 때 다시 맞춘다
      state.pendingTurn = null;
      renderVariants();
      renderSteps();
      renderBuildList();
      return;
    }
    // 보던 빌드가 도감에서 사라진 경우만 처음처럼 다시 고른다
  }

  const config = await ipcRenderer.invoke('config:get');
  const remembered = config.lastBuildId
    ? state.builds.find((b) => b.id === config.lastBuildId)
    : null;
  if (remembered) {
    state.tab = remembered.category;
    renderTabs();
    selectBuild(remembered.id, { save: false });
  } else {
    renderBuildList();
  }

  if (!firstRun) return;
  if (config.ocrRegion) {
    state.region = config.ocrRegion;
    setOcrStatus('턴 위치 지정됨 — 자동을 켜면 인식 시작', '');
  }
  if (typeof config.opacity === 'number') {
    $('opacity').value = config.opacity;
    applyOpacity(config.opacity);
  }
}

function categories() {
  const seen = new Set();
  const order = [];
  for (const b of state.builds) {
    if (!seen.has(b.category)) {
      seen.add(b.category);
      order.push(b.category);
    }
  }
  return order;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  for (const cat of categories()) {
    const btn = document.createElement('button');
    btn.textContent = cat;
    btn.className = cat === state.tab ? 'on' : '';
    btn.onclick = () => {
      state.tab = cat;
      renderTabs();
      renderBuildList();
    };
    tabs.appendChild(btn);
  }
}

function visibleBuilds() {
  const q = $('search').value.trim().toLowerCase();
  return state.builds
    .filter((b) => b.category === state.tab)
    .filter((b) => !q || b.label.toLowerCase().includes(q) || b.name.toLowerCase().includes(q));
}

function renderBuildList() {
  const select = $('build-select');
  select.innerHTML = '';
  const list = visibleBuilds();
  for (const b of list) {
    const option = document.createElement('option');
    option.value = b.id;
    option.textContent = b.weekdays.length ? `[${b.weekdays.join('·')}] ${b.name}` : b.name;
    select.appendChild(option);
  }

  const inList = list.some((b) => b.id === state.buildId);
  if (inList) {
    select.value = state.buildId;
    return;
  }

  // 지금 보는 빌드가 검색어·탭 때문에 목록에서 빠졌을 뿐이면 그대로 둔다.
  // (한 글자 잘못 쳤다고 전투 중인 빌드가 바뀌면 안 된다)
  if (currentBuild()) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = `(보는 중: ${currentBuild().name})`;
    select.prepend(placeholder);
    return;
  }

  // 진짜로 사라졌으면 첫 번째로
  if (list.length > 0) {
    selectBuild(list[0].id, { save: false });
  } else {
    state.buildId = null;
    state.steps = [];
    renderSteps();
    renderVariants();
  }
}

function currentBuild() {
  return state.builds.find((b) => b.id === state.buildId) || null;
}

function selectBuild(id, { save = true } = {}) {
  state.buildId = id;
  state.picks = {};
  state.index = 0;
  state.lastTurn = null;
  state.pendingTurn = null;
  const build = currentBuild();
  if (build) {
    const select = $('build-select');
    if (select.value !== id) select.value = id;
    state.steps = flatten(build.groups, state.picks);
  } else {
    state.steps = [];
  }
  renderVariants();
  renderSteps();
  if (save) ipcRenderer.invoke('config:set', { lastBuildId: id });
}

// ─────────────────────────────── 변형(분기)

function renderVariants() {
  const wrap = $('variants');
  const build = currentBuild();
  wrap.innerHTML = '';
  const branched = build ? build.groups.filter((g) => g.variants.length > 1) : [];
  if (branched.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  build.groups.forEach((group, gi) => {
    if (group.variants.length < 2) return;
    group.variants.forEach((variant, vi) => {
      const btn = document.createElement('button');
      btn.textContent = variant.label;
      btn.className = (state.picks[gi] ?? 0) === vi ? 'on' : '';
      btn.onclick = () => {
        state.picks[gi] = vi;
        state.steps = flatten(build.groups, state.picks);
        state.index = Math.min(state.index, state.steps.length - 1);
        renderVariants();
        renderSteps();
      };
      wrap.appendChild(btn);
    });
  });
}

// ─────────────────────────────── 단계 표시 (3개씩)

function renderSteps() {
  const wrap = $('steps');
  wrap.innerHTML = '';
  if (state.steps.length === 0) {
    wrap.innerHTML = '<div style="color:#888;text-align:center;padding:16px">이 빌드에는 스킬 순서가 없어요</div>';
    return;
  }

  state.index = Math.max(0, Math.min(state.index, state.steps.length - 1));

  // 직전 1개(흐리게) + 현재 + 다음 2개 = "3개씩 넘어가는" 창
  const from = Math.max(0, state.index - 1);
  const view = state.steps.slice(from, state.index + 3);

  view.forEach((step, k) => {
    const i = from + k;
    const row = document.createElement('div');
    row.className = 'step' + (i < state.index ? ' done' : i === state.index ? ' now' : '');
    row.innerHTML =
      `<span class="turn">${step.turn}턴</span>` +
      `<span class="act"></span>` +
      `<span class="seg"></span>`;
    row.querySelector('.act').textContent = step.text;
    row.querySelector('.seg').textContent = step.label;
    row.onclick = () => {
      state.index = i;
      renderSteps();
    };
    wrap.appendChild(row);
  });

  const remain = state.steps.length - state.index - 1;
  if (remain > 2) {
    const more = document.createElement('div');
    more.style.cssText = 'text-align:center;color:#667;font-size:10px';
    more.textContent = `… 이후 ${remain - 2}단계`;
    wrap.appendChild(more);
  }
}

function nav(delta) {
  if (state.steps.length === 0) return;
  // 수동 이동은 자동 추적을 잠깐 끈다 (OCR이 곧바로 되돌리는 것 방지)
  if (state.auto && delta !== 0) {
    $('auto-toggle').checked = false;
    toggleAuto(false);
    setOcrStatus('수동 이동 — 자동을 다시 켜면 턴 추적 재개', '');
  }
  state.index = Math.max(0, Math.min(state.index + delta, state.steps.length - 1));
  renderSteps();
}

// ─────────────────────────────── 턴 OCR

let media = null; // MediaStream
let ocrTimer = null;
let workerPromise = null; // tesseract 워커 (자동 첫 시작 때 만든다)
let ocrBusy = false;
/** toggleAuto가 비동기라 겹칠 수 있다 — 세대 번호로 늦게 도착한 이전 호출을 무효화한다 */
let autoGen = 0;
/** 연속으로 숫자를 못 읽은 횟수 (사용자에게 알려주기 위해) */
let ocrMisses = 0;

function ensureWorker() {
  if (workerPromise) return workerPromise;
  setOcrStatus('인식 엔진 준비 중… (첫 실행은 다운로드 때문에 1분쯤 걸릴 수 있어요)', '');
  workerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    // 언어 데이터는 한 번 받으면 .cache에 저장되어 다음부터는 오프라인으로 뜬다
    const cachePath = path.join(__dirname, '..', '.cache');
    require('node:fs').mkdirSync(cachePath, { recursive: true });
    const w = await createWorker('eng', 1, { cachePath });
    await w.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7', // 한 줄
    });
    return w;
  })().catch((e) => {
    workerPromise = null; // 실패하면 다음에 다시 시도할 수 있게
    throw e;
  });
  return workerPromise;
}

async function startCapture() {
  if (!state.region) throw new Error('턴 위치를 먼저 지정해주세요');
  const sourceId = await ipcRenderer.invoke('capture:source-for-display', state.region.displayId);
  if (!sourceId) {
    throw new Error('영역을 지정했던 모니터를 찾지 못했어요 — 턴 위치를 다시 지정해주세요');
  }

  stopStream(); // 이전 스트림이 남아 있으면 정리하고 시작
  media = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 5,
      },
    },
  });
  const video = $('cap');
  video.srcObject = media;
  await video.play();
}

function stopStream() {
  if (media) {
    for (const track of media.getTracks()) track.stop();
    media = null;
  }
  $('cap').srcObject = null;
}

function stopCapture() {
  if (ocrTimer) {
    clearInterval(ocrTimer);
    ocrTimer = null;
  }
  stopStream();
}

/** 지정 영역을 잘라 확대 + 흑백 대비 강화 (게임 폰트 인식률을 올린다) */
function cropFrame() {
  const video = $('cap');
  if (!video.videoWidth) return null;
  const { fx, fy, fw, fh } = state.region;
  const sx = fx * video.videoWidth;
  const sy = fy * video.videoHeight;
  const sw = Math.max(4, fw * video.videoWidth);
  const sh = Math.max(4, fh * video.videoHeight);

  const scale = Math.max(2, Math.min(6, 96 / sh)); // 글자 높이를 96px 근처로
  const canvas = $('crop');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // 흑백 + 임계값 — 밝은 글자/어두운 글자 어느 쪽이든 살아남게 두 단계로
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  const mean = sum / (d.length / 4);
  const invert = mean > 128; // 배경이 밝으면 글자가 어두운 쪽
  for (let i = 0; i < d.length; i += 4) {
    let v = d[i];
    if (invert) v = 255 - v;
    v = v > 96 ? 255 : 0; // 흰 글자 / 검은 배경으로 통일
    d[i] = d[i + 1] = d[i + 2] = 255 - v; // tesseract는 검은 글자를 좋아한다
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function ocrTick() {
  if (ocrBusy || !state.auto) return;
  const canvas = cropFrame();
  if (!canvas) return;
  ocrBusy = true;
  const gen = autoGen;
  try {
    const w = await ensureWorker();
    const { data } = await w.recognize(canvas.toDataURL('image/png'));
    // 기다리는 동안 자동이 꺼졌거나(수동 이동) 영역이 바뀌었으면 결과를 버린다
    if (!state.auto || gen !== autoGen) return;
    const m = String(data.text || '').match(/\d{1,3}/);
    if (m) {
      ocrMisses = 0;
      applyRecognizedTurn(Number(m[0]));
    } else {
      ocrMisses += 1;
      if (ocrMisses === 8) {
        // 5초 넘게 아무 숫자도 못 읽었다 — 엉뚱한 곳을 보고 있을 가능성이 크다
        setOcrStatus('숫자를 못 읽고 있어요 — 턴 위치를 다시 지정해보세요', 'err');
      }
    }
  } catch (e) {
    if (state.auto && gen === autoGen) setOcrStatus(`인식 오류: ${e.message}`, 'err');
  } finally {
    ocrBusy = false;
  }
}

function applyRecognizedTurn(t) {
  if (!state.auto) return;
  if (t < 0 || t > 999) return;
  // 오인식 방어 — 같은 값이 두 번 연속으로 읽혀야 반영
  if (state.pendingTurn !== t) {
    state.pendingTurn = t;
    return;
  }
  if (state.lastTurn === t) return;
  state.lastTurn = t;
  $('turn-badge').textContent = `턴 ${t}`;
  setOcrStatus(`인식 중 — ${t}턴`, 'on');

  const next = nextIndexForTurn(state.steps, state.index, t);
  if (next !== state.index) {
    state.index = next;
    renderSteps();
  }
}

async function toggleAuto(on) {
  const gen = ++autoGen; // 이전에 걸려 있던 toggleAuto 호출을 전부 무효화
  state.auto = on;
  if (!on) {
    stopCapture();
    if (state.region) setOcrStatus('자동 꺼짐', '');
    return;
  }
  try {
    await ensureWorker();
    if (gen !== autoGen || !state.auto) return; // 기다리는 동안 상태가 바뀌었다
    await startCapture();
    if (gen !== autoGen || !state.auto) {
      stopStream(); // 이 호출이 만든 스트림은 이 호출이 치운다
      return;
    }
    state.pendingTurn = null;
    state.lastTurn = null;
    ocrMisses = 0;
    if (ocrTimer) clearInterval(ocrTimer);
    ocrTimer = setInterval(ocrTick, 700);
    setOcrStatus('인식 중…', 'on');
  } catch (e) {
    if (gen !== autoGen) return;
    state.auto = false;
    $('auto-toggle').checked = false;
    stopCapture();
    setOcrStatus(e.message, 'err');
  }
}

function setOcrStatus(text, cls) {
  const el = $('ocr-status');
  el.textContent = text;
  el.className = cls || '';
}

// ─────────────────────────────── 빈 상태 / 이벤트 배선

function showEmpty(message, withPicker) {
  const el = $('empty');
  el.classList.remove('hidden');
  el.innerHTML = '';
  const p = document.createElement('div');
  p.textContent = message;
  el.appendChild(p);
  if (withPicker) {
    const btn = document.createElement('button');
    btn.textContent = 'builds.json 직접 선택';
    btn.onclick = async () => {
      const r = await ipcRenderer.invoke('builds:pick-file');
      if (r && r.ok) loadBuilds();
    };
    el.appendChild(btn);
  }
}

function hideEmpty() {
  $('empty').classList.add('hidden');
}

function applyOpacity(v) {
  document.documentElement.style.setProperty('--bg-alpha', String(v / 100));
}

$('build-select').addEventListener('change', (e) => selectBuild(e.target.value));
$('search').addEventListener('input', renderBuildList);
$('btn-prev').addEventListener('click', () => nav(-1));
$('btn-next').addEventListener('click', () => nav(1));
$('btn-region').addEventListener('click', () => ipcRenderer.invoke('picker:open'));
$('auto-toggle').addEventListener('change', (e) => toggleAuto(e.target.checked));
$('opacity').addEventListener('input', (e) => {
  applyOpacity(Number(e.target.value));
  ipcRenderer.invoke('config:set', { opacity: Number(e.target.value) });
});
$('btn-close').addEventListener('click', () => window.close());
$('btn-min').addEventListener('click', () => {
  const collapsed = $('body').classList.toggle('collapsed');
  $('btn-min').textContent = collapsed ? '▸' : '▾';
  // CSS만 숨기면 투명한 창이 그대로 게임 클릭을 막는다 — 창 자체를 제목줄 높이로 줄인다
  ipcRenderer.send('overlay:collapse', collapsed);
});

ipcRenderer.on('step:nav', (_e, delta) => nav(delta));
ipcRenderer.on('builds:updated', () => loadBuilds());
ipcRenderer.on('ocr:region', async (_e, region) => {
  state.region = region;
  setOcrStatus('턴 위치 지정됨 — 자동을 켜면 인식 시작', '');
  if (state.auto) {
    // 영역이 바뀌었으니 캡처를 다시 시작 (세대 번호가 이전 재시작과의 경쟁을 정리한다)
    await toggleAuto(false);
    $('auto-toggle').checked = true;
    await toggleAuto(true);
  }
});
ipcRenderer.on('overlay:click-through', (_e, on) => {
  $('lock-hint').classList.toggle('hidden', !on);
});
ipcRenderer.on('shortcuts:failed', (_e, combos) => {
  setOcrStatus(`⚠️ 단축키 사용 불가: ${combos.join(', ')} (다른 프로그램이 사용 중)`, 'err');
});

// 창을 닫을 때 캡처 스트림과 인식 워커를 정리한다
window.addEventListener('beforeunload', () => {
  stopCapture();
  if (workerPromise) {
    workerPromise.then((w) => w.terminate()).catch(() => {});
    workerPromise = null;
  }
});

loadBuilds({ firstRun: true });
