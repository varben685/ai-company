# Milestone 1 · Elfogadási jegyzőkönyv

Dátum: **2026-10-06**. Scope: kizárólag M1. A forrás-specifikációt teljes egészében elolvastuk a fájlmódosítások előtt; a `docs/SPEC.md` byteazonos a megadott implementation packkel. Kezdetben nem volt alkalmazáskód vagy alkalmazható AGENTS.md; az új gyökérszabályok és a Next dev által generált webszabályok a repóban vannak.

**Állapot: offline M1 implementálva és ellenőrizve. LIVE_VALIDATION_PENDING.** Az engedélyezett worker környezetben nincs OPENAI_API_KEY. A live smoke nem végzett modellhívást. Ezért valódi AI-val az M1 még **nem teljesen elfogadott**.

## M1-01–M1-14

| Feladat                     | Eredmény                   | Tényleges bizonyíték                                                                                                                                                          |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-01 · scaffold            | PASS                       | pnpm workspace, strict TS, három entrypoint; registryben ellenőrzött, pontos dependency-verziók; install és lockfile                                                          |
| M1-02 · infrastruktúra      | PASS                       | Compose PostgreSQL/Redis healthy, loopback portok; új DB-re migration deploy, seed                                                                                            |
| M1-03 · szerződések         | PASS                       | Zod request/response/ProductPlan; business limitek; prioritás és hibás input tesztek                                                                                          |
| M1-04 · DB/repository       | PASS                       | Verziókezelt Prisma/SQL migráció, composite FK-k, unique constraint-ek és immutable triggerek; valós DB-tesztek                                                               |
| M1-05 · workflow            | PASS                       | Tiltott tranzíciók, optimista approval verzió, konkurens planning, kanonizált receipt, rollback tesztek                                                                       |
| M1-06 · session/REST        | PASS                       | Session nélkül 401; Origin/CSRF, strict input, lapozás, logout-revocation, login rate limit; generált OpenAPI                                                                 |
| M1-07 · outbox/worker       | PASS                       | Valós Redis-kapcsolat megszakítása; pending request megőrzése; delivery-before-ack újrakézbesítés; két worker global concurrency 1; lease recovery; valódi SIGKILL és restart |
| M1-08 · DEMO/Product prompt | PASS                       | Determinisztikus inputhoz kötött fixture, módosításkérés és maximális inputméret; látható DEMO jelzés                                                                         |
| M1-09 · OPENAI              | IMPLEMENTED / LIVE PENDING | Valódi Agents SDK kontrollált HTTP transporttal: schema output, usage/model, refusal, 401/429/5xx/400, abort, hiányzó accounting; nincs élő API bizonyíték                    |
| M1-10 · approval/verziók    | PASS                       | Approve/reject verseny, stale task/plan, 5-verziós limit, immutable history; failed revision retry megőrzi a change requestet                                                 |
| M1-11 · dashboard           | PASS                       | Négy API-backed oldal; valódi böngészős create/plan/change/approve/reload folyamat; régi terv döntési gomb nélkül                                                             |
| M1-12 · cost/observability  | PASS                       | Decimal string + USD, cached input helyes, null usage/model/tarifa unknown; ismert kései költség megmarad; safe error/correlation; secret scan                                |
| M1-13 · tesztek             | PASS offline               | **41 backend teszt**: 21 valós DB/Redis/HTTP integráció + 20 unit/SDK contract; DEMO Playwright dev és production build módban is sikeres                                     |
| M1-14 · átadás              | PASS                       | README, .env.example, AGENTS.md, változatlan SPEC, DECISIONS, project-context és ez a tényleges eredménylista                                                                 |

## Ténylegesen futtatott parancsok

| Parancs                                                         | Eredmény                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `corepack pnpm install`                                         | PASS, kezdeti tiszta dependency install                           |
| `corepack pnpm install --frozen-lockfile`                       | PASS, lockfile egyezett                                           |
| `corepack pnpm setup:local`                                     | PASS, ignorált helyi credentials; meglévő env védett              |
| `docker compose up -d --wait`                                   | PASS, PostgreSQL és Redis healthy                                 |
| `corepack pnpm db:generate`                                     | PASS                                                              |
| `corepack pnpm db:migrate`                                      | PASS; új app DB, továbbá izolált tesztsémák                       |
| `corepack pnpm db:seed`                                         | PASS, Sample Notes App létrejött                                  |
| `corepack pnpm typecheck`                                       | PASS, backend + Next typegen/web strict ellenőrzés                |
| `corepack pnpm lint`                                            | PASS                                                              |
| `corepack pnpm format:check`                                    | PASS                                                              |
| `corepack pnpm test`                                            | PASS, 41/41                                                       |
| `corepack pnpm build`                                           | PASS, API/worker bundle és Next production build                  |
| `corepack pnpm exec playwright install chromium`                | PASS                                                              |
| `corepack pnpm test:e2e`                                        | PASS, 1/1 DEMO workflow, dev processzek                           |
| `M1_E2E_BUILT=1 corepack pnpm test:e2e`                         | PASS, 1/1 DEMO workflow, buildelt API/worker/web                  |
| `corepack pnpm test:live`                                       | **LIVE_VALIDATION_PENDING**, exit 2; kulcs hiányzik, 0 live hívás |
| `git diff --check`                                              | PASS                                                              |
| Lokális secret-értékek keresése verziókezelésre szánt fájlokban | PASS; értékeket nem naplóztunk                                    |
| SPEC összehasonlítás az eredeti implementation packkel          | PASS, byteazonos                                                  |

Az első ellenőrzések találtak és javítottunk egy bundler CLI kapcsolóhibát, egy task wire contract mismatch-et, egy abort error osztályozási hibát, valamint túl tág Playwright locatort (task státusz és audit event azonos szöveggel). Ezek korábbi hibás futások voltak; a fenti PASS az utánuk ténylegesen lefutott ellenőrzésekre vonatkozik.

A tsup emitDecoratorMetadata figyelmeztetést ad, mert nem használ SWC-t. A szükséges Nest dependency-k explicit `@Inject` tokennel vannak kötve; a buildelt API-t a production E2E ténylegesen elindítja és végighívja. Az opcionális msgpackr natív build nincs engedélyezve; a JS változat működését a queue tesztek ellenőrizték.

## Acceptance folyamat és korlátok

A Playwright valódi böngészővel, sessionnel és három külön alkalmazásprocesszel futtatja: login → projekt → archiválási task → DEMO plan v1 → cím szerinti keresés módosításkérése → plan v2 → régi verzió ellenőrzése → approve → reload → PLAN_APPROVED → logout. A screenshot: `.local/demo-task-approved.png` (ignorált helyi artifact). A legutóbbi E2E külön tesztsémát és queue prefixet használ, majd csak ezeket törli.

A végállapot `PLAN_APPROVED`. A UI jelzi: “Plan approved. Development becomes available in Milestone 2.” Nincs development job, repository-klónozás, shell tool, sandbox, Developer/Reviewer, GitHub integráció, PR, auto-merge, production deploy, research, marketing, payment vagy multi-user SaaS funkció.

A lease és idempotencia a DB-mellékhatásokat védi. A külső LLM-hívás nem exactly-once; crash/retry után ismétlődhet. Cancellation nem garantál ingyenes távoli megszakítást. Hiányzó usage továbbra is unknown. DEMO attempt ismert költsége nulla akkor is, ha a worker megszakadt; a tokenadat ilyenkor nem kitalált nulla. Nincs garantált havi költségplafon.

## Hátralévő blocker és következő mérföldkő

Egyetlen külső blocker: az OpenAI live hitelesítő adat/hozzáférés hiánya. Következő M1 acceptance lépés: helyileg konfigurált worker key és modell után `corepack pnpm test:live`, majd az operátor a tényleges terv szemantikai minőségét ellenőrzi. A kulcsot nem kell és nem szabad chatbe küldeni.

M2 minimális következő lépése: izolált development workspace és jogosultsági modell külön specifikációja és acceptance tesztje. Csak ezután köthető a már jóváhagyott konkrét tervhez a korlátos Developer/Reviewer ciklus.
