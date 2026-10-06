-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "context" JSONB NOT NULL,
    "contextVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "priorityRank" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "currentPlanId" UUID,
    "approvedPlanId" UUID,
    "activeRunId" UUID,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "agentType" TEXT NOT NULL DEFAULT 'PRODUCT',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "inputSnapshot" JSONB NOT NULL,
    "outputPlanId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "ownerToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunAttempt" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "agentRunId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "ownerToken" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "estimatedCostUsd" DECIMAL(20,8),
    "pricingVersion" TEXT,
    "providerRequestId" TEXT,
    "errorCode" TEXT,

    CONSTRAINT "AgentRunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskPlan" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "agentRunId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contextVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PLAN',
    "targetPlanId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID,
    "agentRunId" UUID,
    "type" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "correlationId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "agentRunId" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PLAN_REQUESTED',
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandReceipt" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_projectId_priorityRank_createdAt_idx" ON "Task"("projectId", "priorityRank", "createdAt");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_projectId_key" ON "Task"("id", "projectId");

-- CreateIndex
CREATE INDEX "AgentRun_status_nextAttemptAt_idx" ON "AgentRun"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_taskId_projectId_key" ON "AgentRun"("id", "taskId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_projectId_key" ON "AgentRun"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunAttempt_ownerToken_key" ON "AgentRunAttempt"("ownerToken");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunAttempt_agentRunId_attemptNumber_key" ON "AgentRunAttempt"("agentRunId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlan_agentRunId_key" ON "TaskPlan"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlan_taskId_versionNumber_key" ON "TaskPlan"("taskId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlan_id_taskId_projectId_key" ON "TaskPlan"("id", "taskId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPlan_id_agentRunId_taskId_projectId_key" ON "TaskPlan"("id", "agentRunId", "taskId", "projectId");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_targetPlanId_type_key" ON "Approval"("targetPlanId", "type");

-- CreateIndex
CREATE INDEX "Event_taskId_createdAt_idx" ON "Event"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_agentRunId_kind_key" ON "OutboxMessage"("agentRunId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CommandReceipt_operation_actorId_key_key" ON "CommandReceipt"("operation", "actorId", "key");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunAttempt" ADD CONSTRAINT "AgentRunAttempt_agentRunId_projectId_fkey" FOREIGN KEY ("agentRunId", "projectId") REFERENCES "AgentRun"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlan" ADD CONSTRAINT "TaskPlan_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskPlan" ADD CONSTRAINT "TaskPlan_agentRunId_taskId_projectId_fkey" FOREIGN KEY ("agentRunId", "taskId", "projectId") REFERENCES "AgentRun"("id", "taskId", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_targetPlanId_taskId_projectId_fkey" FOREIGN KEY ("targetPlanId", "taskId", "projectId") REFERENCES "TaskPlan"("id", "taskId", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_agentRunId_taskId_projectId_fkey" FOREIGN KEY ("agentRunId", "taskId", "projectId") REFERENCES "AgentRun"("id", "taskId", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Composite parent ownership, including cyclic pointers not modeled by Prisma.
ALTER TABLE "Task" ADD CONSTRAINT task_current_plan_fk FOREIGN KEY ("currentPlanId",id,"projectId") REFERENCES "TaskPlan"(id,"taskId","projectId");
ALTER TABLE "Task" ADD CONSTRAINT task_approved_plan_fk FOREIGN KEY ("approvedPlanId",id,"projectId") REFERENCES "TaskPlan"(id,"taskId","projectId");
ALTER TABLE "Task" ADD CONSTRAINT task_active_run_fk FOREIGN KEY ("activeRunId",id,"projectId") REFERENCES "AgentRun"(id,"taskId","projectId");
ALTER TABLE "AgentRun" ADD CONSTRAINT run_output_plan_fk FOREIGN KEY ("outputPlanId",id,"taskId","projectId") REFERENCES "TaskPlan"(id,"agentRunId","taskId","projectId");
ALTER TABLE "Event" ADD CONSTRAINT event_project_fk FOREIGN KEY ("projectId") REFERENCES "Project"(id);
ALTER TABLE "Event" ADD CONSTRAINT event_task_fk FOREIGN KEY ("taskId","projectId") REFERENCES "Task"(id,"projectId");
ALTER TABLE "Event" ADD CONSTRAINT event_run_fk FOREIGN KEY ("agentRunId","taskId","projectId") REFERENCES "AgentRun"(id,"taskId","projectId");
ALTER TABLE "Event" ADD CONSTRAINT event_run_requires_task CHECK ("agentRunId" IS NULL OR "taskId" IS NOT NULL);
CREATE UNIQUE INDEX one_active_run_per_task ON "AgentRun"("taskId") WHERE status IN ('QUEUED','RUNNING');
ALTER TABLE "Task" ADD CONSTRAINT task_status CHECK (status IN ('DRAFT','QUEUED_FOR_PLANNING','PLANNING','WAITING_PLAN_APPROVAL','PLAN_APPROVED','REJECTED','FAILED','CANCELLED'));
ALTER TABLE "Task" ADD CONSTRAINT task_priority CHECK ((priority,"priorityRank") IN (('URGENT',1),('HIGH',2),('NORMAL',3),('LOW',4)));
ALTER TABLE "Task" ADD CONSTRAINT task_version CHECK (version > 0);
ALTER TABLE "TaskPlan" ADD CONSTRAINT plan_version CHECK ("versionNumber" BETWEEN 1 AND 5);
ALTER TABLE "AgentRun" ADD CONSTRAINT run_status CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'));
ALTER TABLE "AgentRun" ADD CONSTRAINT run_attempt_bound CHECK ("attemptCount" BETWEEN 0 AND 3);
ALTER TABLE "AgentRun" ADD CONSTRAINT run_provider CHECK (provider IN ('DEMO','OPENAI'));
ALTER TABLE "AgentRunAttempt" ADD CONSTRAINT attempt_status CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED'));
ALTER TABLE "AgentRunAttempt" ADD CONSTRAINT attempt_number CHECK ("attemptNumber" BETWEEN 1 AND 3);
ALTER TABLE "Approval" ADD CONSTRAINT approval_status CHECK (status IN ('PENDING','APPROVED','CHANGES_REQUESTED','REJECTED','CANCELLED'));
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable record'; END; $$;
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON "TaskPlan" FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER append_only_event BEFORE UPDATE OR DELETE ON "Event" FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON "CommandReceipt" FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE FUNCTION protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."inputSnapshot" IS DISTINCT FROM OLD."inputSnapshot" OR NEW."promptVersion" IS DISTINCT FROM OLD."promptVersion" OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."taskId" IS DISTINCT FROM OLD."taskId" THEN RAISE EXCEPTION 'Immutable run input'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_run_input BEFORE UPDATE ON "AgentRun" FOR EACH ROW EXECUTE FUNCTION protect_snapshot();
