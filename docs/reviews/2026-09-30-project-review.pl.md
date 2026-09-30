# Review Multi Device Context — 30.09.2026

**Wniosek:** nie znalazłem aktywnych sekretów ani danych użytkownika w sprawdzonym kodzie, historii Git, logach CI i kodzie aplikacji z opublikowanych prywatnie wydań. Nie ma obecnie potwierdzonego wycieku poświadczeń, który wymagałby czyszczenia historii przed publikacją. Są jednak błędy dotyczące trwałego usuwania, zachowania szkiców i obsługi awarii oraz braki w przygotowaniu do publicznej dystrybucji. Najpierw należy poprawić R1 i uporządkować kwestie wskazane poniżej.

Repozytorium pozostaje **private**. Review nie zmieniło kodu aplikacji, wdrożenia, konfiguracji chmury ani widoczności GitHub. Raport nie jest zgodą na publikację. Publiczny serwer już udostępnia czytelne źródła frontendu przez source maps — szczegóły w R7.

Sprawdzona wersja: `4de2aad`, identyczna zawartościowo z pobranym `origin/main` po scaleniu `7e44b9a`. Zakres: 119 śledzonych plików, wszystkie 36 osiągalnych commitów, 242 unikalne obiekty plików Git, web/server/desktop/contracts, reguły i Terraform, runtime, CLI, dokumentacja, workflow oraz metadane dwóch PR-ów. Gitleaks analizował 35 commitów z różnicami; dodatkowy skan objął pełną zawartość historycznych plików i metadane commitów.

Priorytety: **P1** — poprawić pilnie ze względu na prywatność lub utratę danych; **P2** — konkretna poprawka przed szerszym użyciem; **P3** — usprawnienie utrzymania lub przygotowania publikacji. Priorytet projektu nie jest równoważny ocenie CVSS biblioteki.

| ID | Priorytet | Ustalenie | Dowód |
| --- | --- | --- | --- |
| R1 | P1 | Usunięta treść pozostaje w trwałym cache Firestore | Chromium + emulator, także po odświeżeniu |
| R2 | P2 | Kosztowne operacje backendu dostępne przed ograniczeniem żądań | Lokalne testy HTTP i przegląd kodu |
| R3 | P2 | Druga karta nadpisuje zapis szkicu z pierwszej | Test rzeczywistego hooka nawigacji |
| R4 | P2 | Retry po błędzie usuwania nie ponawia DELETE | Test komponentu |
| R5 | P2 | Usuwanie oczekującej wiadomości nie usuwa jej z lokalnej kolejki | Test komponentu + przepływ outbox/rules |
| R6 | P2 | Niezmienione multimedia są pobierane ponownie po snapshotach | Test komponentu |
| R7 | P2 | Produkcja publicznie serwuje źródła frontendu w plikach `.map` | Niezalogowane GET → HTTP 200 |
| R8 | P2 | CI nie zabezpiecza zmian web/server/rules ani PR-ów | Jedyny workflow w repozytorium |
| R9 | P2 | Interfejs nie wyjaśnia wysyłania treści do zewnętrznego modelu | UI + kod TitleWorker |
| R10 | P2 | Zależności mają opublikowane ostrzeżenia bezpieczeństwa | `pnpm audit`, analiza zastosowania |

1. **R1 — domknąć usuwanie lokalnej historii.**

   [cloud.ts:154](../../apps/web/src/cloud.ts#L154) włącza trwały cache Firestore. Obsługa markerów w [App.tsx:234](../../apps/web/src/App.tsx#L234) usuwa szkice, wpisy outbox i stan UI, lecz nie usuwa dokumentów z cache SDK. Cache jest czyszczony dopiero przy wylogowaniu w [auth.ts:76](../../apps/web/src/auth.ts#L76).

   Odtworzenie: odczytać wiadomość, zakończyć obserwację jej kolekcji jak przy przejściu do innego kontekstu, usunąć wiadomość i kontekst po stronie serwera, odebrać aktualną listę kontekstów. `getDocFromCache` nadal zwraca usuniętą treść; zwraca ją również po odświeżeniu strony. Test używał Chromium, rzeczywistych reguł i wyłącznie syntetycznych danych w emulatorze `demo-mdc`.

   Usunięcie w chmurze i ukrycie w UI działają, ale nie oznaczają usunięcia wszystkich kopii zarządzanych przez aplikację. To nie jest obejście reguł przez innego użytkownika — jest to pozostałość danych na urządzeniu. Firebase opisuje trwałość cache między sesjami i zaleca uwzględnienie zaufania do urządzenia przy danych wrażliwych. [Dokumentacja Firebase](https://firebase.google.com/docs/firestore/manage-data/enable-offline).

   Zalecenie: ustalić jeden mechanizm kontrolowanego przechowywania historii lokalnej. Najprościej rozważyć cache Firestore wyłącznie w pamięci, pozostawiając trwały outbox; jeśli historia offline ma pozostać, potrzebuje własnego mechanizmu usuwania i testu po ponownym uruchomieniu. Uczciwie opisać czas usuwania na urządzeniu offline. W tym review czyszczenie całej bazy przy wylogowaniu z drugą otwartą kartą zakończyło się sukcesem — nie traktuję tego scenariusza jako potwierdzonej usterki.

2. **R2 — ograniczać żądania przed odczytem z płatnych usług.**

   [agent-routes.ts:53](../../apps/server/src/agent-routes.ts#L53) wywołuje uwierzytelnienie przed limiterem. [agent-store.ts:55](../../apps/server/src/agent-store.ts#L55) odczytuje Firestore dla każdego poprawnie zbudowanego identyfikatora klucza, nawet gdy klucz nie istnieje. Test 150 różnych błędnych kluczy z jednego źródła spowodował 150 odczytów adaptera i 150 odpowiedzi 401; ani jednej 429. Limit 120/min chroni dopiero poprawnie uwierzytelniony klucz.

   Dodatkowo publiczny [server.ts:121](../../apps/server/src/server.ts#L121) przy każdym `/health/ready` uruchamia odczyt Firestore i metadanych bucketu ([firebase.ts:276](../../apps/server/src/firebase.ts#L276)); 150 lokalnych żądań uruchomiło backend 150 razy. To ryzyko kosztów i przeciążenia, bez konieczności dostępu do danych. Testy obciążenia nie dotykały produkcji.

   Zalecenie: limit IP/globalny przed weryfikacją klucza, limit per użytkownik po weryfikacji, krótko cache'owana lub wewnętrzna gotowość. Uporządkować też tworzenie kluczy i limity łącznego składowania: obecne limity wielkości pojedynczej wiadomości/pliku nie ograniczają liczby zapisów przez zalogowane konto, a przeglądarka zapisuje bezpośrednio do Firebase. Nie zakładam, że niebadane ustawienia Cloudflare zapewniają brakującą ochronę.

3. **R3 — zapisywać szkice niezależnie i synchronizować karty.**

   [navigation.ts:13](../../apps/web/src/navigation.ts#L13) czyta mapę szkiców tylko przy inicjalizacji. [navigation.ts:27](../../apps/web/src/navigation.ts#L27) przy każdej zmianie zapisuje całą lokalną mapę bez scalania i bez obsługi zmian z drugiej karty.

   Dwie instancje dla tego samego konta: A zapisuje „Draft A”, następnie B zapisuje „Draft B”. Zapis B usuwa A z localStorage. A nadal widzi tekst w pamięci, lecz po zamknięciu/odświeżeniu może go stracić. Test odtworzył to na rzeczywistym `useNavigation`.

   Zalecenie: osobny rekord per kontekst, transakcje IndexedDB i synchronizacja między kartami; określić zachowanie równoczesnej edycji tego samego szkicu. Nie wystarczy wyłącznie nasłuchiwanie `storage`, jeśli zapis nadal zastępuje całą mapę.

4. **R4 — komunikat i Retry muszą odpowiadać operacji usuwania.**

   [App.tsx:445](../../apps/web/src/App.tsx#L445) po każdym błędzie DELETE informuje, że serwer automatycznie ponowi sprzątanie. Gdy sieć przerwała żądanie przed jego dotarciem do serwera, żaden marker usuwania nie powstał. Przycisk Retry ([App.tsx:490](../../apps/web/src/App.tsx#L490)) uruchamia wyłącznie retry outbox, nie DELETE.

   Test: odrzucenie `deleteContext` błędem połączenia, kliknięcie Retry — licznik DELETE pozostaje równy jeden. Użytkownik otrzymuje mylące zapewnienie, a kontekst nadal istnieje.

   Zalecenie: zachować konkretną operację do ponowienia; rozróżnić brak potwierdzenia żądania od rozpoczętego sprzątania. Powtórny DELETE jest już po stronie serwera idempotentny.

5. **R5 — osobno obsłużyć usuwanie wiadomości oczekujących na wysłanie.**

   Przycisk usunięcia elementu w [App.tsx:492](../../apps/web/src/App.tsx#L492) zawsze wywołuje API. Nie usuwa odpowiadającego rekordu outbox ani `optimisticItems`. API może utworzyć marker nawet dla jeszcze nieistniejącej wiadomości, a późniejszy upload tej wiadomości zostanie odrzucony przez reguły. Lokalna treść nadal pozostaje w kolejce.

   Test komponentu potwierdził, że po udanym DELETE oczekująca wiadomość nadal jest widoczna i nie została usunięta z kolejki. Zalecenie: dodać operację usuwania konkretnego itemu w outbox, obsłużyć trwającą wysyłkę oraz usunąć stan optymistyczny; zachować marker chroniący przed późnym zapisem. Dla niewysłanego pierwszego elementu jawnie określić dalszy los lokalnego kontekstu.

6. **R6 — nie pobierać ponownie niezmienionych załączników.**

   [App.tsx:100](../../apps/web/src/App.tsx#L100) uzależnia pobieranie preview od referencji obiektu `content`. [cloud.ts:123](../../apps/web/src/cloud.ts#L123) parsuje dokumenty do nowych obiektów przy kolejnych snapshotach. Nowy snapshot tej samej wiadomości powoduje ponowne pobranie pliku i utworzenie URL, mimo identycznego ID i metadanych. Test potwierdził dwa pobrania jednego niezmienionego obrazka.

   Przy większej liczbie obrazów/wideo oznacza to transfer, opóźnienia i alokacje pamięci. Zalecenie: stabilny klucz załącznika/metadanych, współdzielone pobranie i ograniczone ładowanie preview. Dodatkowo `shareFiles` czyta cały plik przed sprawdzeniem limitu ([App.tsx:392](../../apps/web/src/App.tsx#L392)); sprawdzać `File.size` przed `arrayBuffer()`, ustalić limit całej paczki. Ścieżka publikowania pobiera też pełne listy kontekstów i elementów, aby znaleźć pojedyncze ID ([cloud.ts:251](../../apps/web/src/cloud.ts#L251)); zastąpić to ograniczonymi zapytaniami z zachowaniem reguł dla brakujących rekordów.

7. **R7 — source maps już udostępniają czytelny frontend.**

   [vite.config.ts:8](../../apps/web/vite.config.ts#L8) ustawia `sourcemap: true`, a serwer udostępnia katalog builda. Niezalogowane pobranie mapy aktualnego głównego skryptu produkcyjnego zwróciło HTTP 200, 33 wpisy `sources` i `sourcesContent` zawierające m.in. `ContextWorkspace`. Nie znalazłem tam prywatnych ścieżek home-dev ani sekretów.

   Prywatność repozytorium nie oznacza więc obecnie prywatności źródeł frontendu. To nie ujawnia całego repozytorium ani kodu backendu; skompilowany JavaScript i tak jest dostępny klientowi. Jeśli czytelne źródła mają pozostać prywatne do świadomej publikacji, usuwać mapy z publicznego katalogu i przechowywać je osobno do diagnostyki. Samo ukrycie odnośnika `sourceMappingURL` nie wystarczy.

8. **R8 — przenieść sprawdzone lokalnie testy do normalnego CI.**

   Jedyny [workflow:4](../../.github/workflows/native-installers.yml#L4) uruchamia się na dwóch konkretnych gałęziach roboczych i ręcznie. Filtry nie obejmują zmian web/server/rules; brak `pull_request` i `main`. Wykonuje testy desktopu, bez pełnych testów aplikacji i reguł. Nie ma w repo skonfigurowanego automatycznego skanera sekretów ani cyklicznego audytu zależności.

   Aktualne ręczne wyniki są dobre, lecz nie zabezpieczają kolejnych zmian. Zalecenie: zwykłe CI dla PR/main — testy, typecheck, build i emulator; osobny workflow instalatorów z kontrolą zawartości paczek; skan sekretów i zależności. Akcje są przypięte do tagów, nie pełnych SHA — warto to uporządkować razem z automatycznymi aktualizacjami. Nie należy nadawać obcym PR-om dostępu do sekretów wdrożenia.

9. **R9 — ujawnić w produkcie zakres przetwarzania AI.**

   [titles.ts:6](../../apps/server/src/titles.ts#L6) wysyła pierwsze 8000 jednostek tekstu JavaScript albo nazwę/MIME załącznika do OpenRouter. [App.tsx:532](../../apps/web/src/App.tsx#L532) zapewnia o prywatności, ale nie wyjaśnia tego przepływu. Jest on opisany w instrukcji instalacji i API, więc nie jest całkowicie nieudokumentowany. Brak jednak informacji przed pierwszym wklejeniem i ustawienia użytkownika wyłączającego automatyczne tytuły.

   Funkcja została świadomie zamówiona dla obecnego użytkownika; uwaga dotyczy nowej osoby korzystającej z publicznie dostępnej aplikacji. ZDR ogranicza retencję u obsługujących go dostawców, ale dane nadal są wysyłane i przetwarzane poza GCP. [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr).

   Zalecenie: krótka, jasna informacja w UI o pierwszej wiadomości/nazwach plików, dostawcy i braku wysyłania bajtów załączników; opcja tytułów lokalnych. Opis „Only you” doprecyzować jako izolację między użytkownikami, bez sugerowania szyfrowania end-to-end lub braku dostępu operatora usług.

10. **R10 — zaktualizować zależności, zachowując ocenę rzeczywistej ekspozycji.**

    Pełny `pnpm audit` zgłosił **6 advisory: 2 high, 2 moderate, 2 low**. `pnpm audit --prod` zgłosił 4. Nie utożsamiam tych wyników z sześcioma zdalnie wykorzystywalnymi lukami aplikacji.

    | Pakiet w lockfile | Advisory / ocena rejestru | Zastosowanie w projekcie |
    | --- | --- | --- |
    | `js-yaml 4.3.1` | [GHSA-2883-xcg3-v3hh — high](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) | Zależność PM2. Opisany problem wymaga przetwarzania odpowiedniego YAML; tutaj proces jest uruchamiany z kontrolowanego pliku CJS, nie z YAML użytkownika. Poprawka 4.3.2. |
    | `@grpc/grpc-js 1.9.16` | [GHSA-m9gg-hp2v-232j — high](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j) oraz [GHSA-f596-whhp-79r4 — low](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4) | Gałąź zależności SDK Firebase. Ostrzeżenia dotyczą określonej konfiguracji serwera gRPC i komunikatów jego handlerów. Aplikacja nie wystawia takiego serwera; nie potwierdziłem ścieżki wykorzystania. |
    | `uuid 9.0.1` | [GHSA-w5hq-g745-h8pq — moderate](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq) | Także produkcyjny łańcuch Admin SDK → Storage → gaxios. Problem dotyczy v3/v5/v6 z zewnętrznym buforem; kod aplikacji generuje identyfikatory przez `randomUUID`. |
    | `@opentelemetry/core 1.30.1` | [GHSA-8988-4f7v-96qf — moderate](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-8988-4f7v-96qf) | W zgłoszonym łańcuchu `firebase-tools`/PubSub, narzędzia provisioningowe. |
    | `esbuild 0.27.3` | [GHSA-g7r4-m6w7-qqqr — low](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr) | Problem serwera developerskiego esbuild na Windows; repo używa esbuild do budowania, bez wskazanej konfiguracji serwowania. Poprawka 0.28.1. |

    Zalecenie: aktualizacja zależności nadrzędnych/lockfile, ponowne testy i udokumentowanie nieosiągalnych ścieżek zamiast globalnego ignorowania ostrzeżeń. Dodatkowe ustalenie dotyczące paczkowania: macOS `app.asar` zawiera 84 manifesty pakietów, w tym niepotrzebne desktopowi `pm2 7.0.4` i `js-yaml 4.3.1`. Odizolować zależności serwera/PM2 od instalatora i sprawdzać listę plików gotowego artefaktu. Sama obecność tego YAML parsera w paczce nie dowodzi, że jest wykonywany.

**Materiały wrażliwe a przyszła publikacja**

| Obszar | Wynik | Znaczenie |
| --- | --- | --- |
| Śledzone pliki i historia wszystkich pobranych refs | Gitleaks 8.30.1: brak znalezisk; dodatkowo brak dopasowań kluczy prywatnych, OpenRouter, agent API, GitHub, JWT, Google API i AWS w 242 blobach | Brak potwierdzonego sekretu do rotacji lub usunięcia z historii |
| Dwa PR-y, ich opisy oraz 13 dostępnych logów Actions | Brak znalezisk; brak komentarzy issue/review | Publiczne byłyby również informacje organizacyjne z tych materiałów |
| Wydania 0.1.0 i 0.2.0 | 19 plików zgodnych rozmiarem i SHA-256 z GitHub; rozpakowany kod ASAR Windows/macOS i portable CLI bez wykrytych sekretów | ASAR w DMG identyczny z ASAR w ZIP każdej wersji; raporty/screenshoty nie zawierają kontekstów użytkownika |
| Wartości połączeniowe w instalatorach i CI | Obecna domena publicznej instancji; oczekiwane dla natywnej aplikacji przypisanej do origin | Informacja infrastrukturalna, nie hasło; przyszłe publiczne binaria nadal kierowałyby do tej instancji |
| Metadane autora Git | Adres autora w prywatnej domenie, nie adres noreply | Decyzja o ujawnieniu danych kontaktowych; zmiana README nie usuwa danych z commitów |
| Dokumentacja wdrożenia/akceptacji | Nazwa home-dev, powiązanie z pbuchman-dev, modele urządzeń, wersje OS, porty istniejących usług, opis dawnego incydentu diagnostycznego | Nie są poświadczeniami. Warto oddzielić prywatny dziennik wdrożenia od uniwersalnej dokumentacji |
| Lokalny checkout | Ignorowane buildy, zależności, log emulatora i metadane backendu `.terraform/terraform.tfstate` | Nie należą do publikowanej historii. Nie publikować archiwum całego katalogu roboczego |

Nie znaleziono rzeczywistych wiadomości, zrzutów ekranu użytkownika, haseł, payloadów Secret Manager, kluczy service account ani Management Key w badanych materiałach publikacyjnych. Nie ma podstaw do zalecania masowej rotacji wyłącznie z powodu tego review. Nazwa hosta, publiczny origin oraz publiczne identyfikatory klienta nie są równoważne sekretom.

Skaner nie jest matematycznym dowodem braku sekretów. Przed faktyczną zmianą widoczności trzeba przeskanować wtedy aktualny stan, dodatkowe refs i nowe artefakty. Nie analizowano nieosiągalnych/usuniętych obiektów po stronie GitHub ani każdej historycznej roboczej paczki Actions. Nie prowadzono audytu wszystkich prywatnych plików poza repozytorium ani testu penetracyjnego kont dostawców.

**Funkcjonalność i wzorce projektowe**

Podział na wspólne kontrakty, web, backend i niewielką powłokę Electron jest odpowiedni do tej aplikacji. Interfejsy `Backend`, `WorkspaceServices`, `CloudWritePort` i `PublishPort` oddzielają zewnętrzne usługi od logiki i umożliwiają sensowne testy. Nie widzę potrzeby wprowadzania mikroserwisów ani dodatkowego brokera wiadomości.

Trwały outbox, stabilne UUID, atomowe utworzenie kontekstu z pierwszym elementem, retry i serwerowe markery usunięcia to dobre rozwiązania. TitleWorker ma trwały stan i lease oraz sprawdza, czy odpowiedź modelu nie nadpisze ręcznej nazwy lub usuniętego kontekstu. Klucze agentów są losowe, zapisane jako hash i ograniczone do właściciela; zarządzanie nimi wymaga odrębnego uwierzytelnienia Google. API z CLI wystarcza do obecnego przepływu między agentami, bez konieczności dokładania MCP.

Największa złożoność jest w synchronizacji kilku rodzajów stanu: Firestore, cache SDK, IndexedDB outbox, localStorage szkiców, stan React i natywna kolejka. R1, R3–R6 wynikają właśnie z granic między nimi. `App.tsx` łączy UI, kolejkę, subskrypcje, operacje usuwania i inicjalizację usług. Zalecam wydzielić kontroler synchronizacji i operacji kontekstu oraz obsługę multimediów, zachowując prosty UI. W testach trzeba modelować awarie i zdarzenia między tymi warstwami, nie tylko pojedyncze adaptery.

Tekst/kod, załączniki, ręczne Copy/Save, nowy kontekst, linki, automatyczne przełączanie, agent API i tytuły AI są zaimplementowane. Potwierdzone defekty opisano wyżej. Drobna niespójność prezentacji: nagłówek osi czasu jest zawsze „Today”, także dla starszych wiadomości ([App.tsx:492](../../apps/web/src/App.tsx#L492)). `watch` CLI wykrywa nowe konteksty, nie dopisanie wiadomości do starych; dokumentacja opisuje to poprawnie. Pełny dostęp klucza i brak automatycznego demona są świadomymi ograniczeniami pierwszej wersji.

**Bezpieczeństwo konstrukcji**

Pozytywnie oceniam weryfikację issuer/audience/algorytmu/expiry/azp i Google subject, wyprowadzenie UID po stronie serwera, domyślne deny w regułach, weryfikację metadanych uploadu oraz usuwanie tokenów pobierania przed oznaczeniem załącznika jako gotowego. Nie znalazłem potwierdzonego obejścia izolacji użytkowników. Testy emulatora obejmują dostęp anonimowy, między kontami i próby odtworzenia usuniętych rekordów.

Electron ma sandbox, context isolation, wyłączone Node integration, walidację nadawcy IPC i ograniczone operacje. PKCE/state/nonce oraz OS-backed safeStorage chronią natywną sesję. Kod nie renderuje wklejonego HTML jako wykonywalnej zawartości. Prywatny runtime jest pobierany spoza Git, pliki konfiguracji mają sprawdzane uprawnienia, a publiczny config jest projektowany z jawnej listy pól.

Pozostają kompromisy: hosted UI jest zaufaną częścią granicy dostępu do natywnego schowka, więc bezpieczeństwo serwera i webu ma znaczenie także dla desktopu; lokalny outbox/cache webu nie ma tego samego szyfrowania aplikacyjnego co natywna kolejka; pełny klucz agenta pozwala trwale usuwać dane. Nie ma szyfrowania end-to-end. Wyłączenie loggera ogranicza wycieki, ale razem z pustymi catch w TitleWorker utrudnia diagnozę — dodać niesensytywne liczniki/statusy błędów, bez treści i poświadczeń.

**Dokumentacja i przygotowanie publikacji — P3**

Instrukcje instalacji, API, rotacji konfiguracji i odzyskiwania wdrożenia są użyteczne. Dobrze odróżniają natywne CI od akceptacji na rzeczywistym Dellu i Macu oraz jawnie opisują brak podpisu Windows i notarization macOS. Brak backups/trash jest zamierzony i opisany; poprawić należy zakres obietnicy dotyczącej kopii lokalnych, a nie dodawać niezamówione backupy.

Do uporządkowania przed prezentacją repo jako projektu dla innych:

- Brak `LICENSE`; desktop deklaruje `UNLICENSED`. Wybrać i zapisać warunki udostępnienia przed przedstawianiem projektu jako open source. Sama publiczna widoczność jest odrębną decyzją.
- Dodać aktualną specyfikację v0.2 lub oznaczyć starsze dokumenty jako historyczne. [Pierwotny design](../superpowers/specs/2026-09-30-installable-app-design.md) opisuje brak wymuszonej zmiany kontekstu; [kontrakt serwera](../superpowers/specs/2026-09-30-server-contract.md) w dodatku twierdzi, że klienci nie czytają markerów, choć v0.2 celowo udostępnia właścicielowi markery kontekstu.
- Dodać samodzielną instrukcję uruchomienia dla obcej osoby: własny tenant/Google connection, własny origin i infrastruktura, bez wymagania dostępu do prywatnego `pbuchman-dev`. Obecny runbook jest dobry dla konkretnego home-dev, lecz nie stanowi kompletnego publicznego quickstartu.
- Dodać `SECURITY.md`, opis przepływu danych/prywatności i procedurę zgłoszenia błędu; uporządkować historię zmian oraz rozdzielić dziennik prywatnego wdrożenia od dokumentacji produktu.
- Zachować jawne informacje o unsigned/ad-hoc instalatorach. Podpisy i notarization poprawiają gotowość publicznej dystrybucji binarnej; ich brak nie jest sekretem w repo i nie dowodzi błędu autoryzacji.

**Wykonana weryfikacja i ograniczenia**

| Sprawdzenie wykonane podczas review | Wynik |
| --- | --- |
| `pnpm test` | 151 testów Vitest + 8 runtime, PASS |
| `pnpm typecheck` | 4 projekty workspace, PASS |
| `pnpm build:web`, build serwera | PASS; ostrzeżenia bundlera dotyczą komentarzy zależności Zod |
| `pnpm test:rules`, Java 21 | 18 testów Firestore/Storage, PASS; oczekiwany log przerwanego uploadu w teście błędnego rozmiaru |
| Istniejący test UI Playwright | Desktop light/dark i wąski widok, PASS, bez błędów konsoli |
| Dodatkowe testy diagnostyczne review | 6 testów potwierdzających R2–R6; asercje opisują istniejące błędy, nie ich naprawę |
| Osobny probe Chromium + emulator | Treść w cache po usunięciu i po reload: potwierdzona; pełne clear przy logout w tym scenariuszu działa |
| Gitleaks + dodatkowy skan historii | Brak wykrytych sekretów |
| Audyt zależności | 6 advisory łącznie, 4 przy `--prod`; nie jest wynikiem PASS |
| Natywne wydania | Kontrola zawartości i hashy istniejących artefaktów; nie wykonywano nowej instalacji na fizycznych urządzeniach |

Testy diagnostyczne i środowisko demonstracyjne zostały usunięte z katalogu źródeł po sprawdzeniu; nie wdrażano ich publicznie. Dowody techniczne review zachowano lokalnie poza repozytorium. Żaden test nie czytał ani nie modyfikował osobistych kontekstów użytkownika.

Kolejność dalszej pracy: poprawić R1 oraz błędy utraty szkiców/usuwania; ograniczyć kosztowne publiczne żądania; usunąć zbędne pobrania; ustalić udostępnianie source maps i komunikat AI; włączyć pełne CI i odświeżyć zależności; następnie uporządkować dokumentację, licencję i metadane publikacyjne. Review nie wykazało potrzeby przepisywania całej aplikacji.
