// 화면 읽기 동의창만 띄우는 껍데기. 시스템 대화상자는 액티비티에서만 뜨기 때문에 필요하다.
package kr.guildbot.overlay

import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

class ProjectionRequestActivity : AppCompatActivity() {

    private val consent = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val forward = Intent(this, OverlayService::class.java)
            .setAction(OverlayService.ACTION_PROJECTION)
            .putExtra(OverlayService.EXTRA_CODE, result.resultCode)
        result.data?.let { forward.putExtra(OverlayService.EXTRA_DATA, it) }
        startService(forward)
        finish()
        overridePendingTransition(0, 0)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        overridePendingTransition(0, 0)
        val manager = getSystemService(MediaProjectionManager::class.java)
        if (manager == null) {
            finish()
            return
        }
        // savedInstanceState가 있으면 이미 띄운 뒤 되살아난 것 — 두 번 띄우지 않는다
        if (savedInstanceState == null) {
            consent.launch(manager.createScreenCaptureIntent())
        }
    }
}
