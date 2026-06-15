package com.zekktris.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

/**
 * Keeps the user logged in across app restarts.
 *
 * Auth is a short-lived (15 min) access token in localStorage plus a 30-day
 * httpOnly refresh-token cookie. localStorage already persists in the WebView,
 * but the Android System WebView only reliably keeps cookies if we (a) accept
 * them and (b) flush them to disk before the process is backgrounded/killed.
 * Without the flush, an app kill can drop the refresh cookie, so once the
 * access token expires the user is bounced to the login screen. Flushing on
 * pause makes the 30-day session survive restarts, matching the web/desktop.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        // The WebView loads the app from server.url; accept its cookies even
        // when assets/CDN are a different origin.
        if (this.bridge != null && this.bridge.getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(this.bridge.getWebView(), true);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Persist cookies to disk now, so a later app kill can't lose the
        // refresh-token cookie (and log the user out).
        CookieManager.getInstance().flush();
    }
}
