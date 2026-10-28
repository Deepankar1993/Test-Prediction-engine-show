package tech.sylox.predictor

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Handler
import android.os.HandlerThread
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Auto-read: an accessibility service that reads the game's on-screen text (no screenshots, no
 * network, zero dependencies). Two jobs:
 *  - scan(): list every text node the game shows right now, so the user can see whether the
 *    result / reel digits are readable at all, and tap which one is which ("binding").
 *  - auto: once bound, the OS pushes a window-change event the instant the game's text changes;
 *    when the bound nodes settle on a new valid result (0–27, or 3 reel digits) it is handed to
 *    the overlay, exactly as if the user had tapped it.
 * Games drawn on a canvas (no text nodes) show up as an empty scan — they need a screenshot reader.
 */
class ScreenReader : AccessibilityService() {

    companion object {
        @Volatile
        var live: ScreenReader? = null
        const val PREFS = "sylox_reader"
        const val KEY_CFG = "cfg"          // {pkg, auto, items:[{role,id,cx,cy}]}
        const val SETTLE_MS = 900L         // value must hold this long (skips rolling-reel animation)
        const val TICK_MS = 4000L          // watchdog look (the result card stays up ~10s)
        const val STALE_MS = 200_000L      // ~3 rounds with the game open and nothing read → buzz
        const val TAG = "SyloxReader"
        // a "6+0+5" card anywhere in the game: fallback if the game renames its result view
        private val CARD = Regex("^\\s*\\d\\s*\\+\\s*\\d\\s*\\+\\s*\\d\\s*$")
        private val ROLES = setOf("result", "d1", "d2", "d3", "round", "total")

        // Known games: read straight from their result card, no binding needed. Chamet's 0–27 game
        // shows "6+0+5" (resultText) = "11" (tv_result_num) for ~10s after every draw (adb dump, Oct 2026).
        const val CHAMET = "com.hkfuliao.chamet"
        private val PRESETS = mapOf(CHAMET to listOf(
            JSONObject().put("role", "result").put("id", "$CHAMET:id/resultText"),
            JSONObject().put("role", "total").put("id", "$CHAMET:id/tv_result_num"),
        ))
    }

    private fun gamePkg(c: JSONObject) = c.optString("pkg").ifEmpty { CHAMET }

    /** The user's own binding if they made one, else the built-in preset for the game. */
    private fun itemsOf(c: JSONObject): List<JSONObject> {
        val a = c.optJSONArray("items")
        if (a != null && a.length() > 0) return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
        return PRESETS[gamePkg(c)] ?: emptyList()
    }

    private val worker = HandlerThread("sylox-reader").apply { start() }
    private val h = Handler(worker.looper)
    @Volatile private var cfg = JSONObject()
    private var lastSig = ""        // signature of the last value handed to the overlay
    private var pendSig = ""        // value currently settling
    private var pendAt = 0L
    private var primed = false      // first reading after (re)start is only remembered, not logged
    @Volatile var lastRead = ""     // human-readable last emission, for the overlay status
        private set
    @Volatile private var lastAt = 0L     // when the last result was handed over
    @Volatile private var gameUp = false  // game window on screen at the last look
    private var alerted = false           // stale-read buzz already given for this outage
    private val checkRun = Runnable { check() }

    // Health watchdog: every few seconds, look again even without an event (safety net for a
    // missed event), track whether the game is on screen, and buzz once when reads stop.
    private val tick = object : Runnable {
        override fun run() {
            if (cfg.optBoolean("auto")) check()
            val now = System.currentTimeMillis()
            if (cfg.optBoolean("auto") && gameUp && lastAt > 0 && now - lastAt > STALE_MS && !alerted) {
                alerted = true
                Log.w(TAG, "no result read for ${(now - lastAt) / 1000}s while the game is open")
                buzz()
            }
            h.postDelayed(this, TICK_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        cfg = loadCfg()
        live = this
        h.post(tick)
        OverlayService.live?.setKeepOn(cfg.optBoolean("auto"))
    }

    private fun buzz() {
        try {
            @Suppress("DEPRECATION")
            val v = getSystemService(VIBRATOR_SERVICE) as Vibrator
            v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 250, 150, 250), -1))
        } catch (_: Exception) {}
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (live === this) live = null
        worker.quitSafely()
        super.onDestroy()
    }

    private fun loadCfg(): JSONObject = try {
        JSONObject(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CFG, "{}") ?: "{}")
    } catch (_: Exception) { JSONObject() }

    // "preset" tells the overlay auto can run without the user binding anything
    fun config(): String = JSONObject(cfg.toString())
        .put("preset", (cfg.optJSONArray("items")?.length() ?: 0) == 0 && PRESETS.containsKey(gamePkg(cfg)))
        .put("last", lastRead).put("lastAt", lastAt).put("gameUp", gameUp).toString()

    /** Save the binding chosen in the overlay; only known roles are kept. */
    fun setConfig(json: String) {
        val inc = try { JSONObject(json) } catch (_: Exception) { return }
        val items = JSONArray()
        val src = inc.optJSONArray("items") ?: JSONArray()
        for (i in 0 until src.length()) {
            val it = src.optJSONObject(i) ?: continue
            if (it.optString("role") in ROLES) items.put(it)
        }
        val c = JSONObject().put("pkg", inc.optString("pkg")).put("items", items)
        c.put("auto", inc.optBoolean("auto") && itemsOf(c).isNotEmpty())
        cfg = c
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_CFG, c.toString()).apply()
        h.post { lastSig = ""; pendSig = ""; primed = false; alerted = false }
        OverlayService.live?.setKeepOn(c.optBoolean("auto"))   // auto on → screen stays awake
    }

    // ---------------------------------------------------------------- reading the screen

    private class TextNode(val text: String, val id: String, val r: Rect)

    /** Every visible text node of the topmost non-Sylox app window. */
    private fun read(): Pair<String, List<TextNode>> {
        val out = ArrayList<TextNode>()
        var pkg = ""
        val ws = try { windows } catch (_: Exception) { emptyList() }
        // app windows only (top first) — skips the keyboard, status bar and our own floating window
        val roots = ws.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .mapNotNull { it.root }.ifEmpty { listOfNotNull(rootInActiveWindow) }
        for (root in roots) {
            val p = root.packageName?.toString() ?: ""
            if (p == packageName || p == "com.android.systemui") continue
            if (pkg.isEmpty()) pkg = p else if (p != pkg) continue
            walk(root, out, 0)
        }
        return pkg to out
    }

    private fun walk(n: AccessibilityNodeInfo?, out: MutableList<TextNode>, depth: Int) {
        if (n == null || depth > 60 || out.size >= 400) return
        if (n.isVisibleToUser && !n.isPassword) {   // never read password fields
            val t = (n.text ?: n.contentDescription)?.toString()?.trim().orEmpty()
            if (t.isNotEmpty()) {
                val r = Rect(); n.getBoundsInScreen(r)
                out.add(TextNode(t.take(80), n.viewIdResourceName ?: "", r))
            }
        }
        for (i in 0 until n.childCount) walk(n.getChild(i), out, depth + 1)
    }

    /** Diagnostic for the overlay: what text can we see in the game right now? */
    fun scan(): String {
        val (pkg, nodes) = read()
        val dm = resources.displayMetrics
        val arr = JSONArray()
        for (n in nodes) arr.put(JSONObject()
            .put("t", n.text).put("id", n.id)
            .put("cx", n.r.exactCenterX() / dm.widthPixels).put("cy", n.r.exactCenterY() / dm.heightPixels))
        return JSONObject().put("pkg", pkg).put("items", arr).toString()
    }

    /** The node a bound item refers to: same view id if it has one, else the nearest text node. */
    private fun locate(item: JSONObject, nodes: List<TextNode>): TextNode? {
        val id = item.optString("id")
        if (id.isNotEmpty()) nodes.firstOrNull { it.id == id }?.let { return it }
        val dm = resources.displayMetrics
        val cx = item.optDouble("cx", -1.0) * dm.widthPixels
        val cy = item.optDouble("cy", -1.0) * dm.heightPixels
        val tol = 0.06 * maxOf(dm.widthPixels, dm.heightPixels)
        return nodes.minByOrNull { Math.hypot(it.r.exactCenterX() - cx, it.r.exactCenterY() - cy) }
            ?.takeIf { Math.hypot(it.r.exactCenterX() - cx, it.r.exactCenterY() - cy) <= tol }
    }

    private fun ints(s: String) = Regex("\\d+").findAll(s).map { it.value.toInt() }.toList()

    /** Turn the bound nodes' text into (sum, reels) — null when they don't show a valid result yet. */
    private fun interpret(vals: Map<String, String>): Pair<Int, IntArray?>? {
        val d = listOf("d1", "d2", "d3").map { k -> vals[k]?.let { ints(it) }?.singleOrNull() }
        if (d.all { it != null && it in 0..9 }) {
            val r = IntArray(3) { d[it]!! }
            return r.sum() to r
        }
        val res = vals["result"] ?: return null
        val n = ints(res)
        // "3 + 5 + 7 = 15", "3 5 7", "357 = 15" style: three single digits (optionally + their sum)
        val digits = if (n.size == 1 && res.trim().matches(Regex("\\d{3}"))) res.trim().map { it - '0' } else n
        // a separately shown total (preset "total" node) must agree, else it's a half-drawn frame
        val total = vals["total"]?.let { ints(it) }?.singleOrNull()
        if (digits.size >= 3 && digits.take(3).all { it in 0..9 }) {
            val r = digits.take(3).toIntArray()
            if ((digits.size == 3 || digits[3] == r.sum()) && (total == null || total == r.sum())) return r.sum() to r
        }
        if (n.size == 1 && n[0] in 0..27 && (total == null || total == n[0])) return n[0] to null
        return null
    }

    override fun onAccessibilityEvent(e: AccessibilityEvent?) {
        val c = cfg
        if (!c.optBoolean("auto")) return
        if (e?.packageName?.toString() != gamePkg(c)) return
        h.removeCallbacks(checkRun)
        h.postDelayed(checkRun, 120)   // coalesce bursts of change events
    }

    private fun check() {
        val c = cfg
        val items = itemsOf(c)
        if (items.isEmpty()) return
        val (pkg, nodes) = read()
        gameUp = pkg == gamePkg(c)
        if (!gameUp) return
        val vals = HashMap<String, String>()
        for (it in items) locate(it, nodes)?.let { n -> vals[it.optString("role")] = n.text }
        val preset = (c.optJSONArray("items")?.length() ?: 0) == 0
        if (preset && vals["result"] == null)
            nodes.firstOrNull { CARD.matches(it.text) }?.let { vals["result"] = it.text }
        val got = interpret(vals)
        if (got == null) {
            // result cleared off screen → the next result counts even if it's the same number
            if (vals["round"] == null) lastSig = ""
            primed = true
            pendSig = ""; return
        }
        val sig = (vals["round"] ?: "") + "|" + got.first + "|" + (got.second?.joinToString(",") ?: "")
        // whatever is already on screen when auto starts is an old round — don't log it
        if (!primed) { primed = true; lastSig = sig; return }
        if (sig == lastSig) return
        val now = System.currentTimeMillis()
        if (sig != pendSig) { pendSig = sig; pendAt = now }
        if (now - pendAt < SETTLE_MS) {
            h.removeCallbacks(checkRun)
            h.postDelayed(checkRun, SETTLE_MS - (now - pendAt) + 50)   // re-check once settled
            return
        }
        lastSig = sig; pendSig = ""
        val (sum, reels) = got
        lastRead = if (reels != null) "${reels.joinToString("+")}=$sum" else "$sum"
        Log.i(TAG, "read $lastRead" + (if (lastAt > 0) " (+${(now - lastAt) / 1000}s)" else ""))
        lastAt = now; alerted = false
        OverlayService.live?.pushAuto(sum, reels)
    }
}
