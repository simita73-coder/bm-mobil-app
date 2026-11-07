"""A `npx cap add android` által létrehozott Android-projekt kiegészítése:
- engedélyek (minden fájl kezelése) és megosztás-fogadás a AndroidManifest.xml-ben,
- a saját natív plugin (SQLite, linknyitás, MHTML), a FileProvider és a MainActivity bemásolása,
- állandó aláírókulcs (így az új verzió a régire ráfrissíthető).
A GitHub Actions futtatja, a projekt gyökeréből: python3 scripts/patch_android.py
"""
import json
import pathlib
import shutil
import sys

cfg = json.loads(pathlib.Path("capacitor.config.json").read_text(encoding="utf-8"))
app_id = cfg["appId"]
root = pathlib.Path("android")
if not root.is_dir():
    sys.exit("Nincs android mappa: előbb futtasd az `npx cap add android` parancsot.")

# 1) manifest: engedélyek, megosztás-fogadás, FileProvider
manifest = root / "app/src/main/AndroidManifest.xml"
text = manifest.read_text(encoding="utf-8")

perms = [
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
]
add = "".join(f'    <uses-permission android:name="{p}" />\n' for p in perms if p not in text)
if add:
    if "<application" not in text:
        sys.exit("A manifestben nincs <application> elem.")
    text = text.replace("<application", add + "    <application", 1)

# Megosztás-fogadás: a böngésző "Megosztás" menüjében megjelenik az app (szöveg/link)
share_filter = """            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
"""
if "android.intent.action.SEND" not in text:
    marker = "</activity>"
    if marker not in text:
        sys.exit("A manifestben nincs </activity>.")
    text = text.replace(marker, share_filter + "        " + marker, 1)

# MHTML megnyitásához saját FileProvider (a Capacitoré mellett, más névvel)
provider = f"""        <provider
            android:name="{app_id}.BmFileProvider"
            android:authorities="{app_id}.bmprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/bm_file_paths" />
        </provider>
"""
if "BmFileProvider" not in text:
    text = text.replace("</application>", provider + "    </application>", 1)

manifest.write_text(text, encoding="utf-8")
print("Manifest rendben.")

# 2) fájlok a csomagnak megfelelő mappába
pkg_dir = root / "app/src/main/java" / pathlib.Path(*app_id.split("."))
pkg_dir.mkdir(parents=True, exist_ok=True)
for name in ("BmPlugin.java", "BmFileProvider.java", "MainActivity.java"):
    src = pathlib.Path("android-extra") / name
    (pkg_dir / name).write_text(src.read_text(encoding="utf-8").replace("__PACKAGE__", app_id), encoding="utf-8")
    print("Bemásolva:", pkg_dir / name)

xml_dir = root / "app/src/main/res/xml"
xml_dir.mkdir(parents=True, exist_ok=True)
shutil.copyfile("android-extra/bm_file_paths.xml", xml_dir / "bm_file_paths.xml")
print("Bemásolva:", xml_dir / "bm_file_paths.xml")

# 3) állandó aláírókulcs
shutil.copyfile("android-extra/debug.keystore", root / "app/debug.keystore")
gradle = root / "app/build.gradle"
g = gradle.read_text(encoding="utf-8")
if "debug.keystore" not in g:
    g += """

// Állandó debug aláírás (a patch_android.py adta hozzá)
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
}
"""
    gradle.write_text(g, encoding="utf-8")
print("Aláírókulcs beállítva.")
