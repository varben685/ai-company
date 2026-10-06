# AI Software Company v0.1 — Implementation Pack

Verzió: 1.0 · Dátum: 2026-10-06 · Tulajdonos: Bence

Ez a dokumentum a megbeszélt architektúrát megvalósítható specifikációvá alakítja. Tartalmazza a teljes v0.1 határait, a Milestone 1 részletes szerződéseit és feladatlistáját, valamint a közvetlenül használható Codex master promptot. Ez tervezési és implementációs átadóanyag; még nem futó alkalmazás.

## 1. Cél és mérföldkövek

**v0.1 cél:** egy nyers fejlesztési igényből jóváhagyott specifikáció, majd megvalósított, tesztelt és külön agent által review-zott változtatás szülessen. Az ember dönti el, hogy a konkrét tervet és a konkrét kódváltozatot elfogadja-e. A workflow állapotait alkalmazáskód kezeli.

| Milestone | Eredmény | Elfogadás feltétele |
|---|---|---|
| M1 — Core + Product Agent | Több projekt, taskok, strukturált terv, tervjóváhagyás, audit és futási adatok | Nyers task → valódi AI-terv → emberi jóváhagyás, működő dashboardon |
| M2 — Development Loop | Izolált workspace, Developer, csak olvasó Reviewer, diff és teszteredmények | Sample repóban kis feature készül; a review ciklus korlátos |
| M3 — GitHub Workflow | GitHub App, branch, draft PR, CI, végső jóváhagyás | Tesztelt és review-zott draft PR érkezik a taskhoz |
| M4 — Opportunity Research | Bizonyítékokkal alátámasztott ötletek és pontozás | Külön későbbi specifikáció; nem része a v0.1-nek |

Marketing, sales, support, reklámköltés, automatikus merge és production deploy későbbi scope. A platform több projektre készül, de az első teszt egyetlen sample projekten történik. A projektek technológiai stackje később eltérhet a platform saját stackjétől.

**M1 bemutató:** projekt létrehozása → task rögzítése → tervezés indítása → ProductPlan megtekintése → approve. Az utolsó állapot `PLAN_APPROVED`. A dashboard ekkor jelzi: „Plan approved. Development becomes available in Milestone 2.” M1-ben nem kerül development job a queue-ba.

## 2. Rögzített technikai döntések

| Terület | Döntés |
|---|---|
| Nyelv | TypeScript strict mode |
| Backend | NestJS REST API |
| Frontend | Next.js App Router, egyszerű dashboard |
| DB / ORM | PostgreSQL + Prisma |
| Queue | Redis + BullMQ; M1-ben csak `planning` queue |
| Agent runtime | `@openai/agents`, egy valódi Product Agent |
| Szerződések | Zod; ebből származtatott TypeScript típusok |
| Monorepo | pnpm workspace |
| Lokális futtatás | Docker Compose: PostgreSQL, Redis; API/web/worker külön processz |
| Tesztelés | Vitest vagy Jest a csomagokhoz; API integrációs tesztek; egy Playwright teljes folyamat |
| Felület / dokumentáció | UI angol; átadóanyag magyar, kód és master prompt angol |
| Modell | `OPENAI_PRODUCT_MODEL` környezeti változó; az implementációkor ellenőrzött, Structured Outputs kompatibilis modell |
| Provider csere | Egy `AgentProvider` interfész; M1-ben OpenAI és determinisztikus Demo adapter |

A Node/pnpm/Next/Nest/Prisma/SDK pontos kompatibilis verzióit a scaffold készítésekor kell ellenőrizni és lockfile-ban rögzíteni. Nem használunk ellenőrizetlen, feltételezett SDK-metódusokat.

Az Agents SDK futtatja az agentet és kezeli a strukturált kimenetet. A DB-t, queue-t, approvalokat és workflow-t mi implementáljuk. A sandbox konkrét szolgáltatója M2 döntés: az SDK-választás önmagában nem helyettesíti az izolációt és a jogosultsági rendszert.

```text
ai-company/
  apps/
    api/
    web/
    worker/
  packages/
    contracts/
    database/
    workflow/
    agents/
    integrations/
    observability/
  docs/
    SPEC.md
    MILESTONE-1.md
    DECISIONS.md
  project-context/
    PRODUCT.md
    ARCHITECTURE.md
    CODING_STANDARDS.md
    TESTING.md
    SECURITY.md
    DECISIONS.md
  docker-compose.yml
  pnpm-workspace.yaml
  package.json
  .env.example
  AGENTS.md
  README.md
```

Az `apps/api` HTTP-t és üzleti műveleteket kezel; az `apps/worker` dolgozza fel a queue-t. A közös workflow package biztosítja, hogy ugyanazok a tranzíciós szabályok érvényesüljenek mindkét processzben. Az üzleti szolgáltatások repository rétegen keresztül érik el a DB-t. Nem építünk microservice rendszert, Kafkát vagy Kubernetes deploymentet.

## 3. M1 funkciók

1. Projekt létrehozása, listázása és részletei; név, leírás és projektkontextus megadása.
2. Task létrehozása projekthez; cím, leírás, prioritás; projekt tasklistájának megjelenítése.
3. Tervezés explicit indítása, háttérben futó workerrel.
4. Strukturált, verziózott ProductPlan megjelenítése.
5. Konkrét tervverzió jóváhagyása, módosításkérése vagy elutasítása.
6. Futások és próbálkozások állapota, időtartama, provider/model, tokenhasználat és becsült költség.
7. Időrendi üzleti audit log; hibák és következő elérhető műveletek.
8. Kontrollált retry és cancellation; API/worker újraindítás után megmaradó adatok.
9. Demo provider API-kulcs nélkül és külön OpenAI provider valódi AI-futtatáshoz.

Nincs repo-klónozás, kódszerkesztés, shell tool, GitHub API-hívás vagy Developer/Reviewer futtatás M1-ben. Repository onboarding és az `agent_artifacts` táblája M2/M3-ban készül el. M1-ben a Product Agent csak a taskot és a megadott projektkontextust látja; nem állíthatja, hogy repót vagy teszteredményeket ellenőrzött.

## 4. Adatmodell — M1

Az ID-k UUID-k; dátumok UTC-ben, ISO 8601-ként kerülnek az API-ba. A pénz PostgreSQL Decimal, API-ban decimális string és currency. A terv JSON mezőjét íráskor és providerhatáron Zod validálja. Az ORM migráció és a seed verziókezelt.

| Entitás | Lényeges mezők / invariánsok |
|---|---|
| `Project` | id, name, description, status ACTIVE/ARCHIVED, context JSON, contextVersion, createdAt, updatedAt |
| `Task` | id, projectId, title, description, priority LOW/NORMAL/HIGH/URGENT, status, version, currentPlanId?, approvedPlanId?, activeRunId?, failureCode?, createdAt, updatedAt |
| `TaskPlan` | id, projectId, taskId, versionNumber, agentRunId, schemaVersion, content JSON, contextVersion, createdAt; unique(taskId, versionNumber), unique(agentRunId) |
| `AgentRun` | id, projectId, taskId, agentType PRODUCT, status QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED, provider, model?, promptVersion, inputSnapshot JSON, outputPlanId?, startedAt?, finishedAt?, failureCode? |
| `AgentRunAttempt` | id, projectId, agentRunId, attemptNumber, status, startedAt, finishedAt?, inputTokens?, outputTokens?, cachedInputTokens?, estimatedCostUsd?, pricingVersion?, providerRequestId?, errorCode?; unique(agentRunId, attemptNumber) |
| `Approval` | id, projectId, taskId, type PLAN, targetPlanId, status PENDING/APPROVED/CHANGES_REQUESTED/REJECTED/CANCELLED, decidedBy?, decidedAt?, comment?, createdAt; unique(targetPlanId, type) |
| `Event` | id, projectId, taskId?, agentRunId?, type, actorType HUMAN/SYSTEM/AGENT, actorId?, correlationId, payload JSON, createdAt; csak append |
| `OutboxMessage` | id, projectId, taskId, agentRunId, kind PLAN_REQUESTED, payload JSON, status PENDING/DISPATCHED, attempts, nextAttemptAt, dispatchedAt?, createdAt; unique(agentRunId, kind) |

A `Task` kap egy `version` mezőt az optimista konkurenciakezeléshez. A `currentPlanId`, `approvedPlanId`, `activeRunId` és approval target kapcsolatoknak ugyanahhoz a taskhoz/projekthez kell tartozniuk; ahol lehetséges, ezt összetett foreign key is kikényszeríti. A run attempt a saját parent runjának projektjét örökli.

**Terv és bemenet változatlan snapshot:** a run a taskleírás, projektkontextus, korábbi terv és módosításkérés akkori változatát kapja. A TaskPlan utólag nem szerkeszthető. Új tervhez új run és új tervverzió kell. M1-ben a task leírását és a projektkontextust a létrehozáskor adjuk meg; általános szerkesztőfelület később jön.

**Kapcsolatok:** Project → Tasks → AgentRuns → Attempts; Task → TaskPlans → Approvals. Minden művelet projekthatáron belül validál. M1 egyetlen operátor rendszer, nem többfelhasználós SaaS: a `projectId` önmagában nem felhasználói jogosultság.

## 5. Állapotgép

### M1 tranzíciók

| Kiinduló állapot | Művelet / eredmény | Célállapot |
|---|---|---|
| DRAFT | Tervezés indítása | QUEUED_FOR_PLANNING |
| QUEUED_FOR_PLANNING | Worker DB-ben atomikusan claimeli a runt | PLANNING |
| PLANNING | Validált és üzletileg elfogadható terv mentése | WAITING_PLAN_APPROVAL |
| WAITING_PLAN_APPROVAL | Aktuális terv approve | PLAN_APPROVED |
| WAITING_PLAN_APPROVAL | Changes requested, kötelező kommenttel | QUEUED_FOR_PLANNING |
| WAITING_PLAN_APPROVAL | Reject, opcionális kommenttel | REJECTED |
| QUEUED_FOR_PLANNING / PLANNING | Végleges hiba vagy próbálkozási limit | FAILED |
| FAILED | Explicit emberi retry | QUEUED_FOR_PLANNING |
| DRAFT / QUEUED_FOR_PLANNING / PLANNING / WAITING_PLAN_APPROVAL / FAILED | Cancel | CANCELLED |

`PLAN_APPROVED`, `REJECTED`, `CANCELLED` M1-ben lezárt állapot. Más tranzíció 409. Hiányzó erőforrás 404. Az LLM nem kap státuszmódosító toolt. A `Task`, `AgentRun`, approval és az üzleti event változásai egy DB-tranzakcióban történnek.

M1-ben a tervezés csak explicit indításra történik. Egyszerre egy aktív logical run lehet egy taskhoz. A planner nem ad hozzá automatikusan új taskokat vagy projekteket.

### A későbbi v0.1 folytatása

M2 hozzáadja: `PLAN_APPROVED → QUEUED_FOR_IMPLEMENTATION → IMPLEMENTING → REVIEWING`. Az `APPROVE` review után `WAITING_FINAL_APPROVAL`, a `REQUEST_CHANGES` után új Developer kör jön. Legfeljebb **3 teljes Developer + Reviewer kör** lehet; a harmadik sikertelen review után `HUMAN_REVIEW_REQUIRED`. A `BLOCK` eredmény `BLOCKED`. A körszámot alkalmazáskód növeli, nem az LLM.

Végső jóváhagyás: `WAITING_FINAL_APPROVAL → DONE` vagy `REJECTED`. M3-ban a jóváhagyás a konkrét commit SHA-ra, review- és CI-eredményre vonatkozik; új commit érvényteleníti. A `DONE` azt jelenti, hogy a kész eredményt elfogadták; nem jelent automatikus merge-öt vagy production deployt.

## 6. Agent- és provider-szerződések

### ProductPlan v1

```typescript
import { z } from 'zod';

// Provider-compatible shape; business limits are validated separately.
export const ProductPlanSchema = z.object({
  schemaVersion: z.literal('1'),
  summary: z.string(),
  requirements: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  implementationSteps: z.array(z.object({
    order: z.number().int(),
    description: z.string(),
  }).strict()),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  complexity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
}).strict();

export type ProductPlan = z.infer<typeof ProductPlanSchema>;
```

Mentés előtt külön üzleti validáció szükséges: nem üres summary, legalább egy nem üres requirement és acceptance criterion, legalább egy implementation step, pozitív és egymást követő lépésszámok, korlátos hossz és elemszám. Az SDK/JSON Schema által nem támogatott megszorításokat nem erőltetjük a provider-sémába.

Az assumptions és openQuestions megakadályozza, hogy a planner csendben találjon ki követelményeket. A dashboard ezekre is felhívja az operátor figyelmét. Az approval az operátor döntése; az agent nem nyilvánítja saját tervét jóváhagyottnak.

### ProductAgentInput

```typescript
export interface ProductAgentInput {
  projectId: string;
  taskId: string;
  runId: string;
  task: { title: string; description: string; priority: string };
  project: {
    name: string;
    description: string;
    contextVersion: number;
    context: {
      product: string;
      architecture: string;
      codingStandards: string;
      testing: string;
      security: string;
      decisions: string;
    };
  };
  previousPlan: ProductPlan | null;
  changeRequest: string | null;
}
```

### Provider API

```typescript
export interface AgentDefinition<TOutput> {
  key: 'product';
  promptVersion: string;
  instructions: string;
  outputSchema: z.ZodType<TOutput>;
}

export interface AgentExecution<TOutput> {
  output: TOutput;
  provider: string;
  model: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
  };
  providerRequestId: string | null;
}

export interface AgentProvider {
  execute<TInput, TOutput>(
    definition: AgentDefinition<TOutput>,
    input: TInput,
    options: { signal: AbortSignal; runId: string },
  ): Promise<AgentExecution<TOutput>>;
}
```

Az interfész nem ígéri, hogy minden szolgáltató ugyanazokat a toolokat támogatja. M1-ben csak strukturált tervezésre szolgál. Az OpenAI adapter a Zod outputType-ból és `finalOutput`-ból dolgozik az implementációkor ellenőrzött SDK szerint. A Demo adapter determinisztikus, az inputhoz kapcsolódó fixture-tervet készít, és `provider=DEMO`, `model=null` értéket ad.

**Product prompt követelményei:** taskhoz kötött, implementálható specifikáció; projektkorlátok tisztelete; tesztelhető acceptance criteria; feltételezések és hiányzó adatok külön jelölése; kitalált fájlok, futtatott tesztek és kutatási bizonyítékok kerülése. Nincs külső tool vagy repohozzáférés M1-ben. Task és context adatok nem írhatják felül a system utasításokat vagy a platform-jogosultságokat.

## 7. Queue, retry és tartós működés

**DB az igazság forrása; queue a kézbesítés.** Tervezésindításkor egyetlen tranzakció létrehozza a runt, módosítja a taskot, írja az eventet és az outbox rekordot. A worker processz outbox dispatcherje a commit után küldi a BullMQ jobot. Így Redis kiesésekor sem vész el a request.

Job payload: `{ projectId, taskId, agentRunId }`. Job ID: `planning-<runUUID>`. A job nem hordoz titkot, teljes promptot vagy változó tasksnapshotot. A dispatcher Redis-hiba esetén backoff után újrapróbálja a kézbesítést.

Kettős kézbesítés lehetséges: a worker DB-ben claimeli a futást, lease/heartbeat és ownership token alapján. Minden véglegesítő írás ellenőrzi a még élő ownership tokent, az aktív run ID-t és a task állapotát. Egy már sikeres vagy lezárt run ismételt jobja no-op. A job ID deduplikációja önmagában nem elegendő.

M1 feldolgozási limitek:

- `PLANNING_CONCURRENCY=1` globális, queue-szinten kikényszerítve; több worker indulásakor is egy aktív planning job. A lease az ismételt kézbesítés ellen is szükséges.
- Maximum 3 automatikus végrehajtási próbálkozás egy logical runhoz. A DB-s attempt számláló az irányadó worker crash esetén is.
- Egy attempt timeoutja alapértelmezetten 120 másodperc; konfigurálható, megszakítási jel átadva a providernek.
- 429, átmeneti hálózati és 5xx hiba retry: exponenciális backoff és jitter. Auth/config hiba, refusal, invalid structured output: FAILED, nincs automatikus végtelen javítóciklus.
- A provider belső retry-ját ki kell kapcsolni vagy a teljes próbálkozási keretbe beszámítani. Az SDK és queue egymásba ágyazott retry-ja nem szorozhatja fel észrevétlenül a hívásokat.
- M1-ben emberi módosításkérés legfeljebb 5 tervverzióig engedélyezett taskonként; utána 409 `PLAN_REVISION_LIMIT_REACHED`. A külön explicit retry új logical runt hoz létre, és a költségadatai is külön láthatók.
- Cancellation DB-ben azonnal lezárja a taskot és a pending approvalt; a még futó providerhívás kései eredményét nem publikáljuk. A megszakítás nem garantálja, hogy a provider már elindított munkája nem kerül pénzbe.

Crash után lejárt lease esetén új attempt indulhat. A korábbi attempt `INTERRUPTED` állapotot kap. A DB-eredmény legyen idempotens; külső LLM-hívásra nem állítunk „exactly once” garanciát. Újrahívás és ismeretlen tokenhasználat a futástörténetben látszik.

M2-től development/review queue-k és külön projektenkénti erőforráskeretek jönnek. Ezeket M1 nem színleli kész funkciónak. A priority M1-ben lista- és queue-sorrendet befolyásol; egy már futó jobot nem szakít meg. A queue priority mappingje legyen explicit és tesztelt.

## 8. Approval és API

A teljes approval döntés tranzakció: pending rekord claim, task és aktuális terv ellenőrzése, döntés mentése, státuszváltozás, event; changes requested esetén az új run és outbox létrehozása is ide tartozik.

Az approve requestben kötelező a `planId` és `expectedTaskVersion`. Régi terv, lezárt approval vagy közben megváltozott task esetén 409. Két párhuzamos döntésből csak az egyik változtathat állapotot. Az actor az operátor sessionjéből származik, nem a request bodyból.

| Módszer / útvonal | Viselkedés |
|---|---|
| `POST /projects` | Projekt és kezdeti context létrehozása, 201 |
| `GET /projects` | Lapozott projektlista |
| `GET /projects/:id` | Projektrészletek |
| `POST /projects/:id/tasks` | Task létrehozása DRAFT állapotban, 201 |
| `GET /projects/:id/tasks` | Lapozott, szűrhető tasklista |
| `GET /tasks/:id` | Task, tervverziók, approvalok, run összesítők |
| `GET /tasks/:id/runs` | Runok és attempt összesítők |
| `GET /tasks/:id/events` | Lapozott audit log |
| `POST /tasks/:id/plan` | DRAFT task tervezésindítása, 202, runId |
| `POST /tasks/:id/retry` | FAILED task új runja, 202 |
| `POST /tasks/:id/cancel` | Engedélyezett cancellation, 200 |
| `POST /approvals/:id/approve` | Aktuális terv jóváhagyása |
| `POST /approvals/:id/request-changes` | Kötelező komment + új tervezési run |
| `POST /approvals/:id/reject` | Terv és task elutasítása |
| `GET /health/live` | Processz működik |
| `GET /health/ready` | A processzhez szükséges DB/Redis elérhetőség |
| `GET /capabilities` | provider mód, enabled funkciók; titok nélkül |

Író végpontok Zod inputvalidációt használnak, ismeretlen mezőket elutasítanak. Soha nincs általános `PATCH status`. Az API OpenAPI dokumentációja és a Zod szerződések ne térjenek el.

Tervezés, retry és approval műveletekhez `Idempotency-Key` kötelező. M1-ben a command request/response nyilvántartás tartós DB-rekordként készül, composite unique(operation, actorId, key) szabállyal. Ez egy kilencedik, technikai `CommandReceipt` tábla: key, operation, actorId, requestHash, resourceId, response JSON, createdAt. Ugyanaz a kulcs és body az eredeti választ adja; eltérő body 409. Az üzleti állapotvalidáció új kulcs esetén is meggátolja a párhuzamos planning runt.

API-hiba alakja: `{ code, message, correlationId, details? }`; stack trace, API-kulcs és raw provider request nem kerül a klienshez. A lapozásnak legyen fix felső limitje. M1 felület 2 másodperces pollingot használ aktív taskoknál, lezárt állapotnál leáll; nincs WebSocket infrastruktúra.

## 9. Dashboard

| Oldal | Tartalom |
|---|---|
| `/dashboard` | Projektszám, aktív taskok, pending approvalok, futások, ismert becsült AI-költség |
| `/projects` | Projektlista és létrehozás |
| `/projects/[id]` | Context áttekintés, tasklista, task létrehozása |
| `/tasks/[id]` | Állapot, tervverziók, approval, runok/attemptök, audit timeline, retry/cancel |

Kell üres, betöltési, hiba- és sikerállapot. A plan oldalon requirements, acceptance criteria, lépések, assumptions, openQuestions, risks és complexity olvasható. Pending approvalnál approve / request changes / reject gomb jelenik meg. A módosításkérés kommentje kötelező. Régi tervverzión nincs aktív approval gomb.

A demómód állandó `DEMO — no live AI` jelzést kap. Null usage/költség „Not reported” / „Unknown”; nem megtévesztő nulla. `PLAN_APPROVED` után nincs aktív „Run Developer” gomb M1-ben. Hiba esetén konkrét hibaok és elérhető retry jelenik meg, nem végtelen spinner.

## 10. Titkok, hozzáférés és költség

M1 egyetlen operátor lokális alkalmazása. Alapértelmezésben localhostra kötött; nincs public deployment. Egyszerű operátori belépés: envben megadott jelszó, backendoldali ellenőrzés, HttpOnly/SameSite session cookie, env session secret, Origin/CSRF védelem az író műveleteken, login rate limit. A böngésző sem OpenAI-kulcsot, sem operátori secretet nem kap. Jelszó és session secret nincs seedben vagy repóban. API csak sessionnel hívható a health és login kivételével.

Az OpenAI-kulcs csak a worker környezetében szükséges. Provider=openai esetén hiányzó kulcs vagy modell explicit konfigurációs hiba; nem történik automatikus visszaesés demo módra. ChatGPT-előfizetés és az alkalmazás API-hívásainak elszámolása külön kezelendő; a dokumentum nem ígér ingyenes live futtatást.

Trace csak explicit konfiguráció alapján, titkok és érzékeny inputok redakciójával. Üzleti audit mindig saját DB-ben. Nyers chain-of-thought nem tárolandó és nem szükséges. Modellválasz és bemeneti snapshot korlátos méretű; csak szükséges projektadatokat tartalmazhat.

Költség: a provider által jelentett usage-ból, konfigurált és verziózott árakkal számított **becslés**, nem számla. Cached input, normál input és output külön tarifával számolható; a cached input nem számít kétszer. Hiányzó tarifánál vagy usage-nál estimated cost null. Összesítéskor az ismert összeg mellett jelölni kell az ismeretlen attemptök számát. Sikertelen/késői attempt ismert költsége is beleszámít. Demo költség nulla, provider jelzéssel.

M1-ben nincs garantált havi költségplafon. Szabályozható concurrency, attemptlimit, timeout és támogatott provider outputlimit van. A későbbi havi budget hard limithez foglalások és párhuzamos hívások előzetes elszámolása szükséges; puszta utólagos tokenmérés nem biztosít kemény költségkorlátot.

## 11. Milestone 1 feladatlista

Minden task egy ellenőrizhető eredményt adjon. A sorrend függőségi sorrend; a dashboardot valódi API-ra kell kötni.

| ID | Feladat | Függőség | Elkészülés bizonyítéka |
|---|---|---|---|
| M1-01 | pnpm scaffold, API/web/worker entrypoint, tsconfig, lint/format, env validáció | — | Tiszta install; mindhárom processz fordul; lockfile |
| M1-02 | Docker Compose PostgreSQL/Redis, migrációs/seed parancs, healthcheck | M1-01 | DB és Redis ready; új üres DB-re migráció fut |
| M1-03 | Zod input/output szerződések, ProductPlan, hibakódok, priority mapping | M1-01 | Érvényes/hibás DTO-k és terv üzleti szabályainak tesztjei |
| M1-04 | Prisma modellek, indexek, relation invariánsok, repository réteg | M1-02/03 | Migráció, seed, keresztprojekt és duplicate constraint tesztek |
| M1-05 | Determinisztikus workflow, version check, command receipt, eventek | M1-04 | Tiltott tranzíció és párhuzamos művelet tesztelve |
| M1-06 | Operátori session és REST végpontok | M1-05 | Session nélkül 401; CRUD/validation és OpenAPI ellenőrizve |
| M1-07 | Outbox dispatcher, planning queue, DB claim/lease, retry/cancel | M1-05 | Redis-hiba, duplicate job, worker restart és kései válasz teszt |
| M1-08 | AgentProvider, Demo adapter, verziózott Product prompt | M1-03/07 | Inputból konzisztens terv; egyértelmű DEMO jelzés |
| M1-09 | OpenAI adapter: outputType, timeout, usage, hibakezelés | M1-08 | Mockolt provider contract tesztek; kulccsal külön live smoke |
| M1-10 | Approval API, request-changes, tervverziók és audit | M1-06/09 | Régi terv nem approve-olható; két döntésből csak egy commit |
| M1-11 | Dashboard négy oldala, formok, polling, run/approval nézetek | M1-06/10 | Valódi API/DB folyamat; reload után állapot megmarad |
| M1-12 | Költségbecslés, correlation ID, redakció, capabilities | M1-09/11 | Null usage nem nulla; hibás tarifánál unknown; nincs secret leak |
| M1-13 | Integrációs és Playwright folyamat, demo/live külön jelölés | M1-11/12 | Demo E2E zöld; live ellenőrzés külön riportban |
| M1-14 | README, .env.example, AGENTS.md, SPEC, döntési napló | M1-13 | Másik fejlesztő dokumentált parancsokkal elindítja |

### Szükséges tesztek

- DRAFT taskból pontosan egy aktív planning run indul, párhuzamos requesteknél is.
- Tranzakció után, queue kézbesítés előtt történő crash nem veszíti el az outbox requestet.
- Ugyanazon job kétszeri kézbesítése nem eredményez két tervet, approvalt vagy completion eventet.
- Lejárt worker lease után régi worker nem írhatja felül az új attempt eredményét.
- Hibás output, refusal és auth hiba nem hoz létre pending approvalt; átmeneti hiba korlátosan retry-olódik.
- Cancellation után érkező valid terv nem változtatja vissza a taskot.
- Approve vs reject versenyben csak egy döntés commitol; stale plan/task version 409.
- Request changes új tervverziót készít, a korábbi terv és döntés megmarad.
- Projektidegen plan/run/approval ID elutasítandó akkor is, ha létező ID.
- Input snapshot a run indításkori változatot mutatja.
- Null tokenadat és ismeretlen ár nem jelenik meg ingyenes futásként; cached input számítása helyes.
- Playwright: login → project → task → demo plan → changes requested → új plan → approve → reload → PLAN_APPROVED.
- Live smoke külön: OpenAI planner érvényes és taskhoz kapcsolódó tervet ad; usage és model a tényleges válaszból jön.

A concurrency/crash tesztek valódi PostgreSQL/Redis mellett fussanak, a modellhívás kontrollált fake providerrel. Az offline CI ne hívjon fizetős API-t. A mock teszt és a demo E2E nem helyettesíti a valódi Product Agent ellenőrzését.

### M1 Definition of Done

1. Tiszta checkoutból dokumentált install/migrate/seed/dev parancsokkal indul.
2. A projektek, taskok, tervverziók és approvalok újraindítás után megmaradnak.
3. Demo E2E, typecheck, lint, build és a fenti érdemi backend tesztek sikeresek.
4. OpenAI adapter implementált; a live smoke lefutott, vagy az eredmény egyértelműen `LIVE_VALIDATION_PENDING` a hiányzó kulcs/hozzáférés miatt. Utóbbi esetben M1 még nem tekinthető valódi AI-val teljesen elfogadottnak.
5. Approval után `PLAN_APPROVED`; nincs development job, látszat-PR vagy automatikus deploy.
6. A futási adatok, hibák, tervverzió és döntéstörténet a dashboardon láthatók.
7. Nincs beégetett secret, publikus default deployment vagy kitalált teszteredmény.

## 12. Codex master prompt — közvetlenül használható

A repository gyökerében ezt az átadóanyagot tedd a `docs/SPEC.md` fájlba. Utána az alábbi prompt használható. A prompt implementációt kér; az M1 határain belül végig kell vinni a munkát.

```text
You are the lead engineer implementing AI Software Company Milestone 1.

Read docs/SPEC.md in full before changing files. It is the authoritative
implementation specification. Inspect the repository and all applicable
AGENTS.md instructions first. Preserve unrelated existing work.

Build a real runnable platform, not a visual mockup. Implement ONLY M1:
project and task management, deterministic workflow, durable queued planning,
one Product Agent, versioned structured plans, human plan approvals,
agent-run/attempt records, audit events, cost estimates, and the dashboard.

Stack:
- pnpm TypeScript strict monorepo
- apps/api: NestJS REST
- apps/web: Next.js App Router
- apps/worker: separate BullMQ worker process
- PostgreSQL, Prisma, Redis, Docker Compose
- Zod contracts
- @openai/agents behind a small AgentProvider interface

Choose and verify compatible stable dependency versions, pin them, and commit
a lockfile. Check current official OpenAI SDK docs before using SDK methods.
Do not invent an OpenAI sandbox API. No coding sandbox is required for M1.

Architecture:
- Controllers do not contain business logic; services use repositories.
- API and worker share deterministic workflow rules.
- The LLM never directly changes task status, approvals, or permissions.
- Persist immutable task/context input snapshots and immutable plan versions.
- Every child resource must belong to its declared project/task.
- Plan approval binds to a specific current plan and expected task version.
- End M1 at PLAN_APPROVED. Do not queue development or claim implementation
  happened after a planning approval.

Reliability:
- Atomically persist command, run, task transition, event, and outbox message.
- Use a transactional outbox and stable BullMQ job IDs.
- Handle at-least-once delivery through DB claims, leases, ownership tokens,
  unique constraints, and conditional transactional finalization.
- Record execution attempts separately; handle worker crashes and stale writes.
- Bound retries/timeouts and avoid multiplying SDK retries with queue retries.
- Never publish a late provider result after cancellation.
- Persist command idempotency receipts; reject key reuse with a different body.
- Do not promise exactly-once LLM calls or a hard monthly spending cap.

Providers:
- DEMO is a deterministic adapter for local onboarding and offline tests.
- OPENAI is a real Product Agent using schema-constrained output and Zod
  validation, configurable model, cancellation/timeout, and real usage data.
- Never silently fall back from OPENAI to DEMO.
- Show provider mode clearly. Unknown usage/cost stays unknown.
- Failed/interrupted attempts remain in run history; known cost counts too.
- Keep API keys server-side in the worker; never request secrets in chat.

Security and UI:
- Single-operator local app, localhost defaults, documented operator session.
- HttpOnly session, CSRF/Origin checks, input limits, login rate limit.
- No secrets in the browser, source control, audit logs, or public errors.
- Four primary pages: dashboard, projects, project detail, task detail.
- Use the real API. Implement loading, empty, error, pending, and terminal UI.
- Show requirements, criteria, steps, assumptions, questions, risks, complexity.
- Support approve, request changes, reject, retry, and cancellation as specified.
- Make stale approval conflicts understandable to the operator.

Execution:
1. Inspect the workspace and report the immediate implementation plan.
2. Implement M1-01 through M1-14 in dependency order with working increments.
3. Add meaningful workflow, concurrency, duplicate-delivery, crash recovery,
   stale-approval, provider-error, cancellation, and cost tests.
4. Run typecheck, lint, backend tests, build, and the demo Playwright workflow.
5. If credentials are already available through the authorized environment,
   run one explicitly identified live Product Agent smoke test. Otherwise
   complete all offline work and report LIVE_VALIDATION_PENDING precisely.
6. Write README setup/run/test commands, .env.example, AGENTS.md, architecture
   decisions, and a milestone acceptance checklist with actual results.
7. Summarize implemented behavior, commands actually run, remaining blockers,
   and the minimal next step for M2.

Stay within M1. No GitHub integration, Developer/Reviewer execution, shell
tools for agents, automatic merge, production deployment, Research Agent,
marketing, payments, or multi-user SaaS features. Do not change global system
configuration or expose the app publicly to complete local setup.

Proceed autonomously on reversible implementation choices. Stop only for
genuinely missing external credentials, unavailable required infrastructure,
or destructive changes outside the authorized task. Complete independent
work before reporting blockers. Never claim a test or live run that did not
actually happen.
```

## 13. Első acceptance task

Ez a Product Agentet próbálja ki; a platform M1-ben még nem implementálja magát a feature-t.

**Projekt:** Sample Notes App

**Context:** TypeScript, NestJS REST API, Next.js UI, PostgreSQL. Controllerben nincs üzleti logika. A jegyzet a belépett userhez tartozik. Új endpoint integrációs tesztet kap. A projektkontextus szerint a jegyzet title és content mezőkből áll; további meglévő mezőkről nincs információ.

**Task:** „Szeretném archiválni a jegyzeteimet. Az archivált jegyzetek ne jelenjenek meg az alaplistában, de legyen egy külön lista, ahol láthatók, és onnan vissza tudjam állítani őket.”

**Elvárt terv:** archive és restore művelet, alaplista és archivált lista szűrése, jogosultsági ellenőrzés, ismételt archive/restore viselkedése, releváns API/UI tesztek. A hiányzó route/fájlszerkezetre vonatkozó feltételezéseket jelezze. Ne találjon ki ténylegesen beolvasott fájlokat vagy már futtatott teszteket.

**Módosításkérés:** „Az archivált jegyzeteket is lehessen cím alapján keresni.” Új tervverzió készül; a régi terv és approval döntés megmarad. Csak az új verzió hagyható jóvá.

## 14. Ellenőrzött források és döntési határ

A következő elsődleges dokumentációt 2026-10-06-án ellenőriztük. A konkrét dependency API-kat implementációkor újra kell ellenőrizni.

- OpenAI — [Agent definitions](https://developers.openai.com/api/docs/guides/agents/define-agents): TypeScript agent definíció, Zod `outputType`, `finalOutput`.
- OpenAI — [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk): az SDK alkalmazásoldali agent futtatás és toolvezérlés alapja.
- OpenAI — [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): séma szerinti kimenet és natív sémahelperek; a szemantikai helyességet külön kell ellenőrizni.
- BullMQ — [Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): retry esetén azonos végállapotot biztosító jobtervezés.

A NestJS/Next.js/Prisma stack, a transactional outbox, a snapshotok, a lease/fencing és a pontos státuszok a jelen dokumentum tervezési döntései. Nem állítjuk, hogy ezeket az Agents SDK automatikusan megoldja. A dokumentumban nincsenek hipotetikus feature-költségek tényleges mért eredményként feltüntetve.
