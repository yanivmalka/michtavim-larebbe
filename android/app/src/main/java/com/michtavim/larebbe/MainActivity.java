package com.michtavim.larebbe;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int BAR_COLOR = Color.parseColor("#1f3a5f");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(DeviceAuthPlugin.class);
        super.onCreate(savedInstanceState);
        fitToSystemBarsAndKeyboard();
    }

    /**
     * Edge-to-edge on every Android version, with the web view kept clear of the status bar,
     * the navigation bar and the on-screen keyboard: when the keyboard opens the page shrinks
     * above it, so the text box stays visible (like modern chat apps).
     */
    private void fitToSystemBarsAndKeyboard() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View root = getWindow().getDecorView();
        root.setBackgroundColor(BAR_COLOR); // what shows behind the status / navigation bars
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        View webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets sys = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = sys.left;
            mlp.rightMargin = sys.right;
            mlp.topMargin = sys.top;
            mlp.bottomMargin = Math.max(sys.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }
}
