# AI Company engineering rules

Read `docs/SPEC.md` and `docs/MILESTONE-2-SPEC.md` before changing behavior. This repository implements **M1 and M2**. Preserve unrelated work. M2 permits only the versioned local sample workspace and its bounded Developer/Reviewer loop. Do not add GitHub integration, arbitrary repository execution, research, merge, deployment, or M3 behavior without separate authorization.

- Use strict TypeScript and pinned pnpm dependencies. Commit the lockfile with dependency changes.
- Controllers handle HTTP routing only. Services validate and serialize contracts; repositories own persistence and transactional commands. Shared workflow rules are authoritative in both API and worker.
- Keep task input snapshots, plans, command receipts and audit events immutable. Preserve composite foreign keys and partial unique indexes in migrations.
- All planning/approval commands are transactional and idempotent. Never move an external call into a database transaction.
- Worker writes require an active run, matching task/project, live lease and ownership token. Retain attempt records and known costs after failure/cancellation. Never claim exactly-once provider execution.
- Agents have no authority to approve, mutate workflow, or grant permissions. Product has no tools; Developer has only registered sample workspace tools and named commands; Reviewer has readonly tools. Verify current official docs and installed declarations when changing the adapter.
- M2 candidate publication requires an owned live lease, stopped workspace, bounded file collector, frozen artifact hash, independent validator result and separate review. Never trust an agent's check claim as validation evidence. Three review rounds is a hard limit.
- `.env`, `.env.worker`, `.local/` and credentials must remain ignored. Never print secrets, full environment dumps, provider payloads or chain-of-thought. Keep OpenAI keys in the worker only.
- Bind local processes and Compose ports to loopback. Do not change host configuration or deploy publicly to work around setup issues.
- Run `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`, and `corepack pnpm test:e2e` for workflow changes. Tests must use isolated schemas/queue prefixes and real PostgreSQL/Redis for concurrency.
- `corepack pnpm test:live` and `corepack pnpm test:live:m2` are explicitly identified paid smoke tests only when authorized credentials are present. Offline tests must never invoke a paid model. Human plan and final code approvals must remain human actions. Report live validation separately.
- Update `docs/MILESTONE-1.md` with commands actually executed. Pending live validation is not full live-AI acceptance.
