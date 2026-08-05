// 도감 파서·검색 자체 점검. 노션 없이 돌아간다.
//   npm test
'use strict';

const assert = require('node:assert');
const {
  buildsFromMarkdown,
  detectWeekdays,
  score,
  chosung,
  norm,
} = require('../src/builds');

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

const names = (list) => list.map((b) => b.name).sort();
const of = (list, name) => list.find((b) => b.name === name);

// 실제 도감에서 나올 법한 구조를 흉내낸다.
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
const siege = builds.filter((b) => b.category === '공성전');
const dest = builds.filter((b) => b.category === '파괴신');

// ─── 파싱

test('실제 빌드만 정확히 뽑아낸다 (개수·이름 단언)', () => {
  assert.deepStrictEqual(names(siege), ['델론즈 속공', '스파이크 4턴', '파이 세인 3턴'].sort());
  assert.deepStrictEqual(names(dest), ['루디 크리스 5턴', '파이 세인 4턴'].sort());
});

test('내용 없는 중간 헤딩(월요일·수요일)은 빌드가 아니다', () => {
  assert.ok(!builds.some((b) => b.name === '월요일'), '월요일이 빌드로 잡힘');
  assert.ok(!builds.some((b) => b.name === '수요일'), '수요일이 빌드로 잡힘');
});

test('카테고리 헤딩 자체와 무관한 섹션은 제외한다', () => {
  assert.ok(!builds.some((b) => b.name === '공성전'));
  assert.ok(!builds.some((b) => b.name === '파괴신'));
  assert.ok(!builds.some((b) => b.name === '잡담'));
});

test('형제 빌드의 본문이 서로 섞이지 않는다', () => {
  assert.ok(of(siege, '파이 세인 3턴').body.includes('루디'));
  assert.ok(!of(siege, '파이 세인 3턴').body.includes('델론즈'), '옆 빌드 본문이 섞임');
  assert.ok(of(siege, '델론즈 속공').body.includes('아일린'));
});

test('요일을 인식한다', () => {
  assert.deepStrictEqual(of(siege, '파이 세인 3턴').weekdays, ['월']);
  assert.deepStrictEqual(of(siege, '스파이크 4턴').weekdays, ['수']);
  assert.deepStrictEqual(of(dest, '파이 세인 4턴').weekdays, []);
});

test('이미지 URL을 뽑고 본문에서는 걷어낸다', () => {
  const b = of(dest, '파이 세인 4턴');
  assert.strictEqual(b.image, 'https://example.com/a.png');
  assert.ok(!b.body.includes('!['), `본문에 이미지가 남음: ${b.body}`);
});

test('라벨에서 카테고리는 빼고 나머지 경로는 남긴다', () => {
  assert.strictEqual(of(siege, '파이 세인 3턴').label, '월요일 › 파이 세인 3턴');
  assert.strictEqual(of(dest, '파이 세인 4턴').label, '파이 세인 4턴');
});

test('빌드마다 유일한 자동완성 키가 붙는다', () => {
  const ids = builds.map((b) => b.id);
  assert.strictEqual(new Set(ids).size, ids.length, '키가 겹침');
  for (const id of ids) {
    assert.ok(id.startsWith('#') && id.length <= 100, `잘못된 키: ${id}`);
  }
});

// ─── 리뷰에서 나온 회귀 케이스

test('표의 "#" 번호 열을 헤딩으로 오인하지 않는다', () => {
  const withTable = `
# 공성전
## 수요일
### 표 빌드
# | 조합 | 턴수
1 | 파이 | 4
### 다음 빌드
내용 있음
`;
  const parsed = buildsFromMarkdown(withTable);
  assert.deepStrictEqual(names(parsed), ['다음 빌드', '표 빌드'].sort());
  assert.strictEqual(of(parsed, '표 빌드').category, '공성전');
  assert.deepStrictEqual(of(parsed, '표 빌드').weekdays, ['수']);
});

test('빌드 이름에 다른 모드 이름이 들어가도 카테고리가 뒤집히지 않는다', () => {
  const tricky = `
# 공성전
## 월요일
### 파괴신 카운터 조합
내용
# 파괴신
## 시즌 3
### 공성 겸용 덱
내용
`;
  const parsed = buildsFromMarkdown(tricky);
  assert.strictEqual(of(parsed, '파괴신 카운터 조합').category, '공성전');
  assert.strictEqual(of(parsed, '공성 겸용 덱').category, '파괴신');
});

test('빌드 아래 세부 섹션은 따로 빌드가 되지 않고 본문에 합쳐진다', () => {
  const nested = `
# 파괴신
## 파이 세인 4턴
공략 요약
### 1턴
세인 스킬
### 2턴
파이 궁
`;
  const parsed = buildsFromMarkdown(nested);
  assert.deepStrictEqual(names(parsed), ['파이 세인 4턴']);
  const b = of(parsed, '파이 세인 4턴');
  assert.ok(b.body.includes('세인 스킬') && b.body.includes('파이 궁'), `본문: ${b.body}`);
});

test('카테고리 루트 이름이 달라도 빌드로 새지 않는다', () => {
  const parsed = buildsFromMarkdown(`
# 🏰 공성전 도감
이 문서는 공성전 빌드를 모아둔 곳입니다.
## 수요일
### 방어덱
내용
`);
  assert.deepStrictEqual(names(parsed), ['방어덱']);
});

test('주차가 다른 동명 빌드가 라벨로 구분된다', () => {
  const parsed = buildsFromMarkdown(`
# 공성전 1주차
## 수요일
### 마법사 조합
1주차 내용
# 공성전 2주차
## 수요일
### 마법사 조합
2주차 내용
`);
  assert.strictEqual(parsed.length, 2);
  assert.notStrictEqual(parsed[0].label, parsed[1].label, `라벨이 겹침: ${parsed[0].label}`);
  assert.notStrictEqual(parsed[0].id, parsed[1].id);
});

test('카테고리 이름·초성이 검색어일 때 전부 걸리지 않는다', () => {
  for (const b of siege) {
    assert.strictEqual(score(b, '공성'), 0, `"공성"에 ${b.name}이 걸림`);
    assert.strictEqual(score(b, 'ㄱㅅ'), 0, `"ㄱㅅ"에 ${b.name}이 걸림`);
  }
});

test('서로 다른 빌드의 본문 조각을 합친 가짜 결과가 나오지 않는다', () => {
  for (const b of siege) {
    assert.strictEqual(score(b, '파이 델론즈'), 0, `${b.name}이 가짜로 걸림`);
  }
});

// ─── 요일 파싱

test('요일 표기를 폭넓게 인식한다', () => {
  assert.deepStrictEqual(detectWeekdays(['수요일']), ['수']);
  assert.deepStrictEqual(detectWeekdays(['일요일']), ['일']);
  assert.deepStrictEqual(detectWeekdays(['수']), ['수']);
  assert.deepStrictEqual(detectWeekdays(['월·목요일']), ['월', '목']);
  assert.deepStrictEqual(detectWeekdays(['월, 목요일 방어덱']), ['월', '목']);
  assert.deepStrictEqual(detectWeekdays(['월~수요일']), ['월', '화', '수']);
});

test('요일이 아닌 헤딩에서 요일을 만들어내지 않는다', () => {
  assert.deepStrictEqual(detectWeekdays(['월드보스']), []);
  assert.deepStrictEqual(detectWeekdays(['3그룹 보스']), []);
  assert.deepStrictEqual(detectWeekdays([]), []);
});

// ─── 검색 점수

const dest4 = of(dest, '파이 세인 4턴');
const dest5 = of(dest, '루디 크리스 5턴');

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

test('본문에만 있는 단어로도 찾는다', () => {
  assert.ok(score(of(siege, '파이 세인 3턴'), '루디') > 0);
});

test('검색어가 비면 전부 통과시킨다 (목록 표시용)', () => {
  assert.ok(score(dest4, '') > 0);
  assert.ok(score(dest5, '   ') > 0);
});

test('긴 본문의 뒷부분도 검색에 걸린다', () => {
  const filler = '가나다라마바사아자차 '.repeat(600); // 약 6600자
  const parsed = buildsFromMarkdown(`
# 파괴신
## 긴 빌드
${filler}
크리스티나 마무리
`);
  const b = of(parsed, '긴 빌드');
  assert.ok(b.body.includes('크리스티나'));
  assert.ok(score(b, '크리스티나') > 0, '본문 뒷부분이 검색에서 누락됨');
});

test('자동완성에 뜬 라벨을 직접 쳐도 같은 빌드가 1등이다', () => {
  for (const b of builds) {
    const same = builds.filter((x) => x.category === b.category);
    const ranked = same
      .map((x) => ({ x, s: score(x, b.label) }))
      .filter((r) => r.s > 0)
      .sort((p, q) => q.s - p.s);
    assert.ok(ranked.length > 0, `"${b.label}" 검색 결과 없음`);
    assert.strictEqual(ranked[0].x.name, b.name, `"${b.label}" → ${ranked[0].x.name}`);
  }
});

// ─── 유틸

test('chosung이 한글만 초성으로 바꾼다', () => {
  assert.strictEqual(chosung('파이 세인 4턴'), 'ㅍㅇ ㅅㅇ 4ㅌ');
});

test('norm이 공백·구두점을 없앤다', () => {
  assert.strictEqual(norm(' 파이 / 세인 (4턴) '), '파이세인4턴');
  assert.strictEqual(norm('월요일 › 파이'), '월요일파이');
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
