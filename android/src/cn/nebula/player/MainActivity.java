package cn.nebula.player;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.DialogInterface;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.view.Gravity;

/**
 * NEBULA 粒子音乐空间 —— 安卓外壳。
 *
 * 设计要点：播放器的后端跑不到手机上（网易云要 weapi/eapi 加密、QQ/酷狗要服务端直连中转），
 * 所以手机是"瘦客户端"：这个 App 就是一个专用浏览器，指向你自己的服务器。
 *
 * 因为公网隧道（Cloudflare 快速隧道）每次重启地址都会变，
 * 所以【服务器地址必须能在应用里改】—— 长按画面任意位置即可修改，改完记在本地。
 *
 * 零依赖：只用 Android 平台自带 API（没有 AndroidX、没有 Gradle 依赖），
 * 这样在国内网络下构建不需要拉任何 maven 包。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "nebula";
    private static final String KEY_URL = "server_url";
    private static final String DEFAULT_URL = "https://herb-glen-inherited-panels.trycloudflare.com";

    private WebView web;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = sp.getString(KEY_URL, "");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // 播放器用 localStorage 记忆画质/音源/全屏状态
        s.setMediaPlaybackRequiresUserGesture(false); // 不要每次都要手点才出声
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.setBackgroundColor(Color.BLACK);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                v.loadUrl(url);
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());

        // 长按画面 = 改服务器地址（隧道地址变了，用户不用重装 App）
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                askServer(true);
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 起一个极简的提示层，首次使用时告诉用户"地址可以改"
        TextView hint = new TextView(this);
        hint.setText("长按画面可修改服务器地址");
        hint.setTextColor(0x66FFFFFF);
        hint.setTextSize(11);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.gravity = Gravity.BOTTOM | Gravity.START;
        hint.setPadding(16, 8, 16, 8);
        root.addView(hint, hp);

        setContentView(root);

        if (serverUrl == null || serverUrl.length() == 0) {
            serverUrl = DEFAULT_URL;   // 首次进来先用它，多半直接能用
            askServer(false);
        } else {
            open();
        }
    }

    private void open() {
        if (web != null && serverUrl != null && serverUrl.length() > 0) {
            web.loadUrl(serverUrl);
        }
    }

    /** showCancel=true 表示用户在主动修改；false 表示首次引导 */
    private void askServer(final boolean showCancel) {
        final EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        in.setText(serverUrl);
        in.setHint("https://xxx.trycloudflare.com");

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("服务器地址")
                .setMessage("播放器的后端在你的电脑上，这里填隧道地址。\n地址变了就在这里改（长按画面随时可改）。")
                .setView(in)
                .setPositiveButton("连接", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        String u = in.getText().toString().trim();
                        if (u.length() == 0) return;
                        if (!u.startsWith("http://") && !u.startsWith("https://")) {
                            u = "https://" + u;
                        }
                        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
                        serverUrl = u;
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                .putString(KEY_URL, u).apply();
                        open();
                        Toast.makeText(MainActivity.this, "正在连接…", Toast.LENGTH_SHORT).show();
                    }
                });
        if (showCancel) {
            b.setNegativeButton("取消", null);
        } else {
            b.setCancelable(false);
        }
        b.show();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }
}
