-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'CANCELLED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "toAddress" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "deadlineEventAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "activeVersionId" TEXT,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "roundRobinCursor" INTEGER NOT NULL DEFAULT 0,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecution" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "leadId" TEXT,
    "status" "ExecutionStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "skipReason" TEXT,
    "error" TEXT,
    "errorKind" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "manualRetries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecutionStep" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" "StepStatus" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowExecutionStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workflow_organizationId_status_idx" ON "Workflow"("organizationId", "status");

-- CreateIndex
CREATE INDEX "WorkflowVersion_organizationId_trigger_idx" ON "WorkflowVersion"("organizationId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "WorkflowExecution_organizationId_createdAt_idx" ON "WorkflowExecution"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowExecution_organizationId_workflowId_createdAt_idx" ON "WorkflowExecution"("organizationId", "workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowExecution_organizationId_status_idx" ON "WorkflowExecution"("organizationId", "status");

-- CreateIndex
CREATE INDEX "WorkflowExecution_status_nextAttemptAt_idx" ON "WorkflowExecution"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowExecution_versionId_eventId_key" ON "WorkflowExecution"("versionId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowExecutionStep_executionId_stepIndex_key" ON "WorkflowExecutionStep"("executionId", "stepIndex");

-- CreateIndex
CREATE INDEX "WorkflowExecutionStep_organizationId_executionId_idx" ON "WorkflowExecutionStep"("organizationId", "executionId");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecution" ADD CONSTRAINT "WorkflowExecution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecution" ADD CONSTRAINT "WorkflowExecution_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowExecutionStep" ADD CONSTRAINT "WorkflowExecutionStep_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "WorkflowExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security for the new tenant tables (NFR-SEC-01).
ALTER TABLE "Workflow" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Workflow" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "WorkflowVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkflowVersion" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "WorkflowExecution" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkflowExecution" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

ALTER TABLE "WorkflowExecutionStep" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WorkflowExecutionStep" TO datoflow_app
  USING ("organizationId" = current_setting('app.organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.organization_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "Workflow", "WorkflowVersion", "WorkflowExecution", "WorkflowExecutionStep" TO datoflow_app;

-- A saved workflow version never changes (WF-01). Deleting it with its workflow is allowed.
CREATE FUNCTION workflow_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WorkflowVersion is immutable: save a new version instead' USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER workflow_version_immutable
  BEFORE UPDATE ON "WorkflowVersion"
  FOR EACH ROW EXECUTE FUNCTION workflow_version_immutable();

-- Next steps that are already due raised no event before workflows existed. Mark them as done,
-- so the first run of the deadline scan does not fire for every old deadline at once.
UPDATE "Task" SET "deadlineEventAt" = "dueAt" WHERE "status" = 'OPEN' AND "dueAt" <= now();

-- The deadline scan reads open tasks that are due and have not raised their event.
CREATE INDEX "Task_deadline_pending_idx" ON "Task" ("dueAt") WHERE "status" = 'OPEN';
