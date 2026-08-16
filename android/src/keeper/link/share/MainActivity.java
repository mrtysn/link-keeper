package keeper.link.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Settings and the queue, built programmatically — no resources, no dependencies, so the whole
 * app compiles with javac against android.jar and needs no build system.
 *
 * Config can also be seeded over adb, which beats typing a 48-character token on a phone:
 *   adb shell am start -n keeper.link.share/.MainActivity \
 *       -e endpoint http://100.x.y.z:8477 -e token <hex>
 */
public class MainActivity extends Activity {
    private EditText endpoint, token;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySeed(getIntent());

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        col.setPadding(pad, pad, pad, pad);

        col.addView(label("Inbox endpoint (http://tailscale-ip:port)"));
        endpoint = field(Store.endpoint(this), InputType.TYPE_TEXT_VARIATION_URI);
        col.addView(endpoint);

        col.addView(label("Token"));
        token = field(Store.token(this), InputType.TYPE_TEXT_VARIATION_PASSWORD);
        col.addView(token);

        Button save = new Button(this);
        save.setText("Save");
        save.setOnClickListener(v -> {
            Store.prefs(this).edit()
                    .putString("endpoint", endpoint.getText().toString().trim().replaceAll("/+$", ""))
                    .putString("token", token.getText().toString().trim())
                    .apply();
            refresh("saved");
        });
        col.addView(save);

        Button test = new Button(this);
        test.setText("Send test link");
        test.setOnClickListener(v -> inBackground(() -> {
            String err = Store.post(this, "https://example.com/from-the-phone");
            return err == null ? "test link delivered" : "failed: " + err;
        }));
        col.addView(test);

        Button flush = new Button(this);
        flush.setText("Flush queue");
        flush.setOnClickListener(v -> inBackground(() -> {
            int sent = Store.flush(this);
            return sent + " sent, " + Store.queue(this).size() + " still queued";
        }));
        col.addView(flush);

        status = new TextView(this);
        status.setPadding(0, pad, 0, 0);
        col.addView(status);

        ScrollView root = new ScrollView(this);
        root.addView(col, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);
        refresh(null);
    }

    /** adb-seeded config: save what the intent extras carry, then show it like any other state.
     *  Also handled for a relaunch onto a running instance, or the seed silently misses. */
    private void applySeed(Intent it) {
        if (it == null) return;
        if (it.getStringExtra("endpoint") != null || it.getStringExtra("token") != null) {
            Store.prefs(this).edit()
                    .putString("endpoint", or(it.getStringExtra("endpoint"), Store.endpoint(this)))
                    .putString("token", or(it.getStringExtra("token"), Store.token(this)))
                    .apply();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        applySeed(intent);
        if (endpoint != null) endpoint.setText(Store.endpoint(this));
        if (token != null) token.setText(Store.token(this));
        refresh("config updated");
    }

    private void refresh(String note) {
        int queued = Store.queue(this).size();
        String s = (Store.endpoint(this).isEmpty() ? "not configured yet" : Store.endpoint(this))
                + "\nqueued: " + queued + (note != null ? "\n\n" + note : "");
        status.setText(s);
        if (note != null) Toast.makeText(this, note, Toast.LENGTH_SHORT).show();
    }

    private interface Work { String run(); }

    private void inBackground(Work w) {
        new Thread(() -> {
            String result = w.run();
            new Handler(Looper.getMainLooper()).post(() -> refresh(result));
        }).start();
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setPadding(0, dp(14), 0, dp(4));
        return t;
    }

    private EditText field(String value, int inputType) {
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_TEXT | inputType);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        e.setText(value);
        return e;
    }

    private static String or(String a, String b) { return a != null ? a : b; }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
