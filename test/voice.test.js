// 음성 체류시간 집계 점검. 실제 기록 파일은 건드리지 않는다.
//   node test/voice.test.js
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), `guildbot-voice-test-${process.pid}.json`);
process.env.VOICE_DATA_PATH = TMP;

const voice = require('../src/voiceTime');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 2026-08-05(수) 12:00 KST = 2026-08-05T03:00:00Z
const WED = Date.parse('2026-08-05T03:00:00Z');

test('한국시간 기준 그 주 월요일을 주 키로 쓴다', () => {
  assert.strictEqual(voice.weekKey(WED), '2026-08-03'); // 그 주 월요일
  assert.strictEqual(voice.weekKey(WED + 2 * DAY), '2026-08-03'); // 같은 주 금요일
  assert.strictEqual(voice.weekKey(WED + 5 * DAY), '2026-08-10'); // 다음 주 월요일
});

test('한국시간 월요일 0시 직전·직후가 다른 주로 갈린다', () => {
  const mondayMidnightKst = Date.parse('2026-08-10T00:00:00+09:00');
  assert.strictEqual(voice.weekKey(mondayMidnightKst - 1000), '2026-08-03');
  assert.strictEqual(voice.weekKey(mondayMidnightKst), '2026-08-10');
});

test('통화 시간을 주간·전체에 함께 쌓는다', () => {
  voice.begin('u1', 'c1', WED);
  const ms = voice.end('u1', WED + 90 * MIN);
  assert.strictEqual(ms, 90 * MIN);

  const t = voice.timeOf('u1', WED + 2 * HOUR);
  assert.strictEqual(t.week, 90 * MIN);
  assert.strictEqual(t.total, 90 * MIN);
  assert.strictEqual(t.ongoing, 0);
});

test('같은 주에 여러 번 하면 합산된다', () => {
  voice.begin('u1', 'c1', WED + 3 * HOUR);
  voice.end('u1', WED + 4 * HOUR);

  const t = voice.timeOf('u1', WED + 5 * HOUR);
  assert.strictEqual(t.week, 150 * MIN);
  assert.strictEqual(t.total, 150 * MIN);
});

test('주가 바뀌면 주간만 초기화되고 전체 누적은 남는다', () => {
  const nextWeek = WED + 7 * DAY;
  const t = voice.timeOf('u1', nextWeek);
  assert.strictEqual(t.week, 0, '주간이 초기화되지 않음');
  assert.strictEqual(t.total, 150 * MIN, '전체 누적이 사라짐');

  voice.begin('u1', 'c1', nextWeek);
  voice.end('u1', nextWeek + 20 * MIN);
  const after = voice.timeOf('u1', nextWeek + HOUR);
  assert.strictEqual(after.week, 20 * MIN);
  assert.strictEqual(after.total, 170 * MIN);
});

test('통화 중이면 실시간 시간이 더해진다', () => {
  const at = WED + 8 * DAY;
  voice.begin('u2', 'c1', at);
  const t = voice.timeOf('u2', at + 25 * MIN);
  assert.strictEqual(t.ongoing, 25 * MIN);
  assert.strictEqual(t.week, 25 * MIN);
  assert.ok(voice.isActive('u2'));
  voice.end('u2', at + 25 * MIN);
  assert.ok(!voice.isActive('u2'));
});

test('시작 기록 없이 끝나면 0 (봇 재시작 등)', () => {
  assert.strictEqual(voice.end('없는사람'), 0);
});

test('1초 미만은 버린다', () => {
  const at = WED + 9 * DAY;
  voice.begin('u3', 'c1', at);
  voice.end('u3', at + 300);
  assert.strictEqual(voice.timeOf('u3', at + HOUR).total, 0);
});

test('순위는 시간 내림차순이고 통화 중도 포함된다', () => {
  const at = WED + 10 * DAY;
  voice.begin('a', 'c1', at);
  voice.end('a', at + 10 * MIN);
  voice.begin('b', 'c1', at);
  voice.end('b', at + 30 * MIN);
  voice.begin('c', 'c1', at); // 아직 통화 중

  // 다른 테스트에서 만든 사람이 같은 주에 섞이므로 이 셋만 추려서 본다
  const rows = voice.ranking('week', at + 50 * MIN);
  const top = rows.filter((r) => ['a', 'b', 'c'].includes(r.userId)).map((r) => r.userId);
  assert.deepStrictEqual(top, ['c', 'b', 'a'], `순서가 ${top.join('>')} (c 50분 > b 30분 > a 10분)`);
  assert.ok(rows.find((r) => r.userId === 'c').ongoing > 0, '통화 중인 사람이 순위에 안 잡힘');

  voice.end('c', at + 50 * MIN);
});

test('전체 누적 순위는 지난 주 기록도 센다', () => {
  const rows = voice.ranking('total', WED + 10 * DAY);
  const u1 = rows.find((r) => r.userId === 'u1');
  assert.ok(u1, 'u1이 전체 순위에 없음');
  assert.strictEqual(u1.ms, 170 * MIN);
});

test('시간 표기', () => {
  assert.strictEqual(voice.formatDuration(90 * MIN), '1시간 30분');
  assert.strictEqual(voice.formatDuration(5 * MIN + 3000), '5분 3초');
  assert.strictEqual(voice.formatDuration(42 * 1000), '42초');
  assert.strictEqual(voice.formatDuration(0), '0초');
  assert.strictEqual(voice.formatDuration(-5), '0초');
});

test('flushAll이 진행 중인 통화를 적립하고 파일로 저장한다', () => {
  const at = WED + 11 * DAY;
  voice.begin('u9', 'c1', at);
  voice.flushAll(at + 15 * MIN);

  assert.ok(!voice.isActive('u9'));
  assert.ok(fs.existsSync(TMP), '기록 파일이 만들어지지 않음');
  const saved = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.ok(saved.users.u9, '저장된 기록에 u9이 없음');
  assert.strictEqual(saved.users.u9.total, 15 * MIN);
});

try {
  fs.rmSync(TMP, { force: true });
} catch {
  /* 무시 */
}

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
