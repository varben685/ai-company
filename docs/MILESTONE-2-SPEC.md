# AI Software Company — Milestone 2 Implementation Pack

Verzió: 1.0 · Dátum: 2026-10-06 · Tulajdonos: Bence

**Átadóanyag:** az M1 forráskódjára épülő M2 specifikáció, feladatlista és csatolható Codex master prompt. Ez a dokumentum M2 implementációját írja elő; M2-t ebben a munkában nem implementáltuk és nem futtattuk.

## 1. Ellenőrzött kiindulási állapot

Repository: [varben685/ai-company](https://github.com/varben685/ai-company)

Branch: `codex/m1-core-platform`

Vizsgált commit: **`94c2e42a439ed77a29d76c8d36c3f0ba769ecca2`** — `Use Corepack for nested pnpm scripts`. Ez a korábban jelzett `b44e195` M1 commit utáni állapot.

Az M2 tervezésekor a contracts, workflow, adatmodell és SQL-migráció, API service/controller, worker, agent provider, queue dispatcher, observability, task oldal, tesztszerkezet és ADR/acceptance dokumentumok forrását néztük át. A teszteket ebben az áttekintésben nem futtattuk; a 41 sikeres backendteszt és a browser E2E a repository M1 jegyzőkönyvének eredménye.

Bence a működést és a tesztprojekt sikeres kipróbálását visszajelezte. A commitban tárolt `docs/MILESTONE-1.md` még `LIVE_VALIDATION_PENDING` állapotot tartalmaz. M2 elején ezt egyeztetni kell a tényleges helyi live eredménnyel; a forrásszintű áttekintésből nem állítható, hogy a live smoke lefutott.

Ez az áttekintés az M2 kapcsolódási pontjainak felmérése, nem teljes biztonsági audit vagy új M1 acceptance futtatás.

### Konkrét kapcsolódási pontok

| Jelenlegi fájl / működés | M2-ben szükséges változtatás |
|---|---|
| `packages/contracts/src/index.ts` | Új task státuszok, agent típusok, development/validation/review/final approval DTO-k; RunView jelenleg nem ad `agentType` mezőt |
| `packages/workflow/src/index.ts` | `PLAN_APPROVED` most terminális; új explicit START_DEVELOPMENT és további determinisztikus tranzíciók |
| `packages/database/src/index.ts` | `queue/start/decide` planning-specifikus; stage szerinti queue és approval döntés; régi PLAN/RETRY megőrzése |
| `packages/database/src/worker-repository.ts` | Claim és owned csak planning státuszt fogad; ProductInput parsing és TaskPlan completion külön stage handlerbe kerül |
| `packages/database/prisma/schema.prisma` | Session, workspace, artifact, validation, tool/model call rekordok; FINAL_CODE approval target |
| `.../202610060001_initial/migration.sql` | `task_status` CHECK csak M1 státuszok; `Approval.targetPlanId` kötelező FK; immutable triggerek és composite FK-k új migrációval bővítendők |
| `packages/integrations/src/index.ts` | `planningQueue`, `planning-<id>` és `Dispatcher` hardcoded; kind szerinti routing és validator outbox |
| `packages/agents/src/index.ts` | `key: product`, ProductInput/ProductPlanSchema, `tools: []`, `maxTurns: 1`; külön Developer és Reviewer agent kell |
| OpenAI transport wrapper | A metadata jelenleg egy hívásra készült, új válasznál felülír; M2-ben minden modellhívásról külön accounting kell |
| `packages/observability/src/index.ts` | Egyetlen modell/tarifa; több agent, több call és stage konfiguráció |
| `apps/worker/src/main.ts` és `processor.ts` | Külön planning/development/validation/review processor; shared lease/recovery mechanika |
| `apps/api/src/service.ts` | Capabilities: development=false; külön worker/sandbox readiness és stage-safe API |
| `apps/web/app/tasks/[id]/page.tsx` | Polling most csak planningnél; approvalt csak plan ID alapján keres; fejlesztési roundok, diff, validation, review, final approval |
| `tests/unit.test.ts`, `tests/integration.test.ts` | M1 megtartása, új stage/crash/fencing/validation tesztek izolált DB/Redis mellett |

Az M1 migrációt és immutable történelmet nem írjuk át. Az M2 új, forward-only migrációt kap; a meglévő taskok/tervek/approvals/receipt-ek változatlanul olvashatók maradnak.

## 2. Az M2 célja és határa

**Cél:** jóváhagyott terv → izolált sample workspace → Developer módosításai → független validáció → külön, csak olvasó Reviewer → legfeljebb három kör → konkrét kód-snapshot emberi jóváhagyása.

Sikeres végállapot `DONE`. Ez a kódcsomag elfogadását jelenti. M2 nem merge-öl és nem telepít semmit.

M2 elsőként egy beépített `sample-todo-v1` forrásprojekttel működik. Minden platform Projecthez választható ez a serveroldali, verziózott source ID. Tetszőleges user által megadott host path vagy GitHub URL importja nem része az első M2 scope-nak. A source/workspace interfészek később támogatják ezeket, de most nincs GitHub App, klónozás, push vagy PR.

Az acceptance-hez külön sample Project és a fixture stackjének megfelelő context készül, majd erre generált tervet hagy jóvá az operátor. Meglévő, más stackre vagy más célalkalmazásra írt M1-tervet nem szabad csendben ehhez a sample-höz átértelmezni. Source/context mismatch esetén konkrét BLOCKED indok jelenjen meg.

**A platform saját `ai-company` repositoryja nem az agent cél-workspace-e.** A Developer a sample projekt másolatát írja; az API/web/worker forráskódját, a platform DB-jét és a host környezetét nem kapja meg.

A planning approval továbbra is `PLAN_APPROVED` állapotig visz. Innen egy új, explicit **Start development** művelet indul. Ez megőrzi az M1 viselkedését és elkerüli, hogy a régi, már jóváhagyott taskok a migráció után maguktól végrehajtódjanak.

## 3. Megvalósítási sorrend

| Rész | Eredmény | Továbblépés feltétele |
|---|---|---|
| M2A — Workspace és validation alap | Valódi Docker workspace, képességkorlátok, immutable artifact, valódi tesztfuttatás | Izoláció, orphan cleanup és stale snapshot tesztje zöld |
| M2B — Determinisztikus offline loop | Demo Developer + Demo Reviewer, valódi fájlváltozás/teszt/diff/final approval | Siker, javítás és 3-körös limit E2E tesztelve |
| M2C — Live agentek | OpenAI Developer toolhasználattal és külön Reviewer | Live sample feature valódi változtatással és independent validationnel |

Ez egyetlen M2; a részek függőségi sorrendje kötelező. A sandbox jogosultsági tesztjei megelőzik az autonóm live kódfuttatást.

## 4. Source és Docker workspace

### Source registry

Új `packages/workspace` package. Source adapter: `BuiltinFixtureSource`, verziózott sample könyvtárral, file manifesttel és serveroldali validation konfigurációval.

Source snapshot: `{ sourceId, sourceVersion, baselineHash, policyVersion, validatorVersion }`. A hash fájlnevekből, fájlbájtokból és releváns filemode-okból, determinisztikus sorrendben készül. A teljes source snapshot M2 elején az approved planhez és DevelopmentSessionhöz kötve fagy meg.

M2-ben a sample fixture baseline egyszerű JavaScript ESM modul és Node beépített tesztfuttató. Nincs hálózati dependency install a task közben. Az image és minden runtime dependency előre, megbízható setup során készül, rögzített image ID/digesttel. Új sample forrás nem kerül automatikusan a registrybe LLM output alapján.

### Workspace életciklus

1. Session előkészítése az approvedPlanId + source baseline alapján.
2. Minden Developer attempthez **külön workdir/volume és konténer**, attempt ownership tokenből származó azonosítóval.
3. Round 1 a baseline-ból indul. Fix round az előző **publikált, immutable candidate** másolatából indul, nem egy elhagyott dirty workdirből.
4. Toolhívások előtt ownership ellenőrzés. Token/lease elvesztésekor toolok megszakadnak és az attempt konténere leállításra kerül.
5. Agent finish után minden task-processz/container leáll; a collector ezután olvassa a workdir végleges bájtjait. Élő processz által még módosítható snapshot nem publikálható.
6. Collector ellenőrzi a file policyt, létrehozza a tartalomhash-es immutable candidate artifactot és a baseline-hoz képest kumulatív diffet.
7. Csak élő lease-szel és feltételes DB-finalizationnel publikálható a candidate. Kései attempt artifactja nem kerül a session currentCandidate pointerére.
8. Validation és Reviewer ebből a befagyasztott candidate-ból dolgozik. A Reviewer nem kap writable Developer workspacet.

DB fencing nem azonos filesystem fencinggel. Az attemptenkénti izoláció szükséges akkor is, ha minden DB-írás megfelelően ellenőrzi a tokent. A korábbi worker legfeljebb a saját, eldobható attemptkönyvtárát módosíthatja, a következő attemptet és a publikált artifactot nem.

### Konténerpolicy

- Unprivileged user; read-only root filesystem; külön korlátos `/tmp`.
- Developer csak a saját sample workdirhez kap RW mountot. A sample engine/validator és a platform policy RO, ha szükséges hozzáférni.
- `network=none`, nincs portpublikálás, host network/PID namespace vagy device mount.
- Nincs Docker socket a sandboxban. A hostoldali workspace adapter vezérli a konténert; ezt a capabilityt az agent nem kapja meg.
- Nincs API-kulcs, DB/Redis cím/jelszó, host HOME, SSH agent, `.env.worker` vagy teljes host `process.env` a konténerben. Env allowlist: szükséges runtime változók, titok nélkül.
- `cap-drop=ALL`, `no-new-privileges`; default seccomp megtartva; CPU/memória/PID és loglimitek.
- Sample induló limitek: 1 CPU, 512 MiB memória, 64 PID, egy command 30 s, fejlesztési attempt 10 perc. Konfigurálhatók, a policy szerveren készül.
- Nincs általános shell-string tool; hostoldalon `spawn/execFile` argumentumtömbbel és `shell:false`.
- M1 planning tovább működhet Docker nélkül, de development explicit `WORKSPACE_UNAVAILABLE` hibával letiltott, ha a szükséges image/engine hiányzik. Nincs host shell fallback.

A Docker itt a saját, egyoperátoros sample projekthez választott izolációs backend. Nem tekintjük automatikusan többfelhasználós, ellenséges kódot korlátlanul fogadó hosting-szolgáltatásnak.

### Fájlpolicy és limitezés

Minden path workspace-relatív. Absolute path, `..`, `.git`, titokfájlok, platformmappák, symlink, hardlink és special file elutasítandó. Symlinkeken keresztüli kilépést a tool és a collector is ellenőrzi; a repo-olvasás és artifact letöltés sem követhet ilyen linket.

Az első fixture csak normál UTF-8 source/test/README fájlokat enged. Fájlonként 256 KiB, teljes candidate 5 MiB, legfeljebb 200 fájl; tool válaszonként 32 KiB, összes command output 128 KiB. A pontos limitek tesztelt serverpolicyban legyenek. Rejected/oversized output nem kerül korlátlan promptba vagy audit logba.

## 5. Workspace és tool interfészek

Az alábbi alakszerződés irányadó; az implementáció Zod DTO-kat és typed runtime capabilityket használ. Az SDK nem tárolja helyettünk a workspace-életciklust.

```typescript
interface CodingWorkspace {
  listFiles(input: { path: string; limit: number }): Promise<FilePage>;
  readFile(input: { path: string; startLine: number; endLine: number }): Promise<FileSlice>;
  search(input: { query: string; paths: string[]; limit: number }): Promise<SearchResult>;
  writeFile(input: { path: string; content: string; expectedHash: string | null }): Promise<FileWriteResult>;
  applyPatch(input: { patch: string }): Promise<PatchResult>;
  runCommand(input: { commandId: 'unit-tests' | 'syntax-check' }): Promise<CommandResult>;
  getDiff(): Promise<DiffResult>;
}

interface WorkspaceBackend {
  prepareAttempt(input: TrustedWorkspaceRequest): Promise<WorkspaceHandle>;
  freezeCandidate(handle: WorkspaceHandle): Promise<CandidateArtifactDraft>;
  terminate(handle: WorkspaceHandle): Promise<void>;
  reconcileOwnedContainers(): Promise<void>;
}
```

`TrustedWorkspaceRequest` csak szerveroldali, DB-ből feloldott source/session/attempt/policy adatot tartalmaz. Az agent nem választhat host rootot, mountot, image-t, command template-et vagy Docker optiont. Workspace backend és LLM provider külön absztrakció: a modell cseréje nem változtatja meg a sandbox permissiont.

| Szerep | Engedélyezett képességek |
|---|---|
| Product | Változatlan M1 structured planning, tool nélkül |
| Developer | list/read/search, write/applyPatch engedélyezett fájlokra, named command, diff |
| Reviewer | Immutable candidate/baseline list/read/search, diff, validation report; nincs write vagy command |
| Validator | Szerveroldali, versioned commandok és acceptance suite; nem LLM és nem agenttool |

Mindegyik toolhívás validált, timeoutos és auditált. A denied hívás is kap kódot és korlátos ToolExecution rekordot. A review readonly capabilityjéből hiányoznak az író függvények; nem csak prompt tiltja azokat.

## 6. Determinisztikus workflow

| Kiindulás | Trigger | Cél / mellékhatás |
|---|---|---|
| PLAN_APPROVED | Ember: Start development, approvedPlanId + expectedTaskVersion + sourceId | QUEUED_FOR_IMPLEMENTATION; session + Developer run + outbox |
| QUEUED_FOR_IMPLEMENTATION | Élő Developer claim | IMPLEMENTING |
| IMPLEMENTING | Valid DeveloperResult és frozen candidate publikálása | QUEUED_FOR_VALIDATION; validation record + outbox |
| QUEUED_FOR_VALIDATION | Validator claim | VALIDATING |
| VALIDATING | Required checks PASS vagy FAIL, érvényes report | QUEUED_FOR_REVIEW; Reviewer run + outbox |
| QUEUED_FOR_REVIEW | Reviewer claim | REVIEWING |
| REVIEWING | APPROVE és deterministic gate PASS | WAITING_FINAL_APPROVAL; FINAL_CODE approval |
| REVIEWING | REQUEST_CHANGES, vagy APPROVE mellett validation FAIL; round < 3 | QUEUED_FOR_IMPLEMENTATION; új round, Developer fix run |
| REVIEWING | Javítás kell és round = 3 | HUMAN_REVIEW_REQUIRED; automatikus loop lezár |
| REVIEWING | BLOCK vagy policy violation | BLOCKED; nincs automatikus folytatás |
| WAITING_FINAL_APPROVAL | Ember approve exact candidate/review/validation + task version | DONE |
| WAITING_FINAL_APPROVAL | Ember reject | REJECTED |
| Aktív stage | Végleges infra/provider hiba | FAILED, failureStage/failureCode tárolva |
| FAILED | Ember stage-safe retry | A hibás stage queued állapota, ugyanazon roundhoz kötve |
| M2 lezárás előtti állapotok | Ember cancel | CANCELLED, active run/validation/approval lezárás és cleanup |

M2-ben nincs „force approve” a HUMAN_REVIEW_REQUIRED vagy BLOCKED állapotból. Az operátor megnézheti és lezárhatja a taskot; a javítás folytatása későbbi, külön definiált művelet vagy új task. Végső approval request-changes nem része az első M2-nek; a három review kör utáni korlát nem kerülhető meg egy rejtett további agentciklussal.

### Round és attempt megkülönböztetése

- Egy sessionben maximum **3 Developer → validation → Reviewer round**.
- Round 1 az induló implementáció; review után indított javítás round 2/3.
- Egy logical run technikai retry-ja külön AgentRunAttempt, nem új round; legfeljebb 3 attempt, az M1 DB-korlát megtartásával.
- Reviewer retry ugyanazt a candidate/validation reportot olvassa, nem futtatja újra a Developert.
- Validator retry ugyanazt az immutable candidate-t ellenőrzi; nem hív modellt.
- Developer infra-retry tiszta attemptworkspacet kap a round bemeneti snapshotjából. Nem örököl bizonytalan dirty állapotot.
- Hiányos candidate, refusal vagy hibás structured result nem lesz automatikusan siker. Nincs végtelen output-repair beszélgetés.

Az új stage-eknek saját transition/claim/completion szabályai vannak. Általános, szabadon állítható `PATCH status` továbbra sincs. A workflow nem LLM handoff döntések alapján választ következő lépést.

## 7. Developer és Reviewer szerződések

### DeveloperInput

Task/Project snapshot + approvedPlanId és ProductPlan + sessionId/round + source baseline hash + round input candidate hash + workspace policy + korábbi ReviewReport és ValidationReport (ha fix round). Az input immutable. Az agent a workspace toolokkal ismeri meg a valódi sample fájlokat.

```typescript
type DeveloperResult = {
  schemaVersion: '1';
  outcome: 'IMPLEMENTED' | 'BLOCKED';
  summary: string;
  claimedChangedFiles: string[];
  claimedChecks: Array<{ commandId: string; summary: string }>;
  remainingRisks: string[];
  blockingReason: string | null;
};

type ReviewReport = {
  schemaVersion: '1';
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'BLOCK';
  summary: string;
  issues: Array<{
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    category: 'BUG' | 'SECURITY' | 'REQUIREMENT' | 'TEST' | 'MAINTAINABILITY';
    file: string | null;
    line: number | null;
    description: string;
    suggestion: string;
  }>;
};
```

Mindkettő provider-compatible Zod shape; külön business validációval, nem üres summaryval, path/line és méretlimitekkel. `BLOCKED` Developer outcome nem publikál ready eredményt. A Reviewer nem írhat saját artifact ID-t vagy workflow státuszt: a szerver köti a választ a run input candidate-jához.

`claimedChangedFiles` és `claimedChecks` az agent állításai. A valós changedFiles, diff, contentHash és checks a collectorból/validatorból jönnek. Ha eltérnek, az eltérés látszik; approvalt nem az agent állításai engedélyeznek.

APPROVE mellett HIGH/CRITICAL issue konzisztenciahiba: a deterministic gate REQUEST_CHANGES-ként kezeli. Policy/titok/tiltott fájl artifact pedig BLOCKED. A Reviewer ítélete nem írhatja felül a sikertelen required validationt.

### Provider bővítés

A meglévő `AgentProvider` bemeneti/kimeneti typing és error classification megmarad, de nem maradhat ProductInput/ProductPlanSchema hardcode egy „generikus” implementáció alatt. Agent definitions: product/developer/reviewer; inputSchema + outputSchema + limit profil.

A tool capabilityk szerveroldali runtime contextben vannak. A model promptnak csak a szükséges, korlátos fájl- és reportadat kerül átadásra. Agentnek nincs DB client, API secret vagy raw Docker controller.

Developer és Reviewer külön agent-definíció, külön Runner/session/run, külön prompt és context. Ugyanaz a modell használható, de a Reviewer nem a Developer korábbi beszélgetésének folytatása. A teljes Developer thought/history helyett approved plan + diff + snapshot + checks + összefoglaló kerül review inputba.

Konfiguráció: `OPENAI_PRODUCT_MODEL` megmarad; hozzá `OPENAI_DEVELOPER_MODEL` és `OPENAI_REVIEWER_MODEL`, explicit env választással. A dokumentum nem állítja, hogy valamelyik modell garantáltan megold minden feature-t. Az implementáció az installált SDK type declarations és aktuális hivatalos docs alapján ellenőrzi a model/tool/structured-output kombinációt.

Induló looplimitek: Developer max 30 SDK turn, legfeljebb 60 tool call; Reviewer max 12 turn, legfeljebb 24 readonly tool call. Attemptenkénti wall-clock timeout és outputlimit külön. Limitnél `AGENT_LIMIT_REACHED`, ismert usage megmarad. Provider SDK retry továbbra is 0; a DB-s attemptlimit vezérli az újrahívást. A 30 turn nem 30 review round.

## 8. Validation és immutable eredmény

Developer után a platform a candidate-t friss konténerben, source RO mounttal ellenőrzi. A validator szükséges scratch könyvtára RW tmpfs/eldobható volume. Nem a Developer által bemondott parancsot vagy változtatható script nevét követi: source registryből feloldott command template és versioned acceptance suite alapján dolgozik.

ValidationReport: `{ candidateArtifactId, candidateHash, validatorVersion, status: PASS|FAIL|ERROR, checks, startedAt, finishedAt }`. Check mezők: commandId, required, exitCode?, signal?, timedOut, durationMs, outputArtifactRef?, truncation, expected/completed test adatok, pass/fail vagy unknown. A validator lezárt reportja immutable.

Két réteg: sample regression tesztek + a feature-hez tartozó platform-controlled acceptance tesztek. Utóbbiak nem írhatók a Developer toolokkal; integritásukat manifest hash ellenőrzi. Hiányos report vagy nulla tényleges teszt nem PASS. Futtatás előtt és után hash ellenőrzés biztosítja, hogy review-ra ugyanaz a candidate kerül.

FAIL (ismert teszthiba) review-ra kerülhet, hogy a következő Developer round javítsa. ERROR (Docker/tooling/infrastructure) technikai retry, majd FAILED. A teszt és reviewer evidence nem matematikai garancia tetszőleges program helyességére; a sample célja egy jól körülhatárolt, ellenőrizhető fejlesztési feladat.

Deterministic final gate:

1. Nem üres, policykompatibilis candidate diff a source baseline-hoz képest.
2. Minden required validation check PASS, nem unknown/skipped/timeout.
3. Review report ugyanarra a candidate hashre és validation verzióra vonatkozik.
4. Review APPROVE és nincs HIGH/CRITICAL issue.
5. Élő session, a task approvedPlanId-ja és a snapshot parent kapcsolatai megfelelnek.

Az artifact store belső, ignorált `.local/m2-artifacts` vagy konfigurált privát storage root; a relatív storage key nem API-ból érkező file path. Hashes mappa, atomic temp → final publish, létező hash tartalma soha nem írható felül. A DB-finalization előtt elkészült, de nem referált artifact orphan: cleanup később törli, nem lesz visible current candidate. Snapshot/export collector csak engedélyezett regular file-okat csomagol, nem követ symlinket vagy archive traversal pathot.

A DB és fájltár között nincs közös ACID tranzakció; publish/hash/reference és reconciliation együtt adják a tartós működést. A referenced artifactok megmaradnak processz újraindítás után. Download előtt létezés és hash ellenőrzés kell; sérült/hiányzó artifact nem fogadható el.

## 9. DB-változtatások és audit

| Elem | Új/bővített szerződés |
|---|---|
| Project | `workspaceSourceId?`; csak source registry ismert ID-ja |
| Task | `developmentSessionId?`, `failureStage?`, `activeValidationId?`; status CHECK bővítése; M1 pointerek megmaradnak |
| AgentRun | PRODUCT/DEVELOPER/REVIEWER; stage- és session/round input; outputArtifactId?; requested model inputban, tényleges model callonként |
| AgentRunAttempt | M1 attempt számláló/ownership megmarad; workspace instance kapcsolat; aggregált usage mint view/összesítés |
| DevelopmentSession | projectId/taskId/approvedPlanId/source snapshot/baselineArtifactId/currentRound(1..3)/currentCandidateId?/status; M2-ben taskonként egy session |
| WorkspaceInstance | session/run/attempt/project/task, input candidate, generated workdir key/container IDs, ownership token, lifecycle, timestamps, cleanup state |
| AgentArtifact | project/task/session, producerRunId?, attemptId?, round, kind BASELINE/CANDIDATE/DIFF/REVIEW_REPORT/COMMAND_LOG, hash, byteSize, internal storageKey, schemaVersion; immutable |
| ValidationRun | project/task/session/round/candidateArtifactId/candidateHash/validatorVersion; status + lease/owner/attempt limit; lezárt report immutable |
| ModelCall | attemptId, call sequence, model/responseId/requestId, usage, estimated cost/pricingVersion, status; append + egyszeri idempotens finalization |
| ToolExecution | attemptId, call ID/name, korlátos redaktált input összefoglaló, artifact/hash reference, allowed/denied/outcome, időtartam; append-only |
| Approval | type PLAN vagy FINAL_CODE; targetPlanId nullable, targetArtifactId nullable; exactly-one target CHECK és type-target CHECK |
| OutboxMessage | kind PLAN_REQUESTED/DEVELOPMENT_REQUESTED/VALIDATION_REQUESTED/REVIEW_REQUESTED; validationRunId? mellett agentRunId?; exactly-one target, kind szerinti FK/unique |

Minden parent/pointer ugyanahhoz a project/task/sessionhöz tartozik; composite FK-k és CHECK-ek a migrációban. Megmarad a taskonként egy aktív AgentRun partial unique index; validation idején agent run nincs aktív, de csak egy aktív ValidationRun lehet taskonként. Állapotváltás task advisory lock alatt, újraolvasással történik.

Candidate és review report publikálása logical runonként egyszer történhet; unique producerRunId/kind szabály és feltételes finalization védi a dupla completiont. A baseline artifact sessionönként egy. Lezárt ValidationRun reportját és az artifact tartalmát immutable trigger/publish policy védi; lifecycle/cleanup státusz ettől külön módosítható.

Approval PLAN rekordjai backfill nélkül megtarthatók. A nullable targetPlanId csak a FINAL_CODE miatt szükséges; a PLAN type továbbra is pontosan egy létező, ugyanahhoz a taskhoz tartozó plan targetet követel. Final approval JSON snapshot/reference tartalmazza candidateHash + approvedPlanId + source baselineHash + validationRunId + reviewArtifactId + policyVersion értékeket.

Új eventek például: DEVELOPMENT_REQUESTED, WORKSPACE_PREPARED, CANDIDATE_CREATED, VALIDATION_COMPLETED, REVIEW_COMPLETED, FIX_ROUND_REQUESTED, FINAL_APPROVAL_CREATED, CODE_APPROVED, TASK_DONE, WORKSPACE_CLEANUP_FAILED. Nyers modell/provider body és fájltartalom nem kerül az audit payloadba. Tool output külön korlátos artifact lehet.

Worker garbage collector startupkor és periodikusan csak a saját DB/label/workdir registry szerinti konténereket kezeli. M1 Postgres/Redis konténereit és más user Docker-erőforrásait nem törölheti. Cancellation/lease expiry/SIGKILL után az orphan processz/container megáll, a megőrzött immutable output nem tűnik el.

## 10. Queue, retry, accounting

Queue-k: `planning`, `development`, **`validation`**, `review`. A validation külön, nem-AI munka; így infra-crash után ugyanaz a candidate ellenőrizhető, új Developer modellhívás nélkül.

A job payload verziózott és kind-diszkriminált. Agent job: projectId/taskId/agentRunId; validation job: projectId/taskId/validationRunId. A meglévő M1 planning payload tovább támogatott. Dispatcher routing DB-outbox kind alapján; a job nevét és queue-t nem az LLM választja.

Agent job ID `<kind>-<runUUID>`, validator job ID `validation-<validationUUID>`. DB-authoritative reconciliation megtartva, stage szerinti claim/owned/finalizationnel. Outbox ack előtti crash, Redis-vesztés és kimerült stalled delivery után is helyreáll a folyamat.

M2-ben queue-nként global concurrency=1. Ez **nem** egy teljes platformra érvényes közös limit: planning és review közben másik task developmentje futhat. Taskonként/sessionönként a DB megakadályozza a párhuzamos stage-eket. Per-project fairness/budget scheduler későbbi scope; nem írunk ki működőnek nem létező kereteket.

### Többmodellhívásos accounting

M1-ben egy execution egy modellválaszra készült. M2-ben egy Developer attempt 1..N Responses hívást indíthat; a transport wrapper utolsó válaszának tokenjeit nem szabad teljes költségként mutatni.

- Minden outbound modellhívás call recordot kap. Válasz/hiba/refusal/abort után a valóban ismert model/usage/cost idempotensen hozzákapcsolódik.
- Az összes modellhívás beleszámít, beleértve a toolok közötti köröket és a sikertelen/kései választ.
- Egymást követő hívások prompttokenjeit nem deduplikáljuk; a provider minden híváson jelentett usage az alap.
- Pricing model+version registry; több Developer/Reviewer modell külön tarifával. Hiányzó ár vagy usage unknown.
- Az attempt/run/task összesítés a call ledgerből számol; attempt aggregate és call sor nem számítódhat kétszer.
- Korábbi M1 attemptöknek nincs call ledgerük: explicit legacy fallback csak azoknál, amelyekhez egyetlen ModelCall sincs. Új PRODUCT run is call ledgerrel dolgozhat. Fake history/backfill providerhívás nem kell.
- UI: ismert subtotal + unknown call/legacy attempt count. Hiányos attempt total nem jelenhet meg teljesen ismertként.
- ModelCall adat megőrzése nem igényel beszélgetéstörténetet vagy chain-of-thoughtot.

A fájltoolok nem jelentenek fizetős modellhívást önmagukban. M2 sem garantál hard havi budgetet vagy exactly-once külső modellhívást. SDK turn/tool/wall-clock limitek korlátozzák a futást, nem adnak garantált fix USD-költséget.

## 11. API, final approval és felület

| Új/bővített végpont | Szerződés |
|---|---|
| `GET /workspace-sources` | Ismert source ID/name/version, supported features; host path nélkül |
| `POST /tasks/:id/develop` | approvedPlanId, expectedTaskVersion, sourceId; 202; idempotens session/run/outbox |
| `GET /tasks/:id/development` | Session, roundok, candidate/validation/review/final approval összesítők |
| `GET /artifacts/:id` | Korlátos artifact metadata, tulajdonkapcsolat, hash; storageKey nem publikus |
| `GET /artifacts/:id/content` | Validált diff/report vagy konkrét allowed text content, méretlimit |
| `GET /artifacts/:id/download` | Authenticated source archive, hash ellenőrzéssel; biztonságos Content-Disposition |
| `POST /tasks/:id/retry-stage` | expectedTaskVersion + failure stage és target run/validation; stage-safe retry |
| `POST /tasks/:id/cancel` | M1 + M2 engedélyezett állapotok; cleanup ütemezés |
| `POST /approvals/:id/approve` | Diszkriminált PLAN vagy FINAL_CODE decision body |
| `POST /approvals/:id/reject` | Ugyanez; pending/current approvalra |
| `GET /capabilities` | Tervezés és development enabled/readiness; max rounds; provider/agent és source támogatás |

FINAL_CODE body: `candidateArtifactId`, `candidateHash`, `validationRunId`, `reviewArtifactId`, `expectedTaskVersion`, opcionális comment. Actor sessionből; író parancsok Idempotency-Key, Origin/CSRF és az M1 request limit alapján.

Jóváhagyáskor a szerver újraolvassa és ellenőrzi az approvedPlanId-t, sessiont, aktuális artifactot/hash-t, PASS required validationt, APPROVE review-t és pending approvalt. Új vagy sérült artifact, régi taskversion vagy más roundhoz tartozó report 409. Agent nem módosíthat approval recordot. M2-ben nincs külön merge/deploy végpont.

Task nézet: a meglévő plan/history mellett Development rounds, valós changed file lista, kumulatív diff, külön agent-claimed és tényleges check adatok, immutable validation report, Reviewer issues, model/tool activity és costs. Final approval panel a konkrét candidate hashhez kötve. WAITING_FINAL_APPROVAL mellett approval várakozás, DONE mellett elfogadott kódcsomag letöltés.

Polling aktív planning/development/validation/review státuszoknál 2 s; waiting approval és lezárt állapotnál nincs végtelen aktív polling. Oldalak és RunView megjelenítik agentType/stage/round értékét. FAILED oldalon „Retry stage” konkrét stage-névvel; nem maradhat minden hibára „Retry planning”.

M2 v1 nem igényel arbitrary generated code preview-t a web originjén. HTML artifactot nem renderelünk közvetlenül a platform DOM-jába; diff és fájlok escape-elt szövegként jelennek meg. Kódcsomag megtekintése/letöltése elég az első acceptance-hez.

## 12. Konkrét sample acceptance

**Source:** `sample-todo-v1`, kis JS ESM todo-store baseline. Meglévő exportok: createTodo(title), listTodos(); az implementation elején létrehozott fixture ezeket valóban tartalmazza és baseline regression tesztek igazolják. Nem hivatkozunk nem létező, jelenlegi repófájlra: a sample új M2 deliverable.

**Feature task:** „A teendőket lehessen késznek jelölni és visszaállítani. A kész teendőket opcionálisan el lehessen rejteni a listából. Az eredeti create/list működés maradjon meg.”

Acceptance API: `setCompleted(id, completed)` idempotens; nem létező ID egyértelmű hiba; `listTodos({ includeCompleted: false })` elrejti a kész elemeket, alapértelmezésben minden elem megjelenik. Store input/output ownership: a visszaadott objektum külső mutációja nem változtathatja meg a tárolt állapotot. Ezekhez fixed platform acceptance suite készül, readonly módon.

Ez célzott coding-loop próba. Böngészős teendőkezelő, localStorage és UI feladat külön következő sample lehet; M2-t az első modul-feature és a platform saját dashboardján végigvitt folyamat bizonyítja.

Demo Developer csak ezen a fixture-n determinisztikus implementációt/fixet készít; valódi workspacet ír, valódi tests és diff keletkezik. Demo Reviewer kontrollált forgatókönyveket ad (approve, egyszer changes, háromszor changes, block). A felület egyértelmű DEMO jelzésű; ez nem autonóm élő fejlesztés.

Live acceptance: új session, OPENAI Developer tényleges toolhívásokkal módosít; independent validation PASS; külön OPENAI Reviewer érvényes report; ember ellenőrzi és jóváhagyja. A live smoke maximum egy sessiont és legfeljebb három roundot indíthat, explicit módon, engedélyezett worker kulccsal. A parancs lehet `corepack pnpm test:live:m2`; offline tests nem hívnak fizetős API-t. Automatikus emberi jóváhagyást live smoke nem végez.

## 13. Feladatlista — M2

| ID | Feladat | Függőség | Bizonyíték |
|---|---|---|---|
| M2-01 | Baseline ellenőrzés, M1 tesztek/live eredmény egyeztetése, új milestone dokumentum | — | M1 regresszió eredménye; baseline SHA; tényleges live státusz |
| M2-02 | Source registry, sample fixture, policy és immutable snapshot formátum | 01 | Baseline hash determinisztikus; regression suite zöld |
| M2-03 | DockerWorkspaceBackend és stage readiness | 02 | Non-root, RO root, no network/secret/socket, korlátos command |
| M2-04 | File/tool boundary, attempt isolation, cleanup és artifact collector | 03 | Traversal/link/injection/oversize/orphan/stale process tesztek |
| M2-05 | DB migráció és composite/immutable invariánsok | 02 | Meglévő M1 DB migrálható; PLAN approval/history sértetlen |
| M2-06 | Stage workflow, session/round, idempotens START_DEVELOPMENT/final decision | 05 | Versenyhelyzetek és 3-round limit valós DB-teszttel |
| M2-07 | Több queue/outbox dispatcher, agent/validator claims, stage recovery | 04/06 | Duplicate delivery, Redis-vesztés és crash minden stage-en |
| M2-08 | Independent validator, PASS/FAIL/ERROR és fixed acceptance suite | 04/07 | Hibás feature bukik; candidate freeze után nincs módosítás |
| M2-09 | Demo Developer/Reviewer és offline teljes loop | 08 | Valódi fájlváltozás, fix kör, tests, review, final approval |
| M2-10 | Agent definitions, tool-enabled OpenAI Developer, readonly Reviewer | 09 | Installed SDK contractteszt; nincs Product hardcode |
| M2-11 | ModelCall és ToolExecution ledger, többmodell pricing és összesítések | 10 | Több modellhívás teljes accounting; legacy M1 költség nincs duplázva |
| M2-12 | REST/OpenAPI/response contractok és capabilities | 06/11 | Stage-safe DTO-k; auth/CSRF/idempotencia és stale final reject |
| M2-13 | Task UI development/review/diff/checks/final approval/export | 12 | Browser E2E-val valódi API; artifact text escape; régi plan nézet megmarad |
| M2-14 | Crash, cancellation, policy és review-limit regresszió | 07/13 | SIGKILL újrafuttatás, orphan cleanup, nincs kései publish |
| M2-15 | Live M2 smoke és átadási dokumentumok | 14 | Live evidence vagy egyértelmű pending; parancsok tényleges eredménnyel |

M2-01 ellenőrzését és az új agent provider schema bővítését a kódoló Codex a meglévő repo telepített declarationjeivel végzi. Széles dependency major upgrade nem része ennek a mérföldkőnek.

### Kötelező érdemi tesztek

1. M1 planning/approval/immutable history, legacy costs és demo E2E továbbra is működik.
2. PLAN_APPROVED nem indít automatikusan developmentet; dupla develop parancs csak egy session/run/outboxot hoz létre.
3. Developer nem ér el host fájlt, titkot, hálózatot, Docker socketet vagy másik task workdirjét; Reviewer nem ír és nem futtat commandot.
4. Tool path traversal, symlink/hardlink, shell interpolation és oversized log/candidate elutasítva; collector is ellenőriz.
5. Lease elvesztése utáni régi konténer nem ír a következő attempt workspace-ébe és nem publikál snapshotot.
6. Candidate freeze előtt leáll minden írni képes processz; hash ugyanaz validationnél, review-nál és final approvalnál.
7. Baseline-hoz képest a new/deleted/untracked allowed fájlok is bekerülnek a diffbe; üres diff nem lesz ready.
8. Required validation FAIL/timeout/unknown nem enged final approvalt, akkor sem, ha Reviewer APPROVE-ot mond.
9. Round 3 sikertelen review után HUMAN_REVIEW_REQUIRED; nincs negyedik automatikus development job.
10. Retry stage-specifikus: Reviewer infrahiba ugyanazt a candidate-t review-zza; Validator retry nem hív modellt; Developer retry tiszta inputból indul.
11. Cancellation minden aktív stage-en azonnali DB-lezárást és végül processzcleanupot okoz; kései accounting megmarad, kései candidate/review nem jelenik meg.
12. Párhuzamos approve/reject, stale artifact hash, foreign review/validation ID és új taskversion esetén egy döntés vagy 409, nincs téves DONE.
13. SIGKILL workspace prepare, artifact-write/DB-commit határ, validation és review után recovery; Redis jobvesztés és outbox dupla delivery tolerált.
14. Több Responses call usage-ja összeadódik; refusal/failed/late call is számít; unknown call nem ingyenes; M1 fallback nincs duplázva.
15. Container/log garbage collector kizárólag a platformhoz tartozó erőforrást érinti; referenced artifact megmarad újraindításkor.
16. Playwright: plan approve → explicit development → fix round → validation/review → exact final approval → DONE → reload → diff/report/export elérhető.

A concurrency/crash tesztek valódi PostgreSQL/Redis és Docker mellett fussanak, fake model transporttal. A sandbox ellenőrzését mock Docker adapter nem helyettesíti. Live API-hívás külön acceptance bizonyíték, nem offline CI-feltétel.

### Definition of Done

- M2A és M2B valós runtime-on ellenőrzött; minden előírt M1/M2 regresszió sikeres.
- Dashboardról induló demo sample feature valós diffet és valódi validation reportot ad, a code package megmarad reload/restart után.
- OpenAI Developer és Reviewer implementált; legalább egy live feature vagy pontos `LIVE_M2_VALIDATION_PENDING` státusz, indokkal. Pending esetén a teljes live M2 még nem elfogadott.
- Végső emberi döntés az exact candidate-re vonatkozik; nincs automatikus merge/deploy és nincs rejtett negyedik round.
- Typecheck/lint/format/build/backend tests/demo E2E és a sandbox izolációs tesztek tényleges futási eredménye dokumentált.
- README/env example/AGENTS/DECISIONS és `docs/MILESTONE-2.md` frissítve; M1 bizonyítékai történelmileg megmaradnak.

## 14. Használat a kódoló Codexben

Csatold ezt a fájlt a **meglévő ai-company projekthez tartozó Codex beszélgetéshez**, majd másold be az alábbi teljes master promptot. Nem kell kézzel átírni a docs/SPEC.md hivatkozását: ez a prompt kifejezetten a csatolmányra hivatkozik.

Az első Codex-művelet a csatolmány tartalmának `docs/MILESTONE-2-SPEC.md` alá mentése és a meglévő M1 szabályok beolvasása legyen. Az M1 AGENTS.md új milestone külön engedélyezését kéri; ez az M2 implementációs kérés ezt kifejezetten megadja. Nem ad engedélyt M3-ra, GitHub-írásra vagy deployra.

## 15. Codex master prompt — bemásolható

```text
Implement Milestone 2 in the EXISTING ai-company project.

Read the attached M2 implementation specification in full. Save an unchanged
copy as docs/MILESTONE-2-SPEC.md, unless that file already contains this exact
version. Read root/nested AGENTS.md, docs/SPEC.md, docs/DECISIONS.md, and the M1
acceptance record. This request explicitly authorizes M2 development, sandbox
code execution, validation, and Developer/Reviewer integration within the
attached scope. It does not authorize M3, GitHub writes, merge, or deployment.

Baseline reviewed for this pack:
repository varben685/ai-company, branch codex/m1-core-platform,
commit 94c2e42a439ed77a29d76c8d36c3f0ba769ecca2.
Inspect the actual current checkout first. Preserve later/user changes. If it
differs, reconcile the specification against current code and explain any
material incompatibility; do not reset to the reviewed commit.
Create a local codex/m2-development-loop branch from the current working base
when possible, preserving uncommitted work. Do not push without authorization.

Deliver a runnable M2 with:
- a versioned builtin sample-todo-v1 source and real Docker-isolated workspace;
- immutable candidate snapshots, cumulative diffs, and artifact downloads;
- Developer tools for bounded file operations and named commands;
- a separate read-only Reviewer with no write or command capability;
- a trusted non-LLM validator and fixed readonly acceptance tests;
- a deterministic workflow with at most 3 development/validation/review rounds;
- exact-candidate human final approval ending at DONE;
- model-call/tool ledgers, honest costs, and the existing dashboard extended.

Preserve M1. Plan approval still ends at PLAN_APPROVED. Development starts only
through a new explicit command. Existing approved tasks must not auto-run after
migration. Keep Product planning, legacy approvals, immutable history and costs.
Do not re-scaffold the repo or add broad dependency upgrades.

Follow M2-01 through M2-15 in dependency order. Complete M2A workspace/policy
tests before enabling autonomous live execution, then M2B demo, then M2C live.
Use the actual files and extension points listed in the attached specification.

Critical implementation details:
- Expand contracts, transition tables, SQL task_status CHECK, claim/owned gates,
  stage processors, approval target relations, queue routing, response schemas,
  OpenAPI, capabilities, UI active/terminal states, and stage-specific retry.
- Add a forward-only migration. Do not edit the initial migration or rewrite
  immutable records. Preserve composite FKs, partial unique indexes and triggers.
- Reuse DB-authoritative outbox/leases/ownership finalization and command
  receipts. Never hold a DB transaction during an LLM or Docker command.
- Add a separate non-AI validation queue with durable validation records.
- Isolate every Developer attempt in a fresh workdir and container. A stale
  worker must not write into the next attempt or any published candidate.
- Stop all writing processes before collecting/finalizing a candidate.
- Validate/review only frozen immutable bytes. Final approval binds to approved
  plan, baseline, candidate hash, validation, review, policy and task version.
- Serialize ownership checks and transitions. Account for FS/DB publish crashes
  with atomic content-addressed writes and reconciliation; do not pretend FS
  writes and DB writes share one ACID transaction.

Sandbox/tools:
- Use a DockerWorkspaceBackend with unprivileged user, read-only root, network
  none, limited scratch, dropped capabilities, no-new-privileges and CPU/memory/
  PID/time/output limits. Verify with real Docker, not just mocked flags.
- No secrets, host env dumps, SSH agent, host paths, platform repo, Docker
  socket, privileged execution or host networking inside the sandbox.
- Never fall back to host shell when Docker is unavailable.
- Host command execution uses argument arrays and shell:false. Model tools
  receive registered command IDs, not arbitrary shell strings or Docker flags.
- Restrict file paths/types/sizes; defend against traversal, symlink/hardlink,
  archive traversal, and concurrent stale workspace access. Enforce in tools
  AND in the snapshot collector and artifact serving path.
- Reviewer gets a different run/session and readonly capability object. It does
  not inherit the Developer conversation or an editable workspace.
- Independent validation reads the exact snapshot and uses platform-controlled
  acceptance tests. Agent-written claims never decide whether checks passed.

Providers/accounting:
- Keep the small AgentProvider abstraction but remove Product-only schema/input
  hardcoding from shared execution. Define PRODUCT/DEVELOPER/REVIEWER profiles.
- Verify current official OpenAI docs and installed TypeScript declarations;
  do not invent APIs or silently change the SDK major version.
- Use existing @openai/agents tooling with controlled function tools and typed
  outputs. A custom Docker adapter is the runtime boundary; a migration to the
  managed Agents API or SDK SandboxAgent is not required for M2.
- Add separate configurable developer/reviewer models, bounded SDK turns/tools,
  attempt wall-clock limits, no hidden retries, and no silent DEMO fallback.
- The current transport accounting only covers one response. Record EVERY
  model call and sum real usage/cost across tool turns, failures and late calls.
- Preserve unknown usage/prices and legacy M1 accounting without double-counting.
- Demo Developer/Reviewer are fixture-only deterministic adapters that create
  real files and run real validation, visibly labeled DEMO.

Validation/acceptance:
- Keep existing M1 tests as regressions; update only intended new M2 behavior.
- Add the specified real DB/Redis/Docker concurrency, duplicate-delivery,
  cancellation, stale-approval, readonly, orphan cleanup and SIGKILL tests.
- Test that validation failure cannot be overridden by Reviewer APPROVE, that
  round 3 failure ends at HUMAN_REVIEW_REQUIRED, and no fourth job is created.
- Add the API-backed demo Playwright flow through exact final approval and DONE.
- Run corepack pnpm typecheck, lint, format:check, test, build, test:e2e and the
  real sandbox isolation/loop suites. Use isolated DB schemas/queue prefixes.
- Run corepack pnpm test:live:m2 only when authorized local worker credentials
  are available. Never ask for keys in chat. Live smoke leaves human approval
  pending and reports actual changes, validation and separate Reviewer evidence.
- If live credentials/infrastructure are missing, complete all independent work
  and report LIVE_M2_VALIDATION_PENDING or the precise blocker. Do not fabricate
  tests, calls, output, checks or successful autonomous development.

Update README, .env.example, AGENTS.md, DECISIONS.md and docs/MILESTONE-2.md with
setup, commands actually run, migration behavior, results and limitations.
Keep historical M1 acceptance separate; reconcile the user's reported successful
M1 test with the checked-in pending entry using evidence, not invented details.

Begin with a concise implementation plan, then execute it. Continue until the
attached Definition of Done is met or a concrete external blocker remains.
Stay within the builtin sample/local single-operator M2 scope. No GitHub clone/
push/PR, arbitrary repo import, public preview/deployment, marketing, payments,
Research Agent, hard monthly budget claim, or exactly-once LLM claim.
```

## 16. Hivatkozások és döntési határ

Repo evidence a vizsgált commitból:

- [Contracts](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/contracts/src/index.ts), [workflow](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/workflow/src/index.ts).
- [PlatformRepository](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/database/src/index.ts), [WorkerRepository](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/database/src/worker-repository.ts).
- [Agent provider](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/agents/src/index.ts), [initial migration](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/packages/database/prisma/migrations/202610060001_initial/migration.sql).
- [Task UI](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/apps/web/app/tasks/%5Bid%5D/page.tsx), [M1 acceptance](https://github.com/varben685/ai-company/blob/94c2e42a439ed77a29d76c8d36c3f0ba769ecca2/docs/MILESTONE-1.md).

Elsődleges dokumentáció, 2026-10-06-án ellenőrizve:

- OpenAI — [Agent definitions](https://developers.openai.com/api/docs/guides/agents/define-agents): agentdefiníció, function tool és strukturált output.
- OpenAI — [Using tools](https://developers.openai.com/api/docs/guides/tools): alkalmazásoldali tool handler és runtime kapcsolat.
- OpenAI — [Sandbox agents](https://developers.openai.com/api/docs/guides/agents/sandboxes): agent harness és sandbox compute külön felelősség; M2 itt saját adaptert választ.
- Docker — [Container run](https://docs.docker.com/reference/cli/docker/container/run), [none network](https://docs.docker.com/engine/network/drivers/none/), [resource constraints](https://docs.docker.com/engine/containers/resource_constraints): a választott runtime izoláció és limitek alapjai.

A task státuszok, snapshot/fencing policy, source scope, validator pipeline és approval gate a jelen dokumentum saját architekturális döntései. Nem állítjuk, hogy az SDK vagy Docker automatikusan teljesíti a platform összes biztonsági és workflow követelményét.
