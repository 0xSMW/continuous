import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileAdapterLedger } from "../core/adapters";
import { db, pool } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  auditEvents,
  connections,
  evaluations,
  evidence,
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

    expect(workerRun?.state).toBe(evalCase.expected.runState);
    expect(workerRun?.mode).toBe(evalCase.expected.runMode);
    expect(output.classification).toBe(evalCase.expected.classification);
    expect(output.externalExecution).toBe("blocked");
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
    expect(dimensions.within_budget).toBe(true);
    expect(dimensions.external_execution_blocked).toBe(true);
    expect(dimensions.owner_approval_required).toBe(true);

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
