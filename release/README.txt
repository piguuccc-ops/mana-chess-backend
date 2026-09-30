MANA CHESS BACKEND
==================

Fiókok, a fiókok paklijai, barátok és jelölések, kihívások, játékszobák (5454-es port) – és a
vezérlőpult, külön porton (5555), csak erről a gépről. Sima HTTP-szerver; interneten
Nginx Proxy Manager (NPM) adja elé a HTTPS-t – de csak az 5454-es port elé.


INDÍTÁS
-------
  Windows:        Start.bat (dupla kattintás)
  macOS / Linux:  ./start.sh
  Kézzel:         node backend.mjs

  Kapcsolók (Start.bat után is írhatók, pl. Start.bat --port 9000):
    --port 9000         a backend portja (alapból 5454; ha foglalt, a következő szabadot keresi)
    --admin-port 9001   a vezérlőpult portja (alapból 5555)
    --data D:\mana      az adatok helye (alapból a „data” mappa e mellett a fájl mellett)
    --host 127.0.0.1    a backend is csak erről a gépről legyen elérhető (pl. ha az NPM ugyanitt fut)
    --setup             új beállítókód (elfelejtett adminjelszóhoz, lásd lent)
    --no-open           ne nyissa meg a böngészőt

Az ablak kiírja a címeit. A játékban (Online) a „helyi hálózaton” címet kell megadni,
pl. 192.168.1.23:5454. Amíg játszotok, hagyd nyitva az ablakot (Ctrl+C vagy bezárás = leállítás;
az adatok ilyenkor is elmentődnek).


ELSŐ INDÍTÁS – AZ ADMINISZTRÁTOR
--------------------------------
Az első indításkor az ablak kiír egy BEÁLLÍTÓKÓDOT (pl. 7KQ2-M4XP), és megnyitja a
vezérlőpultot (http://localhost:5555). Ott a kóddal létrehozod az adminisztrátori
fiókodat. A kód bizonyítja, hogy te futtatod a szervert – csak az ablakban látszik.

Elfelejtett adminjelszó: indítsd a szervert így: node backend.mjs --setup (vagy Start.bat --setup).
Új kódot kapsz; a vezérlőpulton a kóddal és a meglévő admin nevével új jelszót adhatsz.


A VEZÉRLŐPULT (http://localhost:5555)
-------------------------------------
A vezérlőpult külön porton fut, és csak ezen a gépen érhető el (127.0.0.1). A játékosok
portján (5454) nincs vezérlőpult, így az internet felől admin-jelszót sem lehet próbálgatni.
Csak adminisztrátori fiókkal lehet belépni.

Másik gépről:
  - SSH-alagút (ha a backendet futtató gépen van SSH-szerver): a saját gépeden
        ssh -L 5555:127.0.0.1:5555 FELHASZNÁLÓ@A-SZERVER-CÍME
    és amíg ez az ablak nyitva van, a böngésződben: http://localhost:5555
  - Tailscale (ha mindkét gép a tailnetedben van): a backendet futtató gépen egyszer
        tailscale serve --bg --https=5555 http://127.0.0.1:5555
    utána a saját eszközeidről: https://A-GÉP-NEVE.A-TAILNETED.ts.net:5555
    (a pontos címet a „tailscale serve status” írja ki; kikapcsolás:
    tailscale serve --https=5555 off). A „tailscale funnel”-t SOHA ne használd hozzá –
    az az internetre tenné.

  Áttekintés     játékosok, jóváhagyásra várók, ki van online, nyitott szobák
  Felhasználók   új fiók kézzel (azonnal használható, lehet admin is), jóváhagyás,
                 elutasítás, új jelszó, admin jog, kijelentkeztetés, törlés
  Beállítások    a szerver neve; regisztráció: zárva / jóváhagyással / nyitott;
                 vendégjáték be/ki; fail2ban határok; proxy-fejlécek
  Biztonság      zárolt fiókok és kitiltott címek – feloldás egy gombbal
  Napló          a legutóbbi események (belépések, zárolások, szobák…)


BEÉPÍTETT FAIL2BAN
------------------
  - Ugyanarra a fiókra 5 hibás jelszó → a fiók bejelentkezése 10 percre zárolva. Ilyenkor a
    helyes jelszót sem fogadja el. A zárolás a Felhasználók vagy a Biztonság lapon feloldható.
  - Egy címről 10 hibás próbálkozás (bármelyik fiókra) → az a cím 10 percre nem léphet be és
    nem regisztrálhat. A Biztonság lapon feloldható.
  - A számok (3–20 hiba, 1–1440 perc) a Beállításokban módosíthatók.
  - Emellett: címenként legfeljebb 5 regisztráció óránként, és percenként 1200 kérés.


NGINX PROXY MANAGER (HTTPS INTERNETEN)
--------------------------------------
  Hosts → Proxy Hosts → Add Proxy Host
    Details:  Domain Names: sakk-api.pelda.hu
              Scheme: http
              Forward Hostname / IP: ennek a gépnek a helyi címe (pl. 192.168.1.23)
              Forward Port: 5454
              Block Common Exploits: be
              (Websockets Support nem kell, de nem is árt.)
    SSL:      Request a new SSL Certificate, Force SSL, HTTP/2 Support
  A játékban ezután a https://sakk-api.pelda.hu címet kell megadni. A vezérlőpult (5555)
  NEM kerül az NPM mögé – arra soha ne csinálj Proxy Hostot.

  A játékosok valódi címe: az NPM az X-Real-IP / X-Forwarded-For fejlécben küldi. A
  „Proxy-fejlécek: Automatikus” beállítás ezeknek csak akkor hisz, ha a kérés helyi
  hálózatról vagy erről a gépről jön (ott fut az NPM, Dockerben is) – így a fail2ban a
  valódi címeket tiltja ki, nem az NPM-et. Ha az NPM máshol fut, és a backend kizárólag
  rajta át érhető el, válaszd a „Mindig” beállítást.

  Ha az NPM ugyanezen a gépen fut (nem Dockerben), indíthatod így is: Start.bat --host 127.0.0.1
  – ekkor az 5454-es port kívülről egyáltalán nem érhető el, csak az NPM-en át.


ADATOK ÉS MENTÉS
----------------
  Minden a data\mana-chess.json fájlban van (fiókok, paklik, barátok, beállítások).
  A szerver biztonságosan (atomikusan) írja, így futás közben is lemásolható – mentésnek
  elég időnként egy másolat róla. Visszaállítás: állítsd le a szervert, és cseréld vissza a
  fájlt. A futó játszmák csak a memóriában vannak: újraindításkor elvesznek (a fiókok nem).
  A jelszavakat sózott scrypt-hasításként tárolja, a munkamenet-tokeneket hasítva.


TUDNIVALÓK
----------
  - A backend csak a vele egy verzióban készült játékkal enged játszani (a játékszabályok
    miatt). A mana-chess-frontend mappában lévő mana-chess.html mindig a megfelelő.
  - A kérések kis JSON-üzenetek; a játék 25 másodperces „long pollinggal” kap értesítést.
  - Tűzfal: helyi hálózaton az 5454-es TCP portot engedd be (a Windows tűzfal első
    indításkor rákérdez – engedélyezd a Node.js-t magánhálózaton). Az 5555-öt nem kell:
    a vezérlőpult csak erről a gépről érhető el.
  - Játékmódok: saját paklik, vagy Spell-toborzás (32 véletlen spell, felváltva választotok
    6-6-ot). A toborzás asztalát a szerver osztja ki, és minden választást ellenőriz.
