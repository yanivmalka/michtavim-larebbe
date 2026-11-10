package com.michtavim.larebbe;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Asks the user to confirm it is them – fingerprint/face, or the device PIN/pattern/password
 * as a fallback – before a hidden letter is shown.
 */
@CapacitorPlugin(name = "DeviceAuth")
public class DeviceAuthPlugin extends Plugin {
    private static final int AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject ret = new JSObject();
        ret.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("status", status);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String title = call.getString("title", "אימות");
        String subtitle = call.getString("subtitle", "");
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            call.resolve();
                        }

                        @Override
                        public void onAuthenticationError(int code, @NonNull CharSequence message) {
                            call.reject(message.toString(), code == BiometricPrompt.ERROR_USER_CANCELED
                                    || code == BiometricPrompt.ERROR_CANCELED
                                    || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ? "CANCELED" : "AUTH_ERROR");
                        }
                        // onAuthenticationFailed: a single wrong finger – the prompt stays open, nothing to do
                    });
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setAllowedAuthenticators(AUTHENTICATORS);
            if (!subtitle.isEmpty()) info.setSubtitle(subtitle);
            try {
                prompt.authenticate(info.build());
            } catch (Exception e) {
                call.reject(e.getMessage(), "UNAVAILABLE");
            }
        });
    }
}
