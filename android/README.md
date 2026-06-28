# Sylox Predictor — Android floating overlay

A small, see-through, draggable window that floats over the live game and shows the
predicted numbers, win status, recent results, and the 0–27 result buttons.

**Download the APK:**
https://github.com/Deepankar1993/Test-Prediction-engine-show/releases/download/app-latest/sylox-predictor.apk

## How it works
- The app is a thin native shell. The floating window is a **WebView that loads
  `overlay.html` from GitHub Pages**, so the prediction UI and logic update the moment you
  `git push` — **no reinstall needed**. The APK only changes if the native shell changes.
- The APK is built automatically by GitHub Actions (`.github/workflows/android.yml`) and
  published to the **`app-latest`** release on every change to `android/**`.

## Install + use (Android only)
1. On the phone, open the download link and install the APK. You'll need to allow
   **“Install unknown apps”** for your browser (one-time).
2. Open **Sylox Predictor** → tap **Start floating predictor**.
3. Grant **“Display over other apps”** when prompted (Settings opens; toggle it on, go back,
   tap Start again).
4. Open the live game. The small window floats on top — **drag** it by the top “SYLOX” bar,
   tap the number that came up, watch the OLD/NEW predictions + win status. Tap **×** to stop.

## Notes / limits
- **Android only.** iOS does not allow apps to draw over other apps, so a floating overlay is
  not possible there.
- The app keeps its **own saved test** inside its WebView (persists across launches); it is
  separate from the browser version of the tool.
- On some OEMs (Xiaomi/Oppo/etc.) you may need to disable **battery optimization** for the app
  so the floating window isn’t killed when you switch to the game.
- It’s an **unsigned debug APK** for quick testing (sideload). A signed release build is a small
  follow-up if you later want Play Store / in-place auto-updates.

## Build locally (optional)
Requires JDK 17 + Android SDK 35.
```
cd android
gradle wrapper --gradle-version 8.9   # first time, to create ./gradlew
./gradlew assembleDebug
# APK at app/build/outputs/apk/debug/app-debug.apk
```
