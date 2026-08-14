// 길드 오버레이 — 메인 프로세스.
// 투명 항상-위 창, 전역 단축키, 화면 캡처 소스, 설정 저장을 담당한다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
} = require('electron');
const { parseSteps, groupVariants } = require('./lib/steps');

const SELFTEST = process.argv.includes('--selftest');

const CONFIG_PATH = path.join(app.getPath('userData'), 'overlay-config.json');
/** 봇이 만들어 두는 도감 캐시 (오버레이는 이걸 그대로 읽는다) */
const DEFAULT_BUILDS = path.join(__dirname, '..', 'data', 'builds.json');

let overlayWin = null;
let pickerWin = null;
let clickThrough = false;
let watcher = null;
let shortcutFailures = [];
/** 접기 전의 창 높이 (펼칠 때 복원) */
let expandedHeight = null;

// ─────────────────────────────── 설정

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.warn('[설정] 저장 실패:', e.message);
  }
  return next;
}

// ─────────────────────────────── 도감 읽기

function buildsPath() {
  return loadConfig().buildsPath || DEFAULT_BUILDS;
}

/** builds.json → 오버레이용으로 미리 파싱해서 내려준다 */
function loadBuilds() {
  const file = buildsPath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      file,
      error:
        '도감 파일(builds.json)을 읽지 못했어요. 길드봇 폴더에서 npm run notion:dump 를 한 번 실행하거나, 파일을 직접 골라주세요.',
    };
  }
  if (!raw || !Array.isArray(raw.builds)) {
    return { ok: false, file, error: '도감 파일 형식이 예상과 달라요.' };
  }

  const builds = raw.builds
    .filter((b) => b && typeof b.name === 'string' && typeof b.body === 'string')
    .map((b, i) => {
      const { segments } = parseSteps(b.body);
      const groups = groupVariants(segments);
      return {
        id: b.id || `#${i}`,
        name: b.name,
        label: b.label || b.name,
        category: b.category || (String(b.group || '').includes('구사황') ? '구사황' : '기타'),
        group: b.group || '',
        weekdays: Array.isArray(b.weekdays) ? b.weekdays : [],
        groups,
        stepCount: groups.reduce((n, g) => n + g.variants[0].steps.length, 0),
      };
    });

  return { ok: true, file, syncedAt: raw.syncedAt || null, builds };
}

let watchDebounce = null;

function watchBuilds() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  const file = buildsPath();
  try {
    watcher = fs.watch(path.dirname(file), (event, name) => {
      if (name !== path.basename(file)) return;
      // 봇이 tmp에 쓰고 rename으로 교체하면 이벤트가 두 번 온다 — 한 번으로 모은다
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('builds:updated');
        }
      }, 300);
    });
    // 감시 중인 폴더가 지워지면 비동기 error가 나는데, 핸들러가 없으면 프로세스가 통째로 죽는다
    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {
        /* 무시 */
      }
      watcher = null;
    });
  } catch {
    /* 폴더가 없으면 감시 생략 */
  }
}

// ─────────────────────────────── 창

/** 저장된 창 위치가 지금 연결된 모니터 안에 있는지 — 아니면 무시하고 기본 위치로 */
function visibleBounds(bounds) {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  const rect = { x: bounds.x, y: bounds.y, width: bounds.width || 380, height: bounds.height || 560 };
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      rect.x < a.x + a.width - 40 &&
      rect.x + rect.width > a.x + 40 &&
      rect.y < a.y + a.height - 40 &&
      rect.y + rect.height > a.y + 40
    );
  });
  return onScreen ? rect : null;
}

function createOverlay() {
  const config = loadConfig();
  const saved = config.winBounds || {};
  // 모니터를 분리했거나 해상도가 바뀌었으면 저장된 좌표가 화면 밖일 수 있다.
  // 이 창은 작업표시줄에도 Alt+Tab에도 없어서, 밖에 생기면 되찾을 방법이 없다.
  const pos = visibleBounds(saved);

  overlayWin = new BrowserWindow({
    width: saved.width || 380,
    height: saved.height || 560,
    x: pos ? pos.x : undefined,
    y: pos ? pos.y : undefined,
    minWidth: 280,
    minHeight: 320,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      // 로컬 전용 도구라 단순함을 우선한다 (원격 콘텐츠를 절대 싣지 말 것)
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  const remember = () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const bounds = overlayWin.getBounds();
    // 접힌 상태(높이 36)를 저장하면 다음에 켤 때 쪼그라든 채로 뜬다 — 펼친 높이로 기억
    if (expandedHeight) bounds.height = expandedHeight;
    saveConfig({ winBounds: bounds });
  };
  overlayWin.on('moved', remember);
  overlayWin.on('resized', remember);
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function setClickThrough(v) {
  clickThrough = v;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.setIgnoreMouseEvents(v, { forward: true });
  overlayWin.webContents.send('overlay:click-through', v);
}

// ─────────────────────────────── OCR 영역 선택

function openPicker() {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.focus();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  pickerWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    fullscreen: false, // bounds로 이미 화면을 덮는다 (fullscreen은 다중 모니터에서 엉킴)
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  pickerWin.setAlwaysOnTop(true, 'screen-saver');
  pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  pickerWin.webContents.once('did-finish-load', () => {
    pickerWin.webContents.send('picker:init', { displayId: display.id });
  });
  pickerWin.on('closed', () => {
    pickerWin = null;
  });
}

// ─────────────────────────────── IPC

ipcMain.handle('builds:load', () => loadBuilds());

ipcMain.handle('builds:pick-file', async () => {
  const r = await dialog.showOpenDialog({
    title: '도감 파일(builds.json) 선택',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  saveConfig({ buildsPath: r.filePaths[0] });
  watchBuilds();
  return loadBuilds();
});

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, patch) => saveConfig(patch));

ipcMain.handle('picker:open', () => openPicker());

ipcMain.on('picker:done', (_e, region) => {
  // region: { displayId, fx, fy, fw, fh } — 화면 대비 비율(0~1)이라 해상도가 바뀌어도 안전
  saveConfig({ ocrRegion: region });
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('ocr:region', region);
  }
});

ipcMain.on('picker:cancel', () => {
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
});

/** OCR 캡처에 쓸 화면 소스 ID — 영역을 고른 디스플레이와 짝을 맞춘다 */
ipcMain.handle('capture:source-for-display', async (_e, displayId) => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const match = sources.find((s) => String(s.display_id) === String(displayId));
  if (match) return match.id;
  // 모니터가 하나뿐이면 display_id가 비는 환경이 있어 첫 소스로 폴백해도 안전하다.
  // 여러 개인데 못 찾은 거면 엉뚱한 모니터를 조용히 읽게 되므로 오류를 내보낸다.
  if (sources.length === 1) return sources[0].id;
  return null;
});

ipcMain.on('overlay:set-click-through', (_e, v) => {
  // 해제 단축키(Ctrl+Alt+L)가 등록 안 된 상태에서 켜면 영영 못 끄게 된다
  if (v && shortcutFailures.includes('Control+Alt+L')) {
    overlayWin?.webContents.send(
      'shortcuts:failed',
      shortcutFailures.concat(['(클릭 통과를 켤 수 없어요 — 해제 단축키가 막혀 있음)']),
    );
    return;
  }
  setClickThrough(Boolean(v));
});

/** 접기/펼치기 — CSS만 숨기면 투명해도 창 전체가 클릭을 막아서, 창 자체를 줄인다 */
ipcMain.on('overlay:collapse', (_e, collapsed) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const bounds = overlayWin.getBounds();
  if (collapsed) {
    expandedHeight = bounds.height;
    overlayWin.setMinimumSize(280, 36);
    overlayWin.setBounds({ ...bounds, height: 36 });
  } else {
    overlayWin.setMinimumSize(280, 320);
    overlayWin.setBounds({ ...bounds, height: expandedHeight || 560 });
    expandedHeight = null;
  }
});

// ─────────────────────────────── 시작

// 게임 위에 뜨는 도구라 GPU 가속 문제로 투명창이 검게 나오는 기기가 있다
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  if (SELFTEST) {
    const r = loadBuilds();
    if (!r.ok) {
      console.log('[selftest] 도감 읽기 실패:', r.error);
      app.exit(1);
      return;
    }
    const withSteps = r.builds.filter((b) => b.stepCount > 0);
    console.log(`[selftest] 빌드 ${r.builds.length}개 · 스킬순서 있는 빌드 ${withSteps.length}개`);
    for (const b of withSteps.slice(0, 5)) {
      console.log(
        `[selftest]   ${b.category} | ${b.name} — 그룹 ${b.groups.length}개, 단계 ${b.stepCount}개`,
      );
    }
    app.exit(0);
    return;
  }

  createOverlay();
  watchBuilds();

  // 전역 단축키 — 게임에 포커스가 있어도 동작한다.
  // 다른 프로그램이 선점하면 register가 조용히 false를 돌려주므로 확인해서 알려준다.
  const shortcuts = [
    ['Control+Alt+O', () => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (overlayWin.isVisible()) overlayWin.hide();
      else overlayWin.show();
    }],
    ['Control+Alt+L', () => setClickThrough(!clickThrough)],
    ['Control+Alt+R', () => openPicker()],
    ['Control+Alt+Right', () => overlayWin?.webContents.send('step:nav', 1)],
    ['Control+Alt+Left', () => overlayWin?.webContents.send('step:nav', -1)],
  ];
  const failed = [];
  for (const [combo, handler] of shortcuts) {
    if (!globalShortcut.register(combo, handler)) failed.push(combo);
  }
  if (failed.length > 0) {
    console.warn(`[단축키] 다른 프로그램이 사용 중이라 등록 실패: ${failed.join(', ')}`);
    shortcutFailures = failed;
    overlayWin?.webContents.once('did-finish-load', () => {
      overlayWin?.webContents.send('shortcuts:failed', failed);
    });
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
