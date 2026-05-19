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
import { createCoreTask, transitionCoreTask } from "../core/tasks";
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
  objects,
  objectLinks,
  objectVersions,
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
    expect(output.status).toBe("revision_continuation_queued");
    expect(output.nextAction).toBe("prepare_revised_packet");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, continuation.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const revisionContinuation = objectValue(workflowData.revisionContinuation);

    expect(workflowRun?.state).toBe("revision_requested");
    expect(revisionContinuation.workerRunId).toBe(continuation.workerRunId);
    expect(revisionContinuation.action).toBe("revision_requested");
    expect(workflowData.workflowStepIds).toContain(continuation.workflowStepId);

    const [continuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, continuation.workflowStepId ?? ""))
      .limit(1);
    const stepOutput = objectValue(continuationStep?.output);

    expect(continuationStep?.kind).toBe("worker_continuation");
    expect(continuationStep?.fromState).toBe("revision_requested");
    expect(continuationStep?.toState).toBe("revision_requested");
    expect(stepOutput.nextAction).toBe("prepare_revised_packet");
    expect(stepOutput.externalExecution).toBe("blocked");
    expect(stepOutput.externalSend).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, continuation.taskId ?? ""))
      .limit(1);
    const taskOutcome = objectValue(task?.outcome);

    expect(task?.state).toBe("active");
    expect(taskOutcome.status).toBe("revision_continuation_queued");
    expect(objectValue(taskOutcome.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );

    const [originalWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const originalOutput = objectValue(objectValue(originalWorkerRun?.data).output);

    expect(objectValue(originalOutput.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );
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
    expect(objectValue(replay.output).status).toBe("revision_continuation_queued");
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
