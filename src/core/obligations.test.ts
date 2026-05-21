import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../db/client";
import { auditEvents, evidence, obligations, objects, tasks, tenants } from "../db/schema";
import { scanObligations } from "./obligations";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;
const originalAppEnv = process.env.APP_ENV;

const tenantSlug = "continuous-demo";
const operatorEmail = "owner@continuoushq.com";
const seedIds = {
  rulePack: "55555555-5555-4555-8555-000000000008",
  filingRequirement: "55555555-5555-4555-8555-000000000010",
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

maybeDescribe("Core obligation scan", () => {
  beforeAll(() => {
    process.env.APP_ENV = "test";

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

    await pool.end();
  });

  it("materializes filing requirements into obligations, tasks, events, audit, and trace evidence", async () => {
    const idempotencyKey = `ci-obligation-scan-${randomUUID()}`;
    const result = await scanObligations({
      operatorEmail,
      tenantSlug,
      idempotencyKey,
      jurisdiction: "US",
      asOf: "2026-05-22T00:00:00.000Z",
      rulePackId: seedIds.rulePack,
      filingRequirementId: seedIds.filingRequirement,
      scope: {
        domain: "payroll",
      },
      facts: {
        period: "2026-Q2",
      },
      data: {
        source: "core_obligation_scan_test",
      },
    });
    const resultRecord = objectValue(result);
    const obligationIds = arrayValue(resultRecord.obligationIds);
    const objectIds = arrayValue(resultRecord.objectIds);
    const taskIds = arrayValue(resultRecord.taskIds);

    expect(resultRecord.created).toBe(true);
    expect(resultRecord.externalExecution).toBe("blocked");
    expect(obligationIds).toHaveLength(1);
    expect(objectIds).toHaveLength(1);
    expect(taskIds).toHaveLength(1);
    expect(resultRecord.eventId).toMatch(/^[0-9a-f-]+$/);
    expect(resultRecord.auditEventId).toMatch(/^[0-9a-f-]+$/);
    expect(resultRecord.evidenceId).toMatch(/^[0-9a-f-]+$/);

    const obligationId = String(obligationIds[0]);
    const objectId = String(objectIds[0]);
    const taskId = String(taskIds[0]);
    const [obligation] = await db
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligationId))
      .limit(1);
    const [object] = await db.select().from(objects).where(eq(objects.id, objectId)).limit(1);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.id, String(resultRecord.auditEventId)),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:obligation_scanned`),
        ),
      )
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(resultRecord.evidenceId)))
      .limit(1);

    expect(obligation.kind).toBe("filing_due");
    expect(obligation.objectId).toBe(objectId);
    expect(obligation.rulePackId).toBe(seedIds.rulePack);
    expect(object.type).toBe("obligation");
    expect(object.source).toBe("continuous.core.obligations");
    expect(task.objectId).toBe(objectId);
    expect(task.outcome.externalExecution).toBe("blocked");
    expect(audit.type).toBe("core.obligations.scanned");
    expect(proof.kind).toBe("trace");
    expect(objectValue(proof.data).auditEventId).toBe(resultRecord.auditEventId);

    const replay = await scanObligations({
      operatorEmail,
      tenantSlug,
      idempotencyKey,
      jurisdiction: "US",
      asOf: "2026-05-22T00:00:00.000Z",
      rulePackId: seedIds.rulePack,
      filingRequirementId: seedIds.filingRequirement,
      scope: {
        domain: "payroll",
      },
      facts: {
        period: "2026-Q2",
      },
      data: {
        source: "core_obligation_scan_test",
      },
    });
    const replayRecord = objectValue(replay);

    expect(replayRecord.created).toBe(false);
    expect(replayRecord.obligationIds).toEqual(resultRecord.obligationIds);
    expect(replayRecord.auditEventId).toBe(resultRecord.auditEventId);

    await expect(
      scanObligations({
        operatorEmail,
        tenantSlug,
        idempotencyKey,
        jurisdiction: "US",
        asOf: "2026-05-22T00:00:00.000Z",
        rulePackId: seedIds.rulePack,
        filingRequirementId: seedIds.filingRequirement,
        scope: {
          domain: "payroll",
        },
        facts: {
          period: "2026-Q3",
        },
        data: {
          source: "core_obligation_scan_test",
        },
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  });

  it("updates a supplied task with obligation scan evidence", async () => {
    const idempotencyKey = `ci-obligation-scan-task-${randomUUID()}`;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).limit(1);
    if (!tenant) {
      throw new Error("Seed tenant missing for obligation scan task test.");
    }
    const [task] = await db
      .insert(tasks)
      .values({
        tenantId: tenant.id,
        title: "Review payroll filing source",
        state: "draft",
        outcome: {
          existingWorkflowMarker: "keep",
        },
      })
      .returning({ id: tasks.id });
    if (!task) {
      throw new Error("Task insert failed for obligation scan task test.");
    }

    const result = await scanObligations({
      operatorEmail,
      tenantSlug,
      idempotencyKey,
      jurisdiction: "US",
      asOf: "2026-05-23T00:00:00.000Z",
      rulePackId: seedIds.rulePack,
      filingRequirementId: seedIds.filingRequirement,
      taskId: task.id,
      scope: {
        domain: "payroll",
      },
      facts: {
        period: "2026-Q2",
        blockers: ["source_validation_required"],
      },
      data: {
        source: "core_obligation_scan_task_test",
      },
    });
    const resultRecord = objectValue(result);
    const objectId = String(arrayValue(resultRecord.objectIds)[0]);
    const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1);
    if (!updatedTask) {
      throw new Error("Updated task missing after obligation scan.");
    }
    const evidenceData = objectValue(updatedTask.evidence);
    const outcomeData = objectValue(updatedTask.outcome);

    expect(resultRecord.taskIds).toEqual([task.id]);
    expect(updatedTask.state).toBe("blocked");
    expect(updatedTask.objectId).toBe(objectId);
    expect(evidenceData.command).toBe("obligation.scan");
    expect(evidenceData.obligationId).toBe(arrayValue(resultRecord.obligationIds)[0]);
    expect(evidenceData.externalExecution).toBe("blocked");
    expect(arrayValue(evidenceData.blockers)).toContain("source_validation_required");
    expect(outcomeData.existingWorkflowMarker).toBe("keep");
    expect(outcomeData.externalExecution).toBe("blocked");
    expect(outcomeData.obligationState).toBe("blocked");
  });
});
