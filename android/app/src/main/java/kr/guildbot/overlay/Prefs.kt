// 설정 저장 — PC판의 overlay-config.json에 해당한다.
package kr.guildbot.overlay

import android.content.Context

/** 화면에서 턴 숫자가 보이는 자리. 화면 대비 비율(0~1)이라 해상도가 바뀌어도 쓸 수 있다 */
data class TurnRegion(
    val fx: Float,
    val fy: Float,
    val fw: Float,
    val fh: Float,
    /** 지정할 때의 화면 방향 — 다르면 자리가 어긋나므로 알려 준다 */
    val landscape: Boolean,
)

object Prefs {

    private const val FILE = "overlay"
    private const val K_BUILD = "lastBuildId"
    private const val K_ALPHA = "opacity"
    private const val K_X = "winX"
    private const val K_Y = "winY"
    private const val K_REGION = "region"

    private fun p(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun lastBuildId(context: Context): String? = p(context).getString(K_BUILD, null)

    fun setLastBuildId(context: Context, id: String?) {
        p(context).edit().putString(K_BUILD, id).apply()
    }

    /** 창 배경 진하기 25~100 */
    fun opacity(context: Context): Int = p(context).getInt(K_ALPHA, 88).coerceIn(25, 100)

    fun setOpacity(context: Context, v: Int) {
        p(context).edit().putInt(K_ALPHA, v.coerceIn(25, 100)).apply()
    }

    fun windowPos(context: Context): Pair<Int, Int>? {
        val prefs = p(context)
        if (!prefs.contains(K_X)) return null
        return prefs.getInt(K_X, 0) to prefs.getInt(K_Y, 0)
    }

    fun setWindowPos(context: Context, x: Int, y: Int) {
        p(context).edit().putInt(K_X, x).putInt(K_Y, y).apply()
    }

    fun region(context: Context): TurnRegion? {
        val raw = p(context).getString(K_REGION, null) ?: return null
        val parts = raw.split(',')
        if (parts.size < 5) return null
        return try {
            TurnRegion(
                parts[0].toFloat(), parts[1].toFloat(),
                parts[2].toFloat(), parts[3].toFloat(),
                parts[4].toBoolean(),
            )
        } catch (e: NumberFormatException) {
            null
        }
    }

    fun setRegion(context: Context, r: TurnRegion) {
        p(context).edit()
            .putString(K_REGION, "${r.fx},${r.fy},${r.fw},${r.fh},${r.landscape}")
            .apply()
    }
}
