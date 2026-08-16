// 턴 숫자 템플릿 만들기 — lib/turnTemplates.json 을 다시 뽑는다.
//
//   cd overlay && npm run templates
//
// 게임 폰트를 직접 가질 수 없으니, 굵은 산세리프 몇 벌로 0~9를 그려서 템플릿을 만든다.
// 숫자는 폰트가 달라도 뼈대가 비슷해서 이걸로 대개 맞는다. 특정 게임에서 잘 안 맞으면
// 그 화면을 잘라 여기에 폰트 대신 실제 이미지를 넣어 다시 뽑으면 된다.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { toGray, binarize, components, digitBoxes, cropBitmap, normalize, gridToRows } =
  require('../lib/turnReader');

/** 게임 UI에 흔한 굵은 산세리프들 — 없는 폰트는 브라우저가 알아서 대체한다 */
const FONTS = [
  'bold 64px "Arial Black"',
  'bold 64px "Segoe UI"',
  'bold 64px Tahoma',
  'bold 64px Verdana',
  '64px Impact',
  'bold 64px "Malgun Gothic"',
];

const OUT = path.join(__dirname, '..', 'lib', 'turnTemplates.json');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<canvas id="c" width="120" height="120"></canvas>
<script>
  window.draw = (font, ch) => {
    const c = document.getElementById('c');
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff'; g.font = font;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(ch, c.width / 2, c.height / 2);
    const d = g.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  };
</script>
`)}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL(PAGE);

  const templates = [];
  const seen = new Set(); // 폰트가 대체되어 똑같은 그림이 나오면 한 번만 넣는다

  for (const font of FONTS) {
    for (let digit = 0; digit <= 9; digit += 1) {
      const shot = await win.webContents.executeJavaScript(
        `window.draw(${JSON.stringify(font)}, ${JSON.stringify(String(digit))})`,
      );
      const rgba = Uint8Array.from(shot.data);
      const gray = toGray(rgba, shot.w, shot.h);
      const bin = binarize(gray, shot.w, shot.h);
      const boxes = digitBoxes(components(bin, shot.w, shot.h));
      if (boxes.length !== 1) {
        console.warn(`  건너뜀: ${font} "${digit}" — 덩어리 ${boxes.length}개`);
        continue;
      }
      const rows = gridToRows(normalize(cropBitmap(boxes[0], shot.w)));
      const key = `${digit}:${rows.join('')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      templates.push({ d: digit, rows });
    }
  }

  const json = {
    설명: '턴 숫자 대조용 템플릿. scripts/make-turn-templates.js 가 만든다 — 손으로 고치지 말 것.',
    size: [12, 20],
    templates,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(json, null, 1)}\n`, 'utf8');

  const perDigit = {};
  for (const t of templates) perDigit[t.d] = (perDigit[t.d] || 0) + 1;
  console.log(`템플릿 ${templates.length}개 저장 → ${path.relative(process.cwd(), OUT)}`);
  console.log(`숫자별 개수: ${JSON.stringify(perDigit)}`);

  app.exit(templates.length >= 10 ? 0 : 1);
});
