// 읽어주기 설정. 채팅마다 조회되므로 메모리에 캐시해두고 바뀔 때만 저장한다.
// (store.get은 호출마다 파일을 다시 읽어서 고빈도 경로에 쓰면 안 된다)
'use strict';

const store = require('../store');
const { DEFAULT_MAX } = require('./text');

/** guildId → 읽을 텍스트 채널 ID (메모리 캐시) */
const channels = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  const saved = store.get('ttsChannels');
  if (saved && typeof saved === 'object') {
    for (const [guildId, channelId] of Object.entries(saved)) {
      if (typeof channelId === 'string') channels.set(guildId, channelId);
    }
  }
}

/** 읽을 채널로 지정된 곳. 없으면 null (= 어느 채널이든 읽음) */
function channelId(guildId) {
  load();
  return channels.get(guildId) || null;
}

/** @returns {boolean} 파일 저장까지 성공했는지 */
function setChannel(guildId, id) {
  load();
  const before = channels.get(guildId);
  if (id) channels.set(guildId, id);
  else channels.delete(guildId);

  const ok = store.set('ttsChannels', channels.size > 0 ? Object.fromEntries(channels) : null);
  if (!ok) {
    // 저장에 실패했으면 캐시도 되돌린다 — 안 그러면 지금은 되는데 재시작하면 사라져
    // 원인을 알 수 없는 상태가 된다
    if (before) channels.set(guildId, before);
    else channels.delete(guildId);
  }
  return ok;
}

/** 한 번에 읽을 최대 글자 수 */
function maxChars() {
  const n = Number(process.env.TTS_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

module.exports = { channelId, setChannel, maxChars };
