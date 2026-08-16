// 턴 숫자 전용 인식기.
//
// 범용 OCR(tesseract·ML Kit)은 "아무 글자나" 읽으려다 보니 게임 폰트에서 흔들리고,
// 워커·모델 때문에 앱이 무거워진다. 여기서는 0~9 열 개만 구분하면 되므로
// 이진화 → 덩어리 분리 → 크기 정규화 → 템플릿 대조 로 끝난다.
//
// 이미지 처리 라이브러리를 쓰지 않는다 — 회색조 배열 하나만 받으면 되어서
// PC(캔버스)와 안드로이드(비트맵) 양쪽에서 같은 코드를 쓸 수 있다.
//
//   const templates = loadTemplates(require('./turnTemplates.json'));
//   const got = readTurn(gray, w, h, templates);   // → { value, confidence, digits } | null
'use strict';

/** 템플릿 격자 크기 — 숫자 하나를 이 크기로 줄여서 맞춘다 */
const GRID_W = 14;
const GRID_H = 24;

// ─────────────────────────────── 이진화

/** RGBA 바이트 → 회색조 */
function toGray(rgba, w, h) {
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    gray[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
  }
  return gray;
}

/** Otsu — 밝기 분포를 두 덩어리로 가르는 문턱값 */
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];

  let sumB = 0;
  let countB = 0;
  let best = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    countB += hist[t];
    if (countB === 0) continue;
    const countF = total - countB;
    if (countF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / countB;
    const meanF = (sum - sumB) / countF;
    const between = countB * countF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * 글자를 1, 배경을 0으로 만든다.
 * 밝은 글자든 어두운 글자든 상관없게, **화면에서 적은 쪽**을 글자로 본다.
 * (턴 숫자는 배경보다 항상 좁은 면적을 차지한다)
 */
function binarize(gray, w, h) {
  const threshold = otsuThreshold(gray);
  let bright = 0;
  for (let i = 0; i < gray.length; i += 1) if (gray[i] > threshold) bright += 1;
  const foregroundIsBright = bright * 2 <= gray.length;

  const bin = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i += 1) {
    bin[i] = gray[i] > threshold === foregroundIsBright ? 1 : 0;
  }
  return bin;
}

// ─────────────────────────────── 덩어리 나누기

/**
 * 붙어 있는 픽셀을 하나의 덩어리로 묶는다 (8방향).
 * 안티에일리어싱으로 획이 살짝 끊겨도 대각선으로 이어 주려고 8방향을 쓴다.
 */
function components(bin, w, h) {
  const seen = new Uint8Array(w * h);
  const found = [];
  const stack = [];

  for (let start = 0; start < bin.length; start += 1) {
    if (!bin[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    const pixels = [];

    while (stack.length > 0) {
      const p = stack.pop();
      const x = p % w;
      const y = (p / w) | 0;
      pixels.push(p);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (bin[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }

    found.push({
      minX,
      minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      pixels,
    });
  }
  return found;
}

/**
 * 숫자로 볼 만한 덩어리만 남겨 왼쪽부터 정렬한다.
 * 가장 큰 덩어리 높이의 절반이 안 되면 점·테두리 조각으로 보고 버린다.
 */
function digitBoxes(comps) {
  if (comps.length === 0) return [];
  let tallest = 0;
  for (const c of comps) if (c.h > tallest) tallest = c.h;

  const kept = comps.filter(
    (c) => c.h >= tallest * 0.55 && c.h >= 5 && c.w >= 2 && c.pixels.length >= 6,
  );
  kept.sort((a, b) => a.minX - b.minX);
  return kept;
}

// ─────────────────────────────── 크기 맞추기

/** 덩어리만 잘라낸 작은 비트맵 */
function cropBitmap(comp, w) {
  const data = new Uint8Array(comp.w * comp.h);
  for (const p of comp.pixels) {
    const x = (p % w) - comp.minX;
    const y = ((p / w) | 0) - comp.minY;
    data[y * comp.w + x] = 1;
  }
  return { data, w: comp.w, h: comp.h };
}

/**
 * 템플릿 격자에 맞춰 줄인다.
 * **가로세로 비율을 지킨다** — 1은 홀쭉하고 0은 통통한데, 늘려서 채우면 그 차이가 사라진다.
 */
function normalize(bmp) {
  const scale = Math.min(GRID_W / bmp.w, GRID_H / bmp.h);
  const dw = Math.max(1, Math.round(bmp.w * scale));
  const dh = Math.max(1, Math.round(bmp.h * scale));
  const offX = Math.floor((GRID_W - dw) / 2);
  const offY = Math.floor((GRID_H - dh) / 2);

  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < dh; y += 1) {
    const sy0 = Math.floor((y * bmp.h) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * bmp.h) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx0 = Math.floor((x * bmp.w) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * bmp.w) / dw));

      let on = 0;
      let total = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          total += 1;
          on += bmp.data[sy * bmp.w + sx];
        }
      }
      // 절반 넘게 차 있으면 켠다
      if (on * 2 >= total) grid[(offY + y) * GRID_W + offX + x] = 1;
    }
  }
  return grid;
}

// ─────────────────────────────── 대조

/** 한 칸씩 부풀린다 — 획 굵기가 조금 달라도 겹치게 하려고 */
function dilate(grid) {
  const out = new Uint8Array(grid.length);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (!grid[y * GRID_W + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= GRID_H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= GRID_W) continue;
          out[ny * GRID_W + nx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * 닮은 정도 0~1.
 *
 * 두 가지를 반씩 섞는다:
 *  - 딱 겹치는 비율(자카드) — 숫자끼리 구분은 잘 되지만 획 굵기 차이에 약하다
 *  - 한 칸 부풀린 뒤 서로 덮는 비율 — 굵기 차이에 너그럽지만 뭐든 비슷해 보인다
 * 하나만 쓰면 한쪽으로 치우쳐서, 폰트가 바뀌면 못 읽거나 아무거나 읽는다.
 */
function similarity(a, b) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) both += 1;
    if (a[i] || b[i]) either += 1;
  }
  if (either === 0) return 0;
  const exact = both / either;

  const da = dilate(a);
  const db = dilate(b);
  let aOn = 0;
  let bOn = 0;
  let aIn = 0;
  let bIn = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]) {
      aOn += 1;
      if (db[i]) aIn += 1;
    }
    if (b[i]) {
      bOn += 1;
      if (da[i]) bIn += 1;
    }
  }
  if (aOn === 0 || bOn === 0) return 0;
  const loose = (aIn / aOn + bIn / bOn) / 2;

  return (exact + loose) / 2;
}

/**
 * 획으로 둘러싸인 빈 곳의 개수. 0·6·9는 1개, 8은 2개, 1·2·3·5·7은 0개다.
 * 폰트가 바뀌어도 잘 안 변해서, 모양이 비슷한 숫자를 갈라 주는 데 쓴다.
 */
function holeCount(grid) {
  const outside = new Uint8Array(grid.length);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const i = y * GRID_W + x;
    if (grid[i] || outside[i]) return;
    outside[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < GRID_W; x += 1) {
    push(x, 0);
    push(x, GRID_H - 1);
  }
  for (let y = 0; y < GRID_H; y += 1) {
    push(0, y);
    push(GRID_W - 1, y);
  }
  while (stack.length > 0) {
    const p = stack.pop();
    const x = p % GRID_W;
    const y = (p / GRID_W) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  // 바깥과 안 이어진 빈 칸 덩어리를 센다
  const seen = new Uint8Array(grid.length);
  let holes = 0;
  for (let start = 0; start < grid.length; start += 1) {
    if (grid[start] || outside[start] || seen[start]) continue;
    holes += 1;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop();
      const x = p % GRID_W;
      const y = (p / GRID_W) | 0;
      const step = (nx, ny) => {
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return;
        const q = ny * GRID_W + nx;
        if (grid[q] || outside[q] || seen[q]) return;
        seen[q] = 1;
        stack.push(q);
      };
      step(x - 1, y);
      step(x + 1, y);
      step(x, y - 1);
      step(x, y + 1);
    }
  }
  return holes;
}

/** JSON(행 문자열) → 대조에 쓰는 형태 */
function loadTemplates(json) {
  const list = (json && json.templates) || [];
  return list.map((t) => {
    const grid = new Uint8Array(GRID_W * GRID_H);
    t.rows.forEach((row, y) => {
      for (let x = 0; x < row.length && x < GRID_W; x += 1) {
        if (row[x] !== '0' && row[x] !== ' ') grid[y * GRID_W + x] = 1;
      }
    });
    return { digit: t.d, grid, holes: holeCount(grid) };
  });
}

/** 격자 → JSON 행 문자열 (템플릿을 만들 때 쓴다) */
function gridToRows(grid) {
  const rows = [];
  for (let y = 0; y < GRID_H; y += 1) {
    let line = '';
    for (let x = 0; x < GRID_W; x += 1) line += grid[y * GRID_W + x] ? '1' : '0';
    rows.push(line);
  }
  return rows;
}

// ─────────────────────────────── 바깥에 내놓는 것

/**
 * 잘라 온 턴 숫자 영역에서 숫자를 읽는다.
 *
 * @param {Uint8Array} gray 회색조 픽셀 (길이 w*h)
 * @param {number} w
 * @param {number} h
 * @param {Array<{digit:number,grid:Uint8Array}>} templates loadTemplates가 만든 것
 * @param {{minScore?:number, maxDigits?:number}} [opts]
 *   minScore 이 점수에 못 미치는 숫자가 하나라도 있으면 통째로 버린다.
 *   확실하지 않으면 답하지 않는 편이 낫다 — 틀린 턴을 믿고 단계를 건너뛰면 더 나쁘다.
 * @returns {{value:number, confidence:number, digits:number[]}|null}
 */
function readTurn(gray, w, h, templates, opts = {}) {
  // 문턱값은 폰트를 바꿔 가며 재서 고른 값이다 (scripts로 재현 가능).
  // 점수 자체보다 **2등과의 차이**가 중요했다 — 차이를 0.04로 두면 오독이 0이 되고,
  // 대신 "모르겠다"가 늘어난다. 턴을 잘못 읽어 단계를 건너뛰는 것보다 그편이 낫다.
  const minScore = opts.minScore ?? 0.6;
  const maxDigits = opts.maxDigits ?? 3;
  if (!gray || w <= 0 || h <= 0 || !templates || templates.length === 0) return null;

  const bin = binarize(gray, w, h);
  const boxes = digitBoxes(components(bin, w, h));
  if (boxes.length === 0) return null;
  // 자릿수보다 훨씬 많이 잡혔으면 영역 안에 글자 아닌 게 잔뜩 있는 것 — 믿지 않는다
  if (boxes.length > maxDigits) return null;

  const minMargin = opts.minMargin ?? 0.04;

  const digits = [];
  let worst = 1;
  for (const box of boxes) {
    // 꽉 찬 네모는 어떤 숫자와도 어중간하게 닮는다. 1처럼 홀쭉한 건 원래 꽉 차므로 빼고 본다.
    const fill = box.pixels.length / (box.w * box.h);
    if (box.w / box.h > 0.35 && fill > 0.88) return null;

    const grid = normalize(cropBitmap(box, w));
    const holes = holeCount(grid);

    // 숫자별로 가장 잘 맞는 점수를 모은다
    const perDigit = new Array(10).fill(0);
    for (const t of templates) {
      let s = similarity(grid, t.grid);
      // 뚫린 구멍 개수가 다르면 다른 숫자로 본다 (0·6·9 ↔ 1·2·7 을 갈라 준다)
      if (t.holes !== holes) s *= 0.55;
      if (s > perDigit[t.digit]) perDigit[t.digit] = s;
    }

    let bestDigit = -1;
    let bestScore = 0;
    let runnerUp = 0;
    for (let d = 0; d <= 9; d += 1) {
      if (perDigit[d] > bestScore) {
        runnerUp = bestScore;
        bestScore = perDigit[d];
        bestDigit = d;
      } else if (perDigit[d] > runnerUp) {
        runnerUp = perDigit[d];
      }
    }

    // 확실하지 않으면 답하지 않는다 — 틀린 턴을 믿고 단계를 건너뛰면 더 나쁘다
    if (bestDigit < 0 || bestScore < minScore) return null;
    if (bestScore - runnerUp < minMargin) return null;

    digits.push(bestDigit);
    if (bestScore < worst) worst = bestScore;
  }

  return { value: Number(digits.join('')), confidence: worst, digits };
}

module.exports = {
  GRID_W,
  GRID_H,
  toGray,
  otsuThreshold,
  binarize,
  components,
  digitBoxes,
  cropBitmap,
  normalize,
  similarity,
  dilate,
  holeCount,
  loadTemplates,
  gridToRows,
  readTurn,
};
