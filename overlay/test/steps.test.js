// 스킬 순서 파서 점검 — 실제 도감 캐시(builds.json)가 있으면 그것까지 검사한다.
//   node test/steps.test.js
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseSteps,
  groupVariants,
  flatten,
  indexForTurn,
  nextIndexForTurn,
  nextIndexAfterGap,
} = require('../lib/steps');

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

// ─── 기본 형태 (실제 도감에서 그대로 가져온 모양)

const SAMPLE = `
# 세팅
- 나타 (속공 33)
## 스킬 순서
> 턴수는 참고만
### 1라운드
\`0턴\`비스킷 아래 / \`4턴\`나타 아래
### 2라운드
\`4턴\`비스킷 위 / \`8턴\`클로에 위 (\`9턴\`미호 평타로 클리어)
### 3라운드
\`9턴\`리나 위 /
# 다른 섹션
\`99턴\` 이건 스킬 순서 밖이라 무시
`;

const { segments } = parseSteps(SAMPLE);

test('라운드별로 세그먼트를 나눈다', () => {
  assert.deepStrictEqual(
    segments.map((s) => s.label),
    ['1라운드', '2라운드', '3라운드'],
  );
});

test('턴과 액션을 정확히 뽑는다', () => {
  assert.deepStrictEqual(segments[0].steps, [
    { turn: 0, text: '비스킷 아래' },
    { turn: 4, text: '나타 아래' },
  ]);
});

test('괄호 속 마커도 잡고 잔여 기호는 걷어낸다', () => {
  assert.deepStrictEqual(segments[1].steps, [
    { turn: 4, text: '비스킷 위' },
    { turn: 8, text: '클로에 위' },
    { turn: 9, text: '미호 평타로 클리어' },
  ]);
});

test('끝에 슬래시만 남은 줄도 처리한다', () => {
  assert.deepStrictEqual(segments[2].steps, [{ turn: 9, text: '리나 위' }]);
});

test('스킬 순서 섹션 밖의 턴 마커는 무시한다', () => {
  const all = segments.flatMap((s) => s.steps.map((x) => x.turn));
  assert.ok(!all.includes(99));
});

// ─── 분기 (2라운드가 두 번)

const BRANCH = `
## 스킬 순서
### 1라운드
\`0턴\`소교 위 / \`4턴\`파스칼 위
### 2라운드 (4턴)
\`4턴\`헤브 위 / \`8턴\`샤오 아래
### 2라운드 (8턴)
\`8턴\`헤브 위 / \`12턴\`샤오 아래
`;

const bGroups = groupVariants(parseSteps(BRANCH).segments);

test('같은 라운드 번호는 변형으로 묶는다', () => {
  assert.strictEqual(bGroups.length, 2);
  assert.strictEqual(bGroups[0].variants.length, 1);
  assert.strictEqual(bGroups[1].variants.length, 2);
  assert.deepStrictEqual(
    bGroups[1].variants.map((v) => v.label),
    ['2라운드 (4턴)', '2라운드 (8턴)'],
  );
});

test('변형 선택에 따라 다른 줄기가 펼쳐진다', () => {
  const a = flatten(bGroups, { 1: 0 });
  const b = flatten(bGroups, { 1: 1 });
  assert.deepStrictEqual(a.map((s) => s.turn), [0, 4, 4, 8]);
  assert.deepStrictEqual(b.map((s) => s.turn), [0, 4, 8, 12]);
});

// ─── 턴 → 단계 인덱스

const FLOW = flatten(bGroups, {});

test('인식된 턴보다 크거나 같은 첫 단계가 현재다', () => {
  assert.strictEqual(indexForTurn(FLOW, 0), 0);
  assert.strictEqual(indexForTurn(FLOW, 1), 1); // 0턴은 지났고 4턴이 다음
  assert.strictEqual(indexForTurn(FLOW, 4), 1); // 같은 4턴 중 첫 번째
  assert.strictEqual(indexForTurn(FLOW, 5), 3);
  assert.strictEqual(indexForTurn(FLOW, 999), FLOW.length - 1); // 전부 지나면 마지막
});

test('빈 목록은 0', () => {
  assert.strictEqual(indexForTurn([], 5), 0);
});

// ─── 라운드마다 턴이 리셋되는 빌드 (델론즈 유형)

const RESET = flatten(
  groupVariants(
    parseSteps(`
## 스킬 순서
### 1라운드
\`0턴\`라이언 아래
### 2라운드
\`0턴\`돼오 아래
### 3라운드
\`0턴\`레이첼 위 / \`4턴\`비스킷 아래 / \`8턴\`라이언 위
`).segments,
  ),
  {},
);

test('턴 리셋 빌드: 라운드를 건너뛰며 앞으로 진행한다', () => {
  // RESET = [R1:0] [R2:0] [R3:0,4,8]
  // 1라운드 0턴에서 시작
  assert.strictEqual(nextIndexForTurn(RESET, 0, 0), 0);
  // 0으로 다시 리셋돼도 제자리 (0턴끼리는 카운터로 구분 불가 — 창에 다음 라운드 0턴이 같이 보인다)
  assert.strictEqual(nextIndexForTurn(RESET, 0, 0), 0);
  // 카운터가 3이면 R1·R2의 턴(최대 0)은 전부 지난 것 — R3의 4턴으로
  assert.strictEqual(nextIndexForTurn(RESET, 0, 3), 3);
  // 2라운드 위치에서 4가 읽혀도 같은 결론
  assert.strictEqual(nextIndexForTurn(RESET, 1, 4), 3);
  // 3라운드 안에서는 카운터를 그대로 따라간다
  assert.strictEqual(nextIndexForTurn(RESET, 2, 4), 3);
  assert.strictEqual(nextIndexForTurn(RESET, 3, 7), 4);
});

test('전역 카운터 빌드: 라운드가 넘어가도 이어서 따라간다', () => {
  // FLOW = [1라: 0, 4] [2라(4턴): 4, 8]
  assert.strictEqual(nextIndexForTurn(FLOW, 0, 4), 1); // 같은 4턴 중 첫 번째
  assert.strictEqual(nextIndexForTurn(FLOW, 1, 6), 3); // 1라는 지났고 2라의 8턴
  assert.strictEqual(nextIndexForTurn(FLOW, 3, 999), 3); // 끝 유지
  // 턴이 현재 라운드 시작(4턴)보다 작아지면 전투 재시작 — 처음부터 다시
  assert.strictEqual(nextIndexForTurn(FLOW, 3, 0), 0);
  assert.strictEqual(nextIndexForTurn(FLOW, 2, 0), 0);
  // 현재 라운드 범위 안이면 재시작이 아니다
  assert.strictEqual(nextIndexForTurn(FLOW, 3, 5), 3);
});

// ─── 턴 표시가 사라졌다 돌아오는 경우 (스킬 연출 · 라운드 전환)

test('턴이 사라졌다 같은 값으로 돌아오면 다음 라운드로 넘어간다', () => {
  // RESET = [R1:0] [R2:0] [R3:0,4,8] — 라운드마다 0으로 리셋되는 빌드
  assert.strictEqual(nextIndexAfterGap(RESET, 0, 0), 1, 'R1 0턴 → R2 0턴');
  assert.strictEqual(nextIndexAfterGap(RESET, 1, 0), 2, 'R2 0턴 → R3 0턴');
});

test('라운드에 남은 단계가 있으면 연출로 보고 제자리를 지킨다', () => {
  // R3의 첫 단계(0턴)에서 스킬 연출로 잠깐 사라진 것 — 뒤에 4턴·8턴이 남아 있다
  assert.strictEqual(nextIndexAfterGap(RESET, 2, 0), 2);
});

test('사라진 사이에 턴이 올라갔으면 평소대로 따라간다', () => {
  assert.strictEqual(nextIndexAfterGap(RESET, 2, 3), 3);
  assert.strictEqual(nextIndexAfterGap(FLOW, 0, 4), 1);
});

test('마지막 라운드에서는 넘길 곳이 없으니 그대로 둔다', () => {
  const last = RESET.length - 1;
  assert.strictEqual(nextIndexAfterGap(RESET, last, 8), last);
});

test('전역 카운터 빌드도 라운드 끝에서 같은 턴이 돌아오면 다음 라운드로', () => {
  // FLOW = [1라: 0, 4] [2라(4턴): 4, 8] — 1라 마지막(4턴)에서 4가 다시 보이면 라운드가 바뀐 것
  assert.strictEqual(nextIndexAfterGap(FLOW, 1, 4), 2);
  // 라운드 중간(0턴)에서는 건드리지 않는다
  assert.strictEqual(nextIndexAfterGap(FLOW, 0, 0), 0);
});

test('빈 목록·범위 밖 인덱스에도 안전하다', () => {
  assert.strictEqual(nextIndexAfterGap([], 0, 5), 0);
  // 범위 밖 인덱스는 마지막으로 보정되고, 그다음은 평소 규칙을 그대로 탄다
  assert.strictEqual(
    nextIndexAfterGap(RESET, 999, 0),
    nextIndexForTurn(RESET, RESET.length - 1, 0),
  );
});

test('각주의 턴 마커(라운드 안 역행)는 단계로 넣지 않는다', () => {
  const noted = parseSteps(`
## 스킬 순서
### 3라운드
\`60턴\`라이언 위 / \`64턴\`선란 아래 / \`68턴\`선란 위
> *사신강림을 안 쓰면 \`48턴\`돼오 아래 / \`52턴\`라이언 아래
`).segments;
  assert.deepStrictEqual(
    noted[0].steps.map((s) => s.turn),
    [60, 64, 68],
    '각주 48·52턴이 단계로 흡수됨',
  );
});

test('스킬 순서 섹션이 여러 개면 라벨에 구분자가 붙는다', () => {
  const multi = parseSteps(`
## 스킬 순서 (안전형)
### 1라운드
\`0턴\`A 위
## 스킬 순서 (고점형)
### 1라운드
\`0턴\`B 위
`).segments;
  assert.strictEqual(multi.length, 2);
  assert.notStrictEqual(multi[0].label, multi[1].label, `라벨이 같음: ${multi[0].label}`);
  const grouped = groupVariants(multi);
  assert.strictEqual(grouped[0].variants.length, 2);
});

// ─── 실제 도감 캐시가 있으면 전수 검사

const CACHE = path.join(__dirname, '..', '..', 'data', 'builds.json');
if (fs.existsSync(CACHE)) {
  const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));

  test(`실데이터 ${raw.builds.length}개 빌드 전부에서 스킬 순서를 뽑는다`, () => {
    for (const b of raw.builds) {
      const groups = groupVariants(parseSteps(b.body).segments);
      const steps = flatten(groups, {});
      assert.ok(steps.length >= 3, `${b.name}: 단계 ${steps.length}개뿐`);
      for (const s of steps) {
        assert.ok(Number.isInteger(s.turn) && s.turn >= 0, `${b.name}: 턴 이상 ${s.turn}`);
        assert.ok(s.text.length > 0 && s.text.length < 60, `${b.name}: 액션 이상 "${s.text}"`);
      }
    }
  });

  test('실데이터: 어느 빌드에서든 어떤 턴을 읽어도 인덱스가 범위를 벗어나지 않는다', () => {
    for (const b of raw.builds) {
      const groups = groupVariants(parseSteps(b.body).segments);
      const steps = flatten(groups, {});
      for (let cur = 0; cur < steps.length; cur += 1) {
        for (const t of [0, 1, 4, 9, 16, 35, 68, 70, 120]) {
          const next = nextIndexForTurn(steps, cur, t);
          assert.ok(next >= 0 && next < steps.length, `${b.name}: cur=${cur} t=${t} → ${next}`);
        }
      }
    }
  });

  test('실데이터: 델론즈(리셋형) 빌드에서 리셋 진행이 자연스럽다', () => {
    const b = raw.builds.find(
      (x) => x.name.includes('델론즈') && x.name.includes('선란') && x.category === '공성전',
    );
    if (!b) return; // 도감이 바뀌었으면 건너뜀
    const steps = flatten(groupVariants(parseSteps(b.body).segments), {});
    // [0] 1라 0턴 → [1] 2라 0턴 → [2] 3라 0턴 4턴 8턴 …
    assert.strictEqual(steps[0].turn, 0);
    const r3 = steps.findIndex((s, i) => i > 1 && s.turn === 0);
    assert.ok(r3 > 1);
    // 0턴 자리에서는 제자리
    assert.strictEqual(nextIndexForTurn(steps, 0, 0), 0);
    // 카운터가 2가 되면 0턴짜리 라운드들은 지난 것 — 3라운드 4턴이 다음
    assert.strictEqual(nextIndexForTurn(steps, 0, 2), r3 + 1);
    // 3라운드 안에서는 카운터를 그대로 따라간다
    assert.strictEqual(nextIndexForTurn(steps, r3, 4), r3 + 1);
    assert.strictEqual(nextIndexForTurn(steps, r3 + 1, 10), r3 + 3);
  });
} else {
  console.log('  (data/builds.json이 없어 실데이터 검사는 건너뜀)');
}

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
