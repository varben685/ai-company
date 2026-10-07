import type { PrismaClient } from "@company/database";
import { ArtifactStore, DockerWorkspaceBackend } from "@company/workspace";

export async function reconcileWorkspaces(
  db: PrismaClient,
  backend = new DockerWorkspaceBackend(),
  store = new ArtifactStore(),
) {
  const instances = await db.workspaceInstance.findMany({
    where: { status: { not: "CLEANED" } },
    select: { attemptId: true, runId: true, ownerToken: true },
  });
  const live = new Set<string>();
  for (const w of instances) {
    const run = await db.agentRun.findUnique({ where: { id: w.runId } });
    if (
      run?.status === "RUNNING" &&
      run.ownerToken === w.ownerToken &&
      run.leaseUntil &&
      run.leaseUntil > new Date()
    )
      live.add(w.attemptId);
  }
  await backend.reconcileOwnedContainers(live);
  for (const w of instances)
    if (!live.has(w.attemptId)) {
      await backend.cleanupRegistered(w.attemptId);
      await db.workspaceInstance.updateMany({
        where: { attemptId: w.attemptId, status: { not: "CLEANED" } },
        data: { status: "CLEANED", cleanedAt: new Date() },
      });
    }
  const artifacts = await db.agentArtifact.findMany({
    select: { storageKey: true },
  });
  await store.garbageCollect(new Set(artifacts.map((a) => a.storageKey)));
}
