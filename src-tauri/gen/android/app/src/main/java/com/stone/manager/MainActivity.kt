package com.stone.manager

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  private var lastTopInsetPx = 0
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)

    val contentRoot = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contentRoot) { view, insets ->
      val topInsetPx = insets
        .getInsetsIgnoringVisibility(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        .top

      if (topInsetPx != lastTopInsetPx) {
        lastTopInsetPx = topInsetPx
        pushTopInsetToWebView()
      }

      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(contentRoot)
    contentRoot.post { pushTopInsetToWebView() }
  }

  override fun onResume() {
    super.onResume()
    pushTopInsetToWebView()
  }

  @SuppressLint("JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    webView.setOnTouchListener { _, event ->
      event != null && event.pointerCount > 1
    }
    webView.addJavascriptInterface(StoneAndroidInsetsBridge(), "StoneAndroidInsets")

    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(
        webView,
        """
          document.documentElement.style.setProperty(
            "--app-top-safe-area-inset",
            window.StoneAndroidInsets.getTopInsetPx()
          );
        """.trimIndent(),
        setOf("*")
      )
    }

    pushTopInsetToWebView()
    super.onWebViewCreate(webView)
  }

  private fun pushTopInsetToWebView() {
    val webView = appWebView ?: return
    val topInsetCssPx = toCssPx(lastTopInsetPx)
    val script = """
      (function () {
        var topInset = "${topInsetCssPx}px";
        document.documentElement.style.setProperty("--app-top-safe-area-inset", topInset);
      })();
    """.trimIndent()

    webView.post {
      webView.evaluateJavascript(script, null)
    }
  }

  inner class StoneAndroidInsetsBridge {
    @JavascriptInterface
    fun getTopInsetPx(): String {
      return "${toCssPx(lastTopInsetPx)}px"
    }
  }

  private fun toCssPx(nativePx: Int): Int {
    val density = resources.displayMetrics.density.coerceAtLeast(1f)
    return (nativePx.coerceAtLeast(0) / density).toInt()
  }
}
