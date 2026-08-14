// TTS 공급자 어댑터 — 텍스트를 보내면 Ogg/Opus 오디오를 돌려받는다.
//
// ⚠️ 반드시 Ogg/Opus(또는 WebM/Opus)로 받아야 한다.
//    MP3·WAV로 받으면 ffmpeg나 opus 인코더가 필요해지는데, 무료 호스팅 128MB에서는
//    그 순간 메모리가 터진다. 그래서 여기서 응답 포맷을 확인하고 아니면 거절한다.
//
// 설정은 .env로 한다:
//   TTS_URL      필수. {{text}} 자리에 문장이 들어간다. 없으면 ?text= 로 붙인다.
//   TTS_METHOD   GET(기본) 또는 POST
//   TTS_HEADERS  JSON 문자열. 예: {"Authorization":"Bearer ..."}
//   TTS_BODY     POST일 때 본문 템플릿. {{text}} 치환. JSON이면 Content-Type도 같이 넣을 것
//   TTS_TIMEOUT  밀리초 (기본 8000)
'use strict';

const { Readable } = require('node:stream');

const DEFAULT_TIMEOUT_MS = 8000;
/** 오디오 한 개 최대 크기 — 넘으면 받는 도중에 끊는다 (다 받고 재는 게 아니다) */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

function config() {
  const url = (process.env.TTS_URL || '').trim();
  let headers = {};
  let headerError = null;
  if (process.env.TTS_HEADERS) {
    try {
      const parsed = JSON.parse(process.env.TTS_HEADERS);
      // HTTP 헤더는 대소문자를 가리지 않는다 — 소문자로 맞춰두면 조회가 단순해진다
      for (const [k, v] of Object.entries(parsed)) headers[String(k).toLowerCase()] = String(v);
    } catch {
      headerError = 'TTS_HEADERS가 올바른 JSON이 아니에요.';
    }
  }
  return {
    url,
    method: (process.env.TTS_METHOD || 'GET').toUpperCase(),
    headers,
    headerError,
    body: process.env.TTS_BODY || '',
    timeoutMs: Number(process.env.TTS_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  };
}

/** TTS가 설정돼 있는지 (헤더가 깨져 있어도 여기서 터지지 않게 한다) */
function isConfigured() {
  return Boolean(config().url);
}

/** {{text}} 자리를 채운다 (JSON 본문에 넣어도 깨지지 않게 이스케이프) */
function fill(template, text, { json }) {
  const value = json ? JSON.stringify(text).slice(1, -1) : text;
  return template.split('{{text}}').join(value);
}

/** 받은 첫 바이트로 컨테이너를 알아본다 */
function describeFormat(head) {
  const magic = head.subarray(0, 4).toString('latin1');
  if (magic === 'OggS') return 'ogg';
  if (magic === 'RIFF') return 'WAV';
  if (magic.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'MP3';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  return '알 수 없는 형식';
}

/**
 * 문장 하나를 Ogg/Opus 오디오 스트림으로 바꾼다.
 * @param {string} text
 * @returns {Promise<import('node:stream').Readable>}
 */
async function synthesize(text) {
  const cfg = config();
  if (!cfg.url) {
    throw new Error(
      'TTS 서버가 설정되지 않았어요. .env에 TTS_URL을 넣어주세요. (Ogg/Opus를 돌려주는 주소여야 해요)',
    );
  }
  if (cfg.headerError) throw new Error(cfg.headerError);

  const hasSlot = cfg.url.includes('{{text}}');
  // 잘린 서로게이트가 섞이면 encodeURIComponent가 던진다 — 미리 정리한다
  const safe = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
  const url = hasSlot
    ? fill(cfg.url, encodeURIComponent(safe), { json: false })
    : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}text=${encodeURIComponent(safe)}`;

  const init = { method: cfg.method, headers: { ...cfg.headers } };
  if (cfg.method !== 'GET' && cfg.method !== 'HEAD') {
    const isJson = /json/i.test(init.headers['content-type'] || '');
    init.body = cfg.body ? fill(cfg.body, safe, { json: isJson }) : safe;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);

  // ⚠️ 타이머 해제는 **본문까지 다 받은 뒤**에 해야 한다.
  //    헤더만 받고 풀어버리면 본문이 안 오는 서버에서 영원히 매달린다.
  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`TTS 서버가 응답하지 않아요 (${cfg.timeoutMs / 1000}초 초과).`);
      }
      throw new Error(`TTS 서버에 연결하지 못했어요: ${e.message}`);
    }

    if (!response.ok) throw new Error(`TTS 서버 오류 (HTTP ${response.status})`);

    // 크기를 미리 알려주면 받기 전에 끊는다
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      ac.abort();
      throw new Error('TTS 응답이 너무 커요 (2MB 초과).');
    }

    // 흘려받으면서 세다가 상한을 넘으면 즉시 끊는다 (다 받아놓고 재면 이미 늦다)
    const chunks = [];
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > MAX_AUDIO_BYTES) {
          ac.abort();
          throw new Error('TTS 응답이 너무 커요 (2MB 초과).');
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`TTS 서버가 응답하지 않아요 (${cfg.timeoutMs / 1000}초 초과).`);
      }
      throw e;
    }

    const buffer = Buffer.concat(chunks, received);
    if (buffer.length === 0) throw new Error('TTS 서버가 빈 응답을 줬어요.');

    const format = describeFormat(buffer);
    if (format !== 'ogg' && format !== 'webm') {
      throw new Error(
        `TTS 서버가 Ogg/Opus가 아니라 ${format}을(를) 줬어요. ` +
          'Ogg/Opus(48kHz)로 내보내도록 서버를 맞춰주세요 — 다른 포맷은 변환기(ffmpeg)가 필요해서 이 봇에서 재생할 수 없어요.',
      );
    }

    return { stream: Readable.from(buffer), format };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { synthesize, isConfigured, MAX_AUDIO_BYTES };
