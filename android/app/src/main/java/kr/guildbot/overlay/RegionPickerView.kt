// 턴 숫자가 보이는 자리를 드래그로 지정하는 전체화면 오버레이.
// PC판 renderer/picker.js에 해당한다 — 화면 대비 비율로 저장해서 해상도가 바뀌어도 쓸 수 있다.
package kr.guildbot.overlay

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.content.res.Configuration
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View

@SuppressLint("ViewConstructor")
class RegionPickerView(
    context: Context,
    /** 지정 완료 시 비율 영역, 취소하면 null */
    private val onDone: (TurnRegion?) -> Unit,
) : View(context) {

    private val scrim = Paint().apply { color = Color.argb(120, 0, 0, 0) }
    private val clear = Paint().apply { color = Color.argb(0, 0, 0, 0); xfermode =
        android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.CLEAR) }
    private val border = Paint().apply {
        color = Color.parseColor("#7FCBFF")
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
    }
    private val hint = Paint().apply {
        color = Color.WHITE
        textSize = 34f
        isAntiAlias = true
        textAlign = Paint.Align.CENTER
    }

    private var startX = 0f
    private var startY = 0f
    private var curX = 0f
    private var curY = 0f
    private var dragging = false

    init {
        // CLEAR 합성을 쓰려면 하드웨어 레이어를 꺼야 한다
        setLayerType(LAYER_TYPE_SOFTWARE, null)
        // 뒤로 가기로 빠져나갈 수 있어야 한다 — 안 그러면 화면을 덮은 채 갇힌다
        isFocusable = true
        isFocusableInTouchMode = true
        requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            onDone(null)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun rect() = RectF(
        minOf(startX, curX),
        minOf(startY, curY),
        maxOf(startX, curX),
        maxOf(startY, curY),
    )

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), scrim)
        if (dragging) {
            val r = rect()
            canvas.drawRect(r, clear) // 고른 자리는 가리지 않고 그대로 보여 준다
            canvas.drawRect(r, border)
        } else {
            canvas.drawText(
                context.getString(R.string.picker_hint),
                width / 2f,
                height / 2f,
                hint,
            )
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                startX = event.x
                startY = event.y
                curX = event.x
                curY = event.y
                dragging = true
                invalidate()
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                curX = event.x
                curY = event.y
                invalidate()
                return true
            }

            MotionEvent.ACTION_UP -> {
                dragging = false
                val r = rect()
                // 손가락이 미끄러진 정도(탭)면 취소로 본다
                if (r.width() < 24f || r.height() < 16f || width == 0 || height == 0) {
                    onDone(null)
                    return true
                }
                val landscape =
                    context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
                onDone(
                    TurnRegion(
                        fx = r.left / width,
                        fy = r.top / height,
                        fw = r.width() / width,
                        fh = r.height() / height,
                        landscape = landscape,
                    )
                )
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                onDone(null)
                return true
            }
        }
        return super.onTouchEvent(event)
    }
}
