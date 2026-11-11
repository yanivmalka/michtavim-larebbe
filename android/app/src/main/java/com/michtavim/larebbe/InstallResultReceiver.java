package com.michtavim.larebbe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

/** Receives the outcome of an update install session (see AppUpdaterPlugin). */
public class InstallResultReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        Intent confirm = null;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            confirm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class)
                    : intent.getParcelableExtra(Intent.EXTRA_INTENT);
        }
        AppUpdaterPlugin.onResult(context, status,
                intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                intent.getStringExtra(PackageInstaller.EXTRA_OTHER_PACKAGE_NAME),
                confirm);
    }
}
