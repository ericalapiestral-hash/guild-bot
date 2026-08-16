// 빌드 본문(마크다운) → 스킬 순서 단계 목록.
// overlay/lib/steps.js를 그대로 옮긴 것 — 동작이 갈리면 안 되니 로직을 임의로 고치지 말 것.
//
// 도감 형식: "## 스킬 순서" 아래 "### N라운드" 헤딩, 단계는 `N턴`액션 을 ' / '로 나열.
// "### 2라운드 (4턴)" / "### 2라운드 (8턴)" 처럼 같은 라운드가 두 번 나오면 변형(분기)이다.
package kr.guildbot.overlay

/** 한 단계 — "16턴 · 라이언 위". [label]은 속한 라운드 이름 */
data class Step(val turn: Int, val text: String, val label: String = "")

/** 문서에서 잘라낸 한 덩어리 (보통 라운드 하나) */
data class Segment(val label: String, val round: Int?, val steps: List<Step>)

/** 분기의 한 갈래 */
data class Variant(val label: String, val steps: List<Step>)

/** 같은 라운드 번호가 여러 번 나오면 변형 여러 개가 한 그룹으로 묶인다 */
data class StepGroup(val round: Int?, val variants: List<Variant>)

object Steps {

    private val HEADING = Regex("^(#{1,6})\\s+(.+?)\\s*$")
    private val ROUND = Regex("(\\d+)\\s*라운드")
    private val ORDER_TITLE = Regex("스킬\\s*순서")
    private val TURN_MARKER = Regex("`(\\d+)\\s*턴`\\s*([^/`\\n]*)")
    private val TAG_JUNK = Regex("[*_`#()\\[\\]]")
    private val TAG_EDGE = Regex("^[\\s:—–-]+|[\\s:—–-]+$")
    private val TEXT_TAIL = Regex("[()*\\s/]+$")

    /** 헤딩에서 라운드 번호를 뽑는다. "2라운드 (4턴)" → 2 */
    private fun roundOf(title: String): Int? =
        ROUND.find(title)?.groupValues?.get(1)?.toIntOrNull()

    /** 쌓는 동안만 쓰는 가변 세그먼트 */
    private class Building(val label: String, val round: Int?) {
        val steps = mutableListOf<Step>()
        var closed = false
    }

    /**
     * @return 문서 순서 그대로의 세그먼트 목록.
     *   라운드 번호가 겹치는 세그먼트는 변형(둘 중 하나만 진행) — [groupVariants]가 묶는다.
     */
    fun parseSteps(body: String?): List<Segment> {
        val lines = (body ?: "").split("\n")
        val segments = mutableListOf<Building>()
        var current: Building? = null   // 지금 쌓고 있는 세그먼트
        var inOrder = false             // "스킬 순서" 섹션 안인지
        var orderLevel = 0              // 스킬 순서 헤딩의 깊이 (같거나 얕은 헤딩이 오면 섹션 끝)
        var sectionTag = ""             // "스킬 순서 (고점형)" 처럼 섹션 제목에 붙은 구분자

        // 같은 빌드에 스킬 순서 섹션이 여러 개면(안전형/고점형 등) 라벨에 구분자를 붙인다.
        // 안 붙이면 변형 칩이 똑같은 글자 두 개가 되어 구분할 수 없다.
        fun push(label: String, round: Int?) {
            val made = Building(if (sectionTag.isNotEmpty()) "$label — $sectionTag" else label, round)
            segments.add(made)
            current = made
        }

        for (line in lines) {
            val h = HEADING.find(line)
            if (h != null) {
                val level = h.groupValues[1].length
                val title = h.groupValues[2].trim()

                if (ORDER_TITLE.containsMatchIn(title)) {
                    inOrder = true
                    orderLevel = level
                    current = null
                    sectionTag = ORDER_TITLE.replaceFirst(title, "")
                        .replace(TAG_JUNK, " ")
                        .replace(TAG_EDGE, "")
                        .trim()
                    continue
                }
                if (!inOrder) continue

                val round = roundOf(title)
                if (round != null) {
                    push(title, round)
                } else if (level <= orderLevel) {
                    inOrder = false // 스킬 순서 섹션이 끝났다
                    current = null
                }
                // 스킬 순서 안의 라운드가 아닌 하위 헤딩은 무시하고 계속 본다
                continue
            }

            if (!inOrder) continue

            // `N턴`액션 추출 — 항목은 ' / '로 구분되지만 마커 기준으로 자르는 게 안전하다
            for (m in TURN_MARKER.findAll(line)) {
                val text = m.groupValues[2].replace(TEXT_TAIL, "").trim()
                if (text.isEmpty()) continue
                if (current == null) push("스킬 순서", null) // 라운드 헤딩 없이 바로 단계가 나오는 경우
                val seg = current ?: continue
                if (seg.closed) continue
                val turn = m.groupValues[1].toIntOrNull() ?: continue
                // 라운드 안에서 턴은 내려가지 않는다. 내려가는 마커가 나오면 그건 본문 아래의
                // 각주/조건부 대안(예: "*46턴에 사신강림을 안 쓰면 48턴에…")이다 — 단계로 넣지 않는다.
                if (seg.steps.isNotEmpty() && turn < seg.steps.last().turn) {
                    seg.closed = true
                    continue
                }
                seg.steps.add(Step(turn, text))
            }
        }

        return segments
            .filter { it.steps.isNotEmpty() }
            .map { Segment(it.label, it.round, it.steps.toList()) }
    }

    /**
     * 세그먼트를 "변형 그룹"으로 묶는다. 같은 라운드 번호가 여러 번 나오면 그 자리부터 변형이다.
     */
    fun groupVariants(segments: List<Segment>): List<StepGroup> {
        class Acc(val round: Int?, val variants: MutableList<Variant>)

        val groups = mutableListOf<Acc>()
        val byRound = HashMap<String, Acc>()
        for (seg in segments) {
            // 라운드 번호가 없는 세그먼트는 매번 다른 키를 줘서 절대 합쳐지지 않게 한다
            val key = if (seg.round == null) "_${groups.size}" else "r${seg.round}"
            val existing = if (seg.round != null) byRound[key] else null
            if (existing != null) {
                existing.variants.add(Variant(seg.label, seg.steps))
                continue
            }
            val acc = Acc(seg.round, mutableListOf(Variant(seg.label, seg.steps)))
            groups.add(acc)
            if (seg.round != null) byRound[key] = acc
        }
        return groups.map { StepGroup(it.round, it.variants.toList()) }
    }

    /** 변형 선택(그룹 인덱스 → 변형 인덱스)에 따라 한 줄로 펼친다 */
    fun flatten(groups: List<StepGroup>, picks: Map<Int, Int> = emptyMap()): List<Step> {
        val out = mutableListOf<Step>()
        groups.forEachIndexed { gi, group ->
            val pick = (picks[gi] ?: 0).coerceIn(0, group.variants.size - 1)
            val variant = group.variants[pick]
            for (step in variant.steps) out.add(Step(step.turn, step.text, variant.label))
        }
        return out
    }

    /** 같은 라벨(라운드)이 이어지는 구간들의 목록 */
    private fun segmentRanges(steps: List<Step>): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var start = 0
        for (i in 1..steps.size) {
            if (i == steps.size || steps[i].label != steps[start].label) {
                ranges.add(start..(i - 1))
                start = i
            }
        }
        return ranges
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
     */
    fun nextIndexForTurn(steps: List<Step>, cur: Int, t: Int): Int {
        if (steps.isEmpty()) return 0
        val last = steps.size - 1
        val position = cur.coerceIn(0, last)

        val ranges = segmentRanges(steps)
        val found = ranges.indexOfFirst { position in it }
        val curSeg = if (found < 0) 0 else found

        fun searchFrom(segIdx: Int): Int {
            for (s in segIdx until ranges.size) {
                for (i in ranges[s]) {
                    if (steps[i].turn >= t) return i
                }
                // 이 라운드의 모든 턴이 t보다 작다 → 이미 끝난 라운드로 보고 건너뛴다
            }
            return -1
        }

        // 턴이 현재 라운드의 시작보다도 작아졌다 = 전투 재시작 → 처음부터 다시 따라간다.
        // (라운드 리셋형 빌드는 라운드 시작이 0이라 이 조건에 안 걸리고, 아래 앞으로-훑기가 처리한다)
        if (t < steps[ranges[curSeg].first].turn) {
            val again = searchFrom(0)
            if (again != -1) return again
        }

        val next = searchFrom(curSeg)
        if (next != -1) return next

        return last // 전부 지났다 — 마지막 단계 유지
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
     */
    fun nextIndexAfterGap(steps: List<Step>, cur: Int, t: Int): Int {
        if (steps.isEmpty()) return 0
        val last = steps.size - 1
        val position = cur.coerceIn(0, last)

        val normal = nextIndexForTurn(steps, position, t)
        if (normal != position) return normal // 숫자가 올라가서 이미 앞으로 갔다

        val ranges = segmentRanges(steps)
        val found = ranges.indexOfFirst { position in it }
        val curSeg = if (found < 0) 0 else found
        if (position != ranges[curSeg].last) return normal // 이 라운드에 아직 남은 단계가 있다

        val nextSeg = ranges.getOrNull(curSeg + 1) ?: return normal // 마지막 라운드면 그대로
        return nextSeg.first
    }

    /** 처음 켰을 때(현재 위치가 없을 때)의 시작 단계 */
    fun indexForTurn(steps: List<Step>, t: Int): Int = nextIndexForTurn(steps, 0, t)
}
