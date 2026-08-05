// 노션 렌더러 점검. 진짜 노션 대신 가짜 fetch를 끼워 넣어 돌린다.
//   node test/notion.test.js
'use strict';

const assert = require('node:assert');

process.env.NOTION_TOKEN = 'ntn_test';

const ROOT = '3ac73174ac3f809c9b6af4dfd5e54a95';
const P1 = '11111111111111111111111111111111';
const P2 = '22222222222222222222222222222222';
const P3 = '33333333333333333333333333333333';

const dashed = (hex) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

const heading = (level, text) => ({
  id: `h${level}-${text}`,
  type: `heading_${level}`,
  has_children: false,
  [`heading_${level}`]: { rich_text: [{ plain_text: text, annotations: {} }] },
});
const para = (text) => ({
  id: `p-${text}`,
  type: 'paragraph',
  has_children: false,
  paragraph: { rich_text: [{ plain_text: text, annotations: {} }] },
});
const childPage = (id, title) => ({
  id: dashed(id),
  type: 'child_page',
  has_children: true,
  child_page: { title },
});

// 도감이 "빌드마다 하위 페이지"인 구조를 흉내낸다.
const CHILDREN = {
  [dashed(ROOT)]: [
    heading(1, '파괴신'),
    childPage(P1, '파이 세인 4턴'),
    heading(1, '공성전'),
    heading(2, '수요일'),
    childPage(P2, '스파이크 4턴'),
    childPage(P3, '델론즈 속공'),
  ],
  [dashed(P1)]: [para('1턴: 세인 스킬'), para('2턴: 파이 궁')],
  [dashed(P2)]: [para('스파이크 / 카린')],
  [dashed(P3)]: [para('델론즈 / 아일린')],
};

let calls = 0;
global.fetch = async (url) => {
  calls += 1;
  const ok = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
  });

  const pageMatch = url.match(/\/v1\/pages\/([0-9a-f-]+)/i);
  if (pageMatch) {
    return ok({
      id: pageMatch[1],
      url: 'https://www.notion.so/PVE-도감',
      properties: { title: { type: 'title', title: [{ plain_text: 'PVE 빌드 도감', annotations: {} }] } },
    });
  }

  const blockMatch = url.match(/\/v1\/blocks\/([0-9a-f-]+)\/children/i);
  if (blockMatch) {
    const results = CHILDREN[blockMatch[1]] || [];
    return ok({ results, has_more: false, next_cursor: null });
  }

  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
};

const { fetchDocument, normalizePageId } = require('../src/notion');
const { buildsFromMarkdown } = require('../src/builds');

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

(async () => {
  test('normalizePageId가 노션 주소에서 ID만 뽑는다', () => {
    assert.strictEqual(
      normalizePageId('https://app.notion.com/p/brand-inq/PVE-3ac73174ac3f809c9b6af4dfd5e54a95'),
      dashed(ROOT),
    );
    assert.strictEqual(normalizePageId(ROOT), dashed(ROOT));
    assert.strictEqual(normalizePageId(dashed(ROOT)), dashed(ROOT));
  });

  test('ID가 없는 문자열은 null', () => {
    assert.strictEqual(normalizePageId('https://brand-inq.notion.site'), null);
    assert.strictEqual(normalizePageId(''), null);
    assert.strictEqual(normalizePageId(undefined), null);
  });

  const doc = await fetchDocument(ROOT);

  test('하위 페이지를 만난 자리에 펼쳐 넣는다', () => {
    const lines = doc.markdown.split('\n').filter(Boolean);
    assert.deepStrictEqual(lines, [
      '# 파괴신',
      '## 파이 세인 4턴',
      '1턴: 세인 스킬',
      '2턴: 파이 궁',
      '# 공성전',
      '## 수요일',
      '### 스파이크 4턴',
      '스파이크 / 카린',
      '### 델론즈 속공',
      '델론즈 / 아일린',
    ]);
  });

  test('페이지 수를 센다', () => {
    assert.strictEqual(doc.pageCount, 4);
    assert.strictEqual(doc.title, 'PVE 빌드 도감');
  });

  const builds = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });

  test('하위 페이지 빌드가 상위 카테고리를 물려받는다', () => {
    const d = builds.find((b) => b.name === '파이 세인 4턴');
    assert.ok(d, '파이 세인 4턴을 못 찾음');
    assert.strictEqual(d.category, '파괴신');
    assert.ok(d.body.includes('세인 스킬'), `본문: ${d.body}`);
  });

  test('하위 페이지 빌드가 요일까지 물려받는다', () => {
    const s = builds.find((b) => b.name === '스파이크 4턴');
    assert.ok(s, '스파이크 4턴을 못 찾음');
    assert.strictEqual(s.category, '공성전');
    assert.strictEqual(s.weekday, '수');
  });

  test('형제 하위 페이지가 서로 본문을 섞지 않는다', () => {
    const s = builds.find((b) => b.name === '스파이크 4턴');
    const d = builds.find((b) => b.name === '델론즈 속공');
    assert.ok(!s.body.includes('델론즈'), `스파이크 본문에 델론즈가 섞임: ${s.body}`);
    assert.ok(d.body.includes('아일린'), `델론즈 본문: ${d.body}`);
  });

  test('같은 페이지를 두 번 읽지 않는다', () => {
    assert.strictEqual(calls, 5, `요청 ${calls}회 (페이지1 + 블록4 예상)`);
  });

  console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
})();
