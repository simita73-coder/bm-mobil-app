# BM Mobil (Android, v3.1)

A `bm_mobil_v1_4.html` Android-változata. Ugyanaz a felület, de natív SQLite-tal, közvetlenül a telefon
tárhelyén (a Mega-mappában) lévő `bookmarks.db`-vel dolgozik: nincs fájlválasztás, export vagy kézi visszamásolás.

## Alapértelmezett útvonalak (átírhatók az appban)
- adatbázis: `/storage/emulated/0/Norbi/bookmarks.db` (📂 DB gomb)
- offline MHTML mappa: `/storage/emulated/0/Norbi/BM-manager/MHTML` (⚙️ Beállítások; a korábban elmentett egyéni útvonal megmarad)
- összevonás mappája: `/storage/emulated/0/Norbi/Osszevonas` (a másik `bookmarks.db` itt keresendő)

## Első indítás
1. Az app kéri a „Minden fájl kezelése" engedélyt (📂 DB ablak → Engedély megadása) → kapcsold be, majd lépj vissza.
2. 📂 DB → **Megnyitás / újratöltés**. A következő indításkor automatikusan megnyílik.

## Gombok
**1. sor:** ⬆/⬇ rendezés ID szerint (1. nyomás: legkisebb ID elöl, utána váltakozik) · 🔀 véletlen · ⚙️ beállítások · ↩ visszavonás · 🏷 címkék
**2. sor:** ❓ hiányzó adat (címke / tartalom / cím / dátum, VAGY/ÉS) · 🔐 védettek · 📖 olvasásra várók · 🗑 törlésre jelöltek · ✨ új (nem olvasott) cikkek – mindegyik alatt a darabszám, ugyanaz, mint a hozzá tartozó lista hossza (a ❓ száma a kijelölt hiányzó adatokat követi)
**Alul:** 🌐/📄 megnyitás (rövid nyomás: offline MHTML, ha van hozzá fájl – ekkor 📄 a jel –, különben a webcím; hosszú nyomás, 3 mp: mindig a webcím) · 🔒 védelem · 📖 olvasni · 🗑 törlés
Lapozás: húzás balra/jobbra a cikken.

## Címkék ablak
- A címke-mező fölötti keresőbe írt legalább 3 karakter után az **összes** címke közül listázza azokat,
  amelyekben bárhol szerepel a beírt szöveg. Koppintásra a címke a cikk címkéi közé kerül.
- **Javaslatok gépelés közben** (v3.0): a „A cikk címkéi" mezőbe az utolsó vessző után gépelt szó 3. karakterétől felajánlja a meglévő címkéket.
  Sorrend: pontos egyezés → egy szavas címkék (előbb amelyik a beírt szöveggel *kezdődik*, utána amelyik *tartalmazza*) → többszavas címkék (ugyanígy);
  egy csoporton belül a gyakoribb elöl, utána betűrend. A „➕ új: …" lehetőség a lista végén áll.
- Mentéskor a címkék egységes alakra kerülnek (tag_clean szabályai: idézőjelek / szögletes zárójelek le, kisbetű – a betűszavak és a `tag_case_map.json` szavai kivételével –, ismétlések ki).

## Offline megnyitás (v3.0)
A fájlt a mappában lévő név alapján találja meg: `…_id<ID>_….mhtml` (a BM-ből mentett cikk azonosítója), illetve `…_idHR<kód>_….mhtml`
(a Hír-Radarból exportált cikk – a kód a webcímből számolódik). A mappa tartalma az egyetlen igazság: ami ott van, az offline nyílik meg.

## 📄 MHTML lista a Vivaldi MHTML Mentőnek (v3.0, ⚙️)
- Csak a 🔐 védett cikkek kerülnek a listába (a törlésre jelölt nem). Sor: `ID|dátum|cím|URL`, az ID a könyvjelző saját azonosítója.
- „Csak azok, amelyekhez még nincs MHTML fájl" (alapból be): a mappában már megtalálható cikkeket kihagyja – akkor is, ha azokat a Hír-Radar listája mentette le.
- A fájl az adatbázis mellé kerül: `mhtml_lista_ÉÉÉÉHHNN_ÓÓPP.txt`.

## 🔍 Duplikációk (v3.1, ⚙️)
Három keresés, az asztali BM „Duplikáció Kezelő" szabályaival: **1. slash eltérés** (a végi „/" nélkül azonos URL), **2. paraméter eltérés**
(a ?paraméterek és #töredék nélkül, kisbetűvel azonos; a YouTube `v=` marad), **3. kombinált** (azonos domain + azonos URL-eleje N karakterig + legfeljebb M karakter hosszeltérés;
a két szám számmező, 0 = nem számít). A keresés csak listáz, nem töröl.
- A találatok csoportonként jelennek meg (15 csoport / oldal): minden cikknél ID, cím, dátum, címkék, 🔐/📖 jelzés és a **teljes URL**; a csoport URL-jeinek **eltérő része pirossal**
  (∅ = ott semmi nincs, pl. a másiknál lévő „/" hiánya); azonos URL-nél „✔ azonos URL".
- **🌐 Megnyitás** soronként az alapértelmezett böngészőben, így ellenőrizhető, hogy ugyanazt a cikket nyitják-e meg.
- **🗑 Törlés** soronként, megerősítéssel, azonnal és véglegesen – védett cikknél is (két egyforma védett cikk közül az egyiket így lehet törölni).
  A törölt cikk adatait a megmaradó kapja meg, ha az kevesebbet tud: címkék uniója (tisztítva), 🔐 védelem, 📖 olvasásra váró jelölés, üres mezők. Több megmaradó cikknél a „legtöbbet tudó" (védett > olvasásra váró > van címkéje > kisebb ID) kapja.
- A törölt URL a `deleted_log` táblába kerül, kivéve ha a megmaradó cikknek ugyanaz az URL-je. A törlésre jelölt (🗑) cikkek nem szerepelnek a keresésben.
- Az ablak bezárásakor a lista és a számok frissülnek.

## 🔀 Összevonás másik bookmarks.db-vel (v3.0, ⚙️)
- A megnyitott adatbázisba ír; a másik fájlt (alapból `Norbi/Osszevonas/bookmarks.db`) csak olvassa. Előtte automatikus másolat a `Osszevonas/mentes/` mappába (a legutóbbi 2 marad).
- A cikkek uniója **mindkét irányban**: ami csak a másikban van, bekerül; a közös cikkek (URL alapján) állapota és címkéi egyesülnek (🗑 > 📖 > új; a védelem bármelyik oldalról megmarad).
  Ha a leíró mezők (cím, jegyzet…) eltérnek, a választott oldalé marad.
- **Címkék**: az eredmény MINDEN sorának címkéi a tag_clean szabályai szerint javulnak (hibás alak javítva, nem törölve; a jelentésükben téves címkéket nem bírálja el). Az előnézet megmutatja, hány sort érint.
- Az előnézet után indítható; a második futás már semmit nem változtat.

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
- `android-extra/BmPlugin.java` – natív rész: SQLite (tranzakciós csomag), fájlok (olvasás/írás/másolás), MHTML-index, link- és MHTML-megnyitás, megosztás fogadása
- `src/dupes.js` – duplikáció-keresés és kézi törlés
- `src/merge.js`, `src/tags.js`, `src/urlutil.js` – összevonás, címke-tisztítás (a tag_clean.py JS-átirata), URL-normalizálás / MHTML-azonosító
- `android-extra/BmFileProvider.java`, `bm_file_paths.xml` – az MHTML fájl átadásához a böngészőnek
- `android-extra/MainActivity.java` – a plugin regisztrálása, képernyő bekapcsolva tartása
- `android-extra/debug.keystore` – állandó aláírókulcs
- `scripts/patch_android.py` – a generált Android-projekt kiegészítése (engedélyek, megosztás-fogadás, plugin, aláírás)
- `build-apk.yml` – a GitHub Actions munkafolyamat; a repóban a `.github/workflows/build-apk.yml` helyre kell tenni
