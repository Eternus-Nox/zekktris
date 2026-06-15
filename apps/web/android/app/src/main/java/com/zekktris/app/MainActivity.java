package com.zekktris.app;

import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Keep the user logged in across app restarts. Auth = a 15-min access token
    // in localStorage (already persisted by the WebView) + a 30-day httpOnly
    // refresh cookie. The Android WebView can drop cookies on an app kill unless
    // they're flushed to disk, so flush on pause. (Cookies are accepted by the
    // WebView by default, so no extra setup is needed here.)
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }
}
