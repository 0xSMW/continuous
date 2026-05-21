import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../db/client";
import { budgetReservations, usageEvents, workerRuns } from "../db/schema";
import { executeAppServerWorkerTool } from "./app-server-tools";
import { executeWorkerCommand, executeWorkerView } from "./registry";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;
const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

const tenantSlug = "continuous-demo";
const operatorEmail = "owner@continuoushq.com";
const customerExperienceWorker = {
  role: "customer_experience_operations",
  tenantSlug,
};
const seedIds = {
  customerObject: "33333333-3333-4333-8333-000000000001",
  complaintObject: "33333333-3333-4333-8333-000000000010",
  quotePacket: "88888888-8888-4888-8888-000000000007",
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function expectGeneratedId(value: unknown) {
  expect(stringValue(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

maybeDescribe("Customer Experience Worker integration", () => {
  beforeAll(() => {
    process.env.APP_ENV = "test";
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    process.env.WORKER_OPERATOR_EMAIL = operatorEmail;

    execFileSync("bun", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    execFileSync("bun", ["run", "db:seed"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }, 120_000);

  afterAll(async () => {
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }

    if (originalTrustedLocalWorkerTools === undefined) {
      delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
    } else {
      process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = originalTrustedLocalWorkerTools;
    }

    if (originalWorkerOperatorEmail === undefined) {
      delete process.env.WORKER_OPERATOR_EMAIL;
    } else {
      process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail;
    }

    await pool.end();
  });

  it("prepares a customer recovery draft through the app-server worker envelope", async () => {
    const idempotencyKey = `ci-customer-recovery-${randomUUID()}`;
    const config = {
      sourceRefs: {
        customerObjectId: seedIds.customerObject,
        customerSignalObjectId: seedIds.complaintObject,
        evidencePacketId: seedIds.quotePacket,
      },
      policy: {
        tone: "calm",
        channel: "email",
        requiresOwnerApproval: true,
        allowExternalSend: false,
      },
    };

    const response = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "recovery.draft",
      worker: customerExperienceWorker,
      idempotencyKey,
      config,
    });
    const envelope = objectValue(response);
    const result = objectValue(envelope.result);
    const output = objectValue(result.output);

    expect(envelope.command).toBe("recovery.draft");
    expect(objectValue(envelope.worker).role).toBe("customer_experience_operations");
    expect(result.created).toBe(true);
    for (const field of [
      "workerRunId",
      "taskId",
      "eventId",
      "recoveryObjectId",
      "customerSignalId",
      "signalObjectId",
      "customerObjectId",
      "approvalRequestId",
      "evidenceId",
      "packetId",
      "documentId",
      "workflowRunId",
      "signalsViewId",
    ]) {
      expectGeneratedId(result[field]);
    }
    expect(arrayValue(result.workflowStepIds)).toHaveLength(3);
    expect(result.externalExecution).toBe("blocked");
    expect(result.externalSend).toBe(false);
    expect(objectValue(output.handoff).name).toBe("customer.signal_to_experience");
    expect(objectValue(output.draft).externalSend).toBe(false);
    expect(objectValue(output.policy).customerSend).toBe("blocked");

    const [run] = await db.select().from(workerRuns).where(eq(workerRuns.id, stringValue(result.workerRunId))).limit(1);
    const runData = objectValue(run?.data);
    const runBudget = objectValue(runData.budget);
    const runCompletion = objectValue(runData.completion);
    const [localDuplicate] = await db
      .select({ id: workerRuns.id })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.idempotencyKey, idempotencyKey),
          eq(workerRuns.source, "continuous.worker"),
        ),
      )
      .limit(1);
    const [reservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, stringValue(runBudget.reservationId)))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.reservationId, stringValue(runBudget.reservationId)))
      .limit(1);

    expect(run?.source).toBe("continuous.core.worker_runs");
    expect(run?.state).toBe("done");
    expect(run?.taskId).toBe(result.taskId);
    expect(runCompletion.state).toBe("done");
    expect(objectValue(runCompletion.output).recoveryObjectId).toBe(result.recoveryObjectId);
    expect(localDuplicate).toBeUndefined();
    expect(reservation?.state).toBe("used");
    expect(usage?.actorType).toBe("worker");
    expect(usage?.actorId).toBe(objectValue(runCompletion.worker).id);

    const view = await executeWorkerView({
      view: "signals",
      target: customerExperienceWorker,
      operatorEmail,
      config: {
        severity: "medium",
      },
    });
    const signals = objectValue(view.data.signals);

    expect(view.error).toBeNull();
    expect(view.data.view).toBe("signals");
    expect(objectValue(signals.controls).customerSend).toBe("blocked");
    expect(arrayValue(signals.signals).some((signal) => objectValue(signal).objectId === seedIds.complaintObject)).toBe(true);
    expect(arrayValue(signals.recoveryDrafts).some((draft) => objectValue(draft).id === result.recoveryObjectId)).toBe(true);

    const replayResponse = await executeWorkerCommand({
      command: "recovery.draft",
      target: customerExperienceWorker,
      operatorEmail,
      idempotencyKey,
      config,
    });
    const replay = objectValue(replayResponse.result);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(result.workerRunId);
    expect(replay.recoveryObjectId).toBe(result.recoveryObjectId);
    expect(replay.signalsViewId).toBe(result.signalsViewId);
  });
});
