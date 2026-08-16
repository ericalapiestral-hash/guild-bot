// 도감(builds.json) 읽기 — 봇이 노션에서 뽑아 둔 캐시를 그대로 쓴다.
// PC 오버레이는 파일을 직접 읽지만 폰은 그럴 수 없어서, 한 번 가져와 앱 안에 복사해 둔다.
package kr.guildbot.overlay

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** 도감의 빌드 하나 — 스킬 순서까지 미리 파싱해서 들고 있는다 */
data class BuildDoc(
    val id: String,
    val name: String,
    val label: String,
    val category: String,
    val group: String,
    val weekdays: List<String>,
    val groups: List<StepGroup>,
) {
    val stepCount: Int = groups.sumOf { it.variants.firstOrNull()?.steps?.size ?: 0 }
}

/** 도감 읽기 결과 */
sealed class BuildsResult {
    data class Ok(val syncedAt: String?, val builds: List<BuildDoc>) : BuildsResult()
    data class Fail(val message: String) : BuildsResult()
}

object BuildsRepository {

    private const val CACHE_NAME = "builds.json"
    /** 도감 캐시는 60KB 남짓이다. 엉뚱한 파일을 통째로 삼키지 않도록 상한을 둔다 */
    private const val MAX_BYTES = 8L * 1024 * 1024

    fun cacheFile(context: Context): File = File(context.filesDir, CACHE_NAME)

    fun hasCache(context: Context): Boolean = cacheFile(context).isFile

    /** 앱 안에 복사해 둔 도감을 읽는다 */
    fun load(context: Context): BuildsResult {
        val file = cacheFile(context)
        if (!file.isFile) {
            return BuildsResult.Fail("도감을 아직 안 불러왔어요. builds.json을 불러와 주세요.")
        }
        return try {
            parse(file.readText())
        } catch (e: Exception) {
            BuildsResult.Fail("도감 파일을 읽지 못했어요: ${e.message}")
        }
    }

    /** 문자열 → 빌드 목록. 형식이 아니면 Fail */
    fun parse(text: String): BuildsResult {
        val root = try {
            JSONObject(text)
        } catch (e: Exception) {
            return BuildsResult.Fail("JSON 형식이 아니에요.")
        }
        val arr = root.optJSONArray("builds")
            ?: return BuildsResult.Fail("도감 파일 형식이 예상과 달라요 (builds 배열이 없음).")

        val builds = ArrayList<BuildDoc>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val name = o.optString("name").takeIf { it.isNotBlank() } ?: continue
            val body = o.optString("body")
            val group = o.optString("group")

            val weekdaysArr = o.optJSONArray("weekdays")
            val weekdays = if (weekdaysArr == null) emptyList() else
                (0 until weekdaysArr.length()).map { weekdaysArr.optString(it) }.filter { it.isNotBlank() }

            // 카테고리가 비어 있으면 묶음 이름으로 짐작한다 (PC 오버레이와 같은 규칙)
            val category = o.optString("category").takeIf { it.isNotBlank() }
                ?: if (group.contains("구사황")) "구사황" else "기타"

            builds.add(
                BuildDoc(
                    id = o.optString("id").takeIf { it.isNotBlank() } ?: "#$i",
                    name = name,
                    label = o.optString("label").takeIf { it.isNotBlank() } ?: name,
                    category = category,
                    group = group,
                    weekdays = weekdays,
                    groups = Steps.groupVariants(Steps.parseSteps(body)),
                )
            )
        }

        if (builds.isEmpty()) return BuildsResult.Fail("빌드가 하나도 없어요.")
        return BuildsResult.Ok(root.optString("syncedAt").takeIf { it.isNotBlank() }, builds)
    }

    /**
     * 파일 관리자에서 고른 builds.json을 앱 안으로 복사한다.
     * 먼저 파싱해 보고, 진짜 도감일 때만 기존 캐시를 덮어쓴다.
     */
    fun importFrom(context: Context, uri: Uri): BuildsResult {
        val text = try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                stream.bufferedReader().readText()
            } ?: return BuildsResult.Fail("파일을 열지 못했어요.")
        } catch (e: Exception) {
            return BuildsResult.Fail("파일을 읽지 못했어요: ${e.message}")
        }
        return saveIfValid(context, text)
    }

    /** URL에서 받아온다 (도감을 어딘가에 올려 두고 쓰는 경우) */
    fun importFrom(context: Context, url: String): BuildsResult {
        val text = try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 15_000
                requestMethod = "GET"
            }
            try {
                if (conn.responseCode !in 200..299) {
                    return BuildsResult.Fail("받아오지 못했어요 (HTTP ${conn.responseCode}).")
                }
                if (conn.contentLength > MAX_BYTES) {
                    return BuildsResult.Fail("파일이 너무 커요.")
                }
                conn.inputStream.bufferedReader().readText()
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            return BuildsResult.Fail("받아오지 못했어요: ${e.message}")
        }
        return saveIfValid(context, text)
    }

    private fun saveIfValid(context: Context, text: String): BuildsResult {
        if (text.length > MAX_BYTES) return BuildsResult.Fail("파일이 너무 커요.")
        val parsed = parse(text)
        if (parsed is BuildsResult.Ok) {
            // 쓰다 말고 죽으면 캐시가 깨진다 — 임시 파일에 먼저 쓰고 바꿔치기
            val tmp = File(context.filesDir, "$CACHE_NAME.tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(cacheFile(context))) {
                cacheFile(context).writeText(text)
                tmp.delete()
            }
        }
        return parsed
    }
}
