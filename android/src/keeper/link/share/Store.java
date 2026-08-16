package keeper.link.share;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Settings, the offline queue, and the one HTTP call. Everything the two activities share. */
final class Store {
    private static final String PREFS = "linkkeeper";

    private Store() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String endpoint(Context c) { return prefs(c).getString("endpoint", ""); }
    static String token(Context c)    { return prefs(c).getString("token", ""); }

    /** The queue is one string of newline-separated URLs — tiny, ordered, and survives reboots. */
    static List<String> queue(Context c) {
        List<String> out = new ArrayList<>();
        for (String line : prefs(c).getString("queue", "").split("\n")) {
            if (!line.isEmpty()) out.add(line);
        }
        return out;
    }

    static void saveQueue(Context c, List<String> q) {
        prefs(c).edit().putString("queue", String.join("\n", q)).apply();
    }

    static void enqueue(Context c, String url) {
        List<String> q = queue(c);
        if (!q.contains(url)) q.add(url);
        saveQueue(c, q);
    }

    /** POST one URL. Returns null on success, a short reason on failure. Call off the main thread. */
    static String post(Context c, String url) {
        String endpoint = endpoint(c), token = token(c);
        if (endpoint.isEmpty() || token.isEmpty()) return "not configured";
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(endpoint + "/add").openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            String body = "{\"url\":" + jsonString(url) + ",\"client\":\"android\"}";
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            if (code == 200) return null;
            String detail = "";
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    code < 400 ? conn.getInputStream() : conn.getErrorStream(), StandardCharsets.UTF_8))) {
                detail = r.readLine();
            } catch (Exception ignored) {}
            return "HTTP " + code + (detail == null || detail.isEmpty() ? "" : " " + detail);
        } catch (Exception e) {
            return e.getClass().getSimpleName();
        }
    }

    /** Try to send everything queued; whatever fails stays queued. Returns how many went out. */
    static int flush(Context c) {
        List<String> q = queue(c), left = new ArrayList<>();
        int sent = 0;
        for (String url : q) {
            if (post(c, url) == null) sent++;
            else left.add(url);
        }
        saveQueue(c, left);
        return sent;
    }

    /** Shares arrive as "caption text https://…" more often than as a bare URL. */
    static String extractUrl(String text) {
        if (text == null) return null;
        for (String word : text.split("\\s+")) {
            if (word.startsWith("http://") || word.startsWith("https://")) return word;
        }
        return null;
    }

    private static String jsonString(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }
}
