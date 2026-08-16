// 턴 숫자 전용 인식기 점검.
//   node test/turnReader.test.js
//
// 캔버스 없이 돌려야 하므로, 템플릿 격자를 확대해 가짜 화면을 만들어 넣는다.
'use strict';

const assert = require('node:assert');
const {
  GRID_W,
  GRID_H,
  binarize,
  components,
  digitBoxes,
  loadTemplates,
  readTurn,
} = require('../lib/turnReader');

const raw = require('../lib/turnTemplates.json');
const templates = loadTemplates(raw);

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

/** 템플릿 격자들을 나란히 놓아 회색조 화면을 만든다 */
function render(grids, { scale = 4, margin = 6, dark = true } = {}) {
  const dw = GRID_W * scale;
  const dh = GRID_H * scale;
  const gap = scale * 2;
  const w = margin * 2 + grids.length * dw + Math.max(0, grids.length - 1) * gap;
  const h = margin * 2 + dh;

  const bg = dark ? 20 : 235;
  const fg = dark ? 240 : 25;
  const gray = new Uint8Array(w * h).fill(bg);

  grids.forEach((grid, gi) => {
    const offX = margin + gi * (dw + gap);
    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        if (!grid[y * GRID_W + x]) continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            gray[(margin + y * scale + sy) * w + (offX + x * scale + sx)] = fg;
          }
        }
      }
    }
  });
  return { gray, w, h };
}

const first = (digit) => templates.find((t) => t.digit === digit).grid;

// ─── 템플릿 자체

test('템플릿에 0~9가 모두 있다', () => {
  for (let d = 0; d <= 9; d += 1) {
    assert.ok(
      templates.some((t) => t.digit === d),
      `${d} 없음`,
    );
  }
});

// ─── 한 자리

test('한 자리 숫자를 읽는다', () => {
  for (let d = 0; d <= 9; d += 1) {
    const { gray, w, h } = render([first(d)]);
    const got = readTurn(gray, w, h, templates);
    assert.ok(got, `${d}: 못 읽음`);
    assert.strictEqual(got.value, d, `${d} → ${got.value}`);
  }
});

// ─── 여러 자리

test('두 자리·세 자리를 자리 순서대로 잇는다', () => {
  const two = render([first(1), first(6)]);
  assert.strictEqual(readTurn(two.gray, two.w, two.h, templates).value, 16);

  const three = render([first(1), first(0), first(4)]);
  assert.strictEqual(readTurn(three.gray, three.w, three.h, templates).value, 104);
});

test('앞자리 0도 그대로 이어 붙인다', () => {
  const got = render([first(0), first(8)]);
  assert.strictEqual(readTurn(got.gray, got.w, got.h, templates).value, 8);
});

// ─── 밝기 반전

test('어두운 배경에 밝은 글자, 밝은 배경에 어두운 글자 둘 다 읽는다', () => {
  const dark = render([first(2), first(4)], { dark: true });
  const light = render([first(2), first(4)], { dark: false });
  assert.strictEqual(readTurn(dark.gray, dark.w, dark.h, templates).value, 24);
  assert.strictEqual(readTurn(light.gray, light.w, light.h, templates).value, 24);
});

// ─── 크기

test('작게 그려도 읽는다', () => {
  const small = render([first(3), first(5)], { scale: 2, margin: 3 });
  assert.strictEqual(readTurn(small.gray, small.w, small.h, templates).value, 35);
});

// ─── 안 읽어야 하는 것

test('빈 화면은 null', () => {
  const gray = new Uint8Array(60 * 30).fill(20);
  assert.strictEqual(readTurn(gray, 60, 30, templates), null);
});

test('네 자리를 넘게 잡히면 믿지 않는다', () => {
  const many = render([first(1), first(2), first(3), first(4)]);
  assert.strictEqual(readTurn(many.gray, many.w, many.h, templates), null);
});

test('숫자가 아닌 덩어리는 null', () => {
  // 가운데 채워진 네모 하나 — 어느 숫자와도 충분히 닮지 않았다
  const w = 40;
  const h = 40;
  const gray = new Uint8Array(w * h).fill(20);
  for (let y = 8; y < 32; y += 1) for (let x = 12; x < 28; x += 1) gray[y * w + x] = 240;
  assert.strictEqual(readTurn(gray, w, h, templates), null);
});

// ─── 부품

test('이진화는 적은 쪽을 글자로 잡는다', () => {
  const { gray, w, h } = render([first(7)]);
  const bin = binarize(gray, w, h);
  const on = bin.reduce((n, v) => n + v, 0);
  assert.ok(on > 0 && on < bin.length / 2, `글자 픽셀 ${on} / 전체 ${bin.length}`);
});

test('덩어리 개수가 자릿수와 맞는다', () => {
  const { gray, w, h } = render([first(1), first(2), first(3)]);
  const boxes = digitBoxes(components(binarize(gray, w, h), w, h));
  assert.strictEqual(boxes.length, 3);
});

// ─── 폰트가 달라도 되는지 (자기 템플릿을 빼고 맞춰 본다)

test('다른 폰트로 그린 숫자도 맞힌다', () => {
  let hit = 0;
  let unread = 0;
  const wrong = [];

  for (const t of templates) {
    // 자기 자신을 빼고 맞춰 본다 — 처음 보는 폰트를 만난 상황
    const others = templates.filter((x) => x !== t);
    if (!others.some((x) => x.digit === t.digit)) continue;
    const { gray, w, h } = render([t.grid]);
    const got = readTurn(gray, w, h, others);
    if (!got) unread += 1;
    else if (got.value === t.digit) hit += 1;
    else wrong.push(`${t.digit}→${got.value}`);
  }

  const total = hit + unread + wrong.length;
  console.log(
    `      (처음 보는 폰트: 맞음 ${hit} · 모르겠음 ${unread} · 틀림 ${wrong.length} / ${total})`,
  );

  // 틀리게 읽는 것이 못 읽는 것보다 훨씬 나쁘다 — 틀린 턴을 믿으면 엉뚱한 단계로 뛴다.
  // 못 읽으면 그냥 기다렸다가 다음 프레임에 다시 본다.
  assert.strictEqual(wrong.length, 0, `오독: ${wrong.join(', ')}`);
  assert.ok(hit / total >= 0.75, `정답률 ${((hit / total) * 100).toFixed(0)}%`);
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
