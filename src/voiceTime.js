// 음성방 체류시간 집계.
// 진행 중인 통화는 메모리에, 누적 시간은 data/voice.json에 저장한다.
// 주간 기록은 한국시간 월요일 0시 기준으로 자동 초기화된다(조회·적립 시점에 지연 초기화).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 테스트에서 실제 기록을 건드리지 않도록 경로를 바꿔 끼울 수 있게 해둔다
const DATA_PATH =
  process.env.VOICE_DATA_PATH || path.join(__dirname, '..', 'data', 'voice.json');

/** 디스크 쓰기를 몰아서 한다 (음성 이동이 잦아도 파일을 계속 두드리지 않게) */
const FLUSH_DELAY_MS = 5000;

/** 진행 중인 통화: userId → { channelId, since } */
const sessions = new Map();

let data = null;
let flushTimer = null;
let dirty = false;

/** 한국시간 기준 그 주 월요일 날짜 (YYYY-MM-DD) — 주간 기록의 키 */
function weekKey(at = Date.now()) {
  const kst = new Date(at + 9 * 60 * 60 * 1000);
  const dayFromMonday = (kst.getUTCDay() + 6) % 7;
  kst.setUTCDate(kst.getUTCDate() - dayFromMonday);
  return kst.toISOString().slice(0, 10);
}

function load() {
  if (data) return data;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    data = raw && typeof raw.users === 'object' && raw.users ? raw : { users: {} };
  } catch {
    data = { users: {} };
  }
  return data;
}

function flushNow() {
  if (!dirty || !data) return;
  const tmp = `${DATA_PATH}.tmp`;
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, DATA_PATH);
    dirty = false;
  } catch (e) {
    console.warn(`[음성] 기록 저장 실패: ${e.message}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 무시 */
    }
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

/** 그 사람의 기록을 꺼낸다. 주가 바뀌었으면 주간 기록을 0으로 되돌린다. */
function entryOf(userId, at = Date.now()) {
  const store = load();
  const key = weekKey(at);
  let e = store.users[userId];
  if (!e || typeof e !== 'object') {
    e = { total: 0, week: 0, weekKey: key, lastSeen: null };
    store.users[userId] = e;
  }
  if (e.weekKey !== key) {
    e.week = 0;
    e.weekKey = key;
  }
  if (typeof e.total !== 'number' || !Number.isFinite(e.total)) e.total = 0;
  if (typeof e.week !== 'number' || !Number.isFinite(e.week)) e.week = 0;
  return e;
}

/** 통화 시작 */
function begin(userId, channelId, at = Date.now()) {
  sessions.set(userId, { channelId, since: at });
}

/**
 * 통화 종료 — 머문 시간을 누적하고 그 길이(ms)를 돌려준다.
 * 시작 기록이 없으면(봇 재시작 등) 0.
 */
function end(userId, at = Date.now()) {
  const session = sessions.get(userId);
  sessions.delete(userId);
  if (!session) return 0;

  const ms = Math.max(0, at - session.since);
  if (ms < 1000) return ms; // 1초 미만은 버린다 (잘못 눌러 들어갔다 나온 경우)

  const e = entryOf(userId, at);
  e.total += ms;
  e.week += ms;
  e.lastSeen = new Date(at).toISOString();
  scheduleFlush();
  return ms;
}

/** 통화 중인지 */
function isActive(userId) {
  return sessions.has(userId);
}

/** 진행 중인 통화까지 더한 현재 시간 */
function timeOf(userId, at = Date.now()) {
  const e = entryOf(userId, at);
  const session = sessions.get(userId);
  const ongoing = session ? Math.max(0, at - session.since) : 0;
  return { total: e.total + ongoing, week: e.week + ongoing, ongoing };
}

/** 전원 기록 (진행 중인 통화 포함) — 순위표용 */
function ranking(period = 'week', at = Date.now()) {
  const store = load();
  const key = weekKey(at);
  const rows = [];

  const ids = new Set([...Object.keys(store.users), ...sessions.keys()]);
  for (const userId of ids) {
    const e = store.users[userId];
    const base = e ? (period === 'total' ? e.total : e.weekKey === key ? e.week : 0) : 0;
    const session = sessions.get(userId);
    const ongoing = session ? Math.max(0, at - session.since) : 0;
    const ms = (typeof base === 'number' && Number.isFinite(base) ? base : 0) + ongoing;
    if (ms > 0) rows.push({ userId, ms, ongoing });
  }

  return rows.sort((a, b) => b.ms - a.ms);
}

/** 봇이 켜질 때 이미 음성방에 있던 사람들을 통화 중으로 잡아준다 */
function seed(guild, at = Date.now()) {
  if (!guild) return 0;
  let count = 0;
  for (const state of guild.voiceStates.cache.values()) {
    if (!state.channelId || !state.member || state.member.user.bot) continue;
    if (guild.afkChannelId && state.channelId === guild.afkChannelId) continue;
    begin(state.id, state.channelId, at);
    count += 1;
  }
  return count;
}

/** 봇이 꺼질 때 진행 중인 통화를 모두 적립하고 저장한다 */
function flushAll(at = Date.now()) {
  for (const userId of [...sessions.keys()]) end(userId, at);
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushNow();
}

/** 3시간 25분 형태로 */
function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

module.exports = {
  begin,
  end,
  isActive,
  timeOf,
  ranking,
  seed,
  flushAll,
  formatDuration,
  weekKey,
};
