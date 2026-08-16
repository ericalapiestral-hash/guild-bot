// overlay/test/steps.test.js를 그대로 옮긴 것. PC판과 폰이 같은 순서를 내야 한다.
// 실제 도감 캐시(data/builds.json)가 있으면 그것까지 검사하고, 없으면 건너뛴다.
package kr.guildbot.overlay

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

class StepsTest {

    // ─── 기본 형태 (실제 도감에서 그대로 가져온 모양)

    private val sample = """
# 세팅
- 나타 (속공 33)
## 스킬 순서
> 턴수는 참고만
### 1라운드
`0턴`비스킷 아래 / `4턴`나타 아래
### 2라운드
`4턴`비스킷 위 / `8턴`클로에 위 (`9턴`미호 평타로 클리어)
### 3라운드
`9턴`리나 위 /
# 다른 섹션
`99턴` 이건 스킬 순서 밖이라 무시
"""

    private val segments = Steps.parseSteps(sample)

    @Test
    fun `라운드별로 세그먼트를 나눈다`() {
        assertEquals(listOf("1라운드", "2라운드", "3라운드"), segments.map { it.label })
    }

    @Test
    fun `턴과 액션을 정확히 뽑는다`() {
        assertEquals(
            listOf(Step(0, "비스킷 아래"), Step(4, "나타 아래")),
            segments[0].steps,
        )
    }

    @Test
    fun `괄호 속 마커도 잡고 잔여 기호는 걷어낸다`() {
        assertEquals(
            listOf(Step(4, "비스킷 위"), Step(8, "클로에 위"), Step(9, "미호 평타로 클리어")),
            segments[1].steps,
        )
    }

    @Test
    fun `끝에 슬래시만 남은 줄도 처리한다`() {
        assertEquals(listOf(Step(9, "리나 위")), segments[2].steps)
    }

    @Test
    fun `스킬 순서 섹션 밖의 턴 마커는 무시한다`() {
        val all = segments.flatMap { seg -> seg.steps.map { it.turn } }
        assertTrue(99 !in all)
    }

    // ─── 분기 (2라운드가 두 번)

    private val branch = """
## 스킬 순서
### 1라운드
`0턴`소교 위 / `4턴`파스칼 위
### 2라운드 (4턴)
`4턴`헤브 위 / `8턴`샤오 아래
### 2라운드 (8턴)
`8턴`헤브 위 / `12턴`샤오 아래
"""

    private val bGroups = Steps.groupVariants(Steps.parseSteps(branch))

    @Test
    fun `같은 라운드 번호는 변형으로 묶는다`() {
        assertEquals(2, bGroups.size)
        assertEquals(1, bGroups[0].variants.size)
        assertEquals(2, bGroups[1].variants.size)
        assertEquals(
            listOf("2라운드 (4턴)", "2라운드 (8턴)"),
            bGroups[1].variants.map { it.label },
        )
    }

    @Test
    fun `변형 선택에 따라 다른 줄기가 펼쳐진다`() {
        val a = Steps.flatten(bGroups, mapOf(1 to 0))
        val b = Steps.flatten(bGroups, mapOf(1 to 1))
        assertEquals(listOf(0, 4, 4, 8), a.map { it.turn })
        assertEquals(listOf(0, 4, 8, 12), b.map { it.turn })
    }

    // ─── 턴 → 단계 인덱스

    private val flow = Steps.flatten(bGroups)

    @Test
    fun `인식된 턴보다 크거나 같은 첫 단계가 현재다`() {
        assertEquals(0, Steps.indexForTurn(flow, 0))
        assertEquals(1, Steps.indexForTurn(flow, 1)) // 0턴은 지났고 4턴이 다음
        assertEquals(1, Steps.indexForTurn(flow, 4)) // 같은 4턴 중 첫 번째
        assertEquals(3, Steps.indexForTurn(flow, 5))
        assertEquals(flow.size - 1, Steps.indexForTurn(flow, 999)) // 전부 지나면 마지막
    }

    @Test
    fun `빈 목록은 0`() {
        assertEquals(0, Steps.indexForTurn(emptyList(), 5))
    }

    // ─── 라운드마다 턴이 리셋되는 빌드 (델론즈 유형)

    private val reset = Steps.flatten(
        Steps.groupVariants(
            Steps.parseSteps(
                """
## 스킬 순서
### 1라운드
`0턴`라이언 아래
### 2라운드
`0턴`돼오 아래
### 3라운드
`0턴`레이첼 위 / `4턴`비스킷 아래 / `8턴`라이언 위
"""
            )
        )
    )

    @Test
    fun `턴 리셋 빌드 - 라운드를 건너뛰며 앞으로 진행한다`() {
        // reset = [R1:0] [R2:0] [R3:0,4,8]
        // 1라운드 0턴에서 시작
        assertEquals(0, Steps.nextIndexForTurn(reset, 0, 0))
        // 0으로 다시 리셋돼도 제자리 (0턴끼리는 카운터로 구분 불가)
        assertEquals(0, Steps.nextIndexForTurn(reset, 0, 0))
        // 카운터가 3이면 R1·R2의 턴(최대 0)은 전부 지난 것 — R3의 4턴으로
        assertEquals(3, Steps.nextIndexForTurn(reset, 0, 3))
        // 2라운드 위치에서 4가 읽혀도 같은 결론
        assertEquals(3, Steps.nextIndexForTurn(reset, 1, 4))
        // 3라운드 안에서는 카운터를 그대로 따라간다
        assertEquals(3, Steps.nextIndexForTurn(reset, 2, 4))
        assertEquals(4, Steps.nextIndexForTurn(reset, 3, 7))
    }

    @Test
    fun `전역 카운터 빌드 - 라운드가 넘어가도 이어서 따라간다`() {
        // flow = [1라: 0, 4] [2라(4턴): 4, 8]
        assertEquals(1, Steps.nextIndexForTurn(flow, 0, 4)) // 같은 4턴 중 첫 번째
        assertEquals(3, Steps.nextIndexForTurn(flow, 1, 6)) // 1라는 지났고 2라의 8턴
        assertEquals(3, Steps.nextIndexForTurn(flow, 3, 999)) // 끝 유지
        // 턴이 현재 라운드 시작(4턴)보다 작아지면 전투 재시작 — 처음부터 다시
        assertEquals(0, Steps.nextIndexForTurn(flow, 3, 0))
        assertEquals(0, Steps.nextIndexForTurn(flow, 2, 0))
        // 현재 라운드 범위 안이면 재시작이 아니다
        assertEquals(3, Steps.nextIndexForTurn(flow, 3, 5))
    }

    @Test
    fun `각주의 턴 마커는 단계로 넣지 않는다`() {
        val noted = Steps.parseSteps(
            """
## 스킬 순서
### 3라운드
`60턴`라이언 위 / `64턴`선란 아래 / `68턴`선란 위
> *사신강림을 안 쓰면 `48턴`돼오 아래 / `52턴`라이언 아래
"""
        )
        assertEquals(
            "각주 48·52턴이 단계로 흡수됨",
            listOf(60, 64, 68),
            noted[0].steps.map { it.turn },
        )
    }

    @Test
    fun `스킬 순서 섹션이 여러 개면 라벨에 구분자가 붙는다`() {
        val multi = Steps.parseSteps(
            """
## 스킬 순서 (안전형)
### 1라운드
`0턴`A 위
## 스킬 순서 (고점형)
### 1라운드
`0턴`B 위
"""
        )
        assertEquals(2, multi.size)
        assertNotEquals("라벨이 같음: ${multi[0].label}", multi[0].label, multi[1].label)
        assertEquals(2, Steps.groupVariants(multi)[0].variants.size)
    }

    // ─── 실제 도감 캐시가 있으면 전수 검사 (CI에는 캐시가 없어 자동으로 건너뛴다)

    /** 테스트 작업 폴더는 android/app — 저장소 루트의 data/builds.json을 찾는다 */
    private fun cachedBuilds(): List<JSONObject>? {
        val cache = File("../../data/builds.json")
        if (!cache.isFile) return null
        val arr = JSONObject(cache.readText()).optJSONArray("builds") ?: return null
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun stepsOf(build: JSONObject): List<Step> =
        Steps.flatten(Steps.groupVariants(Steps.parseSteps(build.optString("body"))))

    @Test
    fun `실데이터 - 모든 빌드에서 스킬 순서를 뽑는다`() {
        val builds = cachedBuilds()
        assumeTrue("data/builds.json이 없어 건너뜀", builds != null)
        for (b in builds!!) {
            val name = b.optString("name")
            val steps = stepsOf(b)
            assertTrue("$name: 단계 ${steps.size}개뿐", steps.size >= 3)
            for (s in steps) {
                assertTrue("$name: 턴 이상 ${s.turn}", s.turn >= 0)
                assertTrue("$name: 액션 이상 \"${s.text}\"", s.text.isNotEmpty() && s.text.length < 60)
            }
        }
    }

    @Test
    fun `실데이터 - 어떤 턴을 읽어도 인덱스가 범위를 벗어나지 않는다`() {
        val builds = cachedBuilds()
        assumeTrue("data/builds.json이 없어 건너뜀", builds != null)
        for (b in builds!!) {
            val name = b.optString("name")
            val steps = stepsOf(b)
            for (cur in steps.indices) {
                for (t in intArrayOf(0, 1, 4, 9, 16, 35, 68, 70, 120)) {
                    val next = Steps.nextIndexForTurn(steps, cur, t)
                    assertTrue("$name: cur=$cur t=$t → $next", next in steps.indices)
                }
            }
        }
    }

    @Test
    fun `실데이터 - 델론즈 리셋형 빌드에서 리셋 진행이 자연스럽다`() {
        val builds = cachedBuilds()
        assumeTrue("data/builds.json이 없어 건너뜀", builds != null)
        val target = builds!!.firstOrNull {
            val n = it.optString("name")
            n.contains("델론즈") && n.contains("선란") && it.optString("category") == "공성전"
        }
        assumeTrue("도감이 바뀌어 대상 빌드가 없음", target != null)

        val steps = stepsOf(target!!)
        // [0] 1라 0턴 → [1] 2라 0턴 → [2] 3라 0턴 4턴 8턴 …
        assertEquals(0, steps[0].turn)
        val r3 = steps.withIndex().indexOfFirst { (i, s) -> i > 1 && s.turn == 0 }
        assertTrue("3라운드 시작(두 번째 이후의 0턴)을 못 찾음", r3 > 1)
        // 0턴 자리에서는 제자리
        assertEquals(0, Steps.nextIndexForTurn(steps, 0, 0))
        // 카운터가 2가 되면 0턴짜리 라운드들은 지난 것 — 3라운드 4턴이 다음
        assertEquals(r3 + 1, Steps.nextIndexForTurn(steps, 0, 2))
        // 3라운드 안에서는 카운터를 그대로 따라간다
        assertEquals(r3 + 1, Steps.nextIndexForTurn(steps, r3, 4))
        assertEquals(r3 + 3, Steps.nextIndexForTurn(steps, r3 + 1, 10))
    }
}
