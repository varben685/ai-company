# AI Software Company · M1 + M2

Runnable single-operator local platform: project → task → durable Product planning → human plan approval → explicit sample development → independent validation → separate review → human approval of exact code → **DONE**. M1 still ends at **PLAN_APPROVED** until the operator starts M2 development.

A DEMO adapter determinisztikus, nem valódi AI. Az OPENAI adapter az `@openai/agents` SDK-t és a Responses API-t használja, strukturált Zod kimenettel. Nincs automatikus fallback.

M2 supports only the versioned `sample-todo-v1` JavaScript ESM source and its fixed acceptance tests. It does not clone repositories, open PRs, merge, or deploy. The Developer gets bounded sample file tools and named checks inside Docker; the Reviewer receives readonly frozen artifacts. See [M2 acceptance](docs/MILESTONE-2.md) and [M2 specification](docs/MILESTONE-2-SPEC.md).

## Helyi indítás

Előfeltétel: Node **24.10.0** (tesztelt verzió), Corepack, Docker Desktop vagy kompatibilis Docker Compose. A tesztelt dependency-verziók a `package.json` és `pnpm-lock.yaml` fájlokban vannak. Nem kell globális pnpm telepítés vagy rendszerkonfiguráció-módosítás.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm setup:local
docker compose up -d --wait
corepack pnpm db:generate
corepack pnpm db:migrate
corepack pnpm db:seed
corepack pnpm dev
```

Nyisd meg: [http://127.0.0.1:3000](http://127.0.0.1:3000). A generált operátori jelszó az ignorált `.local/operator-password` fájlban található. A setup véletlen jelszót, session secretet és adatbázis-jelszót generál, és **nem írja felül** a meglévő `.env` fájlt. Ne másold ezeket chatbe vagy verziókezelésbe.

A három alkalmazás külön processz: API `127.0.0.1:3001`, web `127.0.0.1:3000`, worker. A web `/api/*` útvonalait a Next.js az API-hoz továbbítja. M1-ben az API-port 3001; a böngésző ugyanazon originen marad. PostgreSQL `127.0.0.1:55432`, Redis `127.0.0.1:56379`; Docker volume-okban tartós adatok. `Ctrl+C` leállítja az alkalmazásokat. `docker compose stop` leállítja az infrastruktúrát az adatok megőrzésével. **Ne használj `down -v` parancsot**, ha meg szeretnéd tartani az adatokat.

Külön terminálokban is futtatható:

```sh
corepack pnpm dev:api
corepack pnpm dev:worker
corepack pnpm dev:web
```

Build után a `corepack pnpm start:api`, `corepack pnpm start:worker`, `corepack pnpm start:web` indítja a buildelt változatot. A web build nem kér külső fontot és nem igényel működő API-t.

## Használat

1. Bejelentkezés → Projects → új projekt és opcionális kontextus.
2. Task létrehozása: cím, leírás, prioritás. A tervezés explicit **Start planning** gombbal indul.
3. Terv átnézése: requirements, acceptance criteria, steps, assumptions, questions, risks, complexity.
4. **Approve plan**, kommenttel **Request changes**, vagy **Reject plan**. Régebbi verzión nincs döntési gomb. Összesen legfeljebb 5 tervverzió készülhet.
5. Hiba után **Retry planning** új logical runt hoz létre; a régi attempts megmaradnak. **Cancel task** azonnal lezárja a taskot és a pending approvalt. Kései eredmény nem publikálhat tervet.
6. For M2, create a project with **Sample Todo v1 · local Docker**, leave its default sample context or provide matching JavaScript/Node context, and create a task about completing todos. Review and approve its plan, then press **Start development**. The UI shows the immutable candidate, cumulative diff, independent checks, and separate review. Approve or reject the exact candidate only after reviewing these. A passing approval marks the task **DONE** without merging or deploying. Failed infrastructure stages can be retried; review changes create at most three rounds. **Cancel task** stops further publication.

Régi taskverzió vagy approval esetén 409 konfliktus érkezik, érthető frissítési üzenettel. A nézet frissíti az aktuális adatokat. Aktív tervezésnél 2 másodperces polling működik; terminális tasknál leáll.

## OPENAI mód és live smoke

A `.env` fájlban állítsd `PROVIDER=OPENAI` és `OPENAI_PRODUCT_MODEL=gpt-4.1-mini` értékre. A modell konfigurálható. Az alapmodell Structured Outputs támogatását ellenőriztük az [OpenAI modelloldalán](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Hozz létre helyileg egy ignorált, csak a worker által betöltött `.env.worker` fájlt (`chmod 600 .env.worker`), benne az `OPENAI_API_KEY` változóval. Ne tedd a kulcsot `.env`, `NEXT_PUBLIC_*`, forráskód vagy böngészőbe küldött konfiguráció alá. A `pnpm dev` az API/web gyermekprocesszek örökölt `OPENAI_API_KEY` értékét is eltávolítja. A worker hiányzó kulcsot explicit konfigurációs hibának tekinti, nem vált DEMO módra.

```sh
corepack pnpm test:live
```

Ez az **egyetlen, explicit live Product Agent smoke** fizetős API-hívást végezhet, és külön acceptance projektet/taskot hoz létre. Érvényes tervet, tényleges model/usage adatokat és pending approvalt ellenőriz; nem hagyja jóvá automatikusan. Kulcs nélkül nincs API-hívás: `LIVE_VALIDATION_PENDING`, exit code 2. Eredmény: lásd [elfogadási checklist](docs/MILESTONE-1.md). Az SDK-s mock és a DEMO teszt nem live bizonyíték.

A workerben mindkét SDK retry kikapcsolt; maximum 3 DB-ben számolt attempt, alapértelmezésben attemptenként 120 s timeout és queue-szinten 1 concurrency. `ATTEMPT_TIMEOUT_MS` 100–300000, `LEASE_MS` 1000–120000; `PLANNING_CONCURRENCY` csak 1 lehet. A queued run megőrzi provider/model választását akkor is, ha a processz beállítása később megváltozik.

For M2 live agents, set `OPENAI_DEVELOPER_MODEL` and `OPENAI_REVIEWER_MODEL` in `.env` (defaults: `gpt-4.1-mini`). The key remains only in ignored `.env.worker`. The installed `@openai/agents` SDK runs the Developer with registered file tools and Reviewer with readonly tools; each Responses call has a separate usage/cost ledger. Run `corepack pnpm test:live:m2` once to generate a real Product plan for a new sample project. Review and approve that plan in the local UI. Then run `M2_LIVE_TASK_ID=<approved-task-uuid> corepack pnpm test:live:m2` to start one bounded development session and leave final code approval pending. The script starts its own local worker; no other live worker is needed. Do not auto-approve the plan or code in the smoke.

## Költségadatok

A költség **becslés, nem számla**. A worker `.env.worker` fájljában opcionálisan add meg: `PRICING_MODEL` (a válaszban ténylegesen jelentett modell), `PRICING_VERSION`, `PRICE_INPUT_PER_MILLION`, `PRICE_CACHED_PER_MILLION`, `PRICE_OUTPUT_PER_MILLION`. Mindhárom tarifa decimális USD / egymillió token. Nincs beégetett, idővel elévülő ár.

Képlet: `(input − cached) × inputPrice + cached × cachedPrice + output × outputPrice`, osztva egymillióval. Hiányzó usage, hiányzó cached adat, ismeretlen/hibás tarifa vagy eltérő modell → **Unknown**. A dashboard az ismert összeget és az ismeretlen attemptök számát külön mutatja. A sikertelen, megszakított és kései attempt ismert költsége is megmarad. DEMO: 0 USD, külön providerjelzéssel.

M2 adds per-Responses-call ledger entries. The dashboard counts these calls, including known cost on failed attempts, and counts unknown calls separately. Legacy M1 attempt cost is included only when that attempt has no call entries. The default exact `gpt-4.1-mini-2025-04-14` tariff is versioned in code; other model prices remain unknown unless explicitly configured. Nincs garantált havi költségplafon vagy exactly-once LLM hívás. Crash utáni új attempt ismét költséget okozhat. A cancellation nem garantálja, hogy a provider már elindított munkája ingyenes.

## Tesztek

```sh
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm test
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
# A production build processzeinek ellenőrzése:
M1_E2E_BUILT=1 corepack pnpm test:e2e
```

A backendtesztek valós PostgreSQL/Redis és M2-höz valós Docker mellett, véletlen nevű külön adatbázissémában és queue prefixszel futnak. Csak a saját tesztsémájukat törlik. Az E2E ugyancsak külön sémát/queue-t kap, és három valódi processzt indít DEMO módban. A 3000/3001 port legyen szabad. Install the pinned workspace image with `docker pull node@sha256:775ba24d35a13e74dedce1d2af4ad510337b68d8e22be89e0ce2ccc299329083` during trusted setup; no dependency installation occurs inside an agent workspace. A tesztekhez nincs OpenAI kulcs és nincs fizetős API-hívás.

Fedezet: konkurens commandok, tartós idempotency receipts, rollback, outbox crash/újrakézbesítés, globális queue concurrency, lejárt lease és stale write, **valódi SIGKILL worker crash és restart**, cancellation, provider error/refusal/invalid output, bounded retry, régi approval, approve/reject verseny, revision limit, cross-project FK-k, immutable snapshotok/tervek, usage és cached költségszámítás. E2E: login → projekt → task → plan → changes → új plan → approve → reload.

## Operátori hozzáférés és API

HttpOnly, SameSite=Strict cookie, 8 órás session; aláírás env secrettel, visszavonható Redis sessionrekord, logoutkor törlés. HTTPS origin esetén Secure cookie. Minden író kérésnél pontos `Origin` és JSON content-type kell; session után `X-CSRF-Token` is. Az operátor azonossága a sessionből jön. Login limit: 10 próbálkozás / 15 perc / IP, atomikus Redis számláló. Az API és web loopbacken figyel, proxy/trust-forwarded IP nincs bekapcsolva.

- `GET /health/live`: processz él.
- `GET /health/ready`: DB és Redis elérhető; ez nem a provider account vagy worker readiness tesztje.
- `GET /capabilities`: sessionnel provider és M1 határok.
- `GET /openapi.json`: sessionnel a tényleges Zod request/response szerződésekből generált OpenAPI 3.1.
- Planning, retry és approval műveleteknél `Idempotency-Key` kötelező (8–128 alfanumerikus/underscore/hyphen karakter).
- Azonos operation/actor/key/resource/body: eredeti válasz. Eltérő body vagy resource: 409.
- Lapozás: `page`, `limit` (maximum 100); projekt tasklistán `status` szűrő.
- Input limit: 128 KB JSON és mezőnként Zod limitek. Nincs általános státuszmódosító endpoint.

Az audit csak szükséges üzleti metadatát tartalmaz. Provider nyers hibát, kulcsot, promptot, chain-of-thoughtot nem naplózunk; SDK tracing kikapcsolt. A szükséges task/context snapshot és terv tartósan PostgreSQL-ben van: ez helyi, érzékeny projektadatokat tartalmazhat.

## Felépítés és folytatás

`apps/api`: NestJS REST, session és service/repository határ. `apps/web`: Next.js App Router. `apps/worker`: BullMQ worker és outbox reconciliation. `packages/contracts`: Zod; `database`: Prisma/migráció/repository; `workflow`: determinisztikus szabályok; `agents`: Product, Developer, Reviewer adapterek; `integrations`: Redis/BullMQ; `workspace`: pinned sample source, Docker backend, immutable artifacts, independent validator; `observability`: konfiguráció, safe logging, decimal pricing.

Részletek: [M1 specifikáció](docs/SPEC.md), [M2 specifikáció](docs/MILESTONE-2-SPEC.md), [architekturális döntések](docs/DECISIONS.md), [M1 elfogadás](docs/MILESTONE-1.md), [M2 elfogadás](docs/MILESTONE-2.md).
