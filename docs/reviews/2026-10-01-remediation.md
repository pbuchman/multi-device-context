# Naprawy po review — 1 października 2026

Zaimplementowano R1–R10 oraz poprawki dokumentacji, licencji i diagnostyki.
Repozytorium pozostaje **prywatne**. Nie usuwano historii Git ani danych autora.
Nie dodano backupów, kosza ani odtwarzania treści. Wdrożenie na home-dev obejmuje
kod `fae145e4c17998a9fdb78d8ee475c42423564f33`; późniejsze zmiany raportu nie zmieniają aplikacji.

## Checkpointy i dowody

| Checkpoint | Wynik | Zmiana i sposób potwierdzenia |
| --- | --- | --- |
| R1 — lokalna historia | PASS | Firestore używa pamięci. Rzeczywisty Chromium/Firebase SDK: profil ze starym cache → migracja → restart; brak historii w cache i brak bazy Firestore w IndexedDB, szkice/outbox zachowane. `apps/web/e2e/history_migration.py`. Przed replay odczytywane są serwerowe markery usunięć; test `operations.test.ts` potwierdza brak wysyłania usuniętych bajtów. |
| R3 — szkice | PASS | Osobne rekordy IndexedDB, transakcje, migracja localStorage, powiadomienia kart, zachowanie konfliktu jako Recovered draft. Testy `drafts.test.ts` i dwie rzeczywiste karty Chromium zachowują obie wersje po odświeżeniu; usunięcie wygrywa ze spóźnionym zapisem. Błędy zapisu mają komunikat i retry. |
| R4 — ponowienie DELETE | PASS | Trwała intencja zawiera identyfikatory, bez usuwanej treści. Test symuluje niedostarczone DELETE, zamknięcie i odtworzenie kontrolera: retry faktycznie wywołuje DELETE. Komunikat pozostaje „niepotwierdzone” do potwierdzenia serwera. |
| R5 — oczekujące elementy | PASS | Atomowe usunięcie bajtów z kolejki i marker antyodtworzeniowy; promocja następnego pierwszego elementu. Testy outbox/UI oraz emulator: usunięcie pierwszego niedokończonego pliku naprawia `firstItemId/ready`, także przy ponowieniu. Pusta lokalna rozmowa znika. |
| R6 — media i odczyty | PASS | Stabilne klucze preview i współdzielone pobranie; test dwóch snapshotów wykonuje jedno pobranie. Rozmiar plików i paczki sprawdzany przed `arrayBuffer`; atomowy enqueue paczki. Zapytania o ID zwracają najwyżej jeden dokument. Test reguł obejmuje brak dokumentu, istniejący/usuwany dokument i obcego właściciela. |
| R2 — koszt żądań | PASS | 60/min/IP i 600/min globalnie przed uwierzytelnieniem, 120/min/właściciel, sesja 30/min/IP, tworzenie kluczy 5/min i maksymalnie 10 kluczy. Regresja 150 błędnych kluczy kończy odczyty po limicie i zwraca 429/Retry-After. 150 odczytów readiness używa wyniku pracy w tle. Rzeczywisty lokalny Caddy: zaufany adres tunelu działa, obcy CF header i sfałszowany XFF nie zastępują IP. |
| R7 — source maps | PASS | Build nie tworzy map, serwer odrzuca `.map` przed fallbackiem SPA. Cztery dawne adresy map sprawdzone po wdrożeniu: 404 bez logowania na loopback i publicznej domenie. Nie trzeba było czyścić CDN. |
| R8 — CI | PASS z ograniczeniem platformy | Workflow Quality dla PR/main, ręcznie i co tydzień: typy, testy, build, reguły, audyt, skan historii/buildu i Chromium. Osobno instalatory z inspekcją gotowego ASAR; akcje przypięte do SHA i Dependabot. GitHub odmawia branch protection dla prywatnego repo na obecnym planie — szczegóły niżej. |
| R9 — AI i prywatność | PASS | Ustawienie konta dostępne wyłącznie przez Google-auth API. Nowe konto: AI off i fallback; emulator potwierdza brak wywołania modelu. Zachowano AI dla jedynego istniejącego, wcześniej świadomie włączonego właściciela, bez włączania nowych kont. UI opisuje OpenRouter, pierwsze 8000 jednostek UTF-16/nazwy plików i brak przesyłania bajtów. Testy izolacji, walidacji oraz wyścigów z ręczną nazwą/usunięciem przechodzą. |
| R10 — zależności i pakowanie | PASS | Pełny audyt i `--prod`: zero advisory. Zbudowane i zainstalowane paczki Windows/macOS mają izolowany ASAR bez `node_modules`, PM2 i map; zawierają MIT oraz notices zależności wbudowanych w desktop. |
| P3 — utrzymanie i dokumentacja | PASS | Poprawne dni osi czasu; diagnostyka z zamkniętymi kodami przyczyn, bez surowych błędów/treści. MIT, SECURITY, privacy, changelog i samodzielny quickstart. Starsze specyfikacje oznaczono historycznie. Rozdzielono instrukcje produktu i prywatny runbook hosta. |
| CP-A — regresje i migracje | PASS | 170 testów Vitest, 8 runtime, 22 reguł/backendu, typy czterech projektów, buildy web/server; Chromium: desktop jasny/ciemny/wąski, profil migracyjny i równoczesne szkice. |
| CP-B — CI i artefakty | PASS | [Quality po poprawce zapytania](https://github.com/pbuchman/multi-device-context/actions/runs/36789678713), [natywne instalatory](https://github.com/pbuchman/multi-device-context/actions/runs/36789065748). Pełna historia i frontend bez wykrytych sekretów; audyt zero. |
| CP-C — wdrożenie | PASS | Reguły wdrożone, dwa composite indexes READY. Usługa active/enabled, port wyłącznie `127.0.0.1:8788`, publiczna gotowość 200, anonimowa sesja 401. Zmieniono tylko fragment Caddy/usługę aplikacji; prywatny runtime bez zmiany poświadczeń. [Aktualizacja pbuchman-dev](https://github.com/pbuchman/pbuchman-dev/pull/34). |
| CP-D — fizyczny Mac i Dell | OCZEKUJE | Runner macOS 15 arm64/Windows Server 2025 x64 nie zastępuje M2 MacBook Pro i Dell PB14250 użytkownika. Lista testów poniżej. |
| CP-E — raport | PASS | Jawne rozróżnienie wdrożenia, testów automatycznych, ograniczeń platformy i niepotwierdzonych testów na urządzeniach. Ten raport nie stanowi zgody na upublicznienie. |

## Dodatkowa akceptacja wdrożenia

Na nowych, syntetycznych kontach przez publiczny origin przeszły:

- CLI/API create, watch, get, append, rename, upload, download oraz delete;
- identyczne bajty załącznika, odmowa dostępu drugiego konta i fallback AI nowego konta;
- dwa rzeczywiste `ContextWorkspace`/FirebaseCloud: pierwsze wklejenie, automatyczne
  przełączanie w obu kierunkach, zachowanie szkicu i trybu kodu, usunięcie widoczne
  w obu sesjach bez błędów uprawnień.

Usunięto syntetyczne konta, konteksty, pliki, klucze i pomocnicze rekordy testu.
Test nie czytał osobistych kontekstów. Prywatne logi/syntetyczne screenshoty pozostają
poza repozytorium. Fizycznego Google callbacku użytkownika nie zastępowano obejściem
logowania w instalatorze; live UI fixture używał wydzielonych kont testowych.

Akceptacja wykryła istotną regresję optymalizacji: `documentId == ID` przy braku
rekordu powodowało odmowę reguł. Test odtworzył błąd w emulatorze, a zamknięty zakres
ID z `limit(1)` go naprawił bez rozszerzania uprawnień. Ponowna akceptacja live przeszła.
Kontrola gotowego ASAR wykryła też automatyczne dołączanie zależności monorepo;
jawny hook pakowania wyłączył ten mechanizm. Nie usunięto żadnej kontroli CI, aby
ukryć te błędy.

## Zależności i ograniczenia

`esbuild` zaktualizowano do 0.28.2. Wąskie overrides przypinają poprawione
`js-yaml` 4.3.2, `@grpc/grpc-js` 1.14.5 i `gaxios > uuid` 11.1.1. Gałąź narzędzi
`firebase-tools > @google-cloud/pubsub` używa 6.1.0 z poprawionym OpenTelemetry,
bez wymuszania niezgodnego głównego wydania samego `@opentelemetry/core`.
Zgodność sprawdzono emulatorami, rzeczywistym wdrożeniem reguł i pełnym cyklem
Storage. Nie wyciszono advisory. Overrides należy usuwać, gdy aktualizacja pakietu
nadrzędnego zapewni odpowiednią wersję.

GitHub API zwraca HTTP403 z wymogiem GitHub Pro dla branch protection tego prywatnego
repozytorium. Workflow uruchamiają się, ale platforma nie wymusza ich przed scaleniem.
Sprawdzono statusy ręcznie; nie zmieniono widoczności ani abonamentu. Do domknięcia
tego jednego zabezpieczenia potrzebny będzie plan GitHub obsługujący ochronę prywatnych
gałęzi. Nie jest to brak testów w repo.

Zachowano zgłoszoną przez użytkownika politykę dostępu u dostawcy tożsamości;
nie dodano drugiej allowlisty. Limity API nie są całkowitym limitem wydatków ani
pojemności dla zatwierdzonego konta zapisującego bezpośrednio przez Firebase.

Po aktualizacji trzeba połączyć aplikację z siecią i zamknąć starsze karty, aby
ukończyć migrację cache. Usunięcie lokalnych rekordów jest logiczne, nie jest
forensic secure erase. Nie można natychmiast wyczyścić odłączonego, starego klienta,
kopii w systemowym schowku ani plików wyeksportowanych przez użytkownika.

## Instalatory i CP-D

Paczki v0.3.0 powstały z `7b8493b430bcf1e6fbefb37ae0ebd084dd2010b8` i ładują bieżący
hosted UI. Późniejsza poprawka zapytań dotyczy webu, nie kodu natywnego.
Oba runner testy potwierdziły instalację, izolowany bridge, OS encryption,
ustawienia autostartu, schowek tekst/obraz/pliki, zamknięcie do tray i linki kontekstu.
Windows dodatkowo respektuje wyłączenie startu przez system po ponownym uruchomieniu.

Do potwierdzenia na fizycznych urządzeniach pozostają:

1. Instalacja z sumą SHA-256, zgoda systemowa na niepodpisaną aplikację i Google callback.
2. Rzeczywiste wylogowanie/logowanie do OS, autostart i zachowanie sesji.
3. Dell → Mac i Mac → Dell: tekst/kod, screenshot i pliki z Finder/Explorer,
   Copy do innej aplikacji oraz zgodność zapisanych bajtów.
4. Tray share, brak sieci/restart, odzyskanie kolejki bez duplikatów, aktualizacja i uninstall.

Windows pozostaje unsigned, macOS ad-hoc signed bez notarization. Nie ma dostępnych
identyfikatorów podpisujących. Ani brak podpisu, ani oczekiwanie na CP-D nie jest
ukryte pod wynikiem PASS dla CI.
