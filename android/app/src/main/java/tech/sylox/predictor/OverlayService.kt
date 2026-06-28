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
import android.view.inputmethod.InputMethodManager
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

        // Persisted flag so UpdateReceiver knows whether to re-open the overlay after an update.
        const val PREFS = "sylox"
        const val KEY_RUNNING = "overlay_running"

        // FileActivity (import) hands the picked JSON back to the live overlay here.
        @Volatile
        var live: OverlayService? = null
        fun inject(json: String) { live?.injectImport(json) }
    }

    private fun setRunning(v: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_RUNNING, v).apply()
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
        setRunning(true)   // an update that kills us while this is true → UpdateReceiver re-opens
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
            setOnClickListener { setRunning(false); stopSelf() }   // explicit close → don't auto-reopen
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

    /**
     * Make the floating window focusable (so the soft keyboard can attach) while the user types
     * the sync code, then restore the normal not-focusable, touch-pass-through state. Without
     * clearing FLAG_NOT_FOCUSABLE the IME never appears for the WebView's input fields.
     */
    fun setImeFocus(focus: Boolean) {
        Handler(mainLooper).post {
            val r = root ?: return@post
            lp.flags = if (focus)
                lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
            else
                lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            try { wm.updateViewLayout(r, lp) } catch (_: Exception) {}
            val w = web ?: return@post
            val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
            if (focus) {
                w.requestFocus()
                // fire after the web side focuses the <input> (~60ms) so the IME has a target
                Handler(mainLooper).postDelayed({ imm.showSoftInput(w, InputMethodManager.SHOW_IMPLICIT) }, 150)
            } else {
                imm.hideSoftInputFromWindow(w.windowToken, 0)
            }
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
        fun close() { setRunning(false); Handler(mainLooper).post { stopSelf() } }

        // The overlay window is FLAG_NOT_FOCUSABLE so it never steals touches from the game.
        // That also blocks the soft keyboard, so the sync-code field can't be typed into.
        // The web calls this to make the window focusable only while entering text, then restore.
        @JavascriptInterface
        fun imeFocus(focus: Boolean) { setImeFocus(focus) }

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
