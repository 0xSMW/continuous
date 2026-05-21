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
const systemsWorker = {
  role: "systems_operations",
  tenantSlug,
};
const seededConnectionId = "78787878-7878-4787-8787-787878787878";

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

function expectGeneratedIds(result: JsonRecord, fields: string[]) {
  for (const field of fields) {
    expectGeneratedId(result[field]);
  }
}

function expectReplayIds(first: JsonRecord, replay: JsonRecord, fields: string[]) {
  expect(replay.created).toBe(false);
  expect(replay.idempotencyKey).toBe(first.idempotencyKey);

  for (const field of fields) {
    expect(stringValue(replay[field])).toBe(stringValue(first[field]));
  }
}

function expectRecordForId(records: unknown, idField: string, id: unknown) {
  const expectedId = stringValue(id);
  const found = arrayValue(records).some((record) => stringValue(objectValue(record)[idField]) === expectedId);

  expect(found).toBe(true);
}

maybeDescribe("Systems Operations Worker integration", () => {
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

  it("plans sync repair through the app-server worker envelope and replays idempotently", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-systems-sync-repair-${runId}`;
    const repairConfig = {
      connectionId: seededConnectionId,
      issueId: `sync-lag-${runId}`,
      issue: {
        kind: "sync_lag",
        severity: "high",
        detectedAt: "2026-05-21T00:00:00.000Z",
      },
      severity: "high",
      strategy: "dry_run_then_approval",
      checks: ["snapshot", "receipt", "rollback"],
      sourceRefs: {
        cursor: "orders:2026-05-20T00:00:00.000Z",
      },
      rollback: {
        strategy: "restore_previous_cursor",
        owner: "owner@continuoushq.com",
      },
    };

    const response = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "sync.repair.plan",
      worker: systemsWorker,
      idempotencyKey,
      config: repairConfig,
    });
    const envelope = objectValue(response);
    const result = objectValue(envelope.result);
    const output = objectValue(result.output);
    const repairIds = [
      "workerRunId",
      "taskId",
      "eventId",
      "packetId",
      "documentId",
      "approvalRequestId",
      "adapterRunId",
      "adapterActionId",
      "evidenceId",
      "receiptEvidenceId",
      "generatedViewId",
    ];

    expect(envelope.command).toBe("sync.repair.plan");
    expect(objectValue(envelope.worker).role).toBe("systems_operations");
    expect(objectValue(envelope.worker).tenantSlug).toBe(tenantSlug);
    expect(result.created).toBe(true);
    expectGeneratedIds(result, repairIds);
    expect(result.externalExecution).toBe("dry_run");
    expect(output.externalExecution).toBe("dry_run");
    expect(output.externalMutation).toBe(false);
    expect(objectValue(output.connection).id).toBe(seededConnectionId);
    expect(objectValue(output.repairPlan).liveMutation).toBe(false);
    expect(objectValue(objectValue(output.repairPlan).rollback).required).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(result.workerRunId)))
      .limit(1);
    const workerRunData = objectValue(workerRun?.data);
    const completion = objectValue(workerRunData.completion);
    const completionBudget = objectValue(completion.budget);
    const [reservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, stringValue(output.budgetReservationId)))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, stringValue(output.usageEventId)))
      .limit(1);
    const [localRun] = await db
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.worker"),
          eq(workerRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    expect(workerRun?.source).toBe("continuous.core.worker_runs");
    expect(objectValue(workerRunData.input).command).toBe("sync.repair.plan");
    expect(completionBudget.state).toBe("used");
    expect(completionBudget.reservationId).toBe(output.budgetReservationId);
    expect(completionBudget.usageEventId).toBe(output.usageEventId);
    expect(reservation?.state).toBe("used");
    expect(usage?.reservationId).toBe(output.budgetReservationId);
    expect(usage?.taskId).toBe(result.taskId);
    expect(localRun).toBeUndefined();

    const replayResponse = await executeWorkerCommand({
      command: "sync.repair.plan",
      target: systemsWorker,
      operatorEmail,
      idempotencyKey,
      config: repairConfig,
    });
    const replay = objectValue(replayResponse.result);

    expectReplayIds(result, replay, repairIds);

    const snapshot = await executeWorkerView({
      view: "snapshot",
      target: systemsWorker,
      operatorEmail,
      config: {},
    });
    const snapshotData = objectValue(snapshot.data.snapshot);

    expect(snapshot.error).toBeNull();
    expect(snapshot.data.view).toBe("snapshot");
    expect(snapshot.data.worker.role).toBe("systems_operations");
    expect(objectValue(snapshotData.controls).externalExecution).toBe("blocked");
    expect(objectValue(snapshotData.controls).repairExecution).toBe("dry_run");
    expectRecordForId(snapshotData.repairs, "id", result.adapterRunId);

    const repairs = await executeWorkerView({
      view: "repairs",
      target: systemsWorker,
      operatorEmail,
      config: {},
    });
    const repairsData = objectValue(repairs.data.repairs);

    expect(repairs.error).toBeNull();
    expect(repairs.data.view).toBe("repairs");
    expect(objectValue(repairsData.controls).externalExecution).toBe("blocked");
    expect(objectValue(repairsData.controls).repairExecution).toBe("dry_run");
    expectRecordForId(repairsData.repairs, "id", result.adapterRunId);
  }, 120_000);

  it("reviews permissions through the registry worker command and keeps external execution blocked", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-systems-permission-review-${runId}`;
    const permissionConfig = {
      connectionId: seededConnectionId,
      requestedScopes: ["lead.read", "payment.write", "admin.full_access"],
      expectedScopes: ["lead.read"],
      policy: {
        desiredScopes: ["lead.read"],
        blockedScopes: ["payment.write", "admin.full_access"],
      },
      sourceRefs: {
        reviewer: operatorEmail,
        reason: "Owner asked whether the website connector has drifted again.",
      },
    };

    const response = await executeWorkerCommand({
      command: "permission.review",
      target: systemsWorker,
      operatorEmail,
      idempotencyKey,
      config: permissionConfig,
    });
    const result = objectValue(response.result);
    const output = objectValue(result.output);
    const permissionIds = [
      "workerRunId",
      "taskId",
      "eventId",
      "packetId",
      "documentId",
      "approvalRequestId",
      "adapterRunId",
      "adapterActionId",
      "evidenceId",
      "receiptEvidenceId",
      "generatedViewId",
    ];

    expect(response.command).toBe("permission.review");
    expect(response.worker.role).toBe("systems_operations");
    expect(response.worker.tenantSlug).toBe(tenantSlug);
    expect(result.created).toBe(true);
    expectGeneratedIds(result, permissionIds);
    expect(result.externalExecution).toBe("blocked");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalMutation).toBe(false);
    expect(objectValue(output.connection).id).toBe(seededConnectionId);
    expect(arrayValue(output.requestedScopes)).toEqual(
      expect.arrayContaining(["payment.write", "admin.full_access"]),
    );
    expect(arrayValue(output.expectedScopes)).toEqual(["lead.read"]);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(result.workerRunId)))
      .limit(1);
    const workerRunData = objectValue(workerRun?.data);
    const completionBudget = objectValue(objectValue(workerRunData.completion).budget);
    const [reservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, stringValue(output.budgetReservationId)))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, stringValue(output.usageEventId)))
      .limit(1);
    const [localRun] = await db
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.worker"),
          eq(workerRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    expect(workerRun?.source).toBe("continuous.core.worker_runs");
    expect(objectValue(workerRunData.input).command).toBe("permission.review");
    expect(completionBudget.state).toBe("used");
    expect(completionBudget.reservationId).toBe(output.budgetReservationId);
    expect(completionBudget.usageEventId).toBe(output.usageEventId);
    expect(reservation?.state).toBe("used");
    expect(usage?.reservationId).toBe(output.budgetReservationId);
    expect(usage?.taskId).toBe(result.taskId);
    expect(localRun).toBeUndefined();

    const replayResponse = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "permission.review",
      worker: systemsWorker,
      idempotencyKey,
      config: permissionConfig,
    });
    const replay = objectValue(objectValue(replayResponse).result);

    expectReplayIds(result, replay, permissionIds);

    const snapshot = await executeWorkerView({
      view: "snapshot",
      target: systemsWorker,
      operatorEmail,
      config: {},
    });
    const snapshotData = objectValue(snapshot.data.snapshot);

    expect(snapshot.error).toBeNull();
    expect(objectValue(snapshotData.controls).externalExecution).toBe("blocked");
    expect(objectValue(snapshotData.controls).repairExecution).toBe("dry_run");
    expect(objectValue(snapshotData.latestRun).workerRunId).toBe(result.workerRunId);

    const repairs = await executeWorkerView({
      view: "repairs",
      target: systemsWorker,
      operatorEmail,
      config: {},
    });
    const repairsData = objectValue(repairs.data.repairs);

    expect(repairs.error).toBeNull();
    expect(objectValue(repairsData.controls).externalExecution).toBe("blocked");
    expect(objectValue(repairsData.controls).repairExecution).toBe("dry_run");
    expect(Array.isArray(repairsData.repairs)).toBe(true);
  }, 120_000);
});
