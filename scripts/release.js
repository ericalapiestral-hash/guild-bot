// 배포용 파일 모으기 — release/ 하나만 보면 최신본이 있게 한다.
//
//   npm run release                 exe를 새로 만들고, APK는 찾아서 같이 넣는다
//   npm run release -- --apk <경로> APK 위치를 직접 지정
//   npm run release -- --skip-exe   exe는 그대로 두고 APK만 갱신
//
// 갱신할 때마다 release/를 비우고 다시 채운다. 파일 이름은 항상 같아서
// "받아 둔 exe가 어느 버전이지?"가 안 생긴다 — 대신 버전.txt에 커밋을 적어 둔다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const OVERLAY = path.join(ROOT, 'overlay');
const EXE_NAME = 'guild-overlay-pc.exe';
const APK_NAME = 'guild-overlay-android.apk';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? true;
};
const skipExe = args.includes('--skip-exe');

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

/**
 * 지울 수 있는 것부터 지운다 — 백신이 갓 만든 파일을 붙들고 있어도 나머지는 치운다.
 * @param keep 이름이 여기 있으면 남긴다 (--skip-exe로 기존 exe를 지키는 용도)
 */
function sweep(dir, keep = []) {
  if (!fs.existsSync(dir)) return [];
  const locked = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (keep.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      locked.push(...sweep(full));
      try {
        fs.rmdirSync(full);
      } catch {
        /* 안에 잠긴 게 남았다 */
      }
    } else {
      try {
        fs.unlinkSync(full);
      } catch {
        locked.push(full);
      }
    }
  }
  return locked;
}

/** overlay/dist가 잠겨 있으면 그 옆에 비어 있는 이름을 찾는다 */
function pickBuildDir() {
  sweep(path.join(OVERLAY, 'dist'));
  try {
    fs.rmdirSync(path.join(OVERLAY, 'dist'));
  } catch {
    /* 남아 있으면 아래에서 다른 이름을 고른다 */
  }
  if (!fs.existsSync(path.join(OVERLAY, 'dist'))) return 'dist';
  for (let i = 2; i < 100; i += 1) {
    const name = `dist${i}`;
    if (!fs.existsSync(path.join(OVERLAY, name))) return name;
  }
  throw new Error('overlay/ 안에 빌드할 자리가 없습니다. npm run clean 을 먼저 돌려주세요.');
}

/** 앱에서 만든 exe 경로 */
function buildExe() {
  const outDir = pickBuildDir();
  console.log(`\n[1/3] PC exe 빌드 (overlay/${outDir})…`);

  // npx/electron-builder.cmd를 부르지 않는다 — Node 24부터 윈도우에서 .cmd 실행이 막혔다.
  // 패키지가 알려주는 JS 진입점을 node로 직접 돌린다.
  const builderDir = path.join(OVERLAY, 'node_modules', 'electron-builder');
  const bin = require(path.join(builderDir, 'package.json')).bin['electron-builder'];
  execFileSync(
    process.execPath,
    [path.join(builderDir, bin), '--win', `-c.directories.output=${outDir}`],
    { cwd: OVERLAY, stdio: 'inherit' },
  );
  const dir = path.join(OVERLAY, outDir);
  const exe = fs.readdirSync(dir).find((n) => n.endsWith('.exe'));
  if (!exe) throw new Error(`${outDir}에 exe가 안 나왔습니다.`);
  return path.join(dir, exe);
}

/**
 * APK 찾기 — CI에서만 만들어지므로 받아 둔 파일을 집어 온다.
 * 지정 → release-src/ → 다운로드 폴더에서 가장 최근 것 순.
 */
function findApk() {
  const given = flag('--apk');
  if (typeof given === 'string') {
    if (!fs.existsSync(given)) throw new Error(`APK를 못 찾았습니다: ${given}`);
    return given;
  }

  const candidates = [];
  for (const dir of [path.join(ROOT, 'release-src'), path.join(os.homedir(), 'Downloads')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.apk')) continue;
      const full = path.join(dir, name);
      try {
        candidates.push({ full, at: fs.statSync(full).mtimeMs });
      } catch {
        /* 무시 */
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0].full;
}

/**
 * CI가 릴리스에 올려 둔 최신 APK. 로그인 없이 받을 수 있는 고정 주소다.
 * (exe는 도감 스냅샷이 들어 있어 릴리스에 올리지 않는다 — APK만 있다)
 */
const APK_URL =
  'https://github.com/ericalapiestral-hash/guild-bot/releases/latest/download/guild-overlay-android.apk';

async function downloadApk(dest) {
  const res = await fetch(APK_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1024) throw new Error('받은 파일이 너무 작습니다');
  fs.writeFileSync(dest, bytes);
  return bytes.length;
}

/** 지정 → 릴리스에서 내려받기 → 받아 둔 파일 순으로 APK를 구한다 */
async function resolveApk(dest) {
  const given = flag('--apk');
  if (typeof given === 'string') {
    if (!fs.existsSync(given)) throw new Error(`APK를 못 찾았습니다: ${given}`);
    fs.copyFileSync(given, dest);
    return given;
  }

  if (!args.includes('--no-download')) {
    console.log('  최신 APK 내려받는 중…');
    try {
      const size = await downloadApk(dest);
      console.log(`  ✓ 릴리스에서 받음 (${mb(size)})`);
      return APK_URL;
    } catch (e) {
      console.log(`  △ 내려받기 실패 (${e.message}) — 받아 둔 파일을 찾아봅니다`);
    }
  }

  const local = findApk();
  if (!local) return null;
  fs.copyFileSync(local, dest);
  console.log(`  ✓ ${local}`);
  return local;
}

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const subject = execSync('git log -1 --pretty=%s', { cwd: ROOT }).toString().trim();
    return { hash, subject };
  } catch {
    return { hash: '(git 정보 없음)', subject: '' };
  }
}

// ─────────────────────────────── 진행

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log('[0/3] release/ 비우는 중…');
  const locked = sweep(OUT, skipExe ? [EXE_NAME] : []);
  if (locked.length > 0) {
    console.log(`  △ ${locked.length}개가 잠겨 있습니다 (백신 검사 중이거나 실행 중):`);
    for (const f of locked) console.log(`    ${path.relative(ROOT, f)}`);
    console.log('  덮어쓰기를 시도합니다.');
  }

  const placed = [];

  if (skipExe) {
    console.log('\n[1/3] exe 빌드 건너뜀 (--skip-exe) — 이미 있는 건 그대로 둡니다');
    const kept = path.join(OUT, EXE_NAME);
    if (fs.existsSync(kept)) {
      placed.push({ name: EXE_NAME, size: fs.statSync(kept).size });
    }
  } else {
    const exe = buildExe();
    const dest = path.join(OUT, EXE_NAME);
    fs.copyFileSync(exe, dest);
    placed.push({ name: EXE_NAME, size: fs.statSync(dest).size });
  }

  console.log('\n[2/3] APK 챙기는 중…');
  const apkDest = path.join(OUT, APK_NAME);
  const apkFrom = await resolveApk(apkDest);
  if (apkFrom) {
    placed.push({ name: APK_NAME, size: fs.statSync(apkDest).size });
  } else {
    console.log(
      '  △ APK를 못 구했습니다.\n' +
        '    Actions → "안드로이드 APK 빌드"가 한 번 돌아야 릴리스에 올라갑니다.\n' +
        '    받아 둔 apk가 있으면 다운로드 폴더나 release-src/ 에 두고 다시 실행하세요.\n' +
        '    (또는  npm run release -- --apk "경로")',
    );
  }

  console.log('\n[3/3] 버전 기록…');
  writeNotes(placed);

  console.log('\n─────────────────────────────');
  console.log(`release/ 준비 완료 (${gitInfo().hash})`);
  for (const p of placed) console.log(`  ${p.name.padEnd(28)} ${mb(p.size)}`);
  if (placed.length === 0) console.log('  (넣은 게 없습니다)');
  console.log(`\n${OUT}`);
}

function writeNotes(placed) {
  const { hash, subject } = gitInfo();
  const stamp = new Date().toLocaleString('ko-KR');
  const notes = [
    '길드 빌드 오버레이',
    '',
    `만든 때 : ${stamp}`,
    `커밋    : ${hash}`,
    subject ? `내용    : ${subject}` : null,
    '',
    ...placed.map((p) => `${p.name}  ${mb(p.size)}`),
    placed.length === 2 ? null : '(둘 중 하나만 들어 있습니다)',
    '',
    'PC  : exe를 그냥 실행하면 됩니다. 설치 필요 없음.',
    '      도감을 바꾸려면 exe 옆에 data/builds.json 을 두세요.',
    '      ※ 이 exe 안에는 길드 도감이 들어 있습니다. 길드 밖으로 돌리지 마세요.',
    '폰  : apk를 옮겨 설치. "출처를 알 수 없는 앱" 허용이 한 번 필요합니다.',
    '      apk에는 도감이 안 들어 있어 앱에서 따로 불러와야 합니다.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  fs.writeFileSync(path.join(OUT, '버전.txt'), `${notes}\n`, 'utf8');
}

main().catch((e) => {
  console.error(`\n실패: ${e.message}`);
  process.exitCode = 1;
});
