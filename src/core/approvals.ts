import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  adapterActions,
  capabilities,
  documents,
  evidence,
  evidencePackets,
  events,
  filingDrafts,
  objects,
  paymentInstructions,
  payrollRuns,
  tasks,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  workerRuns,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type ApprovalPriority = "low" | "normal" | "high" | "urgent";
type ApprovalRisk = "low" | "medium" | "high" | "critical";

const source = "continuous.approvals";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const priorities = new Set<ApprovalPriority>(["low", "normal", "high", "urgent"]);
const risks = new Set<ApprovalRisk>(["low", "medium", "high", "critical"]);

export type ApprovalDecisionAction = "approved" | "rejected" | "revision_requested";
export type ApprovalSubject = "all" | "worker" | "workflow" | "task";

export type ApprovalRecord = {
  id: string;
  state: string;
  kind: string;
  priority: string;
  risk: string;
  title: string;
  summary: string;
  subject: {
    type: "approval_request" | "task" | "worker_run" | "workflow_run";
    id: string;
  };
  taskId: string | null;
  workerRunId: string | null;
  workflowRunId: string | null;
  eventId: string | null;
  objectId: string | null;
  capabilityId: string | null;
  reviewerUserId: string | null;
  requestedAction: JsonObject;
  evidence: JsonObject;
  policy: JsonObject;
  decision: JsonObject;
  data: JsonObject;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
};

export type ApprovalRequestInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  title: string;
  summary?: string;
  taskId?: string;
  eventId?: string;
  objectId?: string;
  capabilityId?: string;
  reviewerUserId?: string;
  priority?: string;
  risk?: string;
  dueAt?: string;
  requestedAction?: JsonObject;
  evidence?: JsonObject;
  policy?: JsonObject;
  data?: JsonObject;
  db?: Database;
};

export type ApprovalRequestResult = {
  created: boolean;
  approvalId: string;
  approvalRequestId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  approval: ApprovalRecord;
};

function approvalSubject(row: typeof approvalRequests.$inferSelect): ApprovalRecord["subject"] {
  if (row.workerRunId) {
    return { type: "worker_run", id: row.workerRunId };
  }

  if (row.workflowRunId) {
    return { type: "workflow_run", id: row.workflowRunId };
  }

  if (row.taskId) {
    return { type: "task", id: row.taskId };
  }

  return { type: "approval_request", id: row.id };
}

function approvalRecord(row: typeof approvalRequests.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    state: row.state,
    kind: row.kind,
    priority: row.priority,
    risk: row.risk,
    title: row.title,
    summary: row.summary,
    subject: approvalSubject(row),
    taskId: row.taskId,
    workerRunId: row.workerRunId,
    workflowRunId: row.workflowRunId,
    eventId: row.eventId,
    objectId: row.objectId,
    capabilityId: row.capabilityId,
    reviewerUserId: row.reviewerUserId,
    requestedAction: row.requestedAction,
    evidence: row.evidence,
    policy: row.policy,
    decision: row.decision,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("approval_field_required", `${field} is required.`, 400);
  }

  return output;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError(
      "approval_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return value;
}

function jsonObject(value: JsonObject | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parsePriority(value: string | undefined, fallback: ApprovalPriority): ApprovalPriority {
  if (!value) {
    return fallback;
  }

  if (priorities.has(value as ApprovalPriority)) {
    return value as ApprovalPriority;
  }

  throw new PlatformUnavailableError(
    "approval_priority_invalid",
    "config.priority must be low, normal, high, or urgent.",
    400,
  );
}

function parseRisk(value: string | undefined): ApprovalRisk {
  if (!value) {
    return "medium";
  }

  if (risks.has(value as ApprovalRisk)) {
    return value as ApprovalRisk;
  }

  throw new PlatformUnavailableError(
    "approval_risk_invalid",
    "config.risk must be low, medium, high, or critical.",
    400,
  );
}

function parseDueAt(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const dueAt = new Date(value);

  if (Number.isNaN(dueAt.getTime())) {
    throw new PlatformUnavailableError("approval_due_at_invalid", "config.dueAt must be an ISO date.", 400);
  }

  return dueAt;
}

function taskStateForDecision(action: ApprovalDecisionAction) {
  if (action === "approved") {
    return "waiting";
  }

  if (action === "revision_requested") {
    return "active";
  }

  return "blocked";
}

function subjectCondition(subject: ApprovalSubject) {
  if (subject === "worker") {
    return sql`${approvalRequests.workerRunId} is not null`;
  }

  if (subject === "workflow") {
    return sql`${approvalRequests.workflowRunId} is not null`;
  }

  if (subject === "task") {
    return sql`${approvalRequests.taskId} is not null`;
  }

  return undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function canTransition(transitions: JsonObject, fromState: string, toState: string) {
  return stringArray(transitions[fromState]).includes(toState);
}

function isTerminal(transitions: JsonObject, state: string) {
  return stringArray(transitions[state]).length === 0;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uuidValue(value: unknown) {
  const valueString = stringValue(value);
  return valueString && uuidPattern.test(valueString) ? valueString : undefined;
}

function workflowStateForDecision(action: ApprovalDecisionAction) {
  if (action === "approved") {
    return "approved";
  }

  return action;
}

function payrollRunStateForDecision(action: ApprovalDecisionAction) {
  if (action === "approved") {
    return "approved";
  }

  if (action === "revision_requested") {
    return "review_required";
  }

  return "blocked";
}

function payrollDraftStateForDecision(action: ApprovalDecisionAction) {
  if (action === "approved") {
    return "approved_blocked";
  }

  if (action === "revision_requested") {
    return "revision_requested";
  }

  return "blocked";
}

function uuidList(value: unknown) {
  return stringArray(value).filter((item) => uuidPattern.test(item));
}

export function normalizeApprovalDecision(value: unknown): ApprovalDecisionAction | null {
  if (value === "approved" || value === "rejected" || value === "revision_requested") {
    return value;
  }

  return null;
}

export async function listApprovals(input: {
  operatorEmail: string;
  tenantSlug?: string;
  state?: string;
  subject?: ApprovalSubject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const subject = input.subject ?? "all";
  const conditions = [eq(approvalRequests.tenantId, operator.tenantId)];
  const scopedCondition = subjectCondition(subject);

  if (input.state) {
    conditions.push(eq(approvalRequests.state, input.state));
  }

  if (scopedCondition) {
    conditions.push(scopedCondition);
  }

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(...conditions))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(50);

  return {
    operator: {
      tenantId: operator.tenantId,
      tenantSlug: operator.tenantSlug,
      userId: operator.userId,
      email: operator.email,
      name: operator.name,
    },
    subject,
    approvals: rows.map(approvalRecord),
  };
}

export async function requestApproval(input: ApprovalRequestInput): Promise<ApprovalRequestResult> {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const title = requiredString(input.title, "config.title");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");
  const requestedEventId = optionalUuid(cleanString(input.eventId), "config.eventId");
  const requestedObjectId = optionalUuid(cleanString(input.objectId), "config.objectId");
  const requestedCapabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const requestedReviewerUserId = optionalUuid(cleanString(input.reviewerUserId), "config.reviewerUserId");
  const dueAt = parseDueAt(cleanString(input.dueAt));

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        eventId: auditEvents.eventId,
        approval: approvalRequests,
      })
      .from(auditEvents)
      .innerJoin(approvalRequests, eq(auditEvents.targetId, approvalRequests.id))
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:approval_requested`),
          eq(auditEvents.targetType, "approval_request"),
        ),
      )
      .limit(1);

    if (existingAudit) {
      const [approvalEvidence] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.tenantId, operator.tenantId),
            sql`${evidence.data}->>'auditEventId' = ${existingAudit.auditEventId}`,
          ),
        )
        .limit(1);

      return {
        created: false,
        approvalId: existingAudit.approval.id,
        approvalRequestId: existingAudit.approval.id,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        evidenceId: approvalEvidence?.id ?? null,
        approval: approvalRecord(existingAudit.approval),
      };
    }

    let task: typeof tasks.$inferSelect | null = null;

    if (taskId) {
      const [taskRow] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.tenantId, operator.tenantId), eq(tasks.id, taskId)))
        .limit(1);

      if (!taskRow) {
        throw new PlatformUnavailableError(
          "approval_task_not_found",
          "config.taskId does not match a task in this tenant.",
          404,
        );
      }

      if (taskRow.state === "done" || taskRow.state === "canceled") {
        throw new PlatformUnavailableError(
          "approval_task_terminal",
          "Done or canceled tasks cannot request approval.",
          409,
        );
      }

      task = taskRow;
    }

    const objectId = requestedObjectId ?? task?.objectId ?? undefined;
    const capabilityId = requestedCapabilityId ?? task?.capabilityId ?? undefined;
    const reviewerUserId = requestedReviewerUserId ?? task?.reviewerUserId ?? operator.userId;
    const priority = parsePriority(cleanString(input.priority), (task?.priority ?? "normal") as ApprovalPriority);
    const risk = parseRisk(cleanString(input.risk));

    if (objectId) {
      const [object] = await tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
        .limit(1);

      if (!object) {
        throw new PlatformUnavailableError(
          "approval_object_not_found",
          "config.objectId does not match an object in this tenant.",
          404,
        );
      }
    }

    if (requestedEventId) {
      const [event] = await tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.tenantId, operator.tenantId), eq(events.id, requestedEventId)))
        .limit(1);

      if (!event) {
        throw new PlatformUnavailableError(
          "approval_event_not_found",
          "config.eventId does not match an event in this tenant.",
          404,
        );
      }
    }

    if (capabilityId) {
      const [capability] = await tx
        .select({ id: capabilities.id })
        .from(capabilities)
        .where(and(eq(capabilities.id, capabilityId), eq(capabilities.active, true)))
        .limit(1);

      if (!capability) {
        throw new PlatformUnavailableError(
          "approval_capability_not_found",
          "config.capabilityId does not match an active capability.",
          404,
        );
      }
    }

    const [reviewer] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenantId, operator.tenantId),
          eq(users.id, reviewerUserId),
          eq(users.state, "active"),
        ),
      )
      .limit(1);

    if (!reviewer) {
      throw new PlatformUnavailableError(
        "approval_reviewer_not_found",
        "config.reviewerUserId does not match an active user in this tenant.",
        404,
      );
    }

    const now = new Date();
    const action = {
      ...jsonObject(input.requestedAction),
      externalExecution: "blocked",
    };
    const requestData = {
      ...jsonObject(input.data),
      taskId: taskId ?? null,
      objectId: objectId ?? null,
      capabilityId: capabilityId ?? null,
      requestedByUserId: operator.userId,
      externalExecution: "blocked",
    };
    const [createdEvent] = requestedEventId
      ? [{ id: requestedEventId }]
      : await tx
          .insert(events)
          .values({
            tenantId: operator.tenantId,
            type: "approval.requested",
            source,
            actorType: "user",
            actorId: operator.userId,
            actorRef: operator.actorRef,
            objectId,
            taskId,
            capabilityId,
            idempotencyKey: `${input.idempotencyKey}:approval_requested`,
            data: {
              kind,
              title,
              summary: input.summary ?? "",
              reviewerUserId,
              ...requestData,
            },
            occurredAt: now,
          })
          .returning({ id: events.id });
    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: operator.tenantId,
        taskId,
        eventId: createdEvent.id,
        objectId,
        capabilityId,
        requesterType: "user",
        requesterId: operator.userId,
        requesterRef: operator.actorRef,
        reviewerUserId,
        kind,
        state: "pending",
        priority,
        risk,
        title,
        summary: input.summary ?? "",
        requestedAction: action,
        evidence: {
          ...jsonObject(input.evidence),
          eventId: createdEvent.id,
        },
        policy: jsonObject(input.policy),
        data: requestData,
        dueAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "approval.requested",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "approval_request",
        targetId: approval.id,
        taskId,
        approvalRequestId: approval.id,
        eventId: createdEvent.id,
        objectId,
        capabilityId,
        risk,
        idempotencyKey: `${input.idempotencyKey}:approval_requested`,
        data: {
          approvalRequestId: approval.id,
          reviewerUserId,
          subject: approvalSubject(approval),
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [approvalEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "approval",
        name: `Approval requested: ${title}`,
        objectId,
        taskId,
        eventId: createdEvent.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${approval.id}:requested:${now.toISOString()}`,
        data: {
          approvalRequestId: approval.id,
          auditEventId: audit.id,
          subject: approvalSubject(approval),
          requestedAction: action,
          externalExecution: "blocked",
        },
      })
      .returning({ id: evidence.id });

    const approvalEvidenceData = {
      ...approval.evidence,
      requestEvidenceId: approvalEvidence.id,
      auditEventId: audit.id,
    };
    const [updatedApproval] = await tx
      .update(approvalRequests)
      .set({
        evidence: approvalEvidenceData,
        updatedAt: now,
      })
      .where(eq(approvalRequests.id, approval.id))
      .returning();

    if (taskId) {
      await tx
        .update(tasks)
        .set({
          state: "approval_required",
          outcome: {
            ...task?.outcome,
            approvalRequestId: approval.id,
            approvalEvidenceId: approvalEvidence.id,
            auditEventId: audit.id,
            externalExecution: "blocked",
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));
    }

    return {
      created: true,
      approvalId: approval.id,
      approvalRequestId: approval.id,
      eventId: createdEvent.id,
      auditEventId: audit.id,
      evidenceId: approvalEvidence.id,
      approval: approvalRecord(updatedApproval ?? approval),
    };
  });
}

export async function decideApproval(input: {
  approvalId: string;
  operatorEmail: string;
  tenantSlug?: string;
  action: ApprovalDecisionAction;
  note?: string;
  subject?: ApprovalSubject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const subject = input.subject ?? "all";
  const now = new Date();
  const taskState = taskStateForDecision(input.action);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.approvalId}`}))`,
    );

    const conditions = [
      eq(approvalRequests.tenantId, operator.tenantId),
      eq(approvalRequests.id, input.approvalId),
    ];
    const scopedCondition = subjectCondition(subject);

    if (scopedCondition) {
      conditions.push(scopedCondition);
    }

    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(and(...conditions))
      .limit(1);

    if (!approval) {
      throw new PlatformUnavailableError(
        "approval_not_found",
        "No approval request matches this id and subject.",
        404,
      );
    }

    if (approval.state !== "pending") {
      throw new PlatformUnavailableError(
        "approval_already_decided",
        "Approval request is no longer pending.",
        409,
      );
    }

    const decision = {
      action: input.action,
      note: input.note ?? "",
      decidedByUserId: operator.userId,
      decidedByEmail: operator.email,
      decidedAt: now.toISOString(),
      externalExecution: "blocked",
    };

    await tx
      .update(approvalRequests)
      .set({
        state: input.action,
        decision,
        decidedByUserId: operator.userId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(approvalRequests.id, approval.id));

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "approval.decided",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "approval_request",
        targetId: approval.id,
        taskId: approval.taskId,
        workerRunId: approval.workerRunId,
        approvalRequestId: approval.id,
        eventId: approval.eventId,
        objectId: approval.objectId,
        capabilityId: approval.capabilityId,
        risk: approval.risk,
        data: {
          ...decision,
          subject: approvalSubject(approval),
          workflowRunId: approval.workflowRunId,
          workerRunId: approval.workerRunId,
        },
      })
      .returning({ id: auditEvents.id });

    const [approvalEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "approval",
        name: `Approval ${input.action}`,
        objectId: approval.objectId,
        taskId: approval.taskId,
        eventId: approval.eventId,
        capabilityId: approval.capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${approval.id}:${input.action}:${now.toISOString()}`,
        data: {
          approvalRequestId: approval.id,
          auditEventId: audit.id,
          subject: approvalSubject(approval),
          workflowRunId: approval.workflowRunId,
          workerRunId: approval.workerRunId,
          decision,
        },
      })
      .returning({ id: evidence.id });

    const approvalData = objectValue(approval.data);
    const approvalEvidenceData = objectValue(approval.evidence);
    const requestedAction = objectValue(approval.requestedAction);
    const adapterRunId = uuidValue(approvalData.adapterRunId ?? approvalEvidenceData.adapterRunId);
    const adapterActionId = uuidValue(
      requestedAction.adapterActionId ?? approvalData.adapterActionId ?? approvalEvidenceData.adapterActionId,
    );
    const adapterReceiptEvidenceId = uuidValue(
      approvalData.adapterReceiptEvidenceId ?? approvalEvidenceData.adapterReceiptEvidenceId,
    );
    const continuation = {
      status:
        input.action === "approved"
          ? "approved_waiting_internal_continuation"
          : input.action === "revision_requested"
            ? "revision_requested"
            : "rejected_closed",
      approvalRequestId: approval.id,
      auditEventId: audit.id,
      evidenceId: approvalEvidence.id,
      workerRunId: approval.workerRunId,
      workflowRunId: approval.workflowRunId,
      adapterRunId: adapterRunId ?? null,
      adapterActionId: adapterActionId ?? null,
      adapterReceiptEvidenceId: adapterReceiptEvidenceId ?? null,
      externalExecution: "blocked",
      externalSend: false,
      adapterMode: "dry_run",
    };

    await tx
      .update(approvalRequests)
      .set({
        decision: {
          ...decision,
          continuation,
        },
      })
      .where(eq(approvalRequests.id, approval.id));

    if (approval.taskId) {
      const [task] = await tx
        .select({ outcome: tasks.outcome })
        .from(tasks)
        .where(and(eq(tasks.tenantId, operator.tenantId), eq(tasks.id, approval.taskId)))
        .limit(1);

      await tx
        .update(tasks)
        .set({
          state: taskState,
          outcome: {
            ...objectValue(task?.outcome),
            status: `approval_${input.action}`,
            approvalRequestId: approval.id,
            approvalEvidenceId: approvalEvidence.id,
            auditEventId: audit.id,
            continuation,
            externalExecution: "blocked",
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, approval.taskId));
    }

    let workflowRunState: string | null = null;
    let workflowStepId: string | null = null;
    let payrollHandoff: JsonObject | null = null;

    if (approval.workflowRunId) {
      const [workflow] = await tx
        .select({
          run: workflowRuns,
          definition: workflowDefinitions,
        })
        .from(workflowRuns)
        .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
        .where(
          and(
            eq(workflowRuns.tenantId, operator.tenantId),
            eq(workflowRuns.id, approval.workflowRunId),
          ),
        )
        .limit(1);

      if (workflow) {
        const decisionState = workflowStateForDecision(input.action);
        const nextState = canTransition(workflow.definition.transitions, workflow.run.state, decisionState)
          ? decisionState
          : workflow.run.state;

        workflowRunState = nextState;

        const [workflowStep] = await tx
          .insert(workflowSteps)
          .values({
            tenantId: operator.tenantId,
            definitionId: workflow.definition.id,
            workflowRunId: workflow.run.id,
            eventId: approval.eventId,
            approvalRequestId: approval.id,
            taskId: approval.taskId,
            objectId: approval.objectId,
            workerId: workflow.run.workerId,
            capabilityId: approval.capabilityId,
            kind: "approval_decision",
            name: `${workflow.definition.key}:approval:${input.action}`,
            state: "done",
            priority: approval.priority,
            risk: approval.risk,
            fromState: workflow.run.state,
            toState: nextState,
            attempt: 1,
            maxAttempts: 1,
            leaseOwner: operator.actorRef,
            leasedUntil: now,
            idempotencyKey: `${approval.id}:approval:${input.action}`,
            input: {
              approvalRequestId: approval.id,
              workflowRunId: workflow.run.id,
              action: input.action,
              note: input.note ?? "",
            },
            output: {
              auditEventId: audit.id,
              evidenceId: approvalEvidence.id,
              continuation,
              externalExecution: "blocked",
            },
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .returning({ id: workflowSteps.id });

        workflowStepId = workflowStep.id;

        await tx
          .update(workflowRuns)
          .set({
            state: nextState,
            data: {
              ...workflow.run.data,
              lastApprovalDecision: {
                approvalRequestId: approval.id,
                auditEventId: audit.id,
                evidenceId: approvalEvidence.id,
                workflowStepId,
                continuation,
                ...decision,
              },
            },
            updatedAt: now,
            completedAt: isTerminal(workflow.definition.transitions, nextState)
              ? (workflow.run.completedAt ?? now)
              : workflow.run.completedAt,
          })
          .where(eq(workflowRuns.id, workflow.run.id));
      }
    }

    if (approval.workerRunId) {
      const [workerRun] = await tx
        .select({ data: workerRuns.data })
        .from(workerRuns)
        .where(and(eq(workerRuns.tenantId, operator.tenantId), eq(workerRuns.id, approval.workerRunId)))
        .limit(1);
      const workerRunData = objectValue(workerRun?.data);
      const output = objectValue(workerRunData.output);

      await tx
        .update(workerRuns)
        .set({
          data: {
            ...workerRunData,
            output: {
              ...output,
              approvalDecision: {
                ...decision,
                workflowStepId,
                continuation,
              },
              externalExecution: "blocked",
              externalSend: false,
            },
            lastApprovalDecision: {
              ...decision,
              workflowStepId,
              continuation,
            },
          },
          updatedAt: now,
        })
        .where(eq(workerRuns.id, approval.workerRunId));
    }

    if (adapterActionId) {
      const adapterConditions = [
        eq(adapterActions.tenantId, operator.tenantId),
        eq(adapterActions.id, adapterActionId),
      ];

      if (approval.workerRunId && adapterRunId) {
        adapterConditions.push(eq(adapterActions.adapterRunId, adapterRunId));
      }

      const [adapterAction] = await tx
        .select({
          response: adapterActions.response,
          receipt: adapterActions.receipt,
        })
        .from(adapterActions)
        .where(and(...adapterConditions))
        .limit(1);

      if (adapterAction) {
        await tx
          .update(adapterActions)
          .set({
            response: {
              ...adapterAction.response,
              continuation,
              externalExecution: "blocked",
              externalSend: false,
            },
            receipt: {
              ...adapterAction.receipt,
              continuation,
              externalMutation: false,
              externalSend: false,
            },
          })
          .where(eq(adapterActions.id, adapterActionId));
      }
    }

    const payrollRunId = uuidValue(approvalData.payrollRunId ?? approvalEvidenceData.payrollRunId);

    if (approval.kind === "payroll_preview_approval") {
      if (!payrollRunId) {
        throw new PlatformUnavailableError(
          "payroll_approval_run_required",
          "Payroll approval is missing its payroll run reference.",
          409,
        );
      }

      const [payrollRun] = await tx
        .select({ id: payrollRuns.id, data: payrollRuns.data })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRunId)))
        .limit(1);

      if (!payrollRun) {
        throw new PlatformUnavailableError(
          "payroll_approval_run_not_found",
          "Payroll approval does not reference a payroll run in this tenant.",
          404,
        );
      }

      const packetId = uuidValue(approvalData.packetId ?? approvalEvidenceData.packetId);
      const packetDocumentId = uuidValue(approvalData.packetDocumentId ?? approvalEvidenceData.packetDocumentId);
      const filingDraftId = uuidValue(approvalData.filingDraftId ?? approvalEvidenceData.filingDraftId);
      const paymentInstructionIds = uuidList(
        approvalEvidenceData.paymentInstructionIds ?? approvalData.paymentInstructionIds,
      );
      const payrollRunState = payrollRunStateForDecision(input.action);
      const draftState = payrollDraftStateForDecision(input.action);
      const handoff = {
        action: input.action,
        state: payrollRunState,
        draftState,
        approvalRequestId: approval.id,
        auditEventId: audit.id,
        evidenceId: approvalEvidence.id,
        packetId: packetId ?? null,
        packetDocumentId: packetDocumentId ?? null,
        filingDraftId: filingDraftId ?? null,
        paymentInstructionIds,
        externalExecution: "blocked",
        moneyMovement: "blocked",
        submission: "blocked",
        decidedAt: now.toISOString(),
      };

      payrollHandoff = handoff;

      await tx
        .update(payrollRuns)
        .set({
          state: payrollRunState,
          data: {
            ...objectValue(payrollRun.data),
            approvalDecision: decision,
            handoff,
          },
          updatedAt: now,
        })
        .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRun.id)));

      if (paymentInstructionIds.length > 0) {
        await tx
          .update(paymentInstructions)
          .set({
            state: draftState,
            data: sql`jsonb_set(jsonb_set(jsonb_set(${paymentInstructions.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true), '{externalExecution}', '"blocked"'::jsonb, true)`,
            updatedAt: now,
          })
          .where(
            and(
              eq(paymentInstructions.tenantId, operator.tenantId),
              inArray(paymentInstructions.id, paymentInstructionIds),
            ),
          );
      }

      if (filingDraftId) {
        await tx
          .update(filingDrafts)
          .set({
            state: draftState,
            data: sql`jsonb_set(jsonb_set(jsonb_set(${filingDrafts.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true), '{externalExecution}', '"blocked"'::jsonb, true)`,
            updatedAt: now,
          })
          .where(and(eq(filingDrafts.tenantId, operator.tenantId), eq(filingDrafts.id, filingDraftId)));
      }

      if (packetId) {
        await tx
          .update(evidencePackets)
          .set({
            state: input.action,
            data: sql`jsonb_set(jsonb_set(${evidencePackets.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true)`,
            updatedAt: now,
          })
          .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, packetId)));
      }

      if (packetDocumentId) {
        await tx
          .update(documents)
          .set({
            state: input.action,
            data: sql`jsonb_set(jsonb_set(${documents.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true)`,
            updatedAt: now,
          })
          .where(and(eq(documents.tenantId, operator.tenantId), eq(documents.id, packetDocumentId)));
      }

      const [payrollEvent] = await tx
        .insert(events)
        .values({
          tenantId: operator.tenantId,
          type: "payroll.preview.approval.applied",
          source,
          actorType: "user",
          actorId: operator.userId,
          actorRef: operator.actorRef,
          objectId: approval.objectId,
          idempotencyKey: `${approval.id}:payroll_preview_approval:${input.action}`,
          data: handoff,
          occurredAt: now,
        })
        .returning({ id: events.id });
      const [payrollAudit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: operator.tenantId,
          type: "payroll.preview.approval.applied",
          source,
          actorType: "user",
          actorId: operator.userId,
          actorRef: operator.actorRef,
          targetType: "payroll_run",
          targetId: payrollRun.id,
          approvalRequestId: approval.id,
          eventId: payrollEvent.id,
          objectId: approval.objectId,
          risk: "high",
          idempotencyKey: `${approval.id}:payroll_preview_approval:${input.action}`,
          data: handoff,
        })
        .returning({ id: auditEvents.id });

      await tx.insert(evidence).values({
        tenantId: operator.tenantId,
        kind: "approval",
        name: `Payroll preview approval ${input.action}`,
        objectId: approval.objectId,
        eventId: payrollEvent.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${approval.id}:payroll:${input.action}:${now.toISOString()}`,
        data: {
          ...handoff,
          auditEventId: payrollAudit.id,
          approvalDecisionEvidenceId: approvalEvidence.id,
        },
      });
    }

    const [updatedApproval] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approval.id))
      .limit(1);

    return {
      approval: approvalRecord(updatedApproval ?? approval),
      auditEventId: audit.id,
      evidenceId: approvalEvidence.id,
      taskState,
      workflowRunState,
      workflowStepId,
      payrollHandoff,
    };
  });
}
