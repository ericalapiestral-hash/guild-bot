// 도감 파서·검색 자체 점검. 노션 없이 돌아간다.
//   npm test
'use strict';

const assert = require('node:assert');
const { buildsFromMarkdown, score, chosung, norm } = require('../src/builds');

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

// 실제 도감에서 나올 법한 두 가지 구조를 모두 흉내낸다.
const SAMPLE = `
# 공성전

## 월요일

### 파이 세인 3턴
- 파이 / 세인 / 루디
장비: 공격력 세팅

### 델론즈 속공
- 델론즈 / 아일린
장비: 속도 세팅

## 수요일

### 스파이크 4턴
- 스파이크 / 카린

# 파괴신

## 파이 세인 4턴
1턴: 세인 스킬
2턴: 파이 궁
![구성](https://example.com/a.png)

## 루디 크리스 5턴
루디 먼저

# 잡담
아무 내용
`;

const builds = buildsFromMarkdown(SAMPLE, { pageUrl: 'https://notion.so/x' });

test('공성전·파괴신 빌드를 모두 뽑아낸다', () => {
  const siege = builds.filter((b) => b.category === '공성전');
  const dest = builds.filter((b) => b.category === '파괴신');
  assert.ok(siege.length >= 3, `공성전 ${siege.length}개`);
  assert.ok(dest.length >= 2, `파괴신 ${dest.length}개`);
});

test('카테고리와 무관한 섹션(잡담)은 제외한다', () => {
  assert.ok(!builds.some((b) => b.name === '잡담'));
});

test('카테고리 최상위 헤딩 자체는 빌드가 아니다', () => {
  assert.ok(!builds.some((b) => b.name === '공성전' && b.path.length === 0));
  assert.ok(!builds.some((b) => b.name === '파괴신' && b.path.length === 0));
});

test('요일을 인식한다', () => {
  const b = builds.find((x) => x.name === '파이 세인 3턴');
  assert.ok(b, '파이 세인 3턴을 못 찾음');
  assert.strictEqual(b.weekday, '월');
});

test('본문을 붙여둔다', () => {
  const b = builds.find((x) => x.name === '델론즈 속공');
  assert.ok(b.body.includes('아일린'), `본문: ${JSON.stringify(b.body)}`);
});

test('이미지 URL을 뽑고 본문에서는 걷어낸다', () => {
  const b = builds.find((x) => x.name === '파이 세인 4턴');
  assert.strictEqual(b.image, 'https://example.com/a.png');
  assert.ok(!b.body.includes('!['), `본문에 이미지가 남음: ${b.body}`);
});

test('같은 이름이 카테고리별로 따로 잡힌다', () => {
  const siege3 = builds.find((b) => b.category === '공성전' && b.name === '파이 세인 3턴');
  const dest4 = builds.find((b) => b.category === '파괴신' && b.name === '파이 세인 4턴');
  assert.ok(siege3 && dest4);
});

// ─── 검색 점수

const dest4 = builds.find((b) => b.category === '파괴신' && b.name === '파이 세인 4턴');
const dest5 = builds.find((b) => b.category === '파괴신' && b.name === '루디 크리스 5턴');

test('정확한 이름이 가장 높은 점수를 받는다', () => {
  assert.ok(score(dest4, '파이 세인 4턴') > score(dest5, '파이 세인 4턴'));
});

test('띄어쓰기를 무시하고 찾는다', () => {
  assert.ok(score(dest4, '파이세인4턴') > 0);
});

test('토큰이 하나라도 없으면 제외한다', () => {
  assert.strictEqual(score(dest4, '파이 없는단어'), 0);
});

test('초성으로도 찾는다', () => {
  assert.ok(score(dest4, 'ㅍㅇㅅㅇ') > 0, '초성 검색 실패');
  assert.strictEqual(score(dest5, 'ㅍㅇㅅㅇ'), 0);
});

test('검색어가 비면 전부 통과시킨다 (자동완성 초기 목록)', () => {
  assert.ok(score(dest4, '') > 0);
  assert.ok(score(dest5, '   ') > 0);
});

test('부분 검색어로도 찾는다', () => {
  assert.ok(score(dest4, '4턴') > 0);
  assert.ok(score(dest5, '루디') > 0);
});

// ─── 유틸

test('chosung이 한글만 초성으로 바꾼다', () => {
  assert.strictEqual(chosung('파이 세인 4턴'), 'ㅍㅇ ㅅㅇ 4ㅌ');
});

test('norm이 공백·구두점을 없앤다', () => {
  assert.strictEqual(norm(' 파이 / 세인 (4턴) '), '파이세인4턴');
});

// ─── 자동완성 값 왕복

test('자동완성 value(label)로 다시 검색하면 같은 빌드가 1등이다', () => {
  for (const b of builds) {
    const value = (b.label || b.name).slice(0, 100);
    const ranked = builds
      .filter((x) => x.category === b.category)
      .map((x) => ({ x, s: score(x, value) }))
      .filter((r) => r.s > 0)
      .sort((p, q) => q.s - p.s);
    assert.ok(ranked.length > 0, `"${value}" 검색 결과 없음`);
    assert.strictEqual(ranked[0].x.name, b.name, `"${value}" → ${ranked[0].x.name}`);
  }
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
