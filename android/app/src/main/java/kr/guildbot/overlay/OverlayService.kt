// 게임 위에 떠 있는 창 — PC판 renderer/overlay.js에 해당한다.
// 전역 단축키가 없는 대신 창에 버튼을 달았고, 화면 캡처는 MediaProjection이 맡는다.
package kr.guildbot.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import kr.guildbot.overlay.databinding.OverlayWindowBinding
import kr.guildbot.overlay.databinding.StepRowBinding

class OverlayService : Service() {

    companion object {
        const val ACTION_SHOW = "kr.guildbot.overlay.SHOW"
        const val ACTION_STOP = "kr.guildbot.overlay.STOP"
        /** 앱에서 빌드를 바꿨을 때 — 창을 새 빌드로 갈아끼운다 */
        const val ACTION_RELOAD = "kr.guildbot.overlay.RELOAD"
        /** 화면 읽기 동의 결과가 돌아왔을 때 */
        const val ACTION_PROJECTION = "kr.guildbot.overlay.PROJECTION"
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"

        private const val CHANNEL_ID = "overlay"
        private const val NOTIF_ID = 1

        /** 앱 화면에서 "실행 중"을 보여 주기 위한 표시 */
        @Volatile
        var running: Boolean = false
            private set
    }

    private lateinit var windowManager: WindowManager
    private lateinit var binding: OverlayWindowBinding
    private lateinit var params: WindowManager.LayoutParams

    /** 클릭 통과 중일 때만 뜨는 자물쇠 해제 단추 (본체가 터치를 안 받으니 따로 띄운다) */
    private var unlockChip: TextView? = null
    private var pickerView: RegionPickerView? = null

    private var capture: TurnCapture? = null

    // ── 상태
    private var build: BuildDoc? = null
    private var picks = mutableMapOf<Int, Int>()
    private var steps: List<Step> = emptyList()
    private var index = 0
    private var auto = false
    private var locked = false
    private var collapsed = false
    private var lastTurn: Int? = null
    private var pendingTurn: Int? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WindowManager::class.java)
        createChannel()
        goForeground(capturing = false)
        addPanel()
        loadSelectedBuild()
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_RELOAD -> loadSelectedBuild()

            ACTION_PROJECTION -> {
                val code = intent.getIntExtra(EXTRA_CODE, 0)
                val data = IntentCompat.getParcelableExtra(intent, EXTRA_DATA, Intent::class.java)
                if (code == android.app.Activity.RESULT_OK && data != null) {
                    startCapture(code, data)
                } else {
                    setAuto(false)
                    status("화면 읽기를 허용하지 않아 자동을 켤 수 없어요", warn = true)
                }
            }
        }
        // 시스템이 되살려도 화면 읽기 동의는 유지되지 않는다 — 살아나면 자동은 꺼진 채로 시작한다
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        stopCapture()
        removeUnlockChip()
        pickerView?.let { runCatching { windowManager.removeView(it) } }
        pickerView = null
        if (this::binding.isInitialized) {
            runCatching { windowManager.removeView(binding.root) }
        }
        super.onDestroy()
    }

    /** 화면을 돌리면 캡처하던 크기가 안 맞는다 — 다시 잡는다 */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        capture?.let { c ->
            if (c.isRunning) {
                c.restart()
                status("화면 방향이 바뀌어 인식을 다시 시작했어요", warn = false)
            }
        }
    }

    // ─────────────────────────────── 창

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun addPanel() {
        binding = OverlayWindowBinding.inflate(LayoutInflater.from(this))

        val width = minOf(dp(300), resources.displayMetrics.widthPixels - dp(24))
        params = WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // 포커스를 안 가져가야 게임 조작을 방해하지 않는다
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val saved = Prefs.windowPos(this@OverlayService)
            x = saved?.first ?: dp(12)
            y = saved?.second ?: dp(80)
        }

        bindHeaderDrag()
        bindButtons()
        applyOpacity(Prefs.opacity(this))

        windowManager.addView(binding.root, params)

        status(
            if (Prefs.region(this) == null) getString(R.string.status_no_region)
            else getString(R.string.status_region_set),
            warn = false,
        )
    }

    private fun bindHeaderDrag() {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        binding.header.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = e.rawX
                    touchY = e.rawY
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (e.rawX - touchX).toInt()
                    params.y = startY + (e.rawY - touchY).toInt()
                    runCatching { windowManager.updateViewLayout(binding.root, params) }
                    true
                }

                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    Prefs.setWindowPos(this, params.x, params.y)
                    true
                }

                else -> false
            }
        }
    }

    private fun bindButtons() {
        binding.btnPrev.setOnClickListener { nav(-1) }
        binding.btnNext.setOnClickListener { nav(1) }
        binding.btnAuto.setOnClickListener { setAuto(!auto) }
        binding.btnRegion.setOnClickListener { showPicker() }
        binding.btnLock.setOnClickListener { setLocked(true) }
        binding.btnClose.setOnClickListener { stopSelf() }

        binding.btnCollapse.setOnClickListener {
            collapsed = !collapsed
            binding.content.visibility = if (collapsed) View.GONE else View.VISIBLE
            binding.btnCollapse.text = if (collapsed) "▸" else "▾"
        }

        binding.btnApp.setOnClickListener {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
    }

    private fun applyOpacity(percent: Int) {
        binding.panel.background?.mutate()?.alpha = (percent * 255 / 100).coerceIn(0, 255)
    }

    // ─────────────────────────────── 클릭 통과 (잠금)

    private fun setLocked(on: Boolean) {
        locked = on
        params.flags = if (on) {
            params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        runCatching { windowManager.updateViewLayout(binding.root, params) }
        if (on) addUnlockChip() else removeUnlockChip()
    }

    /** 본체가 터치를 안 받으므로, 해제용 작은 단추를 따로 띄운다 */
    private fun addUnlockChip() {
        if (unlockChip != null) return
        val chip = TextView(this).apply {
            text = getString(R.string.btn_unlock)
            textSize = 14f
            gravity = Gravity.CENTER
            setBackgroundResource(R.drawable.bg_chip)
            setPadding(dp(10), dp(6), dp(10), dp(6))
            setOnClickListener { setLocked(false) }
        }
        val chipParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = params.x
            y = maxOf(0, params.y - dp(40))
        }
        runCatching {
            windowManager.addView(chip, chipParams)
            unlockChip = chip
        }
    }

    private fun removeUnlockChip() {
        unlockChip?.let { runCatching { windowManager.removeView(it) } }
        unlockChip = null
    }

    // ─────────────────────────────── 빌드 · 단계

    private fun loadSelectedBuild() {
        when (val loaded = BuildsRepository.load(this)) {
            is BuildsResult.Fail -> {
                build = null
                steps = emptyList()
                renderSteps()
                status(loaded.message, warn = true)
            }

            is BuildsResult.Ok -> {
                val id = Prefs.lastBuildId(this)
                val found = loaded.builds.firstOrNull { it.id == id && it.stepCount > 0 }
                    ?: loaded.builds.firstOrNull { it.stepCount > 0 }
                build = found
                picks = mutableMapOf()
                index = 0
                lastTurn = null
                pendingTurn = null
                steps = found?.let { Steps.flatten(it.groups, picks) } ?: emptyList()
                binding.title.text = found?.name ?: getString(R.string.overlay_title)
                renderVariants()
                renderSteps()
            }
        }
    }

    private fun renderVariants() {
        val row = binding.variantRow
        row.removeAllViews()
        val current = build
        val branched = current?.groups?.withIndex()?.filter { it.value.variants.size > 1 }.orEmpty()
        if (branched.isEmpty()) {
            binding.variantScroll.visibility = View.GONE
            return
        }
        binding.variantScroll.visibility = View.VISIBLE

        for ((gi, group) in branched) {
            group.variants.forEachIndexed { vi, variant ->
                val chip = TextView(this).apply {
                    text = variant.label
                    textSize = 10f
                    setPadding(dp(8), dp(4), dp(8), dp(4))
                    setBackgroundResource(
                        if ((picks[gi] ?: 0) == vi) R.drawable.bg_chip_on else R.drawable.bg_chip
                    )
                    setTextColor(
                        resources.getColor(
                            if ((picks[gi] ?: 0) == vi) R.color.accent else R.color.text_dim,
                            theme,
                        )
                    )
                    setOnClickListener {
                        picks[gi] = vi
                        steps = Steps.flatten(current!!.groups, picks)
                        index = index.coerceIn(0, maxOf(0, steps.size - 1))
                        renderVariants()
                        renderSteps()
                    }
                }
                val lp = android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                )
                lp.marginEnd = dp(4)
                row.addView(chip, lp)
            }
        }
    }

    private fun renderSteps() {
        val container = binding.steps
        container.removeAllViews()
        if (steps.isEmpty()) {
            container.addView(TextView(this).apply {
                text = getString(R.string.no_steps)
                textSize = 12f
                setTextColor(resources.getColor(R.color.text_dim, theme))
                setPadding(dp(8), dp(12), dp(8), dp(12))
            })
            return
        }

        index = index.coerceIn(0, steps.size - 1)

        // 직전 1개(흐리게) + 현재 + 다음 2개 = PC판과 같은 "3개씩 넘어가는" 창
        val from = maxOf(0, index - 1)
        val until = minOf(steps.size, index + 3)
        val inflater = LayoutInflater.from(this)

        for (i in from until until) {
            val step = steps[i]
            val row = StepRowBinding.inflate(inflater, container, false)
            row.turn.text = "${step.turn}턴"
            row.act.text = step.text
            row.seg.text = step.label
            when {
                i < index -> {
                    row.act.setTextColor(resources.getColor(R.color.text_done, theme))
                    row.turn.setTextColor(resources.getColor(R.color.text_done, theme))
                }

                i == index -> {
                    row.row.setBackgroundResource(R.drawable.bg_step_now)
                }
            }
            row.row.setOnClickListener {
                index = i
                renderSteps()
            }
            container.addView(row.root)
        }

        val remain = steps.size - index - 1
        if (remain > 2) {
            container.addView(TextView(this).apply {
                text = "… 이후 ${remain - 2}단계"
                textSize = 9f
                gravity = Gravity.CENTER
                setTextColor(resources.getColor(R.color.text_done, theme))
            })
        }
    }

    private fun nav(delta: Int) {
        if (steps.isEmpty()) return
        // 손으로 옮기면 자동 추적을 잠깐 끈다 (인식이 곧바로 되돌리는 것 방지) — PC판과 같은 규칙
        if (auto && delta != 0) {
            setAuto(false)
            status("수동 이동 — 자동을 다시 켜면 턴 추적 재개", warn = false)
        }
        index = (index + delta).coerceIn(0, steps.size - 1)
        renderSteps()
    }

    // ─────────────────────────────── 턴 인식

    private fun setAuto(on: Boolean) {
        if (on) {
            if (Prefs.region(this) == null) {
                status("먼저 '턴 위치'로 숫자가 보이는 자리를 지정해 주세요", warn = true)
                return
            }
            auto = true
            markAutoButton()
            if (capture?.isRunning == true) {
                status(getString(R.string.status_recognizing), warn = false)
            } else {
                // 화면 읽기 동의는 액티비티에서만 받을 수 있다
                status("화면 읽기 권한을 확인하는 중…", warn = false)
                startActivity(
                    Intent(this, ProjectionRequestActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        } else {
            auto = false
            markAutoButton()
            stopCapture()
            binding.turnBadge.text = getString(R.string.turn_none)
            status(getString(R.string.status_auto_off), warn = false)
        }
    }

    private fun markAutoButton() {
        binding.btnAuto.setBackgroundResource(if (auto) R.drawable.bg_chip_on else R.drawable.bg_chip)
        binding.btnAuto.setTextColor(
            resources.getColor(if (auto) R.color.accent else R.color.text_main, theme)
        )
    }

    private fun startCapture(code: Int, data: Intent) {
        val region = Prefs.region(this) ?: return
        // API 34부터는 mediaProjection 종류로 올라간 뒤에야 화면을 가져올 수 있다
        goForeground(capturing = true)
        stopCapture()
        capture = TurnCapture(
            context = this,
            onTurn = { turn -> applyRecognizedTurn(turn) },
            onMiss = { status("숫자를 못 읽고 있어요 — 턴 위치를 다시 지정해보세요", warn = true) },
            onError = { message ->
                auto = false
                markAutoButton()
                status(message, warn = true)
            },
        ).also {
            if (it.start(code, data, region)) {
                status(getString(R.string.status_recognizing), warn = false)
            }
        }
    }

    private fun stopCapture() {
        capture?.stop()
        capture = null
        lastTurn = null
        pendingTurn = null
    }

    /** 오인식 방어 — 같은 값이 두 번 연속으로 읽혀야 반영한다 (PC판과 같은 규칙) */
    private fun applyRecognizedTurn(t: Int) {
        if (!auto) return
        if (t < 0 || t > 999) return
        if (pendingTurn != t) {
            pendingTurn = t
            return
        }
        if (lastTurn == t) return
        lastTurn = t

        binding.turnBadge.text = "턴 $t"
        status("인식 중 — ${t}턴", warn = false)

        val next = Steps.nextIndexForTurn(steps, index, t)
        if (next != index) {
            index = next
            renderSteps()
        }
    }

    // ─────────────────────────────── 턴 위치 지정

    private fun showPicker() {
        if (pickerView != null) return
        val view = RegionPickerView(this) { region ->
            removePicker()
            if (region != null) {
                Prefs.setRegion(this, region)
                status(getString(R.string.status_region_set), warn = false)
                // 보던 자리가 바뀌었으니 인식도 다시 잡는다
                if (capture?.isRunning == true) {
                    capture?.updateRegion(region)
                }
            } else {
                status("턴 위치 지정을 취소했어요", warn = false)
            }
        }
        val pickerParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        runCatching {
            windowManager.addView(view, pickerParams)
            pickerView = view
        }
    }

    private fun removePicker() {
        pickerView?.let { runCatching { windowManager.removeView(it) } }
        pickerView = null
    }

    // ─────────────────────────────── 알림 · 포그라운드

    private fun status(text: String, warn: Boolean) {
        binding.status.text = text
        binding.status.setTextColor(
            resources.getColor(if (warn) R.color.warn else R.color.text_dim, theme)
        )
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun notification(): Notification {
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(build?.name ?: "")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.notif_stop), stop)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun goForeground(capturing: Boolean) {
        val type = when {
            capturing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION

            !capturing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE

            else -> 0
        }
        ServiceCompat.startForeground(this, NOTIF_ID, notification(), type)
    }
}
