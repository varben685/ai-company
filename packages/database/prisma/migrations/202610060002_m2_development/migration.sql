-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "workspaceSourceId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "activeValidationId" UUID,
ADD COLUMN     "developmentSessionId" UUID,
ADD COLUMN     "failureStage" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "inputCandidateHash" TEXT,
ADD COLUMN     "outputArtifactId" UUID,
ADD COLUMN     "round" INTEGER,
ADD COLUMN     "sessionId" UUID;

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "targetArtifactId" UUID,
ADD COLUMN     "targetSnapshot" JSONB,
ALTER COLUMN "targetPlanId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "validationRunId" UUID,
ALTER COLUMN "agentRunId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DevelopmentSession" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "approvedPlanId" UUID NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "baselineHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "baselineArtifactId" UUID,
    "currentRound" INTEGER NOT NULL DEFAULT 1,
    "currentCandidateId" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevelopmentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInstance" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "ownerToken" UUID NOT NULL,
    "workdirKey" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentArtifact" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "producerRunId" UUID,
    "attemptId" UUID,
    "round" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshotHash" TEXT,
    "byteSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "candidateArtifactId" UUID NOT NULL,
    "candidateHash" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "ownerToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "report" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCall" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "agentRunId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT,
    "responseId" TEXT,
    "providerRequestId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(20,8),
    "pricingVersion" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "agentRunId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "callId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inputSummary" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "outputHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentSession_taskId_key" ON "DevelopmentSession"("taskId");

-- CreateIndex
CREATE INDEX "DevelopmentSession_projectId_taskId_idx" ON "DevelopmentSession"("projectId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentSession_id_taskId_projectId_key" ON "DevelopmentSession"("id", "taskId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInstance_attemptId_key" ON "WorkspaceInstance"("attemptId");

-- CreateIndex
CREATE INDEX "WorkspaceInstance_status_createdAt_idx" ON "WorkspaceInstance"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentArtifact_sessionId_round_kind_idx" ON "AgentArtifact"("sessionId", "round", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AgentArtifact_id_taskId_projectId_sessionId_key" ON "AgentArtifact"("id", "taskId", "projectId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentArtifact_producerRunId_kind_key" ON "AgentArtifact"("producerRunId", "kind");

-- CreateIndex
CREATE INDEX "ValidationRun_status_nextAttemptAt_idx" ON "ValidationRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ValidationRun_id_taskId_projectId_key" ON "ValidationRun"("id", "taskId", "projectId");

-- CreateIndex
CREATE INDEX "ModelCall_agentRunId_idx" ON "ModelCall"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCall_attemptId_sequence_key" ON "ModelCall"("attemptId", "sequence");

-- CreateIndex
CREATE INDEX "ToolExecution_agentRunId_idx" ON "ToolExecution"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolExecution_attemptId_callId_key" ON "ToolExecution"("attemptId", "callId");


-- Forward-only M2 invariants. Existing M1 plans, approvals and receipts are untouched.
ALTER TABLE "Task" DROP CONSTRAINT task_status;
ALTER TABLE "Task" ADD CONSTRAINT task_status CHECK (status IN (
 'DRAFT','QUEUED_FOR_PLANNING','PLANNING','WAITING_PLAN_APPROVAL','PLAN_APPROVED',
 'QUEUED_FOR_IMPLEMENTATION','IMPLEMENTING','QUEUED_FOR_VALIDATION','VALIDATING',
 'QUEUED_FOR_REVIEW','REVIEWING','WAITING_FINAL_APPROVAL','HUMAN_REVIEW_REQUIRED',
 'BLOCKED','DONE','REJECTED','FAILED','CANCELLED'));
ALTER TABLE "Project" ADD CONSTRAINT project_workspace_source CHECK ("workspaceSourceId" IS NULL OR "workspaceSourceId" = 'sample-todo-v1');
ALTER TABLE "Task" ADD CONSTRAINT task_failure_stage CHECK ("failureStage" IS NULL OR "failureStage" IN ('PRODUCT','DEVELOPER','VALIDATION','REVIEWER'));
ALTER TABLE "AgentRun" ADD CONSTRAINT run_agent_type CHECK ("agentType" IN ('PRODUCT','DEVELOPER','REVIEWER'));
ALTER TABLE "AgentRun" ADD CONSTRAINT run_round CHECK (("agentType"='PRODUCT' AND "sessionId" IS NULL AND "round" IS NULL) OR ("agentType" IN ('DEVELOPER','REVIEWER') AND "sessionId" IS NOT NULL AND "round" BETWEEN 1 AND 3));
ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_round CHECK ("currentRound" BETWEEN 1 AND 3);
ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_status CHECK (status IN ('ACTIVE','DONE','BLOCKED','HUMAN_REVIEW_REQUIRED','FAILED','CANCELLED','REJECTED'));
ALTER TABLE "AgentArtifact" ADD CONSTRAINT artifact_kind CHECK (kind IN ('BASELINE','CANDIDATE','DIFF','REVIEW_REPORT','COMMAND_LOG'));
ALTER TABLE "AgentArtifact" ADD CONSTRAINT artifact_round CHECK (round BETWEEN 0 AND 3 AND "byteSize" >= 0);
ALTER TABLE "ValidationRun" ADD CONSTRAINT validation_status CHECK (status IN ('QUEUED','RUNNING','PASS','FAIL','ERROR','CANCELLED'));
ALTER TABLE "ValidationRun" ADD CONSTRAINT validation_attempt_bound CHECK ("attemptCount" BETWEEN 0 AND 3);
CREATE UNIQUE INDEX one_active_validation_per_task ON "ValidationRun"("taskId") WHERE status IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX one_baseline_per_session ON "AgentArtifact"("sessionId") WHERE kind='BASELINE';
CREATE UNIQUE INDEX "AgentRunAttempt_id_agentRunId_projectId_key" ON "AgentRunAttempt"(id,"agentRunId","projectId");
CREATE UNIQUE INDEX "AgentArtifact_id_taskId_projectId_sessionId_hash_key" ON "AgentArtifact"(id,"taskId","projectId","sessionId",hash);
CREATE UNIQUE INDEX "AgentArtifact_id_taskId_projectId_key" ON "AgentArtifact"(id,"taskId","projectId");
CREATE UNIQUE INDEX "ValidationRun_id_taskId_projectId_sessionId_key" ON "ValidationRun"(id,"taskId","projectId","sessionId");

ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_task_fk FOREIGN KEY ("taskId","projectId") REFERENCES "Task"(id,"projectId");
ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_plan_fk FOREIGN KEY ("approvedPlanId","taskId","projectId") REFERENCES "TaskPlan"(id,"taskId","projectId");
ALTER TABLE "Task" ADD CONSTRAINT task_development_session_fk FOREIGN KEY ("developmentSessionId",id,"projectId") REFERENCES "DevelopmentSession"(id,"taskId","projectId");
ALTER TABLE "AgentRun" ADD CONSTRAINT run_session_fk FOREIGN KEY ("sessionId","taskId","projectId") REFERENCES "DevelopmentSession"(id,"taskId","projectId");
ALTER TABLE "WorkspaceInstance" ADD CONSTRAINT workspace_session_fk FOREIGN KEY ("sessionId","taskId","projectId") REFERENCES "DevelopmentSession"(id,"taskId","projectId");
ALTER TABLE "WorkspaceInstance" ADD CONSTRAINT workspace_run_fk FOREIGN KEY ("runId","taskId","projectId") REFERENCES "AgentRun"(id,"taskId","projectId");
ALTER TABLE "WorkspaceInstance" ADD CONSTRAINT workspace_attempt_fk FOREIGN KEY ("attemptId","runId","projectId") REFERENCES "AgentRunAttempt"(id,"agentRunId","projectId");
ALTER TABLE "AgentArtifact" ADD CONSTRAINT artifact_session_fk FOREIGN KEY ("sessionId","taskId","projectId") REFERENCES "DevelopmentSession"(id,"taskId","projectId");
ALTER TABLE "AgentArtifact" ADD CONSTRAINT artifact_run_fk FOREIGN KEY ("producerRunId","taskId","projectId") REFERENCES "AgentRun"(id,"taskId","projectId");
ALTER TABLE "AgentArtifact" ADD CONSTRAINT artifact_attempt_fk FOREIGN KEY ("attemptId","producerRunId","projectId") REFERENCES "AgentRunAttempt"(id,"agentRunId","projectId");
ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_baseline_fk FOREIGN KEY ("baselineArtifactId","taskId","projectId","id") REFERENCES "AgentArtifact"(id,"taskId","projectId","sessionId");
ALTER TABLE "DevelopmentSession" ADD CONSTRAINT development_current_candidate_fk FOREIGN KEY ("currentCandidateId","taskId","projectId","id") REFERENCES "AgentArtifact"(id,"taskId","projectId","sessionId");
ALTER TABLE "AgentRun" ADD CONSTRAINT run_output_artifact_fk FOREIGN KEY ("outputArtifactId","taskId","projectId","sessionId") REFERENCES "AgentArtifact"(id,"taskId","projectId","sessionId");
ALTER TABLE "ValidationRun" ADD CONSTRAINT validation_session_fk FOREIGN KEY ("sessionId","taskId","projectId") REFERENCES "DevelopmentSession"(id,"taskId","projectId");
ALTER TABLE "ValidationRun" ADD CONSTRAINT validation_candidate_fk FOREIGN KEY ("candidateArtifactId","taskId","projectId","sessionId","candidateHash") REFERENCES "AgentArtifact"(id,"taskId","projectId","sessionId",hash);
ALTER TABLE "Task" ADD CONSTRAINT task_active_validation_fk FOREIGN KEY ("activeValidationId",id,"projectId") REFERENCES "ValidationRun"(id,"taskId","projectId");
ALTER TABLE "Approval" ADD CONSTRAINT approval_target_artifact_fk FOREIGN KEY ("targetArtifactId","taskId","projectId") REFERENCES "AgentArtifact"(id,"taskId","projectId");
ALTER TABLE "Approval" ADD CONSTRAINT approval_target_kind CHECK ((type='PLAN' AND "targetPlanId" IS NOT NULL AND "targetArtifactId" IS NULL AND "targetSnapshot" IS NULL) OR (type='FINAL_CODE' AND "targetPlanId" IS NULL AND "targetArtifactId" IS NOT NULL AND "targetSnapshot" IS NOT NULL));
CREATE UNIQUE INDEX one_final_approval_per_artifact ON "Approval"("targetArtifactId") WHERE type='FINAL_CODE';
ALTER TABLE "OutboxMessage" ADD CONSTRAINT outbox_validation_fk FOREIGN KEY ("validationRunId","taskId","projectId") REFERENCES "ValidationRun"(id,"taskId","projectId");
ALTER TABLE "OutboxMessage" ADD CONSTRAINT outbox_target_kind CHECK ((kind IN ('PLAN_REQUESTED','DEVELOPMENT_REQUESTED','REVIEW_REQUESTED') AND "agentRunId" IS NOT NULL AND "validationRunId" IS NULL) OR (kind='VALIDATION_REQUESTED' AND "agentRunId" IS NULL AND "validationRunId" IS NOT NULL));
CREATE UNIQUE INDEX one_validation_outbox ON "OutboxMessage"("validationRunId",kind) WHERE "validationRunId" IS NOT NULL;
ALTER TABLE "ModelCall" ADD CONSTRAINT model_call_attempt_fk FOREIGN KEY ("attemptId","agentRunId","projectId") REFERENCES "AgentRunAttempt"(id,"agentRunId","projectId");
ALTER TABLE "ToolExecution" ADD CONSTRAINT tool_execution_attempt_fk FOREIGN KEY ("attemptId","agentRunId","projectId") REFERENCES "AgentRunAttempt"(id,"agentRunId","projectId");

CREATE TRIGGER immutable_artifact BEFORE UPDATE OR DELETE ON "AgentArtifact" FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_tool_execution BEFORE UPDATE OR DELETE ON "ToolExecution" FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE FUNCTION protect_validation_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN ('PASS','FAIL','ERROR','CANCELLED') THEN RAISE EXCEPTION 'Immutable validation result'; END IF;
 IF NEW."candidateArtifactId" IS DISTINCT FROM OLD."candidateArtifactId" OR NEW."candidateHash" IS DISTINCT FROM OLD."candidateHash" OR NEW."validatorVersion" IS DISTINCT FROM OLD."validatorVersion" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW.round IS DISTINCT FROM OLD.round THEN RAISE EXCEPTION 'Immutable validation input'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_validation_report BEFORE UPDATE ON "ValidationRun" FOR EACH ROW EXECUTE FUNCTION protect_validation_report();
CREATE FUNCTION protect_model_call() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status <> 'STARTED' THEN RAISE EXCEPTION 'Immutable model call'; END IF;
 IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId" OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW."agentRunId" IS DISTINCT FROM OLD."agentRunId" THEN RAISE EXCEPTION 'Immutable model call parent'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_model_call BEFORE UPDATE ON "ModelCall" FOR EACH ROW EXECUTE FUNCTION protect_model_call();
CREATE OR REPLACE FUNCTION protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."inputSnapshot" IS DISTINCT FROM OLD."inputSnapshot" OR NEW."promptVersion" IS DISTINCT FROM OLD."promptVersion" OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."taskId" IS DISTINCT FROM OLD."taskId" OR NEW."agentType" IS DISTINCT FROM OLD."agentType" OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW.round IS DISTINCT FROM OLD.round OR NEW."inputCandidateHash" IS DISTINCT FROM OLD."inputCandidateHash" THEN RAISE EXCEPTION 'Immutable run input'; END IF;
 RETURN NEW;
END; $$;
