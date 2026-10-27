package tech.sylox.predictor

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Thin launcher: requests the "Display over other apps" permission, then starts the
 * floating overlay service. All prediction logic/UI lives in the web overlay loaded
 * from GitHub Pages, so updates ship by `git push` with no reinstall.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val pad = (24 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 3, pad, pad)
            setBackgroundColor(Color.parseColor("#0d141d"))
        }

        root.addView(TextView(this).apply {
            text = "Sylox · Floating Predictor"
            setTextColor(Color.parseColor("#e7eef6"))
            textSize = 22f
        })
        root.addView(TextView(this).apply {
            text = "Starts a small see-through window that floats over your game. " +
                "It shows the predicted numbers, the win status, and the result buttons. " +
                "First, allow “Display over other apps”, then tap Start."
            setTextColor(Color.parseColor("#8499ad"))
            textSize = 14f
            setPadding(0, pad, 0, pad)
        })

        root.addView(Button(this).apply {
            text = "Start floating predictor"
            setOnClickListener { startOverlay() }
        })
        root.addView(Button(this).apply {
            text = "Open the full tool"
            setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(OverlayService.FULL_URL)))
            }
        })

        // --- self-update from GitHub Releases ---
        val updStatus = TextView(this).apply {
            text = "App v${Updater.installedName(this@MainActivity)} · checking for updates…"
            setTextColor(Color.parseColor("#8499ad"))
            textSize = 13f
            setPadding(0, pad, 0, pad / 3)
        }
        root.addView(updStatus)
        root.addView(Button(this).apply {
            text = "Check for app update"
            setOnClickListener { Updater.check(this@MainActivity, manual = true) { updStatus.text = it } }
        })
        // check on every app open (only the button jumps to the "Install unknown apps" setting)
        Updater.check(this, manual = true, askPermission = false) { updStatus.text = it }

        setContentView(
            root,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun startOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
            )
            return
        }
        val intent = Intent(this, OverlayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        moveTaskToBack(true)
    }
}
