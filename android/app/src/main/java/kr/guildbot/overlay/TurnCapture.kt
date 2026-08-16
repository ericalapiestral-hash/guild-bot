// 화면을 읽어 턴 숫자를 뽑는다 — PC판의 desktopCapturer + tesseract.js 자리.
// 안드로이드에서는 MediaProjection으로 화면을 미러링하고, 인식은 기기에 내장된 ML Kit이 한다.
package kr.guildbot.overlay

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

class TurnCapture(
    private val context: Context,
    private val onTurn: (Int) -> Unit,
    /** 한동안 숫자를 하나도 못 읽었을 때 한 번만 부른다 */
    private val onMiss: () -> Unit,
    private val onError: (String) -> Unit,
) {

    private companion object {
        /** PC판과 같은 주기 */
        const val INTERVAL_MS = 700L
        /** 5초 넘게 못 읽으면 엉뚱한 곳을 보고 있을 가능성이 크다 */
        const val MISS_LIMIT = 8
        val DIGITS = Regex("\\d{1,3}")
    }

    var isRunning: Boolean = false
        private set

    private val main = Handler(Looper.getMainLooper())
    private var thread: HandlerThread? = null
    private var worker: Handler? = null

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null

    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    private var region: TurnRegion? = null
    private var busy = false
    private var misses = 0
    private var missReported = false

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            // 사용자가 알림에서 "중지"를 눌렀거나 시스템이 회수했다
            main.post {
                stop()
                onError("화면 읽기가 중단됐어요 — 자동을 다시 켜 주세요")
            }
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            grab()
            worker?.postDelayed(this, INTERVAL_MS)
        }
    }

    /** @return 시작에 성공했는지 */
    fun start(resultCode: Int, data: Intent, region: TurnRegion): Boolean {
        this.region = region
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        return try {
            projection = manager.getMediaProjection(resultCode, data)
                ?: throw IllegalStateException("화면 읽기 권한을 받지 못했어요")

            thread = HandlerThread("turn-capture").also { it.start() }
            worker = Handler(thread!!.looper)

            // API 34부터는 가상 디스플레이를 만들기 전에 콜백을 등록해야 한다
            projection?.registerCallback(projectionCallback, worker!!)
            createDisplay()

            isRunning = true
            misses = 0
            missReported = false
            worker?.postDelayed(tick, INTERVAL_MS)
            true
        } catch (e: Exception) {
            stop()
            main.post { onError("화면 읽기를 시작하지 못했어요: ${e.message}") }
            false
        }
    }

    fun updateRegion(region: TurnRegion) {
        this.region = region
        misses = 0
        missReported = false
    }

    /** 화면 방향이 바뀌면 미러링 크기가 안 맞는다 — 가상 디스플레이만 다시 만든다 */
    fun restart() {
        if (!isRunning) return
        worker?.post {
            releaseDisplay()
            runCatching { createDisplay() }.onFailure {
                main.post { onError("화면 크기를 다시 잡지 못했어요: ${it.message}") }
            }
        }
    }

    fun stop() {
        isRunning = false
        worker?.removeCallbacksAndMessages(null)
        releaseDisplay()
        projection?.let {
            runCatching { it.unregisterCallback(projectionCallback) }
            runCatching { it.stop() }
        }
        projection = null
        thread?.quitSafely()
        thread = null
        worker = null
        runCatching { recognizer.close() }
    }

    // ─────────────────────────────── 화면

    private fun screenSize(): Pair<Int, Int> {
        val wm = context.getSystemService(WindowManager::class.java)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            bounds.width() to bounds.height()
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            metrics.widthPixels to metrics.heightPixels
        }
    }

    private fun createDisplay() {
        val (w, h) = screenSize()
        if (w <= 0 || h <= 0) throw IllegalStateException("화면 크기를 알 수 없어요")
        val made = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = made
        display = projection?.createVirtualDisplay(
            "turn-capture",
            w,
            h,
            context.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            made.surface,
            null,
            worker,
        ) ?: throw IllegalStateException("화면 미러링을 만들지 못했어요")
    }

    private fun releaseDisplay() {
        runCatching { display?.release() }
        display = null
        runCatching { reader?.close() }
        reader = null
    }

    // ─────────────────────────────── 인식

    private fun grab() {
        if (busy || !isRunning) return
        val target = region ?: return
        val image = try {
            reader?.acquireLatestImage() ?: return
        } catch (e: Exception) {
            return
        }

        val cropped = try {
            crop(image, target)
        } catch (e: Exception) {
            null
        } finally {
            runCatching { image.close() }
        }
        if (cropped == null) return

        val prepared = try {
            prepare(cropped)
        } catch (e: Exception) {
            runCatching { cropped.recycle() }
            return
        }

        busy = true
        recognizer.process(InputImage.fromBitmap(prepared, 0))
            .addOnSuccessListener { text ->
                val found = DIGITS.find(text.text)?.value?.toIntOrNull()
                if (found != null) {
                    misses = 0
                    missReported = false
                    main.post { onTurn(found) }
                } else {
                    misses += 1
                    if (misses >= MISS_LIMIT && !missReported) {
                        missReported = true
                        main.post { onMiss() }
                    }
                }
            }
            .addOnCompleteListener {
                busy = false
                runCatching { prepared.recycle() }
            }
    }

    /** 지정 영역만 잘라낸다 */
    private fun crop(image: Image, r: TurnRegion): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        if (pixelStride <= 0) return null

        // 줄 끝에 패딩이 붙는 기기가 있어, 버퍼 폭은 화면 폭보다 클 수 있다
        val bufferWidth = rowStride / pixelStride
        val full = Bitmap.createBitmap(bufferWidth, image.height, Bitmap.Config.ARGB_8888)
        plane.buffer.rewind()
        full.copyPixelsFromBuffer(plane.buffer)

        val w = image.width
        val h = image.height
        val x = (r.fx * w).toInt().coerceIn(0, w - 1)
        val y = (r.fy * h).toInt().coerceIn(0, h - 1)
        val cw = (r.fw * w).toInt().coerceAtLeast(8).coerceAtMost(w - x)
        val ch = (r.fh * h).toInt().coerceAtLeast(8).coerceAtMost(h - y)

        val out = Bitmap.createBitmap(full, x, y, cw, ch)
        if (out !== full) full.recycle()
        return out
    }

    /**
     * 확대 + 흑백 대비 강화 — 게임 폰트 인식률을 올린다 (PC판 cropFrame과 같은 처리).
     * 밝은 글자든 어두운 글자든 살아남게 평균 밝기로 반전 여부를 정한다.
     */
    private fun prepare(src: Bitmap): Bitmap {
        val scale = (96f / src.height).coerceIn(1f, 6f)
        val w = (src.width * scale).toInt().coerceAtLeast(32)
        val h = (src.height * scale).toInt().coerceAtLeast(32)

        val scaled = Bitmap.createScaledBitmap(src, w, h, true)
        if (scaled !== src) runCatching { src.recycle() }

        val pixels = IntArray(w * h)
        scaled.getPixels(pixels, 0, w, 0, 0, w, h)

        val gray = IntArray(pixels.size)
        var sum = 0L
        for (i in pixels.indices) {
            val c = pixels[i]
            val g = (0.299f * ((c shr 16) and 0xFF) +
                0.587f * ((c shr 8) and 0xFF) +
                0.114f * (c and 0xFF)).toInt()
            gray[i] = g
            sum += g
        }
        val invert = sum / pixels.size > 128 // 배경이 밝으면 글자가 어두운 쪽

        for (i in pixels.indices) {
            var v = gray[i]
            if (invert) v = 255 - v
            v = if (v > 96) 255 else 0
            val o = 255 - v // 인식기는 흰 배경에 검은 글자를 좋아한다
            pixels[i] = (0xFF shl 24) or (o shl 16) or (o shl 8) or o
        }

        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(pixels, 0, w, 0, 0, w, h)
        runCatching { scaled.recycle() }
        return out
    }
}
