package keeper.link.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

/**
 * The share target. Invisible: grab the URL out of the share, hand it to a background thread,
 * finish immediately. The toast is the entire UI. If the endpoint is unreachable (Tailscale off,
 * no signal), the URL waits in the queue and goes out with the next share or a manual flush.
 */
public class ShareActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = Store.extractUrl(getIntent().getStringExtra(Intent.EXTRA_TEXT));
        if (url == null) {
            Toast.makeText(this, "no link in that share", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            // Everything queued goes as one batch: this share, plus any stragglers before it.
            Store.enqueue(app, url);
            int before = Store.queue(app).size();
            int sent = Store.flush(app);
            int left = before - sent;
            String msg = left == 0
                    ? (sent == 1 ? "saved" : "saved, +" + (sent - 1) + " queued earlier")
                    : "offline — queued (" + left + " waiting)";
            new Handler(Looper.getMainLooper()).post(() ->
                    Toast.makeText(app, "Link Keeper: " + msg, Toast.LENGTH_SHORT).show());
        }).start();

        finish();
    }
}
