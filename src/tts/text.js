// 채팅 → 읽어줄 텍스트로 다듬기.
// 순수 함수만 둔다 (테스트하기 쉽게, 그리고 채팅마다 도는 코드라 가볍게).
'use strict';

/** 한 번에 읽어줄 최대 글자 수 — 넘으면 자르고 "이하 생략"을 붙인다 */
const DEFAULT_MAX = 150;

/** 같은 글자 반복은 이만큼까지만 (ㅋㅋㅋㅋㅋㅋ → ㅋㅋㅋ) */
const MAX_REPEAT = 3;

/**
 * 유니코드 이모지·기호 (읽으면 이상해서 지운다).
 * ZWJ(U+200D)를 빼먹으면 👨‍💻 같은 조합 이모지를 지웠을 때 결합자만 남는데,
 * 눈에는 안 보이지만 빈 문자열이 아니라서 "읽을 게 없음" 검사를 통과해버린다.
 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{20E3}\u{2B00}-\u{2BFF}\u{200D}\u{2000}-\u{206F}\u{2100}-\u{214F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu;

/**
 * 읽어줄 수 있는 문장으로 다듬는다.
 * discord.js의 message.cleanContent를 넣는 걸 전제로 한다 (멘션이 이미 이름으로 바뀐 상태).
 *
 * @param {string} raw
 * @param {{maxChars?: number}} [opts]
 * @returns {string} 읽을 게 없으면 빈 문자열
 */
function toSpeech(raw, { maxChars = DEFAULT_MAX } = {}) {
  let s = String(raw ?? '');

  // 코드 블록·인라인 코드는 읽어봐야 소음이다
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`[^`\n]*`/g, ' ');

  // 링크는 통째로 읽으면 재앙 — 한 단어로 바꾼다
  s = s.replace(/https?:\/\/\S+/gi, ' 링크 ');
  s = s.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, ' $1 '); // 커스텀 이모지 → 이름만
  s = s.replace(/<t:\d+(?::[tTdDfFR])?>/g, ' 시간 '); // 타임스탬프
  s = s.replace(/<id:[a-z]+>/g, ' '); // 길드 내비게이션

  // cleanContent가 남긴 멘션 접두 기호 정리 (@이름 → 이름)
  s = s.replace(/(^|\s)[@#]([^\s@#])/g, '$1$2');

  // 마크다운 장식 제거
  s = s.replace(/(\*\*|__|~~|\*|_|\|\|)/g, '');
  s = s.replace(/^>\s?/gm, ' '); // 인용
  s = s.replace(/^#{1,6}\s+/gm, ' '); // 헤딩
  s = s.replace(/^[-*]\s+/gm, ' '); // 목록

  s = s.replace(EMOJI_RE, ' ');

  // 같은 글자를 길게 늘인 건 줄인다 (ㅋㅋㅋㅋㅋ, ㅠㅠㅠㅠ, !!!!!)
  s = s.replace(/(.)\1{2,}/gu, (m, ch) => ch.repeat(MAX_REPEAT));

  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 글자도 숫자도 안 남았으면 읽을 게 없는 것 (기호·결합자만 남은 경우)
  if (!/[\p{L}\p{N}]/u.test(s)) return '';

  // 코드 포인트 단위로 자른다. UTF-16 인덱스로 자르면 이모지 한가운데가 잘려
  // 뒤에서 URL 인코딩할 때 터진다.
  const points = [...s];
  if (points.length > maxChars) {
    s = `${points.slice(0, maxChars).join('').trim()}, 이하 생략`;
  }
  return s;
}

/**
 * 누가 말했는지 앞에 붙인다. 같은 사람이 연달아 치면 이름을 생략한다.
 * @param {string} speaker 표시 이름
 * @param {string} body toSpeech 결과
 * @param {string|null} lastSpeaker 직전에 읽은 사람 (같으면 이름 생략)
 */
function withSpeaker(speaker, body, lastSpeaker) {
  if (!body) return '';
  const name = String(speaker ?? '').trim();
  if (!name || name === lastSpeaker) return body;
  return `${name}, ${body}`;
}

/** 읽을 가치가 없는 메시지인지 (명령어 흔적, 순수 이모지 등) */
function isSkippable(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return true;
  if (s.startsWith('!') || s.startsWith('/') || s.startsWith('.')) return true; // 다른 봇 명령어
  return false;
}

module.exports = { toSpeech, withSpeaker, isSkippable, DEFAULT_MAX };
