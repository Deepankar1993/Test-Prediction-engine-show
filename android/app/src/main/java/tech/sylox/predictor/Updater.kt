package tech.sylox.predictor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Self-update from GitHub Releases (zero dependencies).
 *
 * CI publishes `version.json` ({"versionCode":N,"versionName":"1.0.N"}) next to the APK on the
 * `app-latest` release. We compare it with the installed versionCode; if newer we download the
 * APK and hand it to PackageInstaller. Android itself guarantees safety: an update installs only
 * if it is signed with the SAME key as the installed app (the CI release keystore).
 *
 * Prompts: the first self-update needs the user to allow "Install unknown apps" for this app and
 * tap Install. From then on this app is the package's installer of record, so on Android 12+ we
 * request USER_ACTION_NOT_REQUIRED and later updates install silently. UpdateReceiver then
 * re-opens the floating window.
 */
object Updater {
    private const val REL = "https://github.com/Deepankar1993/Test-Prediction-engine-show/releases/download/app-latest/"
    const val VERSION_URL = REL + "version.json"
    const val APK_URL = REL + "sylox-predictor.apk"
    private const val CHANNEL = "sylox_update"
    private const val PREF_LAST = "update_last_check"
    private const val PERIOD_MS = 3 * 60 * 60 * 1000L          // while the overlay runs: every 3 h
    @Volatile private var busy = false
    private val main = Handler(Looper.getMainLooper())

    fun installedCode(ctx: Context): Long {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode
        else @Suppress("DEPRECATION") pi.versionCode.toLong()
    }
    fun installedName(ctx: Context): String =
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"

    /** Periodic background checks while the overlay service is alive. */
    private var tick: Runnable? = null
    fun schedule(ctx: Context) {
        val app = ctx.applicationContext
        cancel()
        tick = object : Runnable {
            override fun run() { check(app, manual = false) { }; main.postDelayed(this, PERIOD_MS) }
        }.also { main.postDelayed(it, 20_000) }   // let the overlay settle first
    }
    fun cancel() { tick?.let { main.removeCallbacks(it) }; tick = null }

    /**
     * Check GitHub; install if newer. [report] gets a short human status on the main thread.
     * Automatic checks are throttled to once per hour; manual checks always run.
     */
    fun check(ctx: Context, manual: Boolean, askPermission: Boolean = manual, report: (String) -> Unit) {
        val app = ctx.applicationContext
        val prefs = app.getSharedPreferences(OverlayService.PREFS, Context.MODE_PRIVATE)
        if (!manual && System.currentTimeMillis() - prefs.getLong(PREF_LAST, 0) < 60 * 60 * 1000L) return
        if (busy) { main.post { report("Update already in progress…") }; return }
        busy = true
        Thread {
            try {
                prefs.edit().putLong(PREF_LAST, System.currentTimeMillis()).apply()
                val j = JSONObject(httpText(VERSION_URL + "?t=" + System.currentTimeMillis()))
                val latest = j.getLong("versionCode"); val name = j.optString("versionName", latest.toString())
                val mine = installedCode(app)
                if (latest <= mine) { main.post { report("Up to date (v${installedName(app)})") }; return@Thread }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !app.packageManager.canRequestPackageInstalls()) {
                    // one-time permission: send the user to the toggle (from the app screen) or notify
                    main.post { report("Update v$name available — allow “Install unknown apps” for Sylox, then check again") }
                    if (askPermission) openInstallPermission(app) else if (!manual) notify(app, "Update v$name available",
                        "Open Sylox Predictor to install it", Intent(app, MainActivity::class.java))
                    return@Thread
                }
                main.post { report("Downloading v$name…") }
                val apk = File(app.cacheDir, "update.apk"); download(APK_URL, apk)
                main.post { report("Installing v$name…") }
                install(app, apk)
            } catch (e: Exception) {
                main.post { report("Update check failed: ${e.message ?: e.javaClass.simpleName}") }
            } finally { busy = false }
        }.start()
    }

    fun openInstallPermission(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
    }

    private fun open(url: String): HttpURLConnection {
        // GitHub release downloads redirect (github.com -> objects.githubusercontent.com); follow them by hand
        var u = URL(url)
        repeat(6) {
            val c = (u.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 60_000
                setRequestProperty("User-Agent", "sylox-predictor-updater")
            }
            val code = c.responseCode
            if (code in 300..399) { u = URL(u, c.getHeaderField("Location")); c.disconnect() }
            else if (code == 200) return c
            else { c.disconnect(); throw IllegalStateException("HTTP $code") }
        }
        throw IllegalStateException("too many redirects")
    }
    private fun httpText(url: String): String = open(url).let { c -> c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) } }
    private fun download(url: String, to: File) {
        val c = open(url); val tmp = File(to.path + ".part")
        c.inputStream.use { i -> tmp.outputStream().use { o -> i.copyTo(o) } }
        if (tmp.length() < 50_000) throw IllegalStateException("download too small")
        if (!tmp.renameTo(to)) { to.delete(); tmp.renameTo(to) }
    }

    private fun install(ctx: Context, apk: File) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("base.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            val status = PendingIntent.getBroadcast(ctx, id, Intent(ctx, InstallResultReceiver::class.java), flags)
            s.commit(status.intentSender)
        }
    }

    fun notify(ctx: Context, title: String, text: String, tap: Intent) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = PendingIntent.getActivity(ctx, 7, tap.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(ctx, CHANNEL)
                else @Suppress("DEPRECATION") Notification.Builder(ctx)
        nm.notify(2, b.setContentTitle(title).setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done).setContentIntent(pi).setAutoCancel(true).build())
    }
}

/** PackageInstaller result: shows the system confirm screen when Android asks for it. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                               else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
                // overlay permission exempts us from background-activity-start limits; notify as a fallback
                try { ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                catch (_: Exception) { Updater.notify(ctx, "Sylox update ready", "Tap to install", confirm) }
            }
            PackageInstaller.STATUS_SUCCESS -> { /* app is replaced; UpdateReceiver re-opens the overlay */ }
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "install failed"
                Updater.notify(ctx, "Sylox update failed", msg, Intent(ctx, MainActivity::class.java))
            }
        }
    }
}
