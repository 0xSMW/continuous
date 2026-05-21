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
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
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
export type ApprovalSubject = "all" | "core" | "worker" | "workflow" | "task";

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
  evidenceRefs: Array<{
    type: string;
    label: string;
    id: string;
  }>;
  policy: JsonObject;
  decision: JsonObject;
  data: JsonObject;
  continuation: {
    decisionSurface: "/approval";
    decisionCommand: "approval.decide";
    description: string;
    postDecisionSurface: "/worker" | "/approval" | null;
    postDecisionCommand: string | null;
    config: JsonObject;
    externalExecution: "blocked";
  };
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

type ApprovalDecisionReplay = {
  evidenceId: string | null;
  taskState: string;
  workflowRunState: string | null;
  workflowStepId: string | null;
  payrollHandoff: JsonObject | null;
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

function appendApprovalRef(
  refs: ApprovalRecord["evidenceRefs"],
  seen: Set<string>,
  type: string,
  label: string,
  value: unknown,
) {
  const id = stringValue(value);

  if (!id || !uuidPattern.test(id)) {
    return;
  }

  const key = `${type}:${id}`;

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  refs.push({ type, label, id });
}

function approvalEvidenceRefs(row: typeof approvalRequests.$inferSelect): ApprovalRecord["evidenceRefs"] {
  const refs: ApprovalRecord["evidenceRefs"] = [];
  const seen = new Set<string>();
  const action = objectValue(row.requestedAction);
  const evidenceData = objectValue(row.evidence);
  const rowData = objectValue(row.data);
  const decision = objectValue(row.decision);
  const continuation = objectValue(decision.continuation);

  appendApprovalRef(refs, seen, "approval_request", "Approval request", row.id);
  appendApprovalRef(refs, seen, "task", "Task", row.taskId);
  appendApprovalRef(refs, seen, "worker_run", "Worker run", row.workerRunId);
  appendApprovalRef(refs, seen, "workflow_run", "Workflow run", row.workflowRunId);
  appendApprovalRef(refs, seen, "event", "Event", row.eventId ?? evidenceData.eventId);
  appendApprovalRef(refs, seen, "object", "Object", row.objectId ?? evidenceData.objectId);
  appendApprovalRef(refs, seen, "capability", "Capability", row.capabilityId ?? evidenceData.capabilityId);
  appendApprovalRef(refs, seen, "evidence", "Request evidence", evidenceData.requestEvidenceId);
  appendApprovalRef(refs, seen, "evidence", "Approval evidence", evidenceData.approvalEvidenceId);
  appendApprovalRef(refs, seen, "evidence", "Source snapshot", evidenceData.sourceSnapshotEvidenceId);
  appendApprovalRef(refs, seen, "evidence", "Adapter receipt", evidenceData.adapterReceiptEvidenceId);
  appendApprovalRef(refs, seen, "audit_event", "Audit event", evidenceData.auditEventId);
  appendApprovalRef(refs, seen, "adapter_run", "Adapter run", evidenceData.adapterRunId ?? rowData.adapterRunId);
  appendApprovalRef(
    refs,
    seen,
    "adapter_action",
    "Adapter action",
    action.adapterActionId ?? evidenceData.adapterActionId ?? rowData.adapterActionId,
  );
  appendApprovalRef(refs, seen, "evidence_packet", "Evidence packet", evidenceData.packetId ?? rowData.packetId);
  appendApprovalRef(
    refs,
    seen,
    "document",
    "Packet document",
    evidenceData.packetDocumentId ?? rowData.packetDocumentId,
  );
  appendApprovalRef(
    refs,
    seen,
    "ui_contract",
    "Approval view",
    rowData.quoteApprovalViewId ?? evidenceData.quoteApprovalViewId ?? action.quoteApprovalViewId,
  );
  appendApprovalRef(refs, seen, "payroll_run", "Payroll run", evidenceData.payrollRunId ?? rowData.payrollRunId);
  appendApprovalRef(refs, seen, "filing_draft", "Filing draft", evidenceData.filingDraftId ?? rowData.filingDraftId);
  appendApprovalRef(refs, seen, "workflow_step", "Workflow step", continuation.workflowStepId);

  for (const paymentInstructionId of uuidList(evidenceData.paymentInstructionIds ?? rowData.paymentInstructionIds)) {
    appendApprovalRef(refs, seen, "payment_instruction", "Payment instruction", paymentInstructionId);
  }

  return refs;
}

function approvalContinuation(row: typeof approvalRequests.$inferSelect): ApprovalRecord["continuation"] {
  const subject = approvalSubject(row);
  const subjectScope =
    subject.type === "worker_run"
      ? "worker"
      : subject.type === "workflow_run"
        ? "workflow"
        : subject.type === "task"
          ? "task"
          : "core";
  const base = {
    decisionSurface: "/approval" as const,
    decisionCommand: "approval.decide" as const,
    externalExecution: "blocked" as const,
  };

  if (row.kind === "payroll_preview_approval") {
    return {
      ...base,
      description:
        "Deciding this payroll approval records the payroll handoff while funding, tax submission, and money movement remain blocked.",
      postDecisionSurface: "/approval",
      postDecisionCommand: "approval.decide",
      config: { approvalId: row.id, subject: subjectScope, kind: row.kind },
    };
  }

  if (subject.type === "worker_run") {
    return {
      ...base,
      description:
        "Decide here first, then continue the worker through /worker with command=continue and config.approvalId.",
      postDecisionSurface: "/worker",
      postDecisionCommand: "continue",
      config: { approvalId: row.id, workerRunId: subject.id },
    };
  }

  if (subject.type === "workflow_run") {
    return {
      ...base,
      description:
        "Deciding this request records the workflow approval decision and advances the workflow only through allowed states.",
      postDecisionSurface: "/approval",
      postDecisionCommand: "approval.decide",
      config: { approvalId: row.id, workflowRunId: subject.id },
    };
  }

  if (subject.type === "task") {
    return {
      ...base,
      description:
        "Deciding this request updates the linked task outcome and keeps external execution blocked.",
      postDecisionSurface: "/approval",
      postDecisionCommand: "approval.decide",
      config: { approvalId: row.id, taskId: subject.id },
    };
  }

  return {
    ...base,
    description: "Deciding this request records shared approval evidence and audit proof.",
    postDecisionSurface: "/approval",
    postDecisionCommand: "approval.decide",
    config: { approvalId: row.id, subject: subjectScope, kind: row.kind },
  };
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
    evidenceRefs: approvalEvidenceRefs(row),
    policy: row.policy,
    decision: row.decision,
    data: row.data,
    continuation: approvalContinuation(row),
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
  if (subject === "core") {
    return sql`${approvalRequests.workerRunId} is null and ${approvalRequests.workflowRunId} is null and ${approvalRequests.taskId} is null`;
  }

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

function requiredUuidList(value: unknown, field: string) {
  const values = stringArray(value);

  if (values.length === 0) {
    throw new PlatformUnavailableError(
      "payroll_approval_artifact_required",
      `${field} must include at least one UUID.`,
      409,
    );
  }

  const invalid = values.find((item) => !uuidPattern.test(item));

  if (invalid) {
    throw new PlatformUnavailableError(
      "payroll_approval_artifact_invalid",
      `${field} contains an invalid UUID.`,
      409,
    );
  }

  return [...new Set(values)];
}

function requirePayrollArtifactRef(value: string | undefined, code: string, message: string) {
  if (!value) {
    throw new PlatformUnavailableError(code, message, 409);
  }

  return value;
}

function assertBlockedArtifact(data: unknown, code: string, message: string) {
  if (objectValue(data).externalExecution !== "blocked") {
    throw new PlatformUnavailableError(code, message, 409);
  }
}

function replayFromAudit(data: unknown, fallback: ApprovalDecisionReplay): ApprovalDecisionReplay {
  const replay = objectValue(objectValue(data).replay);
  const payrollHandoff = objectValue(replay.payrollHandoff);

  return {
    evidenceId: uuidValue(replay.evidenceId) ?? fallback.evidenceId,
    taskState: stringValue(replay.taskState) ?? fallback.taskState,
    workflowRunState: stringValue(replay.workflowRunState) ?? fallback.workflowRunState,
    workflowStepId: uuidValue(replay.workflowStepId) ?? fallback.workflowStepId,
    payrollHandoff: Object.keys(payrollHandoff).length > 0 ? payrollHandoff : fallback.payrollHandoff,
  };
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
  priority?: string;
  risk?: string;
  kind?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const subject = input.subject ?? "all";
  const priority = input.priority ? parsePriority(input.priority, "normal") : undefined;
  const risk = input.risk ? parseRisk(input.risk) : undefined;
  const kind = cleanString(input.kind);
  const conditions = [eq(approvalRequests.tenantId, operator.tenantId)];
  const scopedCondition = subjectCondition(subject);

  if (input.state) {
    conditions.push(eq(approvalRequests.state, input.state));
  }

  if (priority) {
    conditions.push(eq(approvalRequests.priority, priority));
  }

  if (risk) {
    conditions.push(eq(approvalRequests.risk, risk));
  }

  if (kind) {
    conditions.push(eq(approvalRequests.kind, kind));
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
    filters: {
      state: input.state ?? "all",
      priority: priority ?? "all",
      risk: risk ?? "all",
      kind: kind ?? "all",
    },
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
  const summary = input.summary ?? "";
  const requestedAction = jsonObject(input.requestedAction);
  const evidenceData = jsonObject(input.evidence);
  const policy = jsonObject(input.policy);
  const data = jsonObject(input.data);
  const idempotency = coreIdempotencyFingerprint("approval.request", {
    kind,
    title,
    summary,
    taskId: taskId ?? null,
    eventId: requestedEventId ?? null,
    objectId: requestedObjectId ?? null,
    capabilityId: requestedCapabilityId ?? null,
    reviewerUserId: requestedReviewerUserId ?? null,
    priority: cleanString(input.priority) ?? null,
    risk: cleanString(input.risk) ?? null,
    dueAt: dueAt?.toISOString() ?? null,
    requestedAction,
    evidence: evidenceData,
    policy,
    data,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        eventId: auditEvents.eventId,
        data: auditEvents.data,
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
      assertCoreIdempotencyReplay({
        command: "approval.request",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

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
      ...requestedAction,
      externalExecution: "blocked",
    };
    const requestData = {
      ...data,
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
              summary,
              reviewerUserId,
              idempotency,
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
        summary,
        requestedAction: action,
        evidence: {
          ...evidenceData,
          eventId: createdEvent.id,
        },
        policy,
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
          idempotency,
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
          idempotency,
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
  idempotencyKey: string;
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
  const subject = input.subject ?? "core";
  const now = new Date();
  const note = input.note ?? "";
  const taskState = taskStateForDecision(input.action);
  const idempotency = coreIdempotencyFingerprint("approval.decide", {
    approvalId: input.approvalId,
    subject,
    action: input.action,
    note,
    decidedByUserId: operator.userId,
  });
  const decisionIdempotencyKey = `${input.idempotencyKey}:approval_decided`;

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

    const [existingDecision] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        data: auditEvents.data,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, decisionIdempotencyKey),
          eq(auditEvents.targetType, "approval_request"),
        ),
      )
      .limit(1);

    if (existingDecision) {
      assertCoreIdempotencyReplay({
        command: "approval.decide",
        fingerprint: idempotency,
        storedData: existingDecision.data,
      });

      if (existingDecision.targetId !== approval.id) {
        throw new PlatformUnavailableError(
          "core_command_idempotency_conflict",
          "An approval.decide command already exists for this idempotency key with a different approval target.",
          409,
        );
      }

      const [approvalEvidence] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.tenantId, operator.tenantId),
            sql`${evidence.data}->>'auditEventId' = ${existingDecision.auditEventId}`,
          ),
        )
        .limit(1);
      const replay = replayFromAudit(existingDecision.data, {
        evidenceId: approvalEvidence?.id ?? null,
        taskState,
        workflowRunState: null,
        workflowStepId: null,
        payrollHandoff: null,
      });

      return {
        approval: approvalRecord(approval),
        auditEventId: existingDecision.auditEventId,
        ...replay,
      };
    }

    if (approval.state !== "pending") {
      throw new PlatformUnavailableError(
        "approval_already_decided",
        "Approval request is no longer pending.",
        409,
      );
    }

    if (approval.reviewerUserId && approval.reviewerUserId !== operator.userId) {
      throw new PlatformUnavailableError(
        "approval_reviewer_forbidden",
        "Only the assigned approval reviewer can decide this approval request.",
        403,
      );
    }

    const decision = {
      action: input.action,
      note,
      decidedByUserId: operator.userId,
      decidedByEmail: operator.email,
      decidedAt: now.toISOString(),
      externalExecution: "blocked",
      idempotency,
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

    const auditData: JsonObject = {
      ...decision,
      subject: approvalSubject(approval),
      workflowRunId: approval.workflowRunId,
      workerRunId: approval.workerRunId,
      idempotency,
    };
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
        idempotencyKey: decisionIdempotencyKey,
        data: auditData,
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

      const packetId = requirePayrollArtifactRef(
        uuidValue(approvalData.packetId ?? approvalEvidenceData.packetId),
        "payroll_approval_packet_required",
        "Payroll approval is missing its evidence packet reference.",
      );
      let packetDocumentId = uuidValue(approvalData.packetDocumentId ?? approvalEvidenceData.packetDocumentId);
      const filingDraftId = requirePayrollArtifactRef(
        uuidValue(approvalData.filingDraftId ?? approvalEvidenceData.filingDraftId),
        "payroll_approval_filing_draft_required",
        "Payroll approval is missing its filing draft reference.",
      );
      const paymentInstructionIds = requiredUuidList(
        approvalEvidenceData.paymentInstructionIds ?? approvalData.paymentInstructionIds,
        "paymentInstructionIds",
      );

      const [packetRef] = await tx
        .select({ id: evidencePackets.id, documentId: evidencePackets.documentId, data: evidencePackets.data })
        .from(evidencePackets)
        .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, packetId)))
        .limit(1);

      if (!packetRef) {
        throw new PlatformUnavailableError(
          "payroll_approval_packet_not_found",
          "Payroll approval evidence packet does not exist in this tenant.",
          404,
        );
      }

      assertBlockedArtifact(
        packetRef.data,
        "payroll_approval_packet_unblocked",
        "Payroll approval evidence packet is not blocked for external execution.",
      );

      const linkedPacketDocumentId = requirePayrollArtifactRef(
        uuidValue(packetRef.documentId),
        "payroll_approval_packet_document_required",
        "Payroll approval evidence packet is missing its packet document reference.",
      );

      if (packetDocumentId && packetDocumentId !== linkedPacketDocumentId) {
        throw new PlatformUnavailableError(
          "payroll_approval_packet_document_mismatch",
          "Payroll approval packet document does not match the evidence packet.",
          409,
        );
      }

      packetDocumentId = linkedPacketDocumentId;

      const [packetDocument] = await tx
        .select({ id: documents.id, data: documents.data })
        .from(documents)
        .where(and(eq(documents.tenantId, operator.tenantId), eq(documents.id, packetDocumentId)))
        .limit(1);

      if (!packetDocument) {
        throw new PlatformUnavailableError(
          "payroll_approval_packet_document_not_found",
          "Payroll approval packet document does not exist in this tenant.",
          404,
        );
      }

      assertBlockedArtifact(
        packetDocument.data,
        "payroll_approval_packet_document_unblocked",
        "Payroll approval packet document is not blocked for external execution.",
      );

      const [filingDraft] = await tx
        .select({ id: filingDrafts.id, data: filingDrafts.data })
        .from(filingDrafts)
        .where(and(eq(filingDrafts.tenantId, operator.tenantId), eq(filingDrafts.id, filingDraftId)))
        .limit(1);

      if (!filingDraft) {
        throw new PlatformUnavailableError(
          "payroll_approval_filing_draft_not_found",
          "Payroll approval filing draft does not exist in this tenant.",
          404,
        );
      }

      assertBlockedArtifact(
        filingDraft.data,
        "payroll_approval_filing_draft_unblocked",
        "Payroll approval filing draft is not blocked for external execution.",
      );

      const paymentDrafts = await tx
        .select({ id: paymentInstructions.id, data: paymentInstructions.data })
        .from(paymentInstructions)
        .where(
          and(
            eq(paymentInstructions.tenantId, operator.tenantId),
            inArray(paymentInstructions.id, paymentInstructionIds),
          ),
        );

      if (paymentDrafts.length !== paymentInstructionIds.length) {
        throw new PlatformUnavailableError(
          "payroll_approval_payment_instruction_not_found",
          "Payroll approval payment instructions must all exist in this tenant.",
          404,
        );
      }

      for (const paymentDraft of paymentDrafts) {
        const paymentData = objectValue(paymentDraft.data);

        if (paymentData.externalExecution !== "blocked" || paymentData.moneyMovement !== "blocked") {
          throw new PlatformUnavailableError(
            "payroll_approval_payment_instruction_unblocked",
            "Payroll approval payment instructions must still block external execution and money movement.",
            409,
          );
        }
      }

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

      const [updatedPayrollRun] = await tx
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
        .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRun.id)))
        .returning({ id: payrollRuns.id });

      if (!updatedPayrollRun) {
        throw new PlatformUnavailableError(
          "payroll_approval_run_update_failed",
          "Payroll approval could not update the payroll run.",
          409,
        );
      }

      const updatedPaymentDrafts = await tx
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
        )
        .returning({ id: paymentInstructions.id });

      if (updatedPaymentDrafts.length !== paymentInstructionIds.length) {
        throw new PlatformUnavailableError(
          "payroll_approval_payment_instruction_update_failed",
          "Payroll approval could not update every payment instruction.",
          409,
        );
      }

      const [updatedFilingDraft] = await tx
        .update(filingDrafts)
        .set({
          state: draftState,
          data: sql`jsonb_set(jsonb_set(jsonb_set(${filingDrafts.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true), '{externalExecution}', '"blocked"'::jsonb, true)`,
          updatedAt: now,
        })
        .where(and(eq(filingDrafts.tenantId, operator.tenantId), eq(filingDrafts.id, filingDraftId)))
        .returning({ id: filingDrafts.id });

      if (!updatedFilingDraft) {
        throw new PlatformUnavailableError(
          "payroll_approval_filing_draft_update_failed",
          "Payroll approval could not update the filing draft.",
          409,
        );
      }

      const [updatedPacket] = await tx
        .update(evidencePackets)
        .set({
          state: input.action,
          data: sql`jsonb_set(jsonb_set(${evidencePackets.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true)`,
          updatedAt: now,
        })
        .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, packetId)))
        .returning({ id: evidencePackets.id });

      if (!updatedPacket) {
        throw new PlatformUnavailableError(
          "payroll_approval_packet_update_failed",
          "Payroll approval could not update the evidence packet.",
          409,
        );
      }

      const [updatedPacketDocument] = await tx
        .update(documents)
        .set({
          state: input.action,
          data: sql`jsonb_set(jsonb_set(${documents.data}, '{approvalDecision}', ${JSON.stringify(decision)}::jsonb, true), '{handoff}', ${JSON.stringify(handoff)}::jsonb, true)`,
          updatedAt: now,
        })
        .where(and(eq(documents.tenantId, operator.tenantId), eq(documents.id, packetDocumentId)))
        .returning({ id: documents.id });

      if (!updatedPacketDocument) {
        throw new PlatformUnavailableError(
          "payroll_approval_packet_document_update_failed",
          "Payroll approval could not update the packet document.",
          409,
        );
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
    const replay: ApprovalDecisionReplay = {
      evidenceId: approvalEvidence.id,
      taskState,
      workflowRunState,
      workflowStepId,
      payrollHandoff,
    };
    const replayData: JsonObject = {
      evidenceId: replay.evidenceId,
      taskState: replay.taskState,
      workflowRunState: replay.workflowRunState,
      workflowStepId: replay.workflowStepId,
      payrollHandoff: replay.payrollHandoff,
    };

    await tx
      .update(auditEvents)
      .set({
        data: {
          ...auditData,
          replay: replayData,
        },
      })
      .where(eq(auditEvents.id, audit.id));

    return {
      approval: approvalRecord(updatedApproval ?? approval),
      auditEventId: audit.id,
      ...replay,
    };
  });
}
