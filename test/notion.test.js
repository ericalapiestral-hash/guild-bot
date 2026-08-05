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
const toggle = (id, text) => ({
  id,
  type: 'toggle',
  has_children: true,
  toggle: { rich_text: [{ plain_text: text, annotations: {} }] },
});
const childPage = (id, title) => ({
  id: dashed(id),
  type: 'child_page',
  has_children: true,
  child_page: { title },
});
const table = (id) => ({ id, type: 'table', has_children: true, table: {} });
const row = (cells) => ({
  id: `row-${cells[0]}`,
  type: 'table_row',
  has_children: false,
  table_row: { cells: cells.map((c) => [{ plain_text: c, annotations: {} }]) },
});

/** 현재 문서의 블록 트리 — 테스트마다 갈아끼운다 */
let CHILDREN = {};
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
      properties: {
        title: { type: 'title', title: [{ plain_text: 'PVE 빌드 도감', annotations: {} }] },
      },
    });
  }

  const blockMatch = url.match(/\/v1\/blocks\/([0-9a-f-]+|[^/]+)\/children/i);
  if (blockMatch) {
    const key = decodeURIComponent(blockMatch[1]);
    return ok({ results: CHILDREN[key] || [], has_more: false, next_cursor: null });
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

const of = (list, name) => list.find((b) => b.name === name);

(async () => {
  // ─── 페이지 ID 정규화

  test('normalizePageId가 노션 주소에서 ID만 뽑는다', () => {
    assert.strictEqual(
      normalizePageId('https://app.notion.com/p/brand-inq/PVE-3ac73174ac3f809c9b6af4dfd5e54a95'),
      dashed(ROOT),
    );
    assert.strictEqual(normalizePageId(ROOT), dashed(ROOT));
    assert.strictEqual(normalizePageId(dashed(ROOT)), dashed(ROOT));
  });

  test('주소 슬러그가 16진수로 끝나도 ID를 뒤섞지 않는다', () => {
    assert.strictEqual(
      normalizePageId('https://www.notion.so/PVE-20240101-1a2b3c4d5e6f7890abcdef1234567890'),
      '1a2b3c4d-5e6f-7890-abcd-ef1234567890',
    );
    assert.strictEqual(
      normalizePageId('https://www.notion.so/deadbeef-3ac73174ac3f809c9b6af4dfd5e54a95'),
      dashed(ROOT),
    );
  });

  test('ID가 없는 문자열은 null', () => {
    assert.strictEqual(normalizePageId('https://brand-inq.notion.site'), null);
    assert.strictEqual(normalizePageId(''), null);
    assert.strictEqual(normalizePageId(undefined), null);
  });

  // ─── 하위 페이지를 제자리에 펼치기

  CHILDREN = {
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
  calls = 0;
  const doc = await fetchDocument(ROOT);

  test('하위 페이지를 만난 자리에 펼쳐 넣는다', () => {
    assert.deepStrictEqual(doc.markdown.split('\n').filter(Boolean), [
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

  test('페이지 수를 세고 같은 페이지를 두 번 읽지 않는다', () => {
    assert.strictEqual(doc.pageCount, 4);
    assert.strictEqual(doc.title, 'PVE 빌드 도감');
    assert.strictEqual(calls, 5, `요청 ${calls}회 (페이지1 + 블록4 예상)`);
  });

  const builds = buildsFromMarkdown(doc.markdown, { pageUrl: doc.pageUrl });

  test('하위 페이지 빌드가 카테고리와 요일을 물려받는다', () => {
    const d = of(builds, '파이 세인 4턴');
    assert.strictEqual(d.category, '파괴신');
    assert.ok(d.body.includes('세인 스킬'), `본문: ${d.body}`);

    const s = of(builds, '스파이크 4턴');
    assert.strictEqual(s.category, '공성전');
    assert.deepStrictEqual(s.weekdays, ['수']);
  });

  test('형제 하위 페이지가 서로 본문을 섞지 않는다', () => {
    assert.ok(!of(builds, '스파이크 4턴').body.includes('델론즈'));
    assert.ok(of(builds, '델론즈 속공').body.includes('아일린'));
  });

  // ─── 토글 안의 하위 페이지 (리뷰 회귀)

  CHILDREN = {
    [dashed(ROOT)]: [heading(1, '공성전'), toggle('tg-수요일', '수요일')],
    'tg-수요일': [childPage(P2, '스파이크 4턴')],
    [dashed(P2)]: [para('스파이크 / 카린')],
  };
  const toggleDoc = await fetchDocument(ROOT);

  test('토글 안에 있는 하위 페이지도 바깥 헤딩 문맥을 유지한다', () => {
    assert.ok(
      toggleDoc.markdown.includes('## 스파이크 4턴'),
      `헤딩 레벨이 어긋남:\n${toggleDoc.markdown}`,
    );
    const parsed = buildsFromMarkdown(toggleDoc.markdown);
    const s = of(parsed, '스파이크 4턴');
    assert.ok(s, '토글 안 빌드가 사라짐');
    assert.strictEqual(s.category, '공성전');
  });

  // ─── 표

  CHILDREN = {
    [dashed(ROOT)]: [heading(1, '파괴신'), heading(2, '표 빌드'), table('tb-1')],
    'tb-1': [row(['#', '조합', '턴수']), row(['1', '파이', '4'])],
  };
  const tableDoc = await fetchDocument(ROOT);

  test('표 행이 헤딩으로 오인되지 않게 앞에 |를 붙인다', () => {
    assert.ok(tableDoc.markdown.includes('| # | 조합 | 턴수'), tableDoc.markdown);
    const parsed = buildsFromMarkdown(tableDoc.markdown);
    assert.deepStrictEqual(parsed.map((b) => b.name), ['표 빌드']);
    assert.ok(of(parsed, '표 빌드').body.includes('조합'));
  });

  // ─── 헤딩 6단계를 넘는 깊은 중첩

  CHILDREN = {
    [dashed(ROOT)]: [heading(3, '공성전'), childPage(P1, '수요일 모음')],
    [dashed(P1)]: [heading(3, '추천'), childPage(P2, '스파이크 4턴')],
    [dashed(P2)]: [para('스파이크 / 카린')],
  };
  const deepDoc = await fetchDocument(ROOT);

  test('헤딩이 6단계에 닿아도 하위 페이지 내용을 계속 읽는다', () => {
    assert.ok(
      deepDoc.markdown.includes('스파이크 / 카린'),
      `깊은 페이지 본문이 사라짐:\n${deepDoc.markdown}`,
    );
    const parsed = buildsFromMarkdown(deepDoc.markdown);
    const s = of(parsed, '스파이크 4턴');
    assert.ok(s, '깊은 빌드가 사라짐');
    assert.strictEqual(s.category, '공성전');
    assert.deepStrictEqual(s.weekdays, ['수']);
  });

  console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
})();
