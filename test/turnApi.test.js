// 턴 인식 API 점검 — 서버를 띄워 실제로 요청해 본다.
//   node test/turnApi.test.js
'use strict';

const assert = require('node:assert');
const { createServer } = require('../src/turnApi');
const { GRID_W, GRID_H, loadTemplates } = require('../overlay/lib/turnReader');

const templates = loadTemplates(require('../overlay/lib/turnTemplates.json'));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** 템플릿 격자를 확대해 회색조 화면을 만든다 (turnReader 테스트와 같은 방식) */
function render(digits, { scale = 4, margin = 6 } = {}) {
  const grids = digits.map((d) => templates.find((t) => t.digit === d).grid);
  const dw = GRID_W * scale;
  const dh = GRID_H * scale;
  const gap = scale * 2;
  const w = margin * 2 + grids.length * dw + Math.max(0, grids.length - 1) * gap;
  const h = margin * 2 + dh;
  const gray = Buffer.alloc(w * h, 20);
  grids.forEach((grid, gi) => {
    const offX = margin + gi * (dw + gap);
    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        if (!grid[y * GRID_W + x]) continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            gray[(margin + y * scale + sy) * w + (offX + x * scale + sx)] = 240;
          }
        }
      }
    }
  });
  return { gray, w, h };
}

/** 서버를 잠깐 띄우고 주소를 준다 */
function withServer(options, run) {
  return new Promise((resolve, reject) => {
    const server = createServer(options);
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

const post = (base, { w, h, body, headers }) =>
  fetch(`${base}/turn?w=${w}&h=${h}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });

// ─── 상태

test('GET /turn 이 대조표 개수를 알려준다', () =>
  withServer({}, async (base) => {
    const res = await fetch(`${base}/turn`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.ok(json.templates >= 10, `대조표 ${json.templates}개`);
  }));

test('없는 주소는 404', () =>
  withServer({}, async (base) => {
    assert.strictEqual((await fetch(`${base}/무엇`)).status, 404);
  }));

test('GET·POST 말고는 405', () =>
  withServer({}, async (base) => {
    assert.strictEqual((await fetch(`${base}/turn`, { method: 'DELETE' })).status, 405);
  }));

// ─── 인식

test('보낸 조각에서 턴 숫자를 읽어 돌려준다', () =>
  withServer({}, async (base) => {
    for (const digits of [[7], [1, 6], [1, 0, 4]]) {
      const { gray, w, h } = render(digits);
      const json = await (await post(base, { w, h, body: gray })).json();
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.value, Number(digits.join('')), `${digits} → ${json.value}`);
      assert.ok(json.confidence > 0.6, `신뢰도 ${json.confidence}`);
    }
  }));

test('못 읽으면 오류가 아니라 value: null', () =>
  withServer({}, async (base) => {
    const w = 60;
    const h = 30;
    const res = await post(base, { w, h, body: Buffer.alloc(w * h, 20) });
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.value, null);
  }));

// ─── 잘못된 요청

test('w·h가 없거나 이상하면 400', () =>
  withServer({}, async (base) => {
    assert.strictEqual((await post(base, { w: 0, h: 10, body: Buffer.alloc(1) })).status, 400);
    assert.strictEqual((await post(base, { w: 'a', h: 'b', body: Buffer.alloc(1) })).status, 400);
  }));

test('본문 길이가 w*h와 다르면 400', () =>
  withServer({}, async (base) => {
    const res = await post(base, { w: 20, h: 10, body: Buffer.alloc(50) });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /길이/);
  }));

// ─── 토큰

test('토큰을 걸면 없는 요청은 401, 맞으면 통과', () =>
  withServer({ token: 's3cret-token' }, async (base) => {
    const { gray, w, h } = render([5]);
    assert.strictEqual((await post(base, { w, h, body: gray })).status, 401);

    const ok = await post(base, { w, h, body: gray, headers: { 'X-Token': 's3cret-token' } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).value, 5);
  }));

test('토큰을 안 걸면 그냥 통과한다', () =>
  withServer({}, async (base) => {
    const { gray, w, h } = render([9]);
    assert.strictEqual((await post(base, { w, h, body: gray })).status, 200);
  }));

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
})();
