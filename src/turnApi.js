// 턴 인식 API — 오버레이(PC·폰)가 잘라 보낸 화면 조각에서 턴 숫자를 읽어 돌려준다.
//
// 왜 서버로 두나: 인식기와 대조표를 고치면 exe·APK를 다시 뿌리지 않아도 양쪽이 같이 좋아진다.
// 폰은 ML Kit(수십 MB)을 앱에서 뺄 수 있다.
//
// 인식기는 overlay/lib/turnReader.js를 그대로 쓴다. 의존성이 하나도 없는 순수 모듈이라
// 봇 쪽에서 바로 require 해도 문제가 없다. **overlay 밖으로 옮기지 말 것** — 옮기면
// electron-builder가 exe에 안 넣어서 PC 오버레이가 혼자서는 못 읽게 된다.
//
//   POST /turn?w=180&h=90    본문 = 회색조 픽셀 (w*h 바이트, 그대로)
//   → { "ok": true, "value": 16, "confidence": 0.87, "digits": [1,6] }
//   → { "ok": true, "value": null }              읽지 못했을 때 (오류가 아니다)
//   GET  /turn                                    상태 확인
'use strict';

const http = require('node:http');
const { loadTemplates, readTurn } = require('../overlay/lib/turnReader');

const templates = loadTemplates(require('../overlay/lib/turnTemplates.json'));

/** 턴 숫자 조각은 크지 않다. 이보다 크면 받지 않는다 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 한 아이피가 이 이상 몰아치면 잠시 막는다 (0.7초마다 한 번이 정상) */
const RATE_PER_SEC = 8;
const RATE_BURST = 24;

/** 아이피별 남은 횟수 — 토큰 버킷 */
const buckets = new Map();

function allow(ip, now) {
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_BURST, at: now };
    buckets.set(ip, b);
  }
  const grew = ((now - b.at) / 1000) * RATE_PER_SEC;
  b.tokens = Math.min(RATE_BURST, b.tokens + grew);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// 오래 조용한 아이피는 버린다 (메모리가 계속 늘지 않게)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
}, 5 * 60 * 1000).unref();

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 본문을 상한까지만 모은다 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {{token?: string}} [options]
 *   token을 주면 X-Token 헤더가 맞아야 답한다.
 *   HTTP 헤더는 아스키만 담을 수 있으므로 **한글을 쓰면 안 된다**.
 */
function createServer(options = {}) {
  const token = options.token || process.env.TURN_API_TOKEN || null;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/turn') {
      send(res, 404, { ok: false, error: '없는 주소입니다' });
      return;
    }

    if (req.method === 'GET') {
      send(res, 200, { ok: true, templates: templates.length, 인증필요: Boolean(token) });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'POST로 보내주세요' });
      return;
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (!allow(ip, Date.now())) {
      send(res, 429, { ok: false, error: '너무 자주 부르고 있어요' });
      return;
    }
    if (token && req.headers['x-token'] !== token) {
      send(res, 401, { ok: false, error: '토큰이 맞지 않습니다' });
      return;
    }

    const w = Number(url.searchParams.get('w'));
    const h = Number(url.searchParams.get('h'));
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w * h > MAX_BYTES) {
      send(res, 400, { ok: false, error: 'w·h가 이상합니다' });
      return;
    }

    let body;
    try {
      body = await readBody(req, MAX_BYTES);
    } catch (e) {
      send(res, e.tooLarge ? 413 : 400, { ok: false, error: '본문을 읽지 못했습니다' });
      return;
    }
    if (body.length !== w * h) {
      send(res, 400, {
        ok: false,
        error: `본문 길이가 w*h와 다릅니다 (${body.length} ≠ ${w * h})`,
      });
      return;
    }

    try {
      const got = readTurn(new Uint8Array(body), w, h, templates);
      // 못 읽은 건 오류가 아니다 — 연출로 숫자가 가려진 순간이 정상적으로 있다
      send(res, 200, got ? { ok: true, ...got } : { ok: true, value: null });
    } catch (e) {
      send(res, 500, { ok: false, error: `인식 중 오류: ${e.message}` });
    }
  });
}

/** 포트가 정해져 있을 때만 띄운다 — 봇만 돌릴 때는 아무 일도 하지 않는다 */
function start(port = process.env.TURN_API_PORT || process.env.PORT) {
  if (!port) return null;
  const server = createServer();
  server.listen(Number(port), () => {
    console.log(`[턴API] ${port} 포트에서 대기 중 (대조표 ${templates.length}개)`);
  });
  return server;
}

module.exports = { createServer, start, templates };
