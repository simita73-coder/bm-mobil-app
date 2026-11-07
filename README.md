# BM Mobil (Android, v2.0)

A `bm_mobil_v1_4.html` Android-változata. Ugyanaz a felület, de natív SQLite-tal, közvetlenül a telefon
tárhelyén (a Mega-mappában) lévő `bookmarks.db`-vel dolgozik: nincs fájlválasztás, export vagy kézi visszamásolás.

## Alapértelmezett útvonalak (átírhatók az appban)
- adatbázis: `/storage/emulated/0/Norbi/bookmarks.db` (📂 DB gomb)
- offline MHTML mappa: `/storage/emulated/0/Norbi/MHTML` (⚙️ Beállítások)

## Első indítás
1. Az app kéri a „Minden fájl kezelése" engedélyt (📂 DB ablak → Engedély megadása) → kapcsold be, majd lépj vissza.
2. 📂 DB → **Megnyitás / újratöltés**. A következő indításkor automatikusan megnyílik.

## Gombok
**1. sor:** ⬆/⬇ rendezés ID szerint (1. nyomás: legkisebb ID elöl, utána váltakozik) · 🔀 véletlen · ⚙️ beállítások · ↩ visszavonás · 🏷 címkék
**2. sor:** ❓ hiányzó adat (címke / tartalom / cím / dátum, VAGY/ÉS) · 🔐 védettek · 📖 olvasásra várók · 🗑 törlésre jelöltek · ✨ minden cikk
**Alul:** 🌐 megnyitás (rövid: web az alapértelmezett böngészőben, 3 mp: offline MHTML az ID alapján) · 🔒 védelem · 📖 olvasni · 🗑 törlés
Lapozás: húzás balra/jobbra a cikken.

## Címkék ablak
A címke-mező fölötti keresőbe írt legalább 3 karakter után az **összes** címke közül listázza azokat,
amelyekben bárhol szerepel a beírt szöveg. Koppintásra a címke a cikk címkéi közé kerül.

## Új funkciók Androidon
- **Megosztás**: böngészőben Megosztás → BM Mobil → új könyvjelző (URL, domain, dátum, cím; a címkét és a tartalmat a Windowsos BM tölti fel később).
- **Vissza gomb**: előbb bezárja a megnyitott ablakot; főképernyőn kétszer kell megnyomni a kilépéshez.
- **Képernyő bekapcsolva marad**, amíg az app előtérben van.
- **⚙️ Beállítások → Összes törlésre jelölt törlése**: véglegesen törli a törlésre jelölt cikkeket (a védetteket kihagyja, az MHTML fájlokhoz nem nyúl).

## Az APK készítése
Minden feltöltésnél (push a `main` ágra) a `.github/workflows/build-apk.yml` lefut, és a **Releases** oldalra kiteszi:
`https://github.com/<felhasznalonev>/bm-mobil-app/releases/latest/download/bm-mobil.apk`

Az APK a képválogatóéval azonos állandó aláírókulccsal készül (`android-extra/debug.keystore`),
ezért az új verzió a régire közvetlenül ráfrissíthető, a beállítások megmaradnak.

## Fájlok
- `www/index.html`, `src/main.js` – a felület és a logika (a build `www/app.js`-t készít belőle)
- `android-extra/BmPlugin.java` – natív rész: SQLite, link- és MHTML-megnyitás, megosztás fogadása
- `android-extra/BmFileProvider.java`, `bm_file_paths.xml` – az MHTML fájl átadásához a böngészőnek
- `android-extra/MainActivity.java` – a plugin regisztrálása, képernyő bekapcsolva tartása
- `android-extra/debug.keystore` – állandó aláírókulcs
- `scripts/patch_android.py` – a generált Android-projekt kiegészítése (engedélyek, megosztás-fogadás, plugin, aláírás)
- `build-apk.yml` – a GitHub Actions munkafolyamat; a repóban a `.github/workflows/build-apk.yml` helyre kell tenni
