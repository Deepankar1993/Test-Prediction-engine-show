# Keep the JS bridge interface (called from WebView JavaScript).
-keepclassmembers class tech.sylox.predictor.OverlayService$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
