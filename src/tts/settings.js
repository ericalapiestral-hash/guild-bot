// 읽어주기 설정.
//
// 읽을 채널은 따로 지정하지 않는다 — 봇이 들어가 있는 **음성 채널의 내장 채팅**만 읽는다.
// (디스코드 음성 채널은 자체 텍스트 채팅을 갖고 있다)
'use strict';

const { DEFAULT_MAX } = require('./text');

/** 한 번에 읽을 최대 글자 수 */
function maxChars() {
  const n = Number(process.env.TTS_MAX_CHARS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX;
  return Math.min(Math.floor(n), 300);
}

module.exports = { maxChars };
