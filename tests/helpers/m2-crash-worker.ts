import {
  PrismaClient,
  PlatformRepository,
  M2WorkerRepository,
} from "@company/database";
import {
  ArtifactStore,
  DockerWorkspaceBackend,
  type Snapshot,
} from "@company/workspace";
import { processDevelopment } from "../../apps/worker/src/m2-processors";

const db = new PrismaClient();
const payload = JSON.parse(process.env.M2_CRASH_PAYLOAD ?? "{}") as {
  projectId: string;
  taskId: string;
  agentRunId: string;
  validationRunId?: string;
};
const stage = new M2WorkerRepository(
  new PlatformRepository(db, "DEMO", null),
  1000,
);
const store = new ArtifactStore();
const backend = new DockerWorkspaceBackend();
async function main() {
  await db.$connect();
  if (process.env.M2_CRASH_STAGE === "ARTIFACT_PUBLISHED") {
    class CrashStore extends ArtifactStore {
      override async publish(snapshot: Snapshot) {
        const artifact = await super.publish(snapshot);
        process.send?.({ storageKey: artifact.storageKey }, () =>
          process.kill(process.pid, "SIGKILL"),
        );
        await new Promise<never>(() => undefined);
        return artifact;
      }
    }
    await processDevelopment(payload, stage, backend, new CrashStore());
    return;
  }
  if (process.env.M2_CRASH_STAGE === "VALIDATION") {
    const claim = await stage.claimValidation({
      projectId: payload.projectId,
      taskId: payload.taskId,
      validationRunId: payload.validationRunId!,
    });
    if (!claim) throw Error("VALIDATION_CLAIM_MISSING");
    setInterval(() => void stage.heartbeatValidation(claim), 200);
    process.send?.({ validationRunId: payload.validationRunId });
    return;
  }
  if (process.env.M2_CRASH_STAGE === "REVIEWER") {
    const claim = await stage.claimAgent(payload, "REVIEWER");
    if (!claim) throw Error("REVIEW_CLAIM_MISSING");
    setInterval(() => void stage.heartbeatAgent(claim), 200);
    process.send?.({ attemptId: claim.attemptId });
    return;
  }
  const claim = await stage.claimAgent(payload, "DEVELOPER");
  if (!claim) throw Error("CLAIM_MISSING");
  const session = await db.developmentSession.findUniqueOrThrow({
    where: { id: claim.sessionId },
  });
  const artifact = await db.agentArtifact.findUniqueOrThrow({
    where: { id: session.baselineArtifactId! },
  });
  const snapshot = await store.read(artifact.storageKey, artifact.hash);
  const handle = await backend.prepareAttempt({
    attemptId: claim.attemptId,
    token: claim.token,
    snapshot,
    owned: async () => {
      const run = await db.agentRun.findUnique({
        where: { id: payload.agentRunId },
      });
      return (
        run?.ownerToken === claim.token &&
        run.leaseUntil !== null &&
        run.leaseUntil > new Date()
      );
    },
  });
  await stage.workspaceActive(claim);
  setInterval(() => void stage.heartbeatAgent(claim), 200);
  process.send?.({ attemptId: claim.attemptId, container: handle.container });
}
void main().catch(() => process.exit(1));
