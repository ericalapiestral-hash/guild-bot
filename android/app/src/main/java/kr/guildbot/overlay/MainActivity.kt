// 앱 화면 — 도감 불러오기, 빌드 고르기, 오버레이 켜기.
// 게임 중에는 이 화면을 볼 일이 없다. 실제 사용은 전부 떠 있는 창에서 이뤄진다.
package kr.guildbot.overlay

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import kr.guildbot.overlay.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private var builds: List<BuildDoc> = emptyList()
    private var syncedAt: String? = null
    private var categories: List<String> = emptyList()
    private var shown: List<BuildDoc> = emptyList()

    private val pickFile = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        when (val r = BuildsRepository.importFrom(this, uri)) {
            is BuildsResult.Ok -> {
                toast("도감 ${r.builds.size}개를 불러왔어요")
                refresh()
            }

            is BuildsResult.Fail -> toast(r.message)
        }
    }

    private val askNotification = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 거절해도 오버레이는 돈다 — 알림만 안 보인다 */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnImportFile.setOnClickListener {
            // 파일 관리자가 json을 octet-stream으로 넘기는 경우가 있어 넓게 연다
            pickFile.launch(arrayOf("*/*"))
        }
        binding.btnImportUrl.setOnClickListener { askUrl() }
        binding.btnPerm.setOnClickListener { openOverlaySettings() }
        binding.btnOverlay.setOnClickListener { toggleOverlay() }

        binding.spinnerCategory.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                fillBuilds(categories.getOrNull(position))
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        binding.spinnerBuild.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val picked = shown.getOrNull(position) ?: return
                Prefs.setLastBuildId(this@MainActivity, picked.id)
                binding.buildInfo.text = "단계 ${picked.stepCount}개 · 라운드 ${picked.groups.size}개"
                // 창이 이미 떠 있으면 곧바로 갈아끼운다
                if (OverlayService.running) {
                    startService(
                        Intent(this@MainActivity, OverlayService::class.java)
                            .setAction(OverlayService.ACTION_RELOAD)
                    )
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotification.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    // ─────────────────────────────── 화면 갱신

    private fun refresh() {
        when (val loaded = BuildsRepository.load(this)) {
            is BuildsResult.Fail -> {
                builds = emptyList()
                syncedAt = null
                binding.statusText.text = loaded.message
            }

            is BuildsResult.Ok -> {
                // 스킬 순서가 없는 빌드는 오버레이에서 쓸 게 없다
                builds = loaded.builds.filter { it.stepCount > 0 }
                syncedAt = loaded.syncedAt
                binding.statusText.text = buildString {
                    append("도감 ${builds.size}개")
                    syncedAt?.let { append(" · 동기화 ").append(it.take(10)) }
                }
            }
        }

        fillCategories()
        updatePermissionState()
        binding.btnOverlay.text = if (OverlayService.running) "오버레이 끄기" else "오버레이 켜기"
    }

    private fun fillCategories() {
        categories = builds.map { it.category }.distinct()
        binding.spinnerCategory.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            categories,
        )
        // 지난번에 보던 빌드가 속한 분류를 먼저 편다
        val remembered = Prefs.lastBuildId(this)
        val at = builds.firstOrNull { it.id == remembered }
            ?.let { categories.indexOf(it.category) } ?: 0
        if (at in categories.indices) binding.spinnerCategory.setSelection(at)
        fillBuilds(categories.getOrNull(binding.spinnerCategory.selectedItemPosition))
    }

    private fun fillBuilds(category: String?) {
        shown = builds.filter { category == null || it.category == category }
        binding.spinnerBuild.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            shown.map { b ->
                if (b.weekdays.isEmpty()) b.name else "[${b.weekdays.joinToString("·")}] ${b.name}"
            },
        )
        val remembered = Prefs.lastBuildId(this)
        val at = shown.indexOfFirst { it.id == remembered }
        if (at >= 0) binding.spinnerBuild.setSelection(at)
    }

    private fun updatePermissionState() {
        val granted = Settings.canDrawOverlays(this)
        binding.permText.text = if (granted) {
            "다른 앱 위에 표시: 허용됨"
        } else {
            "다른 앱 위에 표시 권한이 필요합니다. 이게 없으면 게임 위에 창을 띄울 수 없어요."
        }
        binding.btnPerm.isEnabled = !granted
    }

    // ─────────────────────────────── 동작

    private fun toggleOverlay() {
        if (OverlayService.running) {
            startService(
                Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_STOP)
            )
            binding.btnOverlay.text = "오버레이 켜기"
            return
        }

        if (!Settings.canDrawOverlays(this)) {
            toast("먼저 '다른 앱 위에 표시'를 허용해 주세요")
            openOverlaySettings()
            return
        }
        if (builds.isEmpty()) {
            toast("도감을 먼저 불러와 주세요")
            return
        }

        startForegroundService(
            Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_SHOW)
        )
        binding.btnOverlay.text = "오버레이 끄기"
        toast("게임으로 넘어가면 창이 따라옵니다")
    }

    private fun openOverlaySettings() {
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
        )
    }

    private fun askUrl() {
        val input = EditText(this).apply {
            hint = "https://…/builds.json"
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle("URL에서 도감 받기")
            .setView(input)
            .setPositiveButton("받기") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isEmpty()) return@setPositiveButton
                binding.statusText.text = "받는 중…"
                // 네트워크는 메인 스레드에서 못 돈다
                Thread {
                    val result = BuildsRepository.importFrom(this, url)
                    runOnUiThread {
                        when (result) {
                            is BuildsResult.Ok -> {
                                toast("도감 ${result.builds.size}개를 불러왔어요")
                                refresh()
                            }

                            is BuildsResult.Fail -> {
                                toast(result.message)
                                refresh()
                            }
                        }
                    }
                }.start()
            }
            .setNegativeButton("취소", null)
            .show()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
