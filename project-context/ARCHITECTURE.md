# Architecture

Strict TypeScript pnpm monorepo. NestJS REST API, Next.js App Router web, separate BullMQ worker, PostgreSQL/Prisma and Redis. Services use repositories; shared deterministic workflow rules own transitions. Transactional commands/outbox, immutable snapshots/plans, fenced lease finalization and composite ownership constraints are required.
