// TTS 어댑터 — 문장을 주면 Ogg/Opus 오디오를 돌려준다. 두 가지 방식을 지원한다.
//
//  1) HTTP  : TTS_URL 로 요청 → 응답 본문이 오디오
//  2) 로컬 실행: TTS_COMMAND 로 프로그램을 돌려서 → 표준출력이나 임시 파일에서 오디오
//
// ⚠️ 어느 쪽이든 결과는 Ogg/Opus(또는 WebM/Opus)여야 한다.
//    MP3·WAV로 주면 ffmpeg나 opus 인코더가 필요해지는데, 무료 호스팅 128MB에서는
//    그 순간 메모리가 터진다. 그래서 여기서 형식을 확인하고 아니면 거절한다.
//
// .env 예시
//   TTS_URL=http://localhost:5000/tts?text={{text}}
//   TTS_COMMAND=piper --model ko_KR.onnx --output_file {{out}}      ← 문장은 표준입력으로
//   TTS_COMMAND=python tts.py --text {{text}} --out {{out}}          ← 문장을 인자로
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const DEFAULT_TIMEOUT_MS = 8000;
/** 오디오 한 개 최대 크기 — 넘으면 받는 도중에 끊는다 (다 받고 재는 게 아니다) */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

function config() {
  const url = (process.env.TTS_URL || '').trim();
  const command = (process.env.TTS_COMMAND || '').trim();
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
    command,
    method: (process.env.TTS_METHOD || 'GET').toUpperCase(),
    headers,
    headerError,
    body: process.env.TTS_BODY || '',
    timeoutMs: Number(process.env.TTS_TIMEOUT) || DEFAULT_TIMEOUT_MS,
  };
}

/** TTS가 설정돼 있는지 (헤더가 깨져 있어도 여기서 터지지 않게 한다) */
function isConfigured() {
  const cfg = config();
  return Boolean(cfg.url || cfg.command);
}

/** 상태 표시용 한 줄 */
function describeTarget() {
  const cfg = config();
  if (cfg.command) return `로컬 실행 · ${cfg.command.split(/\s+/)[0]}`;
  if (cfg.url) {
    try {
      return `HTTP · ${new URL(cfg.url.replace('{{text}}', 'x')).host}`;
    } catch {
      return 'HTTP';
    }
  }
  return '없음';
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

function ensureOpus(buffer) {
  if (buffer.length === 0) throw new Error('TTS가 빈 응답을 줬어요.');
  const format = describeFormat(buffer);
  if (format !== 'ogg' && format !== 'webm') {
    throw new Error(
      `TTS가 Ogg/Opus가 아니라 ${format}을(를) 줬어요. ` +
        'Ogg/Opus(48kHz)로 내보내도록 맞춰주세요 — 다른 포맷은 변환기(ffmpeg)가 필요해서 이 봇에서 재생할 수 없어요.',
    );
  }
  return format;
}

// ─────────────────────────────── HTTP 방식

async function viaHttp(cfg, text) {
  if (cfg.headerError) throw new Error(cfg.headerError);

  const hasSlot = cfg.url.includes('{{text}}');
  const url = hasSlot
    ? fill(cfg.url, encodeURIComponent(text), { json: false })
    : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}text=${encodeURIComponent(text)}`;

  const init = { method: cfg.method, headers: { ...cfg.headers } };
  if (cfg.method !== 'GET' && cfg.method !== 'HEAD') {
    const isJson = /json/i.test(init.headers['content-type'] || '');
    init.body = cfg.body ? fill(cfg.body, text, { json: isJson }) : text;
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

    return Buffer.concat(chunks, received);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────── 로컬 실행 방식

/** 명령 문자열을 인자 배열로 쪼갠다 (따옴표 유지) */
function splitArgs(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function viaCommand(cfg, text) {
  const parts = splitArgs(cfg.command);
  if (parts.length === 0) throw new Error('TTS_COMMAND가 비어 있어요.');

  const usesOutFile = cfg.command.includes('{{out}}');
  const outPath = usesOutFile
    ? path.join(os.tmpdir(), `guildbot-tts-${process.pid}-${Date.now()}.ogg`)
    : null;

  // ⚠️ 절대 shell을 쓰지 않는다. 채팅 내용이 그대로 들어오므로 shell을 켜면
  //    누가 채팅에 명령어를 심어 서버에서 실행시킬 수 있다.
  //    shell 없이 argv로 넘기면 문자열이 그대로 인자 하나가 되어 안전하다.
  const usesTextArg = cfg.command.includes('{{text}}');
  const argv = parts
    .slice(1)
    .map((a) => a.split('{{text}}').join(text).split('{{out}}').join(outPath ?? ''));

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(parts[0], argv, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      reject(new Error(`TTS 프로그램을 실행하지 못했어요: ${e.message}`));
      return;
    }

    const chunks = [];
    let received = 0;
    let stderr = '';
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 이미 끝남 */
      }
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`TTS 프로그램이 끝나지 않아요 (${cfg.timeoutMs / 1000}초 초과).`));
    }, cfg.timeoutMs);

    child.on('error', (e) =>
      finish(reject, new Error(`TTS 프로그램을 실행하지 못했어요: ${e.message}`)),
    );
    child.stderr.on('data', (d) => {
      if (stderr.length < 2000) stderr += d.toString();
    });

    if (!usesOutFile) {
      child.stdout.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_AUDIO_BYTES) {
          finish(reject, new Error('TTS 출력이 너무 커요 (2MB 초과).'));
          return;
        }
        chunks.push(chunk);
      });
    } else {
      child.stdout.resume(); // 버퍼가 막히지 않게 흘려보낸다
    }

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          reject,
          new Error(`TTS 프로그램이 오류로 끝났어요 (종료 코드 ${code}) ${stderr.trim().slice(0, 200)}`),
        );
        return;
      }
      if (!usesOutFile) {
        finish(resolve, Buffer.concat(chunks, received));
        return;
      }
      try {
        const stat = fs.statSync(outPath);
        if (stat.size > MAX_AUDIO_BYTES) {
          fs.rmSync(outPath, { force: true });
          finish(reject, new Error('TTS 출력 파일이 너무 커요 (2MB 초과).'));
          return;
        }
        const buffer = fs.readFileSync(outPath);
        fs.rmSync(outPath, { force: true });
        finish(resolve, buffer);
      } catch (e) {
        finish(reject, new Error(`TTS 출력 파일을 읽지 못했어요: ${e.message}`));
      }
    });

    // 문장을 인자로 안 넘겼으면 표준입력으로 준다
    if (!usesTextArg) {
      child.stdin.on('error', () => {}); // 프로그램이 stdin을 안 읽으면 EPIPE가 난다
      child.stdin.end(text);
    } else {
      child.stdin.end();
    }
  });
}

// ─────────────────────────────── 공개 API

/**
 * 문장 하나를 Ogg/Opus 오디오로 바꾼다.
 * @param {string} text
 * @returns {Promise<{stream: import('node:stream').Readable, format: 'ogg'|'webm'}>}
 */
async function synthesize(text) {
  const cfg = config();
  if (!cfg.url && !cfg.command) {
    throw new Error(
      'TTS가 설정되지 않았어요. .env에 TTS_URL(HTTP) 또는 TTS_COMMAND(로컬 실행)를 넣어주세요.',
    );
  }

  // 잘린 서로게이트가 섞이면 인코딩·전달에서 터진다 — 미리 정리한다
  const safe = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;

  const buffer = cfg.command ? await viaCommand(cfg, safe) : await viaHttp(cfg, safe);
  const format = ensureOpus(buffer);
  return { stream: Readable.from(buffer), format };
}

module.exports = { synthesize, isConfigured, describeTarget, MAX_AUDIO_BYTES };
