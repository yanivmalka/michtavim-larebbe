package com.michtavim.larebbe;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

/**
 * Downloads a newer APK of this app, checks it, and installs it through Android's PackageInstaller.
 * Unlike handing the file to the installer screen, a PackageInstaller session reports why an install
 * failed (other signing key, blocked, no space…), and the app shows that reason to the user.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    static final String ACTION_RESULT = "com.michtavim.larebbe.INSTALL_RESULT";

    /** The loaded plugin, so InstallResultReceiver can pass results on to the page. */
    private static AppUpdaterPlugin active;
    /** A confirmation screen that could not be shown while the app was in the background. */
    private static Intent pendingConfirm;
    private boolean resumed = true;

    /** A failure with a code the page turns into a message. */
    private static class UpdateError extends Exception {
        final String code;
        UpdateError(String code, String message) { super(message); this.code = code; }
    }

    @Override
    public void load() { active = this; }

    @Override
    protected void handleOnResume() {
        resumed = true;
        Intent confirm = pendingConfirm;
        pendingConfirm = null;
        if (confirm != null && getActivity() != null) getActivity().startActivity(confirm);
    }

    @Override
    protected void handleOnPause() { resumed = false; }

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
     * Downloads `url` (emitting "progress" events), checks the file and starts the install.
     * Resolves when Android has the package; the outcome arrives as "installStatus" events.
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
                JSObject ret = new JSObject();
                ret.put("method", install(apk));
                call.resolve(ret);
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

    /** Installs through a PackageInstaller session; falls back to the installer screen if that is not possible. */
    private String install(File apk) throws Exception {
        Context ctx = getContext();
        try {
            PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(ctx.getPackageName());
            params.setSize(apk.length());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // updating itself: Android may skip the confirmation when this app installed the current version
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            }
            int id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    session.fsync(out);
                }
                Intent result = new Intent(ctx, InstallResultReceiver.class).setAction(ACTION_RESULT);
                int piFlags = PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pending = PendingIntent.getBroadcast(ctx, id, result, piFlags);
                session.commit(pending.getIntentSender());
            }
            return "session";
        } catch (SecurityException | java.io.IOException e) {
            // some devices do not allow sessions for sideloaded apps: open the installer screen instead
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, "application/vnd.android.package-archive");
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(view);
            return "intent";
        }
    }

    /** Called by InstallResultReceiver: shows the confirmation screen, or passes the outcome to the page. */
    static void onResult(Context ctx, int status, String message, String otherPackage, Intent confirm) {
        AppUpdaterPlugin p = active;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION && confirm != null) {
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (p != null && p.resumed && p.getActivity() != null) {
                p.getActivity().runOnUiThread(() -> p.getActivity().startActivity(confirm));
            } else {
                pendingConfirm = confirm; // shown when the user comes back to the app
            }
        }
        if (p == null) return;
        JSObject r = new JSObject();
        r.put("status", status);
        r.put("message", message == null ? "" : message);
        if (otherPackage != null) r.put("otherPackage", otherPackage);
        p.notifyListeners("installStatus", r, true);
    }

    private boolean installAllowed() {
        return getContext().getPackageManager().canRequestPackageInstalls();
    }
}
