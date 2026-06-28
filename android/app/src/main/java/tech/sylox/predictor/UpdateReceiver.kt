package tech.sylox.predictor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings

/**
 * Re-opens the floating overlay automatically after an in-place APK update.
 *
 * When a new APK is installed over the old one, Android kills the app and the foreground
 * service (the floating window) dies. ACTION_MY_PACKAGE_REPLACED is delivered to the freshly
 * installed app and is exempt from the background foreground-service-start restriction, so we
 * can relaunch the service from here. The "Display over other apps" grant survives updates,
 * so the window can redraw immediately.
 *
 * We only relaunch if the overlay was actually running when the update landed (a flag set by
 * OverlayService and cleared only when the user closes it with ×), so an update never pops the
 * window up on someone who had deliberately closed it.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val wasRunning = context
            .getSharedPreferences(OverlayService.PREFS, Context.MODE_PRIVATE)
            .getBoolean(OverlayService.KEY_RUNNING, false)
        if (!wasRunning) return
        if (!Settings.canDrawOverlays(context)) return   // permission missing → user starts it manually
        val svc = Intent(context, OverlayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
        else context.startService(svc)
    }
}
