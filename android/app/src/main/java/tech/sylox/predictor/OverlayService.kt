package tech.sylox.predictor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * Foreground service that draws a small, draggable, see-through floating window over any
 * other app. The window hosts a WebView that loads the compact predictor UI from GitHub
 * Pages (so updates ship via git push, no rebuild). A native title strip provides drag + close;
 * a JS bridge handles resize, close, open-full-tool, and export/import of the saved test.
 */
class OverlayService : Service() {

    companion object {
        const val CHANNEL = "sylox_overlay"
        const val FULL_URL = "https://deepankar1993.github.io/Test-Prediction-engine-show/"
        const val OVERLAY_URL =
            "https://deepankar1993.github.io/Test-Prediction-engine-show/overlay.html?app=1"

        // FileActivity (import) hands the picked JSON back to the live overlay here.
        @Volatile
        var live: OverlayService? = null
        fun inject(json: String) { live?.injectImport(json) }
    }

    private lateinit var wm: WindowManager
    private val lp = WindowManager.LayoutParams()
    private var root: View? = null
    private var web: WebView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(1, buildNotification())
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        addOverlay()
        live = this
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private fun addOverlay() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

        lp.apply {
            width = dp(330)
            height = WindowManager.LayoutParams.WRAP_CONTENT
            this.type = type
            flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
            format = PixelFormat.TRANSLUCENT
            gravity = Gravity.TOP or Gravity.START
            x = dp(8)
            y = dp(56)
        }

        val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // --- native drag handle + close (so dragging never fights the web buttons) ---
        val handle = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#E60F1925"))
            setPadding(dp(10), dp(6), dp(6), dp(6))
        }
        handle.addView(TextView(this).apply {
            text = "⋮⋮  SYLOX  ·  drag"
            setTextColor(Color.parseColor("#5b8bd0"))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        handle.addView(Button(this).apply {
            text = "×"
            setTextColor(Color.parseColor("#ff9d8b"))
            setBackgroundColor(Color.parseColor("#552a1916"))
            textSize = 16f
            minimumWidth = dp(30)
            minimumHeight = dp(28)
            setPadding(0, 0, 0, 0)
            setOnClickListener { stopSelf() }
        })
        handle.setOnTouchListener(object : View.OnTouchListener {
            var ix = 0; var iy = 0; var rx = 0f; var ry = 0f
            override fun onTouch(v: View, e: MotionEvent): Boolean {
                when (e.action) {
                    MotionEvent.ACTION_DOWN -> { ix = lp.x; iy = lp.y; rx = e.rawX; ry = e.rawY; return true }
                    MotionEvent.ACTION_MOVE -> {
                        lp.x = ix + (e.rawX - rx).toInt()
                        lp.y = iy + (e.rawY - ry).toInt()
                        root?.let { wm.updateViewLayout(it, lp) }
                        return true
                    }
                }
                return false
            }
        })

        // --- web content (the predictor UI; updates live from GitHub Pages) ---
        val w = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // ALWAYS pull the latest UI/logic from GitHub Pages (this is the whole point of
            // the WebView shell). LOAD_DEFAULT cached engine.js, which froze old behaviour.
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            webViewClient = WebViewClient()
            addJavascriptInterface(Bridge(), "SyloxNative")
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(430)
            )
            clearCache(true)
            loadUrl(OVERLAY_URL + "&t=" + System.currentTimeMillis())
        }
        web = w

        container.addView(handle)
        container.addView(w)
        root = container
        wm.addView(container, lp)
    }

    /** Push imported JSON (from FileActivity) into the overlay's saved test. */
    fun injectImport(json: String) {
        val w = web ?: return
        Handler(mainLooper).post {
            w.evaluateJavascript("window.__sxImport(" + JSONObject.quote(json) + ")", null)
        }
    }

    /** Called from overlay.html JS. */
    inner class Bridge {
        @JavascriptInterface
        fun resize(cssHeight: Int) {
            val px = (cssHeight * resources.displayMetrics.density).toInt().coerceIn(dp(120), dp(640))
            Handler(mainLooper).post {
                web?.let {
                    it.layoutParams.height = px
                    it.requestLayout()
                    root?.let { r -> try { wm.updateViewLayout(r, lp) } catch (_: Exception) {} }
                }
            }
        }

        @JavascriptInterface
        fun close() { Handler(mainLooper).post { stopSelf() } }

        @JavascriptInterface
        fun openFull() { startExternal(Intent(Intent.ACTION_VIEW, Uri.parse(FULL_URL))) }

        // export: save the test JSON to a file the user chooses (then import it in the browser tool)
        @JavascriptInterface
        fun share(json: String) { openFile("export", json) }

        // import: pick a JSON file the browser tool exported, and load it here
        @JavascriptInterface
        fun importFile() { openFile("import", null) }

        private fun openFile(mode: String, json: String?) {
            val i = Intent(this@OverlayService, FileActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("mode", mode)
            if (json != null) i.putExtra("json", json)
            startExternal(i)
        }

        private fun startExternal(i: Intent) {
            try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
        }
    }

    private fun startExternal(i: Intent) {
        try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Sylox overlay", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setContentTitle("Sylox predictor")
            .setContentText("Floating window active — tap × to stop")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (live === this) live = null
        root?.let { try { wm.removeView(it) } catch (_: Exception) {} }
        root = null
        web = null
    }
}
