// 빌드 산출물(dist*) 정리.
//   npm run clean                 dist로 시작하는 폴더를 전부 지운다
//   npm run clean -- --keep dist4 그중 하나는 남긴다
//
// 파일을 하나씩 지운다. 백신이 갓 만든 app.asar를 붙들고 있으면 통째로 지우는 명령은
// 그 하나 때문에 전부 실패하는데, 이렇게 하면 나머지는 지우고 남은 것만 알려줄 수 있다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const keep = new Set();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--keep' && args[i + 1]) keep.add(args[i + 1].replace(/[\\/]+$/, ''));
}

/** 폴더를 훑으며 지울 수 있는 것부터 지운다 */
function sweep(dir) {
  let freed = 0;
  const locked = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = sweep(full);
      freed += inner.freed;
      locked.push(...inner.locked);
      try {
        fs.rmdirSync(full);
      } catch {
        /* 안에 잠긴 게 남아 있다 — 위에서 이미 세었다 */
      }
    } else {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* 크기를 못 재도 지우기는 해본다 */
      }
      try {
        fs.unlinkSync(full);
        freed += size;
      } catch {
        locked.push(full);
      }
    }
  }
  return { freed, locked };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MB`;

const targets = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith('dist') && !keep.has(e.name))
  .map((e) => e.name);

if (targets.length === 0) {
  console.log('지울 게 없습니다.');
  process.exit(0);
}

let freedTotal = 0;
const lockedAll = [];

for (const name of targets) {
  const dir = path.join(__dirname, name);
  const { freed, locked } = sweep(dir);
  freedTotal += freed;
  lockedAll.push(...locked);

  let gone = false;
  try {
    fs.rmdirSync(dir);
    gone = true;
  } catch {
    /* 잠긴 파일이 남았다 */
  }
  console.log(
    gone ? `  ✓ ${name} (${mb(freed)})` : `  △ ${name} — ${locked.length}개 잠겨서 남음`,
  );
}

console.log(`\n${mb(freedTotal)} 확보`);

if (keep.size > 0) console.log(`남긴 폴더: ${[...keep].join(', ')}`);

if (lockedAll.length > 0) {
  console.log(`\n잠겨서 못 지운 파일 ${lockedAll.length}개:`);
  for (const f of lockedAll.slice(0, 10)) console.log(`  ${path.relative(__dirname, f)}`);
  if (lockedAll.length > 10) console.log(`  … 외 ${lockedAll.length - 10}개`);
  console.log(
    '\n오버레이가 실행 중이면 끄고 다시 해보세요.\n' +
      '그래도 남으면 백신이 검사 중인 겁니다 — 잠시 뒤나 재부팅 후에 다시 실행하면 지워집니다.',
  );
}
