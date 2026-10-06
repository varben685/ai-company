# AI Company engineering rules

Read `docs/SPEC.md` before changing behavior. This repository currently implements **M1 only**. Preserve unrelated work. Do not implement development, code execution, repository/GitHub integration, research, or deployment without a separately authorized milestone.

- Use strict TypeScript and pinned pnpm dependencies. Commit the lockfile with dependency changes.
- Controllers handle HTTP routing only. Services validate and serialize contracts; repositories own persistence and transactional commands. Shared workflow rules are authoritative in both API and worker.
- Keep task input snapshots, plans, command receipts and audit events immutable. Preserve composite foreign keys and partial unique indexes in migrations.
- All planning/approval commands are transactional and idempotent. Never move an external call into a database transaction.
- Worker writes require an active run, matching task/project, live lease and ownership token. Retain attempt records and known costs after failure/cancellation. Never claim exactly-once provider execution.
- The Product Agent has no tools or authority to approve, mutate workflow, or grant permissions. Do not invent SDK APIs. Verify current official docs and installed declarations when changing the adapter.
- `.env`, `.env.worker`, `.local/` and credentials must remain ignored. Never print secrets, full environment dumps, provider payloads or chain-of-thought. Keep OpenAI keys in the worker only.
- Bind local processes and Compose ports to loopback. Do not change host configuration or deploy publicly to work around setup issues.
- Run `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`, and `corepack pnpm test:e2e` for workflow changes. Tests must use isolated schemas/queue prefixes and real PostgreSQL/Redis for concurrency.
- `corepack pnpm test:live` is an explicitly identified paid smoke test only when authorized credentials are present. Offline tests must never invoke a paid model. Report live validation separately.
- Update `docs/MILESTONE-1.md` with commands actually executed. Pending live validation is not full live-AI acceptance.
