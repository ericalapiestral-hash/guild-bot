// 빌드 본문(마크다운) → 스킬 순서 단계 목록.
// 도감 형식: "## 스킬 순서" 아래 "### N라운드" 헤딩, 단계는 `N턴`액션 을 ' / '로 나열.
// "### 2라운드 (4턴)" / "### 2라운드 (8턴)" 처럼 같은 라운드가 두 번 나오면 변형(분기)이다.
'use strict';

/** 헤딩에서 라운드 번호를 뽑는다. "2라운드 (4턴)" → 2 */
function roundOf(title) {
  const m = String(title).match(/(\d+)\s*라운드/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {{segments: Array<{label: string, round: number|null, steps: Array<{turn: number, text: string}>}>}}
 *   segments는 문서 순서 그대로. 라운드 번호가 겹치는 세그먼트는 변형(둘 중 하나만 진행).
 */
function parseSteps(body) {
  const lines = String(body ?? '').split('\n');
  const segments = [];
  let current = null; // 지금 쌓고 있는 세그먼트
  let inOrder = false; // "스킬 순서" 섹션 안인지
  let orderLevel = 0; // 스킬 순서 헤딩의 깊이 (같거나 얕은 헤딩이 오면 섹션 끝)
  let sectionTag = ''; // "스킬 순서 (고점형)" 처럼 섹션 제목에 붙은 구분자

  const push = (label, round) => {
    // 같은 빌드에 스킬 순서 섹션이 여러 개면(안전형/고점형 등) 라벨에 구분자를 붙인다.
    // 안 붙이면 변형 칩이 똑같은 글자 두 개가 되어 구분할 수 없다.
    current = { label: sectionTag ? `${label} — ${sectionTag}` : label, round, steps: [], closed: false };
    segments.push(current);
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();

      if (/스킬\s*순서/.test(title)) {
        inOrder = true;
        orderLevel = level;
        current = null;
        sectionTag = title
          .replace(/스킬\s*순서/, '')
          .replace(/[*_`#()[\]]/g, ' ')
          .replace(/^[\s:—–-]+|[\s:—–-]+$/g, '')
          .trim();
        continue;
      }
      if (!inOrder) continue;

      const round = roundOf(title);
      if (round !== null) {
        push(title, round);
      } else if (level <= orderLevel) {
        inOrder = false; // 스킬 순서 섹션이 끝났다
        current = null;
      }
      // 스킬 순서 안의 라운드가 아닌 하위 헤딩은 무시하고 계속 본다
      continue;
    }

    if (!inOrder) continue;

    // `N턴`액션 추출 — 항목은 ' / '로 구분되지만 마커 기준으로 자르는 게 안전하다
    for (const m of line.matchAll(/`(\d+)\s*턴`\s*([^/`\n]*)/g)) {
      const text = m[2].replace(/[()*\s/]+$/g, '').trim();
      if (!text) continue;
      if (!current) push('스킬 순서', null); // 라운드 헤딩 없이 바로 단계가 나오는 경우
      if (current.closed) continue;
      const turn = Number(m[1]);
      // 라운드 안에서 턴은 내려가지 않는다. 내려가는 마커가 나오면 그건 본문 아래의
      // 각주/조건부 대안(예: "*46턴에 사신강림을 안 쓰면 48턴에…")이다 — 단계로 넣지 않는다.
      if (current.steps.length > 0 && turn < current.steps[current.steps.length - 1].turn) {
        current.closed = true;
        continue;
      }
      current.steps.push({ turn, text });
    }
  }

  for (const s of segments) delete s.closed;
  return { segments: segments.filter((s) => s.steps.length > 0) };
}

/**
 * 세그먼트를 "변형 그룹"으로 묶는다. 같은 라운드 번호가 여러 번 나오면 그 자리부터 변형이다.
 * @returns {Array<{round: number|null, variants: Array<{label: string, steps: array}>}>}
 */
function groupVariants(segments) {
  const groups = [];
  const byRound = new Map();
  for (const seg of segments) {
    const key = seg.round === null ? `_${groups.length}` : `r${seg.round}`;
    if (seg.round !== null && byRound.has(key)) {
      byRound.get(key).variants.push({ label: seg.label, steps: seg.steps });
      continue;
    }
    const group = { round: seg.round, variants: [{ label: seg.label, steps: seg.steps }] };
    groups.push(group);
    if (seg.round !== null) byRound.set(key, group);
  }
  return groups;
}

/**
 * 변형 선택(그룹 인덱스 → 변형 인덱스)에 따라 한 줄로 펼친다.
 * @returns {Array<{turn: number, text: string, label: string}>}
 */
function flatten(groups, picks = {}) {
  const out = [];
  groups.forEach((group, gi) => {
    const pick = Math.min(picks[gi] ?? 0, group.variants.length - 1);
    const variant = group.variants[pick];
    for (const step of variant.steps) {
      out.push({ turn: step.turn, text: step.text, label: variant.label });
    }
  });
  return out;
}

/** 같은 라벨(라운드)이 이어지는 구간들의 [시작, 끝] 목록 */
function segmentRanges(steps) {
  const ranges = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i += 1) {
    if (i === steps.length || steps[i].label !== steps[start].label) {
      ranges.push([start, i - 1]);
      start = i;
    }
  }
  return ranges;
}

/**
 * 인식된 턴 숫자로 다음 단계를 고른다.
 *
 * 도감 표기가 두 가지라 둘 다 처리해야 한다:
 *  - 턴이 문서 전체에서 이어지는 빌드 (…16턴 | 16턴…)
 *  - 라운드마다 턴이 0부터 다시 시작하는 빌드 (0턴 | 0턴 | 0턴 4턴 8턴…)
 *
 * 라운드(라벨) 구간을 앞에서부터 훑되:
 *  - 현재 라운드부터 시작한다 (현재 라운드 안에서는 되돌아갈 수 있다 — 전투 재시작 대응)
 *  - 어떤 라운드에 "턴 >= t"인 단계가 있으면 그중 첫 번째가 다음 행동이다
 *  - 라운드의 최대 턴이 t보다 작으면 그 라운드는 이미 지난 것 — 통째로 건너뛴다
 *  - 뒤에서 아무것도 못 찾았고 턴이 크게 줄었다면(재시작) 처음부터 다시 찾는다
 *
 * @returns {number} 다음 단계 인덱스
 */
function nextIndexForTurn(steps, cur, t) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const last = steps.length - 1;
  cur = Math.max(0, Math.min(cur ?? 0, last));

  const ranges = segmentRanges(steps);
  const curSeg = Math.max(
    0,
    ranges.findIndex(([a, b]) => cur >= a && cur <= b),
  );

  const searchFrom = (segIdx) => {
    for (let s = segIdx; s < ranges.length; s += 1) {
      const [a, b] = ranges[s];
      for (let i = a; i <= b; i += 1) {
        if (steps[i].turn >= t) return i;
      }
      // 이 라운드의 모든 턴이 t보다 작다 → 이미 끝난 라운드로 보고 건너뛴다
    }
    return -1;
  };

  // 턴이 현재 라운드의 시작보다도 작아졌다 = 전투 재시작 → 처음부터 다시 따라간다.
  // (라운드 리셋형 빌드는 라운드 시작이 0이라 이 조건에 안 걸리고, 아래 앞으로-훑기가 처리한다)
  if (t < steps[ranges[curSeg][0]].turn) {
    const again = searchFrom(0);
    if (again !== -1) return again;
  }

  const found = searchFrom(curSeg);
  if (found !== -1) return found;

  return last; // 전부 지났다 — 마지막 단계 유지
}

/**
 * 턴 표시가 한동안 사라졌다가 돌아왔을 때의 다음 단계.
 *
 * 게임은 스킬 연출과 라운드 전환 동안 턴 숫자를 감춘다. 라운드마다 턴이 0부터 다시
 * 시작하는 빌드에서는 돌아온 숫자가 직전과 같아서(0 → 0) 평소 규칙으로는 제자리에
 * 머물고, 라운드가 넘어간 걸 영영 못 따라간다.
 *
 * 그래서 "사라졌다 돌아왔는데 앞으로 못 갔고, 게다가 지금이 이 라운드의 마지막 단계"면
 * 다음 라운드로 넘긴다. 라운드에 아직 할 게 남아 있으면 스킬 연출이 지나간 것뿐이므로
 * 건드리지 않는다 — 이 조건이 없으면 연출 때마다 라운드를 건너뛴다.
 *
 * @returns {number} 다음 단계 인덱스
 */
function nextIndexAfterGap(steps, cur, t) {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  const last = steps.length - 1;
  cur = Math.max(0, Math.min(cur ?? 0, last));

  const normal = nextIndexForTurn(steps, cur, t);
  if (normal !== cur) return normal; // 숫자가 올라가서 이미 앞으로 갔다

  const ranges = segmentRanges(steps);
  const curSeg = Math.max(
    0,
    ranges.findIndex(([a, b]) => cur >= a && cur <= b),
  );
  if (cur !== ranges[curSeg][1]) return normal; // 이 라운드에 아직 남은 단계가 있다

  const nextSeg = ranges[curSeg + 1];
  return nextSeg ? nextSeg[0] : normal; // 마지막 라운드면 그대로 둔다
}

/** 처음 켰을 때(현재 위치가 없을 때)의 시작 단계 */
function indexForTurn(steps, t) {
  return nextIndexForTurn(steps, 0, t);
}

module.exports = {
  parseSteps,
  groupVariants,
  flatten,
  indexForTurn,
  nextIndexForTurn,
  nextIndexAfterGap,
};
