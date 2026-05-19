import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileAdapterLedger } from "../core/adapters";
import { createCoreTask } from "../core/tasks";
import { db, pool } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  auditEvents,
  connections,
  events,
  evaluations,
  evidence,
  tasks,
  workerRuns,
  type JsonObject,
} from "../db/schema";
import { revenueWorkerEvalCases, scoreRevenueWorkerRun } from "./evals";
import { runRevenueWorker } from "./revenue";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

maybeDescribe("Revenue Worker integration eval", () => {
  beforeAll(() => {
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
    await pool.end();
  });

  it("creates headless core tasks with event and audit proof", async () => {
    const idempotencyKey = `ci-core-task-${randomUUID()}`;
    const first = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      title: "Review agency notice packet",
      priority: "high",
      owner: {
        type: "user",
      },
      evidence: {
        required: ["notice_packet"],
      },
      cost: {
        humanMinutes: 15,
      },
      kpi: {
        riskAvoided: "filing_penalty",
      },
      db,
    });

    expect(first.created).toBe(true);
    expect(first.task.title).toBe("Review agency notice packet");
    expect(first.task.state).toBe("active");
    expect(first.task.priority).toBe("high");
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, first.taskId)).limit(1);
    const [event] = await db.select().from(events).where(eq(events.id, first.eventId ?? "")).limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);

    expect(task?.title).toBe("Review agency notice packet");
    expect(task?.ownerRef).toMatch(/^user:/);
    expect(objectValue(task?.evidence).required).toEqual(["notice_packet"]);
    expect(event?.type).toBe("task.created");
    expect(event?.taskId).toBe(first.taskId);
    expect(audit?.type).toBe("task.created");
    expect(audit?.targetType).toBe("task");
    expect(audit?.targetId).toBe(first.taskId);
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");

    const replay = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      title: "Different title should not create another task",
      db,
    });
    const [taskCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.tasks"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:task_created`),
        ),
      );

    expect(replay.created).toBe(false);
    expect(replay.taskId).toBe(first.taskId);
    expect(taskCount.value).toBe(1);
  }, 120_000);

  it("persists the golden lead-to-quote output, eval row, and idempotent replay", async () => {
    const evalCase = revenueWorkerEvalCases[0];
    const first = await runRevenueWorker({
      idempotencyKey: evalCase.idempotencyKey,
      tenantSlug: evalCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: evalCase.config,
    });
    const scored = scoreRevenueWorkerRun(first, evalCase);

    expect(first.created).toBe(true);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const data = objectValue(workerRun?.data);
    const output = objectValue(data.output);
    const quote = objectValue(output.quote);

    expect(workerRun?.state).toBe(evalCase.expected.runState);
    expect(workerRun?.mode).toBe(evalCase.expected.runMode);
    expect(output.classification).toBe(evalCase.expected.classification);
    expect(output.sourceSnapshotEvidenceId).toBe(first.sourceSnapshotEvidenceId);
    expect(output.draftResponse).toContain(evalCase.expected.draftIncludes);
    expect(quote.totalCents).toBe(evalCase.expected.quoteTotalCents);
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.requiresApproval).toBe(true);
    expect(output.budgetUnits).toBe(evalCase.expected.maxBudgetUnits);
    expect(output.adapterRunId).toBe(first.adapterRunId);
    expect(output.adapterActionId).toBe(first.adapterActionId);
    expect(output.adapterReceiptEvidenceId).toBe(first.adapterReceiptEvidenceId);
    expect(output.approvalRequestId).toBe(first.approvalRequestId);

    const [evaluation] = await db
      .select()
      .from(evaluations)
      .where(
        and(
          eq(evaluations.workerId, first.snapshot.worker?.id ?? ""),
          eq(evaluations.kind, "simulation_quality"),
          sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`,
        ),
      )
      .limit(1);
    const evalData = objectValue(evaluation?.data);
    const dimensions = objectValue(evalData.dimensions);

    expect(evaluation?.score).toBe("0.860");
    expect(dimensions.evidence_complete).toBe(true);
    expect(dimensions.source_snapshot_present).toBe(true);
    expect(dimensions.input_derived_output).toBe(true);
    expect(dimensions.within_budget).toBe(true);
    expect(dimensions.external_execution_blocked).toBe(true);
    expect(dimensions.owner_approval_required).toBe(true);
    expect(dimensions.external_send_blocked).toBe(true);

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);
    const sourceLead = objectValue(sourceData.leadPacket);

    expect(sourceSnapshot?.kind).toBe("snapshot");
    expect(sourceSnapshot?.name).toBe("Lead source snapshot");
    expect(sourceData.externalSend).toBe(false);
    expect(sourceLead.customerIntent).toBe("roof leak inspection");

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterRequest = objectValue(adapterAction?.request);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterRequest.externalSend).toBe(false);
    expect(objectValue(adapterRequest.quote).totalCents).toBe(evalCase.expected.quoteTotalCents);
    expect(adapterReceipt.externalMutation).toBe(false);

    const [runsBeforeReplay] = await db
      .select({ value: count() })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.revenue_worker"),
          eq(workerRuns.idempotencyKey, evalCase.idempotencyKey),
        ),
      );
    const [evalsBeforeReplay] = await db
      .select({ value: count() })
      .from(evaluations)
      .where(sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`);
    const replay = await runRevenueWorker({
      idempotencyKey: evalCase.idempotencyKey,
      tenantSlug: evalCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: evalCase.config,
    });
    const [runsAfterReplay] = await db
      .select({ value: count() })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.revenue_worker"),
          eq(workerRuns.idempotencyKey, evalCase.idempotencyKey),
        ),
      );
    const [evalsAfterReplay] = await db
      .select({ value: count() })
      .from(evaluations)
      .where(sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(first.workerRunId);
    expect(runsAfterReplay.value).toBe(runsBeforeReplay.value);
    expect(evalsAfterReplay.value).toBe(evalsBeforeReplay.value);

    const secondCase = revenueWorkerEvalCases[1];
    const second = await runRevenueWorker({
      idempotencyKey: secondCase.idempotencyKey,
      tenantSlug: secondCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: secondCase.config,
    });
    const secondScored = scoreRevenueWorkerRun(second, secondCase);

    expect(second.created).toBe(true);
    expect(secondScored.passed).toBe(true);

    const [secondWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, second.workerRunId ?? ""))
      .limit(1);
    const secondOutput = objectValue(objectValue(secondWorkerRun?.data).output);

    expect(secondOutput.classification).toBe(secondCase.expected.classification);
    expect(secondOutput.draftResponse).toContain(secondCase.expected.draftIncludes);
    expect(objectValue(secondOutput.quote).totalCents).toBe(secondCase.expected.quoteTotalCents);
    expect(secondOutput.externalSend).toBe(false);
    expect(secondOutput.classification).not.toBe(output.classification);
    expect(secondOutput.draftResponse).not.toEqual(output.draftResponse);
    expect(secondOutput.quote).not.toEqual(output.quote);
  }, 120_000);

  it("reconciles pending dry-run adapter rows without external execution", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-reconcile-${runId}`;
    const now = new Date("2026-05-19T00:00:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_reconciliation_check",
      idempotencyKey: `${key}:run`,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {},
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "done",
      mode: "dry_run",
      operation: "ci_reconciliation_check",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      response: {
        status: "prepared",
      },
      receipt: {
        externalMutation: false,
      },
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 10,
      now,
      db,
    });

    expect(result.processed).toBeGreaterThanOrEqual(2);
    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(result.retryScheduled).toBe(0);
    expect(result.needsReview).toBe(0);

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);

    expect(run?.state).toBe("done");
    expect(run?.reconciliationState).toBe("matched");
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("done");
    expect(action?.reconciliationState).toBe("matched");
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(inArray(auditEvents.id, result.auditEventIds));
    const [evidenceCount] = await db
      .select({ value: count() })
      .from(evidence)
      .where(inArray(evidence.id, result.evidenceIds));

    expect(auditCount.value).toBe(result.auditEventIds.length);
    expect(evidenceCount.value).toBe(result.evidenceIds.length);
  }, 120_000);
});
