package com.michtavim.larebbe;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.List;
import java.util.Locale;

/**
 * Reads text aloud with Android's text-to-speech (a WebView has no speech engine of its own).
 * speak({ chunks, lang, rate }) resolves when the last chunk was said, or when stopped ({ done: false });
 * it is rejected with NO_VOICE when the device has no voice for the language.
 */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ready;
    private PluginCall speaking;
    private int session;

    /** Runs `then` once the engine is ready; rejects the call when the device has none. */
    private synchronized void withEngine(PluginCall call, Runnable then) {
        if (tts != null && ready) { then.run(); return; }
        tts = new TextToSpeech(getContext().getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                tts = null;
                call.reject("No text-to-speech engine", "NO_TTS");
                return;
            }
            ready = true;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }

                @Override public void onDone(String id) { finished(id, null); }

                @Override public void onError(String id) { finished(id, "TTS_ERROR"); }
            });
            then.run();
        });
    }

    /** The last chunk of the current reading ended (ids are "<session>:<index>:<last?>"). */
    private synchronized void finished(String id, String error) {
        if (speaking == null || id == null || !id.startsWith(session + ":")) return;
        if (error == null && !id.endsWith(":last")) return;
        PluginCall call = speaking;
        speaking = null;
        if (error != null) { tts.stop(); call.reject("Reading failed", error); return; }
        call.resolve(new JSObject().put("done", true));
    }

    private synchronized void interrupt() {
        session++;
        if (tts != null) tts.stop();
        if (speaking != null) {
            speaking.resolve(new JSObject().put("done", false));
            speaking = null;
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final List<String> chunks;
        try {
            JSArray list = call.getArray("chunks");
            chunks = list == null ? null : list.toList();
        } catch (JSONException e) {
            call.reject("Bad text", "BAD_REQUEST");
            return;
        }
        if (chunks == null || chunks.isEmpty()) { call.resolve(new JSObject().put("done", true)); return; }
        String lang = call.getString("lang", "he-IL");
        float rate = call.getFloat("rate", 1f);
        withEngine(call, () -> {
            interrupt();
            int available = tts.setLanguage(Locale.forLanguageTag(lang));
            if (available < TextToSpeech.LANG_AVAILABLE) { call.reject("No voice for " + lang, "NO_VOICE"); return; }
            tts.setSpeechRate(rate);
            synchronized (this) {
                speaking = call;
                int limit = TextToSpeech.getMaxSpeechInputLength();
                for (int i = 0; i < chunks.size(); i++) {
                    String text = chunks.get(i);
                    if (text.length() > limit) text = text.substring(0, limit);
                    String id = session + ":" + i + (i == chunks.size() - 1 ? ":last" : "");
                    tts.speak(text, i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, new Bundle(), id);
                }
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        interrupt();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        interrupt();
        if (tts != null) { tts.shutdown(); tts = null; ready = false; }
    }
}
