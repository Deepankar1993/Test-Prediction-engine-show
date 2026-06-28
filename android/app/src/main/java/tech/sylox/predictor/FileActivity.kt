package tech.sylox.predictor

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

/**
 * Transient, transparent helper launched by the overlay's JS bridge to move the saved test
 * between devices: export via ACTION_CREATE_DOCUMENT (save a .json the user picks), import via
 * ACTION_OPEN_DOCUMENT (read a .json the browser tool exported). Storage Access Framework only —
 * no extra permissions, no FileProvider.
 */
class FileActivity : Activity() {

    private var exportJson: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.getStringExtra("mode") == "export") {
            exportJson = intent.getStringExtra("json") ?: ""
            val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, "sylox-test.json")
            }
            launch(i, REQ_EXPORT)
        } else {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
            launch(i, REQ_IMPORT)
        }
    }

    private fun launch(i: Intent, code: Int) {
        try { startActivityForResult(i, code) } catch (e: Exception) { finish() }
    }

    @Deprecated("Classic result API is adequate for a plain Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (resultCode == RESULT_OK && uri != null) {
            try {
                if (requestCode == REQ_EXPORT) {
                    contentResolver.openOutputStream(uri)?.use { it.write((exportJson ?: "").toByteArray()) }
                    toast("Saved — open it in the browser tool's Import")
                } else {
                    val json = contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                    if (json != null) {
                        OverlayService.inject(json)
                        toast("Imported into the floating predictor")
                    }
                }
            } catch (_: Exception) { toast("Could not read that file") }
        }
        finish()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    companion object {
        private const val REQ_EXPORT = 1
        private const val REQ_IMPORT = 2
    }
}
