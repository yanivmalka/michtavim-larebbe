package com.michtavim.larebbe;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

/**
 * Downloads a newer APK of this app, checks it (complete, same package, newer, same signing key),
 * and opens Android's installer screen for it.
 *
 * The install deliberately goes through the installer screen, not a PackageInstaller session:
 * version 1.0.28 installed through a session (asking to skip the confirmation) and could no longer be
 * installed at all on a Galaxy A24 with Android 16 – most likely Play Protect treating that pattern as
 * an app that installs other apps. Keep it this way.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    /** A failure with a code the page turns into a message. */
    private static class UpdateError extends Exception {
        final String code;
        UpdateError(String code, String message) { super(message); this.code = code; }
    }

    /** Whether Android lets this app install packages (a per-app user setting). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", installAllowed());
        call.resolve(ret);
    }

    /** Opens the system screen where the user allows installing updates from this app. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /**
     * Downloads `url` (emitting "progress" events), checks the file and opens the installer screen.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        long expectedSize = call.getLong("expectedSize", 0L);
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("bad url", "BAD_URL");
            return;
        }
        if (!installAllowed()) {
            call.reject("install not allowed", "INSTALL_NOT_ALLOWED");
            return;
        }
        new Thread(() -> {
            try {
                File apk = download(url, expectedSize);
                checkPackage(apk);
                install(apk);
                call.resolve();
            } catch (UpdateError e) {
                call.reject(e.getMessage(), e.code);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "DOWNLOAD_FAILED", e);
            }
        }).start();
    }

    private File download(String url, long expectedSize) throws Exception {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("cannot create cache dir");
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete(); // never install a file left from an earlier try
        File apk = new File(dir, "update-" + System.currentTimeMillis() + ".apk");

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            long total = conn.getContentLengthLong();
            long done = 0;
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                int lastPct = -1;
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct != lastPct) {
                            lastPct = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("progress", p);
                        }
                    }
                }
                out.getFD().sync();
            }
            if ((total > 0 && done != total) || (expectedSize > 0 && done != expectedSize)) {
                throw new UpdateError("INCOMPLETE", "downloaded " + done + " of " + (total > 0 ? total : expectedSize) + " bytes");
            }
        } finally {
            conn.disconnect();
        }
        return apk;
    }

    /** The same app, a newer version, signed with the same key – otherwise Android would refuse it. */
    private void checkPackage(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = PackageManager.GET_SIGNING_CERTIFICATES;
        PackageInfo update = pm.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (update == null) throw new UpdateError("INVALID_APK", "the downloaded file is not a valid app package");
        String me = getContext().getPackageName();
        if (!me.equals(update.packageName)) throw new UpdateError("WRONG_PACKAGE", "package " + update.packageName);
        PackageInfo installed = pm.getPackageInfo(me, flags);
        long newCode = update.getLongVersionCode();
        long myCode = installed.getLongVersionCode();
        if (newCode <= myCode) throw new UpdateError("NOT_NEWER", "version " + newCode + " is not newer than " + myCode);
        Set<String> a = signers(update);
        Set<String> b = signers(installed);
        if (!a.isEmpty() && !b.isEmpty() && !a.equals(b)) {
            throw new UpdateError("SIGNATURE_MISMATCH", "installed " + b + ", update " + a);
        }
    }

    /** SHA-256 of the signing certificates (empty if Android did not read them). */
    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] sigs = info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : null;
        Set<String> out = new TreeSet<>();
        if (sigs == null) return out;
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        for (Signature s : sigs) {
            StringBuilder hex = new StringBuilder();
            for (byte x : sha.digest(s.toByteArray())) hex.append(String.format("%02X", x));
            out.add(hex.toString());
        }
        return out;
    }

    /** Hands the checked file to Android's installer screen (the user confirms there). */
    private void install(File apk) {
        Context ctx = getContext();
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, "application/vnd.android.package-archive");
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(view);
    }

    private boolean installAllowed() {
        return getContext().getPackageManager().canRequestPackageInstalls();
    }
}
