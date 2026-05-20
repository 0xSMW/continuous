import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileAdapterLedger } from "../core/adapters";
import { decideApproval, requestApproval } from "../core/approvals";
import { reserveBudget, chargeBudget, releaseBudget } from "../core/budgets";
import { grantCapability } from "../core/capabilities";
import {
  attachCoreEvidence,
  createCoreDocument,
  ingestCoreEvent,
  linkCoreObjects,
  prepareCorePacket,
  publishCoreView,
  recordCustomerSignal,
  recordCoreDecision,
  upsertCoreObject,
} from "../core/primitives";
import { preparePayrollPreviewPacket, recordPayrollPreview } from "../core/payroll";
import { createCoreTask, transitionCoreTask } from "../core/tasks";
import { executeWorkflowSteps, startWorkflowRun } from "../core/workflows";
import { db, pool } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  customerSignals,
  decisions,
  documents,
  events,
  evaluations,
  evidence,
  evidencePackets,
  filingDrafts,
  objects,
  objectLinks,
  objectVersions,
  paymentInstructions,
  payrollLiabilities,
  payrollLines,
  payrollRuns,
  payrollStatements,
  payrollTraces,
  tasks,
  generatedViews,
  usageEvents,
  workflowRuns,
  workflowSteps,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";
import { ownerBriefEvalCases, revenueWorkerEvalCases, scoreOwnerBriefRun, scoreRevenueWorkerRun } from "./evals";
import { executeWorkerCommand } from "./registry";
import { continueRevenueWorker, runRevenueWorker } from "./revenue";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
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

  it("records payroll preview statements, lines, liabilities, traces, and proof", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-payroll-preview-${runId}`;
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const employmentId = "55555555-5555-4555-8555-000000000004";
    const payrollObjectId = "33333333-3333-4333-8333-000000000105";
    const first = await recordPayrollPreview({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      statement: {
        employmentId,
        objectId: payrollObjectId,
        externalId: `ci-payroll-statement-${runId}`,
        state: "draft",
        grossCents: 336000,
        netCents: 248640,
        taxCents: 87360,
        deductionCents: 0,
        data: {
          source: "ci",
        },
      },
      lines: [
        {
          kind: "earning",
          code: "regular_hours",
          description: "Regular wages",
          amountCents: 336000,
          taxable: true,
          data: {
            hours: 80,
            rateCents: 4200,
          },
        },
        {
          kind: "tax",
          code: "federal_withholding",
          amountCents: 87360,
          data: {
            authority: "IRS",
          },
        },
      ],
      liabilities: [
        {
          kind: "tax_withholding",
          payee: "IRS",
          jurisdiction: "US",
          amountCents: 87360,
          state: "draft",
        },
      ],
      trace: {
        hash: `ci-payroll-trace-${runId}`,
        sourceRefs: {
          payrollRunId,
          employmentId,
        },
        inputs: {
          hours: 80,
          rateCents: 4200,
        },
        outputs: {
          grossCents: 336000,
          netCents: 248640,
          taxCents: 87360,
        },
        rules: {
          execution: "preview_only",
        },
      },
      db,
    });

    expect(first.recorded).toBe(true);
    expect(first.statementId).toBeTruthy();
    expect(first.lineIds).toHaveLength(2);
    expect(first.liabilityIds).toHaveLength(1);
    expect(first.traceId).toBeTruthy();
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();
    expect(first.evidenceId).toBeTruthy();

    const [statement] = await db
      .select()
      .from(payrollStatements)
      .where(eq(payrollStatements.id, first.statementId))
      .limit(1);
    const lines = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.statementId, first.statementId));
    const liabilities = await db
      .select()
      .from(payrollLiabilities)
      .where(eq(payrollLiabilities.statementId, first.statementId));
    const [trace] = await db
      .select()
      .from(payrollTraces)
      .where(eq(payrollTraces.id, first.traceId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.evidenceId ?? ""))
      .limit(1);
    const [payrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);

    expect(statement?.payrollRunId).toBe(payrollRunId);
    expect(statement?.employmentId).toBe(employmentId);
    expect(statement?.grossCents).toBe(336000);
    expect(lines.map((line) => line.kind).sort()).toEqual(["earning", "tax"]);
    expect(liabilities[0]?.payee).toBe("IRS");
    expect(trace?.hash).toBe(`ci-payroll-trace-${runId}`);
    expect(audit?.type).toBe("payroll.preview.recorded");
    expect(audit?.source).toBe("continuous.core.payroll");
    expect(audit?.targetType).toBe("payroll_statement");
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");
    expect(proof?.kind).toBe("trace");
    expect(objectValue(proof?.data).traceId).toBe(first.traceId);
    expect(objectValue(payrollRun?.data).preview).toMatchObject({
      lastStatementId: first.statementId,
      traceId: first.traceId,
      externalExecution: "blocked",
    });

    const replay = await recordPayrollPreview({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      statement: {
        employmentId,
        grossCents: 1,
        netCents: 1,
        taxCents: 0,
      },
      lines: [
        {
          kind: "earning",
          amountCents: 1,
        },
      ],
      trace: {
        hash: "should-not-create-new-trace",
      },
      db,
    });
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.payroll"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:payroll_preview_recorded`),
        ),
      );

    expect(replay.recorded).toBe(false);
    expect(replay.statementId).toBe(first.statementId);
    expect(auditCount.value).toBe(1);
  }, 120_000);

  it("prepares payroll preview packets with approval and blocked funding handoffs", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-payroll-packet-${runId}`;
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const payrollObjectId = "33333333-3333-4333-8333-000000000105";
    const first = await preparePayrollPreviewPacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      objectId: payrollObjectId,
      variance: {
        source: "ci",
      },
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(first.prepared).toBe(true);
    expect(first.packetId).toBeTruthy();
    expect(first.packetDocumentId).toBeTruthy();
    expect(first.varianceDocumentId).toBeTruthy();
    expect(first.payStatementDocumentIds.length).toBeGreaterThanOrEqual(1);
    expect(first.paymentInstructionIds).toHaveLength(2);
    expect(first.filingDraftId).toBeTruthy();
    expect(first.approvalRequestId).toBeTruthy();
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();
    expect(first.evidenceId).toBeTruthy();
    expect(first.externalExecution).toBe("blocked");

    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, first.packetId))
      .limit(1);
    const [packetDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.packetDocumentId ?? ""))
      .limit(1);
    const [varianceDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.varianceDocumentId ?? ""))
      .limit(1);
    const paymentDrafts = await db
      .select()
      .from(paymentInstructions)
      .where(inArray(paymentInstructions.id, first.paymentInstructionIds));
    const [filingDraft] = await db
      .select()
      .from(filingDrafts)
      .where(eq(filingDrafts.id, first.filingDraftId ?? ""))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.evidenceId ?? ""))
      .limit(1);

    expect(packet?.kind).toBe("payroll_packet");
    expect(packet?.state).toBe("approval_required");
    expect(objectValue(packet?.data).externalExecution).toBe("blocked");
    expect(objectValue(packet?.data).approvalRequestId).toBe(first.approvalRequestId);
    expect(packetDocument?.kind).toBe("payroll_packet");
    expect(varianceDocument?.kind).toBe("payroll_variance_report");
    expect(paymentDrafts.map((draft) => draft.kind).sort()).toEqual([
      "payroll_net_pay_funding",
      "payroll_tax_deposit",
    ]);
    expect(paymentDrafts.every((draft) => draft.state === "approval_required")).toBe(true);
    expect(paymentDrafts.every((draft) => objectValue(draft.data).moneyMovement === "blocked")).toBe(true);
    expect(filingDraft?.state).toBe("source_review");
    expect(objectValue(filingDraft?.data).externalExecution).toBe("blocked");
    expect(approval?.kind).toBe("payroll_preview_approval");
    expect(approval?.state).toBe("pending");
    expect(objectValue(approval?.requestedAction).moneyMovement).toBe("blocked");
    expect(audit?.type).toBe("payroll.preview.packet.prepared");
    expect(audit?.targetType).toBe("evidence_packet");
    expect(proof?.kind).toBe("trace");
    expect(objectValue(proof?.data).packetId).toBe(first.packetId);

    const replay = await preparePayrollPreviewPacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      objectId: payrollObjectId,
      variance: {
        source: "changed",
      },
      db,
    });
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.payroll"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:payroll_preview_packet_prepared`),
        ),
      );

    expect(replay.prepared).toBe(false);
    expect(replay.packetId).toBe(first.packetId);
    expect(replay.approvalRequestId).toBe(first.approvalRequestId);
    expect(auditCount.value).toBe(1);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI payroll preview approval; execution remains blocked.",
      db,
    });

    expect(decision.approval.state).toBe("approved");
    expect(objectValue(decision.payrollHandoff).externalExecution).toBe("blocked");

    const [approvedPayrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);
    const approvedPaymentDrafts = await db
      .select()
      .from(paymentInstructions)
      .where(inArray(paymentInstructions.id, first.paymentInstructionIds));
    const [approvedFilingDraft] = await db
      .select()
      .from(filingDrafts)
      .where(eq(filingDrafts.id, first.filingDraftId ?? ""))
      .limit(1);
    const [approvedPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, first.packetId))
      .limit(1);
    const [approvedPacketDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.packetDocumentId ?? ""))
      .limit(1);
    const [handoffEvent] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, "payroll.preview.approval.applied"),
          sql`${events.data}->>'approvalRequestId' = ${first.approvalRequestId}`,
        ),
      )
      .limit(1);
    const [handoffAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.type, "payroll.preview.approval.applied"),
          eq(auditEvents.targetType, "payroll_run"),
          eq(auditEvents.targetId, payrollRunId),
        ),
      )
      .limit(1);

    const payrollHandoff = objectValue(approvedPayrollRun?.data).handoff;
    expect(approvedPayrollRun?.state).toBe("approved");
    expect(objectValue(payrollHandoff).approvalRequestId).toBe(first.approvalRequestId);
    expect(objectValue(payrollHandoff).externalExecution).toBe("blocked");
    expect(objectValue(payrollHandoff).moneyMovement).toBe("blocked");
    expect(approvedPaymentDrafts.every((draft) => draft.state === "approved_blocked")).toBe(true);
    expect(
      approvedPaymentDrafts.every((draft) => objectValue(objectValue(draft.data).approvalDecision).action === "approved"),
    ).toBe(true);
    expect(
      approvedPaymentDrafts.every((draft) => objectValue(objectValue(draft.data).handoff).moneyMovement === "blocked"),
    ).toBe(true);
    expect(approvedFilingDraft?.state).toBe("approved_blocked");
    expect(objectValue(objectValue(approvedFilingDraft?.data).handoff).submission).toBe("blocked");
    expect(approvedPacket?.state).toBe("approved");
    expect(objectValue(objectValue(approvedPacket?.data).handoff).approvalRequestId).toBe(first.approvalRequestId);
    expect(approvedPacketDocument?.state).toBe("approved");
    expect(objectValue(objectValue(approvedPacketDocument?.data).handoff).approvalRequestId).toBe(
      first.approvalRequestId,
    );
    expect(handoffEvent?.source).toBe("continuous.approvals");
    expect(handoffAudit?.risk).toBe("high");
  }, 120_000);

  it("transitions headless core tasks and requests approval packets", async () => {
    const runId = randomUUID();
    const taskResult = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-${runId}`,
      title: "Review agency response packet",
      priority: "high",
      evidence: {
        required: ["response_packet"],
      },
      db,
    });
    const transitionResult = await transitionCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-transition-${runId}`,
      taskId: taskResult.taskId,
      toState: "waiting",
      reason: "Response packet is waiting for owner review.",
      evidence: {
        packetReady: true,
      },
      outcome: {
        status: "waiting_on_owner",
      },
      db,
    });

    expect(transitionResult.transitioned).toBe(true);
    expect(transitionResult.task.state).toBe("waiting");
    expect(transitionResult.eventId).toBeTruthy();
    expect(transitionResult.auditEventId).toBeTruthy();
    expect(transitionResult.evidenceId).toBeTruthy();

    const approvalResult = await requestApproval({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-approval-${runId}`,
      taskId: taskResult.taskId,
      eventId: transitionResult.eventId ?? undefined,
      kind: "agency_notice_response_approval",
      title: "Approve agency response packet",
      summary: "Prepared response packet is ready for review; external submission is blocked.",
      priority: "high",
      risk: "medium",
      requestedAction: {
        action: "approve_prepared_response",
        externalExecution: "blocked",
      },
      evidence: {
        transitionEvidenceId: transitionResult.evidenceId,
      },
      policy: {
        externalSubmission: "approval_required",
      },
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(approvalResult.created).toBe(true);
    expect(approvalResult.approvalRequestId).toBeTruthy();
    expect(approvalResult.eventId).toBe(transitionResult.eventId);
    expect(approvalResult.auditEventId).toBeTruthy();
    expect(approvalResult.evidenceId).toBeTruthy();
    expect(approvalResult.approval.state).toBe("pending");
    expect(approvalResult.approval.subject).toEqual({
      type: "task",
      id: taskResult.taskId,
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskResult.taskId)).limit(1);
    const [transitionEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, transitionResult.eventId ?? ""))
      .limit(1);
    const [transitionEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, transitionResult.evidenceId ?? ""))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalResult.approvalRequestId))
      .limit(1);
    const [approvalEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, approvalResult.evidenceId ?? ""))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          taskResult.auditEventId,
          transitionResult.auditEventId,
          approvalResult.auditEventId,
        ]),
      );

    expect(task?.state).toBe("approval_required");
    expect(objectValue(task?.outcome).approvalRequestId).toBe(approvalResult.approvalRequestId);
    expect(transitionEvent?.type).toBe("task.transitioned");
    expect(transitionEvidence?.kind).toBe("trace");
    expect(objectValue(transitionEvidence?.data).toState).toBe("waiting");
    expect(approval?.state).toBe("pending");
    expect(approval?.eventId).toBe(transitionResult.eventId);
    expect(objectValue(approval?.requestedAction).externalExecution).toBe("blocked");
    expect(approvalEvidence?.kind).toBe("approval");
    expect(objectValue(approvalEvidence?.data).approvalRequestId).toBe(approvalResult.approvalRequestId);
    expect(auditCount.value).toBe(3);

    const transitionReplay = await transitionCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-transition-${runId}`,
      taskId: taskResult.taskId,
      toState: "done",
      reason: "Different state should replay.",
      db,
    });
    const approvalReplay = await requestApproval({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-approval-${runId}`,
      taskId: taskResult.taskId,
      kind: "different_kind",
      title: "Different title should replay",
      db,
    });

    expect(transitionReplay.transitioned).toBe(false);
    expect(transitionReplay.taskId).toBe(taskResult.taskId);
    expect(approvalReplay.created).toBe(false);
    expect(approvalReplay.approvalRequestId).toBe(approvalResult.approvalRequestId);
  }, 120_000);

  it("grants capabilities and moves budget through reserve charge and release", async () => {
    const runId = randomUUID();
    const [capability] = await db
      .select()
      .from(capabilities)
      .where(and(eq(capabilities.key, "worker.read"), eq(capabilities.active, true)))
      .limit(1);
    const [worker] = await db.select().from(workers).where(eq(workers.role, "revenue_operations")).limit(1);

    expect(capability).toBeDefined();
    expect(worker).toBeDefined();

    const [budgetAccount] = await db
      .select()
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.tenantId, worker.tenantId),
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, worker.id),
          eq(budgetAccounts.active, true),
        ),
      )
      .limit(1);

    expect(budgetAccount).toBeDefined();

    const grantResult = await grantCapability({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-capability-grant-${runId}`,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
      },
      scope: {
        flow: "ci_budget_control",
      },
      policy: {
        autonomyLevel: 1,
        externalExecution: "blocked",
      },
      reason: "CI grants a scoped worker capability through Core.",
      db,
    });

    expect(grantResult.granted).toBe(true);
    expect(grantResult.capabilityGrantId).toBeTruthy();
    expect(grantResult.eventId).toBeTruthy();
    expect(grantResult.auditEventId).toBeTruthy();
    expect(grantResult.evidenceId).toBeTruthy();
    expect(grantResult.grant.actor.type).toBe("worker");
    expect(grantResult.grant.capabilityKey).toBe("worker.read");

    const taskResult = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-task-${runId}`,
      title: "Review budget control packet",
      capabilityId: capability.id,
      evidence: {
        required: ["budget_trace"],
      },
      db,
    });
    const reserveResult = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      units: 1200,
      reason: "Reserve budget before worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(reserveResult.reserved).toBe(true);
    expect(reserveResult.reservation.state).toBe("held");
    expect(reserveResult.reservation.units).toBe(1200);
    expect(reserveResult.eventId).toBeTruthy();
    expect(reserveResult.auditEventId).toBeTruthy();
    expect(reserveResult.evidenceId).toBeTruthy();

    const chargeResult = await chargeBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-charge-${runId}`,
      reservationId: reserveResult.reservationId,
      actor: {
        type: "worker",
        id: worker.id,
      },
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      costUsd: "0.000000",
      reason: "Charge the reserved budget after the worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(chargeResult.charged).toBe(true);
    expect(chargeResult.usage.units).toBe(1200);
    expect(chargeResult.usage.reservationId).toBe(reserveResult.reservationId);
    expect(chargeResult.eventId).toBeTruthy();
    expect(chargeResult.auditEventId).toBeTruthy();
    expect(chargeResult.evidenceId).toBeTruthy();

    const releaseReserve = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      units: 600,
      reason: "Reserve budget for a canceled worker action.",
      db,
    });
    const releaseResult = await releaseBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-${runId}`,
      reservationId: releaseReserve.reservationId,
      reason: "Release unused budget after canceling the action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(releaseResult.released).toBe(true);
    expect(releaseResult.reservation.state).toBe("released");
    expect(releaseResult.eventId).toBeTruthy();
    expect(releaseResult.auditEventId).toBeTruthy();
    expect(releaseResult.evidenceId).toBeTruthy();

    const [grant] = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.id, grantResult.capabilityGrantId))
      .limit(1);
    const [chargedReservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, reserveResult.reservationId))
      .limit(1);
    const [releasedReservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, releaseReserve.reservationId))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, chargeResult.usageEventId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          grantResult.auditEventId,
          reserveResult.auditEventId,
          chargeResult.auditEventId,
          releaseResult.auditEventId,
        ]),
      );

    expect(grant?.active).toBe(true);
    expect(objectValue(grant?.policy).externalExecution).toBe("blocked");
    expect(chargedReservation?.state).toBe("used");
    expect(releasedReservation?.state).toBe("released");
    expect(usage?.reservationId).toBe(reserveResult.reservationId);
    expect(usage?.actorType).toBe("worker");
    expect(usage?.actorId).toBe(worker.id);
    expect(auditCount.value).toBe(4);

    const reserveReplay = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      units: 999,
      reason: "Replay should return the first reservation.",
      db,
    });
    const chargeReplay = await chargeBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-charge-${runId}`,
      reservationId: reserveResult.reservationId,
      actor: {
        type: "worker",
        id: worker.id,
      },
      reason: "Replay should return the first usage event.",
      db,
    });
    const releaseReplay = await releaseBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-${runId}`,
      reservationId: releaseReserve.reservationId,
      reason: "Replay should return the first release.",
      db,
    });

    expect(reserveReplay.reserved).toBe(false);
    expect(reserveReplay.reservationId).toBe(reserveResult.reservationId);
    expect(chargeReplay.charged).toBe(false);
    expect(chargeReplay.usageEventId).toBe(chargeResult.usageEventId);
    expect(releaseReplay.released).toBe(false);
    expect(releaseReplay.reservationId).toBe(releaseReserve.reservationId);
  }, 120_000);

  it("persists headless core objects, events, evidence, documents, and decisions", async () => {
    const runId = randomUUID();
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-object-${runId}`,
      type: "agency_notice",
      name: "Agency notice from the Department of Cheerful Paperwork",
      source: "ci.core",
      externalId: `notice-${runId}`,
      state: "received",
      data: {
        agency: "Department of Cheerful Paperwork",
        dueInDays: 14,
      },
      version: {
        data: {
          state: "received",
          factsLocked: true,
        },
        reason: "CI primitive smoke",
      },
      db,
    });

    expect(objectResult.created).toBe(true);
    expect(objectResult.objectId).toBeTruthy();
    expect(objectResult.objectVersionId).toBeTruthy();
    expect(objectResult.eventId).toBeTruthy();
    expect(objectResult.auditEventId).toBeTruthy();

    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-event-${runId}`,
      type: "agency_notice.received",
      source: "ci.core.intake",
      objectId: objectResult.objectId,
      data: {
        channel: "mailroom",
        mood: "stern but manageable",
      },
      db,
    });

    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-evidence-${runId}`,
      kind: "snapshot",
      name: "Agency notice source snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        receivedBy: "operator",
        documentState: "legible",
      },
      db,
    });

    const documentResult = await createCoreDocument({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-document-${runId}`,
      kind: "agency_notice_packet",
      name: "Agency notice packet",
      state: "review_ready",
      sensitivity: "high",
      objectId: objectResult.objectId,
      data: {
        evidenceIds: [evidenceResult.evidenceId],
      },
      db,
    });

    const decisionResult = await recordCoreDecision({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-decision-${runId}`,
      kind: "notice_routing",
      state: "proposed",
      decision: "owner_review_required",
      rationale: "Notice response should be reviewed before any agency contact.",
      eventId: eventResult.eventId,
      data: {
        objectId: objectResult.objectId,
        evidenceId: evidenceResult.evidenceId,
        documentId: documentResult.documentId,
      },
      db,
    });
    const packetResult = await prepareCorePacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-packet-${runId}`,
      kind: "agency_notice_packet",
      name: "Agency notice evidence packet",
      state: "review_ready",
      sensitivity: "high",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      evidenceIds: [evidenceResult.evidenceId],
      documentIds: [documentResult.documentId],
      sections: {
        order: ["summary", "source", "decision"],
      },
      data: {
        decisionId: decisionResult.decisionId,
      },
      db,
    });

    const [object] = await db.select().from(objects).where(eq(objects.id, objectResult.objectId)).limit(1);
    const [version] = await db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.id, objectResult.objectVersionId ?? ""))
      .limit(1);
    const [event] = await db.select().from(events).where(eq(events.id, eventResult.eventId)).limit(1);
    const [evidenceItem] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, evidenceResult.evidenceId))
      .limit(1);
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentResult.documentId))
      .limit(1);
    const [decision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, decisionResult.decisionId))
      .limit(1);
    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, packetResult.packetId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          objectResult.auditEventId,
          eventResult.auditEventId ?? "",
          evidenceResult.auditEventId,
          documentResult.auditEventId,
          decisionResult.auditEventId,
          packetResult.auditEventId,
        ]),
      );
    const replay = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-evidence-${runId}`,
      kind: "snapshot",
      name: "Different name should replay existing evidence",
      db,
    });

    expect(object?.externalId).toBe(`notice-${runId}`);
    expect(version?.version).toBe(objectResult.version);
    expect(event?.type).toBe("agency_notice.received");
    expect(evidenceItem?.kind).toBe("snapshot");
    expect(document?.kind).toBe("agency_notice_packet");
    expect(document?.sensitivity).toBe("high");
    expect(decision?.decision).toBe("owner_review_required");
    expect(packet?.documentId).toBe(packetResult.documentId);
    expect(packet?.state).toBe("review_ready");
    expect(objectValue(packet?.evidenceIds).ids).toEqual([evidenceResult.evidenceId]);
    expect(auditCount.value).toBe(6);
    expect(replay.created).toBe(false);
    expect(replay.evidenceId).toBe(evidenceResult.evidenceId);

    const packetReplay = await prepareCorePacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-packet-${runId}`,
      kind: "agency_notice_packet",
      name: "Replay returns the first packet",
      db,
    });

    expect(packetReplay.prepared).toBe(false);
    expect(packetReplay.packetId).toBe(packetResult.packetId);
  }, 120_000);

  it("persists headless core object links and generated views", async () => {
    const runId = randomUUID();
    const notice = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-link-notice-${runId}`,
      type: "agency_notice",
      name: "Linked agency notice",
      source: "ci.core",
      externalId: `linked-notice-${runId}`,
      db,
    });
    const customer = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-link-customer-${runId}`,
      type: "customer",
      name: "Linked customer",
      source: "ci.core",
      externalId: `linked-customer-${runId}`,
      db,
    });
    const link = await linkCoreObjects({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-object-link-${runId}`,
      fromObjectId: notice.objectId,
      toObjectId: customer.objectId,
      type: "about_customer",
      data: {
        confidence: "operator_confirmed",
      },
      db,
    });
    const view = await publishCoreView({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-view-publish-${runId}`,
      key: `ci.notice.review.${runId}`,
      name: "Notice review",
      purpose: "Render an operator review packet for an agency notice.",
      objectType: "agency_notice",
      taskState: "approval_required",
      contract: {
        sections: ["summary", "evidence", "actions"],
      },
      actions: {
        valid: ["approve", "request_revision"],
      },
      data: {
        objectId: notice.objectId,
      },
      mask: {
        pii: "redacted_by_default",
      },
      db,
    });

    expect(link.created).toBe(true);
    expect(link.updated).toBe(false);
    expect(link.link.fromObjectId).toBe(notice.objectId);
    expect(link.link.toObjectId).toBe(customer.objectId);
    expect(view.created).toBe(true);
    expect(view.updated).toBe(false);
    expect(view.view.key).toBe(`ci.notice.review.${runId}`);

    const [persistedLink] = await db
      .select()
      .from(objectLinks)
      .where(eq(objectLinks.id, link.objectLinkId))
      .limit(1);
    const [persistedView] = await db
      .select()
      .from(generatedViews)
      .where(eq(generatedViews.id, view.viewId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          notice.auditEventId,
          customer.auditEventId,
          link.auditEventId,
          view.auditEventId,
        ]),
      );
    const linkReplay = await linkCoreObjects({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-object-link-${runId}`,
      fromObjectId: notice.objectId,
      toObjectId: customer.objectId,
      type: "about_customer",
      data: {
        confidence: "should_replay",
      },
      db,
    });
    const viewReplay = await publishCoreView({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-view-publish-${runId}`,
      key: `ci.notice.review.${runId}`,
      name: "Different name should replay",
      purpose: "Replay existing view.",
      db,
    });

    expect(persistedLink?.type).toBe("about_customer");
    expect(objectValue(persistedLink?.data).confidence).toBe("operator_confirmed");
    expect(persistedView?.purpose).toBe("Render an operator review packet for an agency notice.");
    expect(persistedView?.taskState).toBe("approval_required");
    expect(objectValue(persistedView?.contract).sections).toEqual(["summary", "evidence", "actions"]);
    expect(auditCount.value).toBe(4);
    expect(linkReplay.created).toBe(false);
    expect(linkReplay.objectLinkId).toBe(link.objectLinkId);
    expect(viewReplay.created).toBe(false);
    expect(viewReplay.viewId).toBe(view.viewId);
  }, 120_000);

  it("records customer signals as headless core primitives", async () => {
    const runId = randomUUID();
    const [customerObject] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.type, "customer"), eq(objects.externalId, "seed-customer")))
      .limit(1);
    const [jobObject] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.type, "job"), eq(objects.externalId, "seed-job")))
      .limit(1);

    expect(customerObject?.id).toBeTruthy();
    expect(jobObject?.id).toBeTruthy();

    const result = await recordCustomerSignal({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-customer-signal-${runId}`,
      type: "review",
      name: "CI Google review request",
      state: "requested",
      source: "ci.core",
      externalId: `ci-review-${runId}`,
      customerObjectId: customerObject?.id,
      relatedObjectId: jobObject?.id,
      data: {
        platform: "google",
        requestStatus: "prepared",
      },
      db,
    });

    expect(result.created).toBe(true);
    expect(result.signalId).toBeTruthy();
    expect(result.objectId).toBeTruthy();
    expect(result.eventId).toBeTruthy();
    expect(result.evidenceId).toBeTruthy();
    expect(result.auditEventId).toBeTruthy();

    const [signal] = await db
      .select()
      .from(customerSignals)
      .where(eq(customerSignals.id, result.signalId))
      .limit(1);
    const [signalObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, result.objectId))
      .limit(1);
    const links = await db
      .select()
      .from(objectLinks)
      .where(eq(objectLinks.fromId, result.objectId));
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, result.eventId ?? ""))
      .limit(1);
    const [note] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, result.evidenceId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, result.auditEventId))
      .limit(1);

    expect(signal?.type).toBe("review");
    expect(signal?.state).toBe("requested");
    expect(signal?.source).toBe("ci.core");
    expect(objectValue(signal?.data).platform).toBe("google");
    expect(signalObject?.type).toBe("review");
    expect(signalObject?.externalId).toBe(`ci-review-${runId}`);
    expect(links.map((link) => link.type).sort()).toEqual(["about_customer", "about_work_item"]);
    expect(event?.type).toBe("customer_signal.recorded");
    expect(note?.kind).toBe("note");
    expect(audit?.targetType).toBe("customer_signal");
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");

    const replay = await recordCustomerSignal({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-customer-signal-${runId}`,
      type: "review",
      name: "Replay returns existing signal",
      db,
    });
    const [signalCount] = await db
      .select({ value: count() })
      .from(customerSignals)
      .where(eq(customerSignals.externalId, `ci-review-${runId}`));

    expect(replay.created).toBe(false);
    expect(replay.signalId).toBe(result.signalId);
    expect(signalCount.value).toBe(1);
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

  it("records a workflow spine and approval continuation for Revenue Worker runs", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-workflow-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "workflow_test",
          sourceEventId: `workflow-test:${runId}`,
          customerName: "Workflow Spine Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
    });

    expect(first.created).toBe(true);
    expect(first.workflowRunId).toBeTruthy();
    expect(first.workflowStepIds.length).toBe(4);
    expect(objectValue(first.output).workflowRunId).toBe(first.workflowRunId);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const workflowBlockers = objectValue(workflowRun?.blockers);

    expect(workflowRun?.state).toBe("approval_requested");
    expect(workflowRun?.workerId).toBe(first.snapshot.worker?.id);
    expect(workflowData.workerRunId).toBe(first.workerRunId);
    expect(workflowData.approvalRequestId).toBe(first.approvalRequestId);
    expect(workflowData.workflowStepIds).toEqual(first.workflowStepIds);
    expect(workflowBlockers.open).toContain("owner_approval_required");

    const steps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, first.workflowStepIds));
    const stepStates = steps.map((step) => step.toState).sort();

    expect(stepStates).toEqual([
      "adapter_dry_run_recorded",
      "approval_requested",
      "intake_resolved",
      "packet_prepared",
    ]);
    expect(steps.every((step) => step.workflowRunId === first.workflowRunId)).toBe(true);
    expect(steps.find((step) => step.toState === "approval_requested")?.approvalRequestId).toBe(
      first.approvalRequestId,
    );

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);

    expect(approval?.workflowRunId).toBe(first.workflowRunId);
    expect(approval?.workerRunId).toBe(first.workerRunId);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI approval continuation check",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("approved");
    expect(decision.workflowStepId).toBeTruthy();

    const [approvedWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const approvedWorkflowData = objectValue(approvedWorkflowRun?.data);
    const lastDecision = objectValue(approvedWorkflowData.lastApprovalDecision);
    const continuation = objectValue(lastDecision.continuation);

    expect(approvedWorkflowRun?.state).toBe("approved");
    expect(lastDecision.action).toBe("approved");
    expect(lastDecision.workflowStepId).toBe(decision.workflowStepId);
    expect(continuation.externalExecution).toBe("blocked");
    expect(continuation.externalSend).toBe(false);

    const [decisionStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, decision.workflowStepId ?? ""))
      .limit(1);
    const decisionStepOutput = objectValue(decisionStep?.output);

    expect(decisionStep?.kind).toBe("approval_decision");
    expect(decisionStep?.fromState).toBe("approval_requested");
    expect(decisionStep?.toState).toBe("approved");
    expect(decisionStep?.approvalRequestId).toBe(first.approvalRequestId);
    expect(objectValue(decisionStepOutput.continuation).externalExecution).toBe("blocked");

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const workerRunOutput = objectValue(objectValue(workerRun?.data).output);
    const approvalDecision = objectValue(workerRunOutput.approvalDecision);

    expect(objectValue(approvalDecision.continuation).externalExecution).toBe("blocked");
    expect(workerRunOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(objectValue(adapterReceipt.continuation).externalExecution).toBe("blocked");

    const approvedContinuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-approved-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const approvedOutput = objectValue(approvedContinuation.output);
    const approvedExecutionPacket = objectValue(approvedOutput.approvedExecutionPacket);

    expect(approvedContinuation.created).toBe(true);
    expect(approvedContinuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(approvedContinuation.workflowRunId).toBe(first.workflowRunId);
    expect(approvedOutput.status).toBe("approved_execution_blocked");
    expect(approvedOutput.approvalRequestId).toBe(first.approvalRequestId);
    expect(approvedOutput.nextAction).toBe("enable_scoped_adapter_execution");
    expect(approvedOutput.externalExecution).toBe("blocked");
    expect(approvedOutput.externalSend).toBe(false);
    expect(approvedOutput.requiresApproval).toBe(false);
    expect(approvedOutput.approvedExecutionEvidenceId).toBeTruthy();
    expect(approvedOutput.approvedExecutionDocumentId).toBeTruthy();
    expect(approvedOutput.approvedEvidencePacketId).toBeTruthy();
    expect(approvedExecutionPacket.status).toBe("approved_execution_blocked");
    expect(approvedExecutionPacket.externalExecution).toBe("blocked");
    expect(approvedExecutionPacket.externalSend).toBe(false);

    const [executionWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const executionWorkflowData = objectValue(executionWorkflowRun?.data);
    const approvedExecutionContinuation = objectValue(
      executionWorkflowData.approvedExecutionContinuation,
    );

    expect(executionWorkflowRun?.state).toBe("execution_blocked");
    expect(approvedExecutionContinuation.workerRunId).toBe(approvedContinuation.workerRunId);
    expect(approvedExecutionContinuation.action).toBe("approved");
    expect(approvedExecutionContinuation.approvedExecutionEvidenceId).toBe(
      approvedOutput.approvedExecutionEvidenceId,
    );
    expect(executionWorkflowData.workflowStepIds).toContain(approvedContinuation.workflowStepId);

    const [approvedContinuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, approvedContinuation.workflowStepId ?? ""))
      .limit(1);
    const approvedStepOutput = objectValue(approvedContinuationStep?.output);

    expect(approvedContinuationStep?.kind).toBe("worker_continuation");
    expect(approvedContinuationStep?.fromState).toBe("approved");
    expect(approvedContinuationStep?.toState).toBe("execution_blocked");
    expect(approvedStepOutput.nextAction).toBe("enable_scoped_adapter_execution");
    expect(approvedStepOutput.externalExecution).toBe("blocked");
    expect(approvedStepOutput.externalSend).toBe(false);

    const [approvedExecutionEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(approvedOutput.approvedExecutionEvidenceId ?? "")))
      .limit(1);
    const approvedExecutionEvidenceData = objectValue(approvedExecutionEvidence?.data);
    const [approvedExecutionDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(approvedOutput.approvedExecutionDocumentId ?? "")))
      .limit(1);
    const [approvedEvidencePacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(approvedOutput.approvedEvidencePacketId ?? "")))
      .limit(1);

    expect(approvedExecutionEvidence?.kind).toBe("draft");
    expect(approvedExecutionEvidenceData.externalExecution).toBe("blocked");
    expect(approvedExecutionEvidenceData.externalSend).toBe(false);
    expect(approvedExecutionDocument?.state).toBe("blocked");
    expect(approvedEvidencePacket?.state).toBe("blocked");
    expect(approvedEvidencePacket?.documentId).toBe(approvedOutput.approvedExecutionDocumentId);

    const [continuedOriginalRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const continuedOriginalOutput = objectValue(objectValue(continuedOriginalRun?.data).output);

    expect(objectValue(continuedOriginalOutput.approvedExecutionContinuation).workerRunId).toBe(
      approvedContinuation.workerRunId,
    );
    expect(continuedOriginalOutput.externalSend).toBe(false);

    const [continuedAdapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const continuedAdapterReceipt = objectValue(continuedAdapterAction?.receipt);

    expect(objectValue(continuedAdapterReceipt.approvedExecutionContinuation).externalExecution).toBe(
      "blocked",
    );
    expect(continuedAdapterReceipt.externalMutation).toBe(false);
    expect(continuedAdapterReceipt.externalSend).toBe(false);

    const approvedReplay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-approved-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(approvedReplay.created).toBe(false);
    expect(approvedReplay.workerRunId).toBe(approvedContinuation.workerRunId);
    expect(objectValue(approvedReplay.output).status).toBe("approved_execution_blocked");
  }, 120_000);

  it("claims, executes, and retries queued workflow steps", async () => {
    const runId = randomUUID();
    const start = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-run-${runId}`,
      initialState: "draft",
      data: {
        source: "workflow_executor_ci",
      },
      db,
    });
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, start.run.id))
      .limit(1);

    expect(start.created).toBe(true);
    expect(run?.state).toBe("draft");

    const [queuedStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: run?.tenantId ?? "",
        definitionId: run?.definitionId ?? "",
        workflowRunId: start.run.id,
        kind: "transition",
        name: "CI execute payroll source lock",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-executor-step-${runId}`,
        input: {
          source: "workflow_executor_ci",
        },
      })
      .returning();

    const executed = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor:${runId}`,
      db,
    });
    const [executionResult] = executed.results;

    expect(executed.processed).toBe(1);
    expect(executed.completed).toBe(1);
    expect(executed.failed).toBe(0);
    expect(executionResult?.stepId).toBe(queuedStep.id);
    expect(executionResult?.state).toBe("done");
    expect(executionResult?.eventId).toBeTruthy();
    expect(executionResult?.auditEventId).toBeTruthy();
    expect(executionResult?.evidenceId).toBeTruthy();

    const [executedRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, start.run.id))
      .limit(1);
    const [executedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, queuedStep.id))
      .limit(1);
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, executionResult?.eventId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, executionResult?.auditEventId ?? ""))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, executionResult?.evidenceId ?? ""))
      .limit(1);
    const executedStepOutput = objectValue(executedStep?.output);

    expect(executedRun?.state).toBe("source_data_locked");
    expect(executedStep?.state).toBe("done");
    expect(executedStep?.leaseOwner).toBeNull();
    expect(executedStep?.leasedUntil).toBeNull();
    expect(executedStepOutput.externalExecution).toBe("blocked");
    expect(event?.type).toBe("workflow.step.executed");
    expect(audit?.targetId).toBe(queuedStep.id);
    expect(proof?.kind).toBe("trace");

    const expiredStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-expired-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [expiredRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, expiredStart.run.id))
      .limit(1);
    const [expiredStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: expiredRun?.tenantId ?? "",
        definitionId: expiredRun?.definitionId ?? "",
        workflowRunId: expiredStart.run.id,
        kind: "transition",
        name: "CI reclaim expired payroll transition",
        state: "running",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        leaseOwner: "expired-runner",
        leasedUntil: new Date("2026-05-19T00:00:00.000Z"),
        idempotencyKey: `ci-workflow-executor-expired-step-${runId}`,
        input: {
          source: "workflow_executor_expired_ci",
        },
        startedAt: new Date("2026-05-19T00:00:00.000Z"),
      })
      .returning();

    const reclaimed = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-expired:${runId}`,
      db,
    });
    const [reclaimedResult] = reclaimed.results;
    const [reclaimedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, expiredStep.id))
      .limit(1);

    expect(reclaimed.processed).toBe(1);
    expect(reclaimed.completed).toBe(1);
    expect(reclaimedResult?.stepId).toBe(expiredStep.id);
    expect(reclaimedResult?.attempt).toBe(2);
    expect(reclaimedStep?.state).toBe("done");
    expect(reclaimedStep?.attempt).toBe(2);
    expect(reclaimedStep?.leaseOwner).toBeNull();

    const [revenueWorker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const [quoteCapability] = await db
      .select({ id: capabilities.id, key: capabilities.key })
      .from(capabilities)
      .where(eq(capabilities.key, "quote.prepare"))
      .limit(1);

    expect(revenueWorker?.id).toBeTruthy();
    expect(quoteCapability?.id).toBeTruthy();

    const revenueWorkerId = revenueWorker?.id ?? "";
    const quoteCapabilityId = quoteCapability?.id ?? "";
    const quoteCapabilityKey = quoteCapability?.key ?? "";
    const capabilityTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-workflow-capability-task-${runId}`,
      title: "Execute capability workflow step",
      capabilityId: quoteCapabilityId,
      owner: {
        type: "worker",
        id: revenueWorkerId,
        ref: `worker:${revenueWorkerId}`,
      },
      db,
    });
    const capabilityStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-capability-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [capabilityRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, capabilityStart.run.id))
      .limit(1);
    const [capabilityStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: capabilityRun?.tenantId ?? "",
        definitionId: capabilityRun?.definitionId ?? "",
        workflowRunId: capabilityStart.run.id,
        taskId: capabilityTask.taskId,
        workerId: revenueWorkerId,
        capabilityId: quoteCapabilityId,
        kind: "capability_execution",
        name: "CI execute quote capability through workflow",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-capability-step-${runId}`,
        input: {
          source: "workflow_capability_ci",
          capabilityKey: quoteCapabilityKey,
        },
      })
      .returning();

    const capabilityExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-capability:${runId}`,
      db,
    });
    const [capabilityResult] = capabilityExecution.results;
    const [executedCapabilityStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, capabilityStep.id))
      .limit(1);
    const [capabilityEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, capabilityResult?.eventId ?? ""))
      .limit(1);
    const [capabilityAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, capabilityResult?.auditEventId ?? ""))
      .limit(1);
    const [capabilityTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, capabilityTask.taskId))
      .limit(1);
    const capabilityOutput = objectValue(executedCapabilityStep?.output);
    const capabilityProof = objectValue(capabilityOutput.capabilityExecution);
    const taskCapabilityOutcome = objectValue(
      objectValue(capabilityTaskRow?.outcome).lastCapabilityExecution,
    );

    expect(capabilityExecution.processed).toBe(1);
    expect(capabilityExecution.completed).toBe(1);
    expect(capabilityResult?.stepId).toBe(capabilityStep.id);
    expect(executedCapabilityStep?.state).toBe("done");
    expect(capabilityProof.capabilityId).toBe(quoteCapabilityId);
    expect(capabilityProof.capabilityKey).toBe("quote.prepare");
    expect(capabilityProof.capabilityGrantId).toBeTruthy();
    expect(objectValue(capabilityProof.actor).id).toBe(revenueWorkerId);
    expect(capabilityOutput.externalExecution).toBe("blocked");
    expect(capabilityEvent?.actorType).toBe("worker");
    expect(capabilityEvent?.actorId).toBe(revenueWorkerId);
    expect(capabilityEvent?.capabilityId).toBe(quoteCapabilityId);
    expect(capabilityAudit?.capabilityId).toBe(quoteCapabilityId);
    expect(taskCapabilityOutcome.workflowStepId).toBe(capabilityStep.id);
    expect(taskCapabilityOutcome.evidenceId).toBe(capabilityResult?.evidenceId);

    const packetTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-workflow-packet-task-${runId}`,
      title: "Prepare workflow packet from queued step",
      state: "active",
      db,
    });
    const packetStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-packet-run-${runId}`,
      initialState: "calculating",
      data: {
        source: "workflow_packet_ci",
      },
      db,
    });
    const [packetRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const [packetStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        kind: "packet_prepare",
        name: "CI prepare payroll workflow packet",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "calculating",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-packet-step-${runId}`,
        input: {
          packet: {
            kind: "payroll_packet",
            name: "CI queued workflow payroll packet",
            state: "review_ready",
            evidenceIds: [String(capabilityResult?.evidenceId)],
            sections: {
              summary: "Workflow executor prepared this packet from a queued step.",
            },
            data: {
              source: "workflow_packet_ci",
            },
          },
        },
      })
      .returning();

    const packetExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-packet:${runId}`,
      db,
    });
    const [packetResult] = packetExecution.results;
    const [executedPacketStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, packetStep.id))
      .limit(1);
    const [executedPacketRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const packetStepOutput = objectValue(executedPacketStep?.output);
    const packetPreparation = objectValue(packetStepOutput.packetPreparation);
    const [workflowPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(packetPreparation.packetId ?? "")))
      .limit(1);
    const [workflowPacketDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(packetPreparation.documentId ?? "")))
      .limit(1);
    const [packetTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const packetEvidenceIds = objectValue(workflowPacket?.evidenceIds).ids;
    const packetTaskOutcome = objectValue(objectValue(packetTaskRow?.outcome).lastWorkflowPacket);

    expect(packetExecution.processed).toBe(1);
    expect(packetExecution.completed).toBe(1);
    expect(packetResult?.stepId).toBe(packetStep.id);
    expect(executedPacketStep?.state).toBe("done");
    expect(executedPacketRun?.state).toBe("awaiting_approval");
    expect(packetPreparation.packetId).toBeTruthy();
    expect(packetPreparation.documentId).toBeTruthy();
    expect(packetPreparation.externalExecution).toBe("blocked");
    expect(workflowPacket?.kind).toBe("payroll_packet");
    expect(workflowPacket?.workflowRunId).toBe(packetStart.run.id);
    expect(workflowPacket?.taskId).toBe(packetTask.taskId);
    expect(workflowPacket?.eventId).toBe(packetResult?.eventId);
    expect(workflowPacket?.state).toBe("review_ready");
    expect(workflowPacketDocument?.kind).toBe("payroll_packet");
    expect(stringList(packetEvidenceIds)).toEqual(
      expect.arrayContaining([String(capabilityResult?.evidenceId), String(packetResult?.evidenceId)]),
    );
    expect(objectValue(objectValue(workflowPacket?.data).sections).summary).toContain(
      "queued step",
    );
    expect(packetTaskOutcome.packetId).toBe(packetPreparation.packetId);
    expect(packetTaskOutcome.workflowStepId).toBe(packetStep.id);

    const [approvalStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        kind: "approval_request",
        name: "CI request payroll workflow approval",
        state: "queued",
        priority: "urgent",
        risk: "high",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-approval-step-${runId}`,
        input: {
          approval: {
            kind: "payroll_approval",
            title: "CI payroll workflow approval",
            summary: "Queued workflow execution requested payroll approval.",
            requestedAction: {
              action: "approve_payroll_packet",
              packetId: String(packetPreparation.packetId ?? ""),
            },
            evidence: {
              packetId: String(packetPreparation.packetId ?? ""),
              packetEvidenceId: String(packetResult?.evidenceId ?? ""),
            },
            data: {
              source: "workflow_approval_ci",
            },
          },
        },
      })
      .returning();

    const approvalExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-approval:${runId}`,
      db,
    });
    const [approvalResult] = approvalExecution.results;
    const [executedApprovalStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, approvalStep.id))
      .limit(1);
    const [approvalRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const approvalStepOutput = objectValue(executedApprovalStep?.output);
    const workflowApproval = objectValue(approvalStepOutput.approvalRequest);
    const [workflowApprovalRequest] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, String(workflowApproval.approvalRequestId ?? "")))
      .limit(1);
    const [workflowApprovalAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, String(workflowApproval.approvalAuditEventId ?? "")))
      .limit(1);
    const [workflowApprovalEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(workflowApproval.approvalEvidenceId ?? "")))
      .limit(1);
    const [approvalTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const approvalRunData = objectValue(approvalRun?.data);
    const lastWorkflowApproval = objectValue(approvalRunData.lastWorkflowApprovalRequest);
    const approvalTaskOutcome = objectValue(
      objectValue(approvalTaskRow?.outcome).lastWorkflowApprovalRequest,
    );

    expect(approvalExecution.processed).toBe(1);
    expect(approvalExecution.completed).toBe(1);
    expect(approvalResult?.stepId).toBe(approvalStep.id);
    expect(executedApprovalStep?.state).toBe("done");
    expect(executedApprovalStep?.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalRun?.state).toBe("awaiting_approval");
    expect(workflowApproval.approvalRequestId).toBeTruthy();
    expect(workflowApproval.externalExecution).toBe("blocked");
    expect(workflowApprovalRequest?.kind).toBe("payroll_approval");
    expect(workflowApprovalRequest?.state).toBe("pending");
    expect(workflowApprovalRequest?.workflowRunId).toBe(packetStart.run.id);
    expect(workflowApprovalRequest?.taskId).toBe(packetTask.taskId);
    expect(workflowApprovalRequest?.eventId).toBe(approvalResult?.eventId);
    expect(objectValue(workflowApprovalRequest?.requestedAction).packetId).toBe(packetPreparation.packetId);
    expect(workflowApprovalAudit?.targetId).toBe(workflowApproval.approvalRequestId);
    expect(workflowApprovalAudit?.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(workflowApprovalEvidence?.kind).toBe("approval");
    expect(objectValue(workflowApprovalEvidence?.data).workflowStepId).toBe(approvalStep.id);
    expect(lastWorkflowApproval.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalTaskRow?.state).toBe("approval_required");
    expect(approvalTaskOutcome.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalTaskOutcome.workflowStepId).toBe(approvalStep.id);

    const retryStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-retry-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [retryRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, retryStart.run.id))
      .limit(1);
    const [retryStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: retryRun?.tenantId ?? "",
        definitionId: retryRun?.definitionId ?? "",
        workflowRunId: retryStart.run.id,
        kind: "transition",
        name: "CI retry invalid payroll transition",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "not_a_state",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-executor-retry-step-${runId}`,
        input: {
          source: "workflow_executor_retry_ci",
        },
      })
      .returning();

    const firstFailure = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-retry:${runId}`,
      db,
    });
    const [firstFailureResult] = firstFailure.results;

    expect(firstFailure.processed).toBe(1);
    expect(firstFailure.completed).toBe(0);
    expect(firstFailure.failed).toBe(1);
    expect(firstFailureResult?.stepId).toBe(retryStep.id);
    expect(firstFailureResult?.state).toBe("failed");

    const [failedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, retryStep.id))
      .limit(1);
    const failedError = objectValue(failedStep?.error);

    expect(failedStep?.state).toBe("failed");
    expect(failedStep?.attempt).toBe(1);
    expect(failedStep?.nextAttemptAt).toBeTruthy();
    expect(failedError.retryable).toBe(true);

    await db
      .update(workflowSteps)
      .set({
        nextAttemptAt: new Date("2026-05-19T00:00:00.000Z"),
      })
      .where(eq(workflowSteps.id, retryStep.id));

    const finalFailure = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-retry:${runId}`,
      db,
    });
    const [finalFailureResult] = finalFailure.results;
    const [finalFailedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, retryStep.id))
      .limit(1);
    const finalError = objectValue(finalFailedStep?.error);

    expect(finalFailure.processed).toBe(1);
    expect(finalFailureResult?.stepId).toBe(retryStep.id);
    expect(finalFailureResult?.state).toBe("failed");
    expect(finalFailedStep?.attempt).toBe(2);
    expect(finalFailedStep?.nextAttemptAt).toBeNull();
    expect(finalError.retryable).toBe(false);
  }, 120_000);

  it("continues revision-requested approval outcomes through the worker command spine", async () => {
    const runId = randomUUID();
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const workerId = worker?.id ?? "";

    expect(workerId).toBeTruthy();

    const createdTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-revision-task-${runId}`,
      title: "Revision continuation quote task",
      state: "active",
      priority: "urgent",
      owner: {
        type: "worker",
        id: workerId,
        ref: `worker:${workerId}`,
      },
      db,
    });
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-revision-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "revision_test",
          sourceEventId: `revision-test:${runId}`,
          customerName: "Revision Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    expect(first.taskId).toBe(createdTask.taskId);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "revision_requested",
      note: "Revise the draft before owner approval.",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("revision_requested");

    const continuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const output = objectValue(continuation.output);

    expect(continuation.created).toBe(true);
    expect(continuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(continuation.workflowRunId).toBe(first.workflowRunId);
    expect(output.status).toBe("revised_packet_ready_for_owner_approval");
    expect(output.nextAction).toBe("owner_approval");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.revisionApprovalRequestId).toBeTruthy();
    expect(output.revisedPacketEvidenceId).toBeTruthy();
    expect(output.revisedPacketDocumentId).toBeTruthy();
    expect(output.revisedEvidencePacketId).toBeTruthy();

    const revisionApprovalRequestId = String(output.revisionApprovalRequestId ?? "");
    const revisedPacketEvidenceId = String(output.revisedPacketEvidenceId ?? "");
    const revisedPacketDocumentId = String(output.revisedPacketDocumentId ?? "");
    const revisedEvidencePacketId = String(output.revisedEvidencePacketId ?? "");
    const revisedPacket = objectValue(output.revisedPacket);

    expect(output.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(output.originalApprovalRequestId).toBe(first.approvalRequestId);
    expect(revisedPacket.status).toBe("revised_packet_ready_for_owner_approval");
    expect(revisedPacket.externalExecution).toBe("blocked");
    expect(revisedPacket.externalSend).toBe(false);
    expect(revisedPacket.requiresApproval).toBe(true);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, continuation.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const revisionContinuation = objectValue(workflowData.revisionContinuation);

    expect(workflowRun?.state).toBe("approval_requested");
    expect(revisionContinuation.workerRunId).toBe(continuation.workerRunId);
    expect(revisionContinuation.action).toBe("revision_requested");
    expect(revisionContinuation.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(revisionContinuation.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(workflowData.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(workflowData.workflowStepIds).toContain(continuation.workflowStepId);

    const [continuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, continuation.workflowStepId ?? ""))
      .limit(1);
    const stepOutput = objectValue(continuationStep?.output);

    expect(continuationStep?.kind).toBe("worker_continuation");
    expect(continuationStep?.fromState).toBe("revision_requested");
    expect(continuationStep?.toState).toBe("approval_requested");
    expect(stepOutput.nextAction).toBe("owner_approval");
    expect(stepOutput.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(stepOutput.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(stepOutput.externalExecution).toBe("blocked");
    expect(stepOutput.externalSend).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, continuation.taskId ?? ""))
      .limit(1);
    const taskOutcome = objectValue(task?.outcome);

    expect(task?.state).toBe("approval_required");
    expect(taskOutcome.status).toBe("revised_packet_ready_for_owner_approval");
    expect(taskOutcome.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(taskOutcome.originalApprovalRequestId).toBe(first.approvalRequestId);
    expect(taskOutcome.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(objectValue(taskOutcome.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );

    const [revisionApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, revisionApprovalRequestId))
      .limit(1);
    const revisionRequestedAction = objectValue(revisionApproval?.requestedAction);
    const revisionPolicy = objectValue(revisionApproval?.policy);
    const revisionApprovalData = objectValue(revisionApproval?.data);

    expect(revisionApproval?.kind).toBe("quote_revision_approval");
    expect(revisionApproval?.state).toBe("pending");
    expect(revisionApproval?.workerRunId).toBe(continuation.workerRunId);
    expect(revisionRequestedAction.action).toBe("review_revised_packet");
    expect(revisionRequestedAction.externalSend).toBe(false);
    expect(revisionRequestedAction.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(revisionRequestedAction.revisedPacketDocumentId).toBe(revisedPacketDocumentId);
    expect(revisionRequestedAction.revisedEvidencePacketId).toBe(revisedEvidencePacketId);
    expect(revisionPolicy.revisionOfApprovalRequestId).toBe(first.approvalRequestId);
    expect(revisionApprovalData.originalApprovalRequestId).toBe(first.approvalRequestId);

    const [revisedEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, revisedPacketEvidenceId))
      .limit(1);
    const revisedEvidenceData = objectValue(revisedEvidence?.data);

    expect(revisedEvidence?.kind).toBe("draft");
    expect(revisedEvidenceData.externalExecution).toBe("blocked");
    expect(revisedEvidenceData.externalSend).toBe(false);
    expect(objectValue(revisedEvidenceData.revisedPacket).status).toBe(
      "revised_packet_ready_for_owner_approval",
    );

    const [revisedDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, revisedPacketDocumentId))
      .limit(1);
    const [revisedPacketRow] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, revisedEvidencePacketId))
      .limit(1);

    expect(revisedDocument?.state).toBe("prepared");
    expect(revisedPacketRow?.state).toBe("prepared");
    expect(revisedPacketRow?.documentId).toBe(revisedPacketDocumentId);

    const [originalWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const originalOutput = objectValue(objectValue(originalWorkerRun?.data).output);

    expect(objectValue(originalOutput.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );
    expect(originalOutput.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(originalOutput.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(originalOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(adapterReceipt.externalSend).not.toBe(true);

    const replay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(continuation.workerRunId);
    expect(objectValue(replay.output).status).toBe("revised_packet_ready_for_owner_approval");
    expect(objectValue(replay.output).revisionApprovalRequestId).toBe(revisionApprovalRequestId);
  }, 120_000);

  it("continues rejected approval outcomes by closing the prepared action", async () => {
    const runId = randomUUID();
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const workerId = worker?.id ?? "";

    expect(workerId).toBeTruthy();

    const createdTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-rejected-task-${runId}`,
      title: "Rejected continuation quote task",
      state: "active",
      priority: "high",
      owner: {
        type: "worker",
        id: workerId,
        ref: `worker:${workerId}`,
      },
      db,
    });
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-rejected-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "rejection_test",
          sourceEventId: `rejection-test:${runId}`,
          customerName: "Rejected Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    expect(first.taskId).toBe(createdTask.taskId);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "rejected",
      note: "Do not send this quote.",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("rejected");
    expect(decision.taskState).toBe("blocked");

    const continuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-rejected-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const output = objectValue(continuation.output);
    const rejectedPacket = objectValue(output.rejectedPacket);

    expect(continuation.created).toBe(true);
    expect(continuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(continuation.workflowRunId).toBe(first.workflowRunId);
    expect(output.status).toBe("rejected_closed");
    expect(output.approvalRequestId).toBe(first.approvalRequestId);
    expect(output.nextAction).toBe("stop_prepared_action");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.requiresApproval).toBe(false);
    expect(output.rejectedPacketEvidenceId).toBeTruthy();
    expect(output.rejectedPacketDocumentId).toBeTruthy();
    expect(output.rejectedEvidencePacketId).toBeTruthy();
    expect(rejectedPacket.status).toBe("rejected_closed");
    expect(rejectedPacket.nextAction).toBe("stop_prepared_action");
    expect(rejectedPacket.externalExecution).toBe("blocked");
    expect(rejectedPacket.externalSend).toBe(false);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, continuation.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const workflowBlockers = objectValue(workflowRun?.blockers);
    const rejectionContinuation = objectValue(workflowData.rejectionContinuation);

    expect(workflowRun?.state).toBe("rejected");
    expect(workflowRun?.completedAt).toBeTruthy();
    expect(workflowBlockers.open).toEqual([]);
    expect(rejectionContinuation.workerRunId).toBe(continuation.workerRunId);
    expect(rejectionContinuation.action).toBe("rejected");
    expect(rejectionContinuation.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(workflowData.workflowStepIds).toContain(continuation.workflowStepId);

    const [continuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, continuation.workflowStepId ?? ""))
      .limit(1);
    const stepOutput = objectValue(continuationStep?.output);

    expect(continuationStep?.kind).toBe("worker_continuation");
    expect(continuationStep?.fromState).toBe("rejected");
    expect(continuationStep?.toState).toBe("rejected");
    expect(stepOutput.nextAction).toBe("stop_prepared_action");
    expect(stepOutput.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(stepOutput.externalExecution).toBe("blocked");
    expect(stepOutput.externalSend).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, continuation.taskId ?? ""))
      .limit(1);
    const taskOutcome = objectValue(task?.outcome);

    expect(task?.state).toBe("blocked");
    expect(taskOutcome.status).toBe("rejected_closed");
    expect(taskOutcome.approvalRequestId).toBe(first.approvalRequestId);
    expect(taskOutcome.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(objectValue(taskOutcome.rejectionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );

    const [rejectedEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(output.rejectedPacketEvidenceId ?? "")))
      .limit(1);
    const rejectedEvidenceData = objectValue(rejectedEvidence?.data);

    expect(rejectedEvidence?.kind).toBe("draft");
    expect(rejectedEvidenceData.externalExecution).toBe("blocked");
    expect(rejectedEvidenceData.externalSend).toBe(false);
    expect(objectValue(rejectedEvidenceData.rejectedPacket).status).toBe("rejected_closed");

    const [rejectedDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(output.rejectedPacketDocumentId ?? "")))
      .limit(1);
    const [rejectedPacketRow] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(output.rejectedEvidencePacketId ?? "")))
      .limit(1);

    expect(rejectedDocument?.state).toBe("closed");
    expect(rejectedPacketRow?.state).toBe("closed");
    expect(rejectedPacketRow?.documentId).toBe(output.rejectedPacketDocumentId);

    const [originalWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const originalOutput = objectValue(objectValue(originalWorkerRun?.data).output);

    expect(objectValue(originalOutput.rejectionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );
    expect(originalOutput.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(originalOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(objectValue(adapterReceipt.rejectionContinuation).externalExecution).toBe("blocked");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(adapterReceipt.externalSend).toBe(false);

    const replay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-rejected-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(continuation.workerRunId);
    expect(objectValue(replay.output).status).toBe("rejected_closed");
  }, 120_000);

  it("runs from persisted Core lead intake under config.intake", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:${runId}`,
      customerName: "Core Intake Roofing",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-event-${runId}`,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead intake snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        ...leadPacket,
        raw: {
          formId: runId,
        },
      },
      db,
    });

    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-intake-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          objectId: objectResult.objectId,
          eventId: eventResult.eventId,
          evidenceId: evidenceResult.evidenceId,
        },
      },
    });
    const output = objectValue(first.output);
    const intake = objectValue(output.intake);

    expect(first.created).toBe(true);
    expect(output.source).toBe(leadPacket.source);
    expect(output.sourceEventId).toBe(leadPacket.sourceEventId);
    expect(output.sourceObjectId).toBe(objectResult.objectId);
    expect(output.sourceEventRowId).toBe(eventResult.eventId);
    expect(output.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(intake.mode).toBe("core_read");
    expect(intake.objectId).toBe(objectResult.objectId);
    expect(intake.eventId).toBe(eventResult.eventId);
    expect(intake.evidenceId).toBe(evidenceResult.evidenceId);
    expect(output.classification).toBe("quote_ready_for_owner_approval");
    expect(output.externalSend).toBe(false);

    const evalCase = revenueWorkerEvalCases.find((item) => item.id === "revenue.core_intake_refs.approval_blocked");
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      throw new Error("Missing core intake refs eval case.");
    }
    const scored = scoreRevenueWorkerRun(first, evalCase);
    expect(scored.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const runData = objectValue(workerRun?.data);
    const runInput = objectValue(runData.input);
    const resolvedConfig = objectValue(runInput.resolvedConfig);
    const resolvedLead = objectValue(resolvedConfig.leadPacket);

    expect(objectValue(runInput.config).intake).toEqual({
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      evidenceId: evidenceResult.evidenceId,
    });
    expect(resolvedLead.customerName).toBe(leadPacket.customerName);
    expect(resolvedLead.customerIntent).toBe(leadPacket.customerIntent);

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);
    const sourceLead = objectValue(sourceData.leadPacket);

    expect(sourceData.sourceObjectId).toBe(objectResult.objectId);
    expect(sourceData.sourceEventRowId).toBe(eventResult.eventId);
    expect(sourceData.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(sourceLead.customerName).toBe(leadPacket.customerName);

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);
    const requestedAction = objectValue(approval?.requestedAction);
    const approvalEvidence = objectValue(approval?.evidence);

    expect(approval?.state).toBe("pending");
    expect(requestedAction.externalSend).toBe(false);
    expect(requestedAction.sourceSnapshotEvidenceId).toBe(first.sourceSnapshotEvidenceId);
    expect(requestedAction.sourceObjectId).toBe(objectResult.objectId);
    expect(approvalEvidence.sourceEventRowId).toBe(eventResult.eventId);
    expect(approvalEvidence.sourceEvidenceId).toBe(evidenceResult.evidenceId);

    const replay = await runRevenueWorker({
      idempotencyKey: `ci-worker-intake-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          objectId: objectResult.objectId,
          eventId: eventResult.eventId,
          evidenceId: evidenceResult.evidenceId,
        },
      },
    });
    const replayOutput = objectValue(replay.output);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(first.workerRunId);
    expect(replayOutput.sourceEventRowId).toBe(eventResult.eventId);
    expect(objectValue(replayOutput.intake).evidenceId).toBe(evidenceResult.evidenceId);
  }, 120_000);

  it("runs from source-based lead intake under config.intake", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:source-lookup:${runId}`,
      customerName: "Source Lookup Roofing",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-source-lookup-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake source lookup integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: leadPacket.sourceEventId,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-source-lookup-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead source lookup snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        leadPacket,
        source: leadPacket.source,
        sourceEventId: leadPacket.sourceEventId,
      },
      db,
    });

    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-source-lookup-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
        },
      },
    });
    const output = objectValue(first.output);
    const intake = objectValue(output.intake);

    expect(first.created).toBe(true);
    expect(output.source).toBe(leadPacket.source);
    expect(output.sourceEventId).toBe(leadPacket.sourceEventId);
    expect(output.sourceObjectId).toBe(objectResult.objectId);
    expect(output.sourceEventRowId).toBe(eventResult.eventId);
    expect(output.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(intake.mode).toBe("core_source_lookup");
    expect(intake.objectId).toBe(objectResult.objectId);
    expect(intake.eventId).toBe(eventResult.eventId);
    expect(intake.evidenceId).toBe(evidenceResult.evidenceId);
    expect(output.classification).toBe("quote_ready_for_owner_approval");
    expect(output.externalSend).toBe(false);

    const evalCase = revenueWorkerEvalCases.find(
      (item) => item.id === "revenue.source_intake_selector.approval_blocked",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      throw new Error("Missing source intake selector eval case.");
    }
    const scored = scoreRevenueWorkerRun(first, evalCase);
    expect(scored.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const runInput = objectValue(objectValue(workerRun?.data).input);

    expect(objectValue(runInput.config).intake).toEqual({
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
    });
    expect(objectValue(runInput.resolvedConfig).leadPacket).toMatchObject({
      customerName: leadPacket.customerName,
      customerIntent: leadPacket.customerIntent,
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
    });

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);

    expect(sourceData.sourceObjectId).toBe(objectResult.objectId);
    expect(sourceData.sourceEventRowId).toBe(eventResult.eventId);
    expect(sourceData.sourceEvidenceId).toBe(evidenceResult.evidenceId);
  }, 120_000);

  it("reads inbound lead source records before running from the returned selector", async () => {
    const runId = randomUUID();
    const sourceEventId = `website_form:lead-read:${runId}`;
    const read = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-lead-read-${runId}`,
      config: {
        source: "website_form",
        records: [
          {
            sourceEventId,
            customerName: "Lead Read Roofing",
            customerIntent: "roof leak inspection",
            serviceArea: "roofing",
            urgency: "high",
            missingFacts: ["preferred_time_window"],
            payload: {
              formId: runId,
            },
          },
        ],
      },
    });
    const readResult = objectValue(read.result);
    const selectors = Array.isArray(readResult.selectors)
      ? readResult.selectors.map((selector) => objectValue(selector))
      : [];
    const selector = selectors[0] ?? {};

    expect(read.command).toBe("lead.read");
    expect(readResult.created).toBe(true);
    expect(readResult.readCount).toBe(1);
    expect(selector.source).toBe("website_form");
    expect(selector.sourceEventId).toBe(sourceEventId);
    expect(selector.objectId).toBeTruthy();
    expect(selector.eventId).toBeTruthy();
    expect(selector.evidenceId).toBeTruthy();
    expect(objectValue(selector.intake)).toEqual({
      source: "website_form",
      sourceEventId,
    });

    const replay = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-lead-read-${runId}`,
      config: {
        source: "website_form",
        records: [
          {
            sourceEventId,
            customerName: "Lead Read Roofing",
            customerIntent: "roof leak inspection",
            serviceArea: "roofing",
            urgency: "high",
            missingFacts: ["preferred_time_window"],
            payload: {
              formId: runId,
            },
          },
        ],
      },
    });

    expect(objectValue(replay.result).created).toBe(false);

    const run = await runRevenueWorker({
      idempotencyKey: `ci-worker-run-from-lead-read-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const output = objectValue(run.output);
    const intake = objectValue(output.intake);

    expect(run.created).toBe(true);
    expect(output.source).toBe("website_form");
    expect(output.sourceEventId).toBe(sourceEventId);
    expect(output.sourceObjectId).toBe(selector.objectId);
    expect(output.sourceEventRowId).toBe(selector.eventId);
    expect(output.sourceEvidenceId).toBe(selector.evidenceId);
    expect(intake.mode).toBe("core_source_lookup");
    expect(output.externalSend).toBe(false);

    const [readRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringList([readResult.workerRunId])[0] ?? ""))
      .limit(1);
    const readRunData = objectValue(readRun?.data);

    expect(readRun?.mode).toBe("read_only");
    expect(objectValue(readRunData.input).command).toBe("lead.read");
    expect(objectValue(readRunData.output).readCount).toBe(1);
  }, 120_000);

  it("rejects mixed persisted intake and direct lead payloads through the worker registry", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:${runId}`,
      customerName: "Core Intake Authority",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake conflict integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-event-${runId}`,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead intake authority snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: leadPacket,
      db,
    });
    const idempotencyKey = `ci-worker-intake-conflict-${runId}`;

    await expect(
      executeWorkerCommand({
        command: "run",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey,
        config: {
          intake: {
            objectId: objectResult.objectId,
            eventId: eventResult.eventId,
            evidenceId: evidenceResult.evidenceId,
          },
          leadPacket: {
            source: "manual_override",
            sourceEventId: `manual_override:${runId}`,
            customerName: "Conflicting Payload",
            customerIntent: "discounted window replacement",
            serviceArea: "windows",
            urgency: "low",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "worker_intake_conflict",
      status: 400,
    });

    const [workerRunCount] = await db
      .select({ count: count() })
      .from(workerRuns)
      .where(eq(workerRuns.idempotencyKey, idempotencyKey));

    expect(workerRunCount.count).toBe(0);
  }, 120_000);

  it("keeps first-pass adapter reconciliation from advancing Revenue workflows past approval", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-adapter-first-pass-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "adapter_first_pass_test",
          sourceEventId: `adapter-first-pass-test:${runId}`,
          customerName: "Adapter First Pass Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "medium",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    await db
      .update(adapterRuns)
      .set({
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        data: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        error: {},
      })
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""));
    await db
      .update(adapterActions)
      .set({
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        request: {
          workflowRunId: first.workflowRunId,
          externalSend: false,
        },
        response: {
          status: "prepared",
        },
        receipt: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        error: {},
      })
      .where(eq(adapterActions.id, first.adapterActionId ?? ""));

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T00:45:00.000Z"),
      db,
    });

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const reconciliationSteps = await db
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.workflowRunId, first.workflowRunId ?? ""),
          eq(workflowSteps.kind, "adapter_reconciliation"),
        ),
      );

    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(workflowRun?.state).toBe("approval_requested");
    expect(reconciliationSteps).toHaveLength(0);
  }, 120_000);

  it("moves Revenue workflows through adapter retry and post-retry reconciliation states", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-adapter-workflow-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "adapter_workflow_test",
          sourceEventId: `adapter-workflow-test:${runId}`,
          customerName: "Adapter Workflow Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Approve before adapter workflow retry smoke.",
      subject: "worker",
      db,
    });
    await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-adapter-workflow-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    const [executionWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);

    expect(executionWorkflowRun?.state).toBe("execution_blocked");

    const [adapterRun] = await db
      .select()
      .from(adapterRuns)
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""))
      .limit(1);
    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);

    expect(adapterRun).toBeTruthy();
    expect(adapterAction).toBeTruthy();

    await db
      .update(adapterRuns)
      .set({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          ...objectValue(adapterRun?.receipt),
          externalMutation: false,
          externalSend: false,
        },
        error: {
          code: "adapter_timeout",
        },
        endedAt: null,
      })
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""));
    await db
      .update(adapterActions)
      .set({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          ...objectValue(adapterAction?.receipt),
          externalMutation: false,
          externalSend: false,
        },
        error: {
          code: "adapter_timeout",
        },
      })
      .where(eq(adapterActions.id, first.adapterActionId ?? ""));

    const retrySchedule = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T01:00:00.000Z"),
      db,
    });

    expect(retrySchedule.retryScheduled).toBeGreaterThanOrEqual(2);
    expect(retrySchedule.workflowStepIds.length).toBeGreaterThanOrEqual(2);

    const [retryWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const retryWorkflowData = objectValue(retryWorkflowRun?.data);
    const retryBlockers = objectValue(retryWorkflowRun?.blockers);
    const retrySteps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, retrySchedule.workflowStepIds));

    expect(retryWorkflowRun?.state).toBe("adapter_retry_scheduled");
    expect(retryBlockers.open).toEqual(["adapter_retry_pending", "external_execution_blocked"]);
    expect(objectValue(retryWorkflowData.lastAdapterReconciliation).decision).toBe(
      "retry_scheduled",
    );
    expect(retrySteps.filter((step) => step.workflowRunId === first.workflowRunId)).toHaveLength(2);
    expect(
      retrySteps
        .filter((step) => step.workflowRunId === first.workflowRunId)
        .every((step) => step.kind === "adapter_reconciliation" && step.toState === "adapter_retry_scheduled"),
    ).toBe(true);

    const retryExecution = await executeWorkerCommand({
      command: "adapters.retry",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      config: {
        limit: 100,
      },
    });
    const retryOutput = objectValue(retryExecution.result);

    expect(stringList(retryOutput.retryRunIds)).toContain(first.adapterRunId);
    expect(stringList(retryOutput.retryActionIds)).toContain(first.adapterActionId);

    const postRetry = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T01:10:00.000Z"),
      db,
    });

    expect(postRetry.matched).toBeGreaterThanOrEqual(2);
    expect(postRetry.workflowStepIds.length).toBeGreaterThanOrEqual(2);

    const [postRetryWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const postRetryWorkflowData = objectValue(postRetryWorkflowRun?.data);
    const postRetryBlockers = objectValue(postRetryWorkflowRun?.blockers);
    const postRetrySteps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, postRetry.workflowStepIds));

    expect(postRetryWorkflowRun?.state).toBe("post_retry_reconciled");
    expect(postRetryBlockers.open).toEqual([
      "external_execution_blocked",
      "scoped_live_credentials_required",
    ]);
    expect(objectValue(postRetryWorkflowData.lastAdapterReconciliation).decision).toBe("matched");
    expect(
      postRetrySteps
        .filter((step) => step.workflowRunId === first.workflowRunId)
        .every((step) => step.kind === "adapter_reconciliation" && step.toState === "post_retry_reconciled"),
    ).toBe(true);
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

  it("creates retry tasks for failed adapter rows that still have attempts remaining", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-retry-${runId}`;
    const createdAt = new Date("2000-01-01T00:00:00.000Z");
    const now = new Date("2026-05-19T00:00:00.000Z");
    const nextAttemptAt = new Date("2026-05-19T00:05:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_retry_check",
      idempotencyKey: `${key}:run`,
      state: "failed",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "adapter_timeout",
      },
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
      createdAt,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "failed",
      mode: "dry_run",
      operation: "ci_retry_check",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "adapter_timeout",
      },
      createdAt,
      updatedAt: createdAt,
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now,
      db,
    });

    expect(result.processed).toBe(2);
    expect(result.retryScheduled).toBe(2);
    expect(result.needsReview).toBe(0);
    expect(result.retryTaskIds).toHaveLength(2);
    expect(result.reviewTaskIds).toHaveLength(0);
    expect(result.taskIds).toEqual(expect.arrayContaining(result.retryTaskIds));

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const retryTasks = await db.select().from(tasks).where(inArray(tasks.id, result.retryTaskIds));
    const retryEvents = await db.select().from(events).where(inArray(events.taskId, result.retryTaskIds));
    const retryEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.taskId, result.retryTaskIds));

    expect(run?.state).toBe("queued");
    expect(run?.attempt).toBe(2);
    expect(run?.reconciliationState).toBe("retry_scheduled");
    expect(run?.nextAttemptAt?.toISOString()).toBe(nextAttemptAt.toISOString());
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("queued");
    expect(action?.attempt).toBe(2);
    expect(action?.reconciliationState).toBe("retry_scheduled");
    expect(action?.nextAttemptAt?.toISOString()).toBe(nextAttemptAt.toISOString());
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    expect(retryTasks).toHaveLength(2);
    for (const task of retryTasks) {
      expect(task.state).toBe("waiting");
      expect(task.priority).toBe("normal");
      expect(task.ownerType).toBe("system");
      expect(task.ownerRef).toBe("system:adapter-reconciliation");
      expect(task.dueAt?.toISOString()).toBe(nextAttemptAt.toISOString());
      expect(objectValue(task.outcome).decision).toBe("retry_scheduled");
      expect(objectValue(task.outcome).externalExecution).toBe("blocked");
      expect(objectValue(task.outcome).executable).toBe(false);
    }
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents.every((event) => event.type === "adapter.retry_task.created")).toBe(true);
    expect(retryEvidence.length).toBeGreaterThanOrEqual(2);
    expect(retryEvidence.some((item) => item.name === "Adapter retry task created")).toBe(true);
    expect(retryEvidence.every((item) => objectValue(item.data).externalExecution === "blocked")).toBe(
      true,
    );

    const retryExecution = await executeWorkerCommand({
      command: "adapters.retry",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      config: {
        limit: 1,
      },
    });
    const retryOutput = objectValue(retryExecution.result);

    expect(retryExecution.command).toBe("adapters.retry");
    expect(retryOutput.processed).toBe(2);
    expect(retryOutput.runs).toBe(1);
    expect(retryOutput.actions).toBe(1);
    expect(retryOutput.retryRunIds).toEqual([runId]);
    expect(retryOutput.retryActionIds).toEqual([actionId]);
    expect(retryOutput.closedRetryTaskIds).toEqual(
      expect.arrayContaining(result.retryTaskIds),
    );

    const [retriedRun] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [retriedAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const closedRetryTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, result.retryTaskIds));
    const retryExecutionEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.id, stringList(retryOutput.evidenceIds)));

    expect(retriedRun?.state).toBe("done");
    expect(retriedRun?.reconciliationState).toBe("pending");
    expect(retriedRun?.nextAttemptAt).toBeNull();
    expect(objectValue(retriedRun?.error)).toEqual({});
    expect(objectValue(retriedRun?.receipt).externalMutation).toBe(false);
    expect(objectValue(retriedRun?.receipt).externalSend).toBe(false);
    expect(retriedAction?.state).toBe("done");
    expect(retriedAction?.reconciliationState).toBe("pending");
    expect(retriedAction?.nextAttemptAt).toBeNull();
    expect(objectValue(retriedAction?.error)).toEqual({});
    expect(objectValue(retriedAction?.receipt).externalMutation).toBe(false);
    expect(objectValue(retriedAction?.receipt).externalSend).toBe(false);
    expect(closedRetryTasks.every((task) => task.state === "done")).toBe(true);
    expect(
      closedRetryTasks.every(
        (task) => objectValue(task.outcome).status === "adapter_retry_executed",
      ),
    ).toBe(true);
    expect(retryExecutionEvidence).toHaveLength(2);
    expect(retryExecutionEvidence.every((item) => item.name === "Adapter retry executed")).toBe(true);
    expect(
      retryExecutionEvidence.every(
        (item) => objectValue(item.data).externalExecution === "blocked",
      ),
    ).toBe(true);

    const retryReconcile = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now: new Date("2026-05-19T00:10:00.000Z"),
      db,
    });

    expect(retryReconcile.processed).toBe(2);
    expect(retryReconcile.matched).toBe(2);

    const [matchedRun] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [matchedAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);

    expect(matchedRun?.reconciliationState).toBe("matched");
    expect(matchedAction?.reconciliationState).toBe("matched");
  }, 120_000);

  it("creates review tasks for failed adapter rows that exhausted retries", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-review-${runId}`;
    const createdAt = new Date("2000-01-01T00:01:00.000Z");
    const now = new Date("2026-05-19T00:00:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_review_check",
      idempotencyKey: `${key}:run`,
      state: "failed",
      attempt: 3,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "max_retries_exhausted",
      },
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
      createdAt,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "failed",
      mode: "dry_run",
      operation: "ci_review_check",
      attempt: 3,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "max_retries_exhausted",
      },
      createdAt,
      updatedAt: createdAt,
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now,
      db,
    });

    expect(result.processed).toBe(2);
    expect(result.retryScheduled).toBe(0);
    expect(result.needsReview).toBe(2);
    expect(result.reviewTaskIds).toHaveLength(2);
    expect(result.retryTaskIds).toHaveLength(0);
    expect(result.taskIds).toEqual(expect.arrayContaining(result.reviewTaskIds));

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const reviewTasks = await db.select().from(tasks).where(inArray(tasks.id, result.reviewTaskIds));
    const reviewEvents = await db
      .select()
      .from(events)
      .where(inArray(events.taskId, result.reviewTaskIds));
    const reviewEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.taskId, result.reviewTaskIds));

    expect(run?.state).toBe("failed");
    expect(run?.attempt).toBe(3);
    expect(run?.reconciliationState).toBe("needs_review");
    expect(run?.nextAttemptAt).toBeNull();
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("failed");
    expect(action?.attempt).toBe(3);
    expect(action?.reconciliationState).toBe("needs_review");
    expect(action?.nextAttemptAt).toBeNull();
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    expect(reviewTasks).toHaveLength(2);
    for (const task of reviewTasks) {
      expect(task.state).toBe("blocked");
      expect(task.priority).toBe("high");
      expect(task.ownerType).toBe("system");
      expect(task.ownerRef).toBe("system:adapter-reconciliation");
      expect(task.dueAt?.toISOString()).toBe(now.toISOString());
      expect(objectValue(task.outcome).decision).toBe("needs_review");
      expect(objectValue(task.outcome).externalExecution).toBe("blocked");
      expect(objectValue(task.outcome).executable).toBe(false);
    }
    expect(reviewEvents).toHaveLength(2);
    expect(reviewEvents.every((event) => event.type === "adapter.review_task.created")).toBe(true);
    expect(reviewEvidence.length).toBeGreaterThanOrEqual(2);
    expect(reviewEvidence.some((item) => item.name === "Adapter review task created")).toBe(true);
    expect(reviewEvidence.every((item) => objectValue(item.data).externalExecution === "blocked")).toBe(
      true,
    );
  }, 120_000);

  it("runs the Owner Chief-of-Staff worker as a read-only brief generator", async () => {
    const runId = randomUUID();
    const result = await executeWorkerCommand({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-brief-${runId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
        includeEvidence: true,
      },
    });
    const ownerResult = result.result as Awaited<ReturnType<typeof import("./owner").generateOwnerBrief>>;
    const score = scoreOwnerBriefRun(ownerResult, ownerBriefEvalCases[0]);

    expect(result.worker.role).toBe("owner_chief_of_staff");
    expect(result.command).toBe("brief.generate");
    expect(ownerResult.created).toBe(true);
    expect(ownerResult.objectId).toBeTruthy();
    expect(ownerResult.objectVersionId).toBeTruthy();
    expect(ownerResult.evidenceId).toBeTruthy();
    expect(ownerResult.documentId).toBeTruthy();
    expect(ownerResult.packetId).toBeTruthy();
    expect(ownerResult.workflowRunId).toBeTruthy();
    expect(ownerResult.workflowStepIds).toHaveLength(3);
    expect(ownerResult.decisionIds.length).toBeGreaterThanOrEqual(1);
    expect(ownerResult.viewIds).toHaveLength(3);
    expect(score.passed).toBe(true);

    const [briefObject] = await db.select().from(objects).where(eq(objects.id, ownerResult.objectId ?? "")).limit(1);
    const [version] = await db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.id, ownerResult.objectVersionId ?? ""))
      .limit(1);
    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, ownerResult.packetId ?? ""))
      .limit(1);
    const [run] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, ownerResult.workerRunId ?? ""))
      .limit(1);
    const [ownerWorker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "owner_chief_of_staff"))
      .limit(1);
    const replay = await executeWorkerCommand({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-brief-${runId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks"],
      },
    });
    const replayResult = replay.result as Awaited<ReturnType<typeof import("./owner").generateOwnerBrief>>;

    expect(briefObject?.type).toBe("owner_brief");
    expect(briefObject?.state).toBe("review_ready");
    expect(version?.objectId).toBe(ownerResult.objectId);
    expect(packet?.kind).toBe("owner_brief_packet");
    expect(objectValue(packet?.data).externalExecution).toBe("blocked");
    expect(run?.mode).toBe("read_only");
    expect(run?.workerId).toBe(ownerWorker?.id);
    expect(objectValue(ownerResult.output).externalExecution).toBe("blocked");
    expect(objectValue(ownerResult.output).externalSend).toBe(false);
    expect(replayResult.created).toBe(false);
    expect(replayResult.workerRunId).toBe(ownerResult.workerRunId);
  }, 120_000);
});
