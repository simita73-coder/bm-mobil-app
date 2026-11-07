package __PACKAGE__;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * BM Mobil natív része:
 *  - közvetlen SQLite-hozzáférés a telefon tárhelyén lévő bookmarks.db-hez ("minden fájl kezelése" engedéllyel),
 *  - webcím megnyitása az alapértelmezett böngészőben,
 *  - offline MHTML keresése (ID alapján) és megnyitása,
 *  - a böngészőből "Megosztás" menüvel érkező link fogadása.
 */
@CapacitorPlugin(name = "BmNative")
public class BmPlugin extends Plugin {

    private SQLiteDatabase db = null;
    private String dbPath = null;

    // A megosztással érkezett, még fel nem dolgozott szöveg
    private String pendingText = null;
    private String pendingSubject = null;

    private static String msg(Exception e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    private boolean granted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return true;
    }

    // ------------------------------------------------------------------ megosztás fogadása

    @Override
    public void load() {
        readShareIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (readShareIntent(intent)) {
            notifyListeners("shared", takePending());
        }
    }

    private boolean readShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return false;
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        // Ne dolgozzuk fel kétszer ugyanazt az intentet (pl. az Activity újraindításakor)
        intent.setAction(Intent.ACTION_MAIN);
        if (text == null || text.trim().isEmpty()) {
            return false;
        }
        pendingText = text;
        pendingSubject = subject;
        return true;
    }

    private JSObject takePending() {
        JSObject r = new JSObject();
        r.put("text", pendingText == null ? "" : pendingText);
        r.put("subject", pendingSubject == null ? "" : pendingSubject);
        pendingText = null;
        pendingSubject = null;
        return r;
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        call.resolve(takePending());
    }

    // ------------------------------------------------------------------ engedély, útvonalak

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("root", Environment.getExternalStorageDirectory().getAbsolutePath());
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("granted", granted());
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            String pkg = getContext().getPackageName();
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + pkg));
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(msg(e));
        }
    }

    @PluginMethod
    public void checkPath(PluginCall call) {
        String path = call.getString("path", "");
        File f = new File(path);
        JSObject r = new JSObject();
        r.put("exists", f.exists());
        r.put("isFile", f.isFile());
        r.put("isDir", f.isDirectory());
        r.put("size", f.isFile() ? f.length() : 0);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ SQLite

    @PluginMethod
    public void openDb(PluginCall call) {
        try {
            String path = call.getString("path");
            if (path == null || path.trim().isEmpty()) {
                call.reject("Hiányzó adatbázis-útvonal");
                return;
            }
            File f = new File(path);
            if (!f.isFile()) {
                call.reject("Az adatbázis nem található: " + path);
                return;
            }
            closeQuietly();
            db = SQLiteDatabase.openDatabase(path, null,
                    SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            dbPath = path;
            // Mega-mappában vagyunk: ne maradjon -wal/-shm fájl a DB mellett, csak rövid életű -journal
            try {
                Cursor c = db.rawQuery("PRAGMA journal_mode=DELETE", null);
                c.moveToFirst();
                c.close();
            } catch (Exception ignored) {
                // nem végzetes
            }
            JSObject r = new JSObject();
            r.put("path", path);
            r.put("size", f.length());
            call.resolve(r);
        } catch (Exception e) {
            closeQuietly();
            call.reject("Az adatbázis nem nyitható meg: " + msg(e));
        }
    }

    @PluginMethod
    public void closeDb(PluginCall call) {
        closeQuietly();
        call.resolve();
    }

    private void closeQuietly() {
        try {
            if (db != null) {
                db.close();
            }
        } catch (Exception ignored) {
            // nincs mit tenni
        }
        db = null;
        dbPath = null;
    }

    private String[] textArgs(JSArray params) throws Exception {
        if (params == null) {
            return new String[0];
        }
        String[] out = new String[params.length()];
        for (int i = 0; i < out.length; i++) {
            Object o = params.get(i);
            out[i] = (o == null || o == JSONObject.NULL) ? null : String.valueOf(o);
        }
        return out;
    }

    private void bindAll(SQLiteStatement st, JSArray params) throws Exception {
        if (params == null) {
            return;
        }
        for (int i = 0; i < params.length(); i++) {
            Object o = params.get(i);
            int idx = i + 1;
            if (o == null || o == JSONObject.NULL) {
                st.bindNull(idx);
            } else if (o instanceof Boolean) {
                st.bindLong(idx, ((Boolean) o) ? 1 : 0);
            } else if (o instanceof Integer || o instanceof Long) {
                st.bindLong(idx, ((Number) o).longValue());
            } else if (o instanceof Number) {
                double d = ((Number) o).doubleValue();
                if (d == Math.rint(d) && Math.abs(d) < 9.0e15) {
                    st.bindLong(idx, (long) d);
                } else {
                    st.bindDouble(idx, d);
                }
            } else {
                st.bindString(idx, String.valueOf(o));
            }
        }
    }

    /**
     * SELECT. flat=true: csak az első oszlop értékei, egyetlen tömbben (nagy azonosító-listákhoz).
     * Válasz: {columns:[...], rows:[[...]]} vagy flat esetén {values:[...]}.
     */
    @PluginMethod
    public void query(PluginCall call) {
        if (db == null) {
            call.reject("Nincs megnyitott adatbázis");
            return;
        }
        Cursor c = null;
        try {
            String sql = call.getString("sql");
            boolean flat = Boolean.TRUE.equals(call.getBoolean("flat", false));
            c = db.rawQuery(sql, textArgs(call.getArray("params")));
            int n = c.getColumnCount();
            JSObject r = new JSObject();
            if (flat) {
                JSArray vals = new JSArray();
                while (c.moveToNext()) {
                    putValue(vals, c, 0);
                }
                r.put("values", vals);
            } else {
                JSArray cols = new JSArray();
                for (int i = 0; i < n; i++) {
                    cols.put(c.getColumnName(i));
                }
                JSArray rows = new JSArray();
                while (c.moveToNext()) {
                    JSArray row = new JSArray();
                    for (int i = 0; i < n; i++) {
                        putValue(row, c, i);
                    }
                    rows.put(row);
                }
                r.put("columns", cols);
                r.put("rows", rows);
            }
            call.resolve(r);
        } catch (Exception e) {
            call.reject(msg(e));
        } finally {
            if (c != null) {
                c.close();
            }
        }
    }

    private void putValue(JSArray arr, Cursor c, int i) {
        switch (c.getType(i)) {
            case Cursor.FIELD_TYPE_INTEGER:
                arr.put(c.getLong(i));
                break;
            case Cursor.FIELD_TYPE_FLOAT:
                try {
                    arr.put(c.getDouble(i));
                } catch (Exception e) {
                    arr.put(JSONObject.NULL);
                }
                break;
            case Cursor.FIELD_TYPE_STRING:
                arr.put(c.getString(i));
                break;
            default:
                arr.put(JSONObject.NULL);
        }
    }

    /** INSERT / UPDATE / DELETE típusos paraméterekkel. Válasz: {changes} vagy INSERT-nél {id}. */
    @PluginMethod
    public void run(PluginCall call) {
        if (db == null) {
            call.reject("Nincs megnyitott adatbázis");
            return;
        }
        SQLiteStatement st = null;
        try {
            String sql = call.getString("sql");
            st = db.compileStatement(sql);
            bindAll(st, call.getArray("params"));
            JSObject r = new JSObject();
            if (sql.trim().toUpperCase(Locale.ROOT).startsWith("INSERT")) {
                r.put("id", st.executeInsert());
            } else {
                r.put("changes", st.executeUpdateDelete());
            }
            call.resolve(r);
        } catch (Exception e) {
            call.reject(msg(e));
        } finally {
            if (st != null) {
                st.close();
            }
        }
    }

    /** Paraméter nélküli utasítás (pl. ALTER TABLE). */
    @PluginMethod
    public void exec(PluginCall call) {
        if (db == null) {
            call.reject("Nincs megnyitott adatbázis");
            return;
        }
        try {
            db.execSQL(call.getString("sql"));
            call.resolve();
        } catch (Exception e) {
            call.reject(msg(e));
        }
    }

    // ------------------------------------------------------------------ megnyitás

    /** Webcím megnyitása az Android alapértelmezett böngészőjében. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        try {
            String url = call.getString("url", "").trim();
            String low = url.toLowerCase(Locale.ROOT);
            if (!(low.startsWith("http://") || low.startsWith("https://"))) {
                call.reject("Csak http/https cím nyitható meg: " + url);
                return;
            }
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Nincs böngésző, amely megnyitná a címet");
        } catch (Exception e) {
            call.reject(msg(e));
        }
    }

    /**
     * Az ID-hoz tartozó MHTML fájl keresése a mappában: dátum_cím_id123_domain.mhtml.
     * Több találatnál a legújabb fájlt adja vissza.
     */
    @PluginMethod
    public void findMhtml(PluginCall call) {
        try {
            String dir = call.getString("dir", "");
            Long id = call.getLong("id");
            if (id == null) {
                call.reject("Hiányzó ID");
                return;
            }
            File d = new File(dir);
            File[] items = d.listFiles();
            if (items == null) {
                call.reject("A mappa nem olvasható (nincs engedély, vagy nem létezik): " + dir);
                return;
            }
            Pattern p = Pattern.compile("_id" + id + "(?=[_.])");
            File best = null;
            for (File f : items) {
                if (!f.isFile()) {
                    continue;
                }
                String n = f.getName();
                String ln = n.toLowerCase(Locale.ROOT);
                if (!(ln.endsWith(".mhtml") || ln.endsWith(".mht"))) {
                    continue;
                }
                if (p.matcher(n).find() && (best == null || f.lastModified() > best.lastModified())) {
                    best = f;
                }
            }
            JSObject r = new JSObject();
            r.put("path", best == null ? "" : best.getAbsolutePath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(msg(e));
        }
    }

    /** MHTML fájl megnyitása külső alkalmazással (alapesetben a böngésző), FileProvider-es content:// címmel. */
    @PluginMethod
    public void openFile(PluginCall call) {
        try {
            File f = new File(call.getString("path", ""));
            if (!f.isFile()) {
                call.reject("A fájl nem létezik: " + f.getPath());
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".bmprovider", f);
            String[] mimes = {"multipart/related", "message/rfc822", "application/x-mimearchive", "text/html"};
            ActivityNotFoundException last = null;
            for (String mime : mimes) {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, mime);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(i);
                    call.resolve();
                    return;
                } catch (ActivityNotFoundException e) {
                    last = e;
                }
            }
            call.reject("Egyik alkalmazás sem tudja megnyitni az MHTML fájlt" + (last == null ? "" : ""));
        } catch (Exception e) {
            call.reject(msg(e));
        }
    }
}
