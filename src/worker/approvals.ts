import { and, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  evidence,
  tasks,
  tenants,
  users,
  type JsonObject,
} from "../db/schema";
import { RevenueWorkerUnavailableError } from "./revenue";

type Database = typeof defaultDb;

const source = "continuous.revenue_worker";

export type ApprovalDecisionAction = "approved" | "rejected" | "revision_requested";

export type RevenueWorkerApprovalRecord = {
  id: string;
  state: string;
  kind: string;
  priority: string;
  risk: string;
  title: string;
  summary: string;
  taskId: string | null;
  workerRunId: string | null;
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

type OperatorContext = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  email: string;
  name: string;
  actorRef: string;
};

async function loadOperator(
  db: Database,
  operatorEmail: string,
  tenantSlug?: string,
): Promise<OperatorContext> {
  const email = operatorEmail.trim().toLowerCase();
  const conditions = [eq(users.email, email), eq(users.state, "active")];

  if (tenantSlug) {
    conditions.push(eq(tenants.slug, tenantSlug));
  }

  const rows = await db
    .select({
      tenantId: users.tenantId,
      tenantSlug: tenants.slug,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(...conditions))
    .orderBy(users.createdAt)
    .limit(2);

  if (rows.length === 0) {
    throw new RevenueWorkerUnavailableError(
      "operator_not_found",
      "Revenue Worker approval access requires an active operator user.",
      403,
    );
  }

  if (rows.length > 1 && !tenantSlug) {
    throw new RevenueWorkerUnavailableError(
      "operator_tenant_ambiguous",
      "Multiple operator tenant memberships match this email. Provide a tenantSlug.",
      409,
    );
  }

  const operator = rows[0];

  return {
    tenantId: operator.tenantId,
    tenantSlug: operator.tenantSlug,
    userId: operator.userId,
    email: operator.email,
    name: operator.name,
    actorRef: `user:${operator.userId}`,
  };
}

function approvalRecord(row: typeof approvalRequests.$inferSelect): RevenueWorkerApprovalRecord {
  return {
    id: row.id,
    state: row.state,
    kind: row.kind,
    priority: row.priority,
    risk: row.risk,
    title: row.title,
    summary: row.summary,
    taskId: row.taskId,
    workerRunId: row.workerRunId,
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

function taskStateForDecision(action: ApprovalDecisionAction) {
  if (action === "approved") {
    return "waiting";
  }

  if (action === "revision_requested") {
    return "active";
  }

  return "blocked";
}

export function normalizeApprovalDecision(value: unknown): ApprovalDecisionAction | null {
  if (value === "approved" || value === "rejected" || value === "revision_requested") {
    return value;
  }

  return null;
}

export async function listRevenueWorkerApprovals(input: {
  operatorEmail: string;
  tenantSlug?: string;
  state?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperator(db, input.operatorEmail, input.tenantSlug);
  const conditions = [eq(approvalRequests.tenantId, operator.tenantId)];

  if (input.state) {
    conditions.push(eq(approvalRequests.state, input.state));
  }

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(...conditions))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(25);

  return {
    operator: {
      tenantId: operator.tenantId,
      tenantSlug: operator.tenantSlug,
      userId: operator.userId,
      email: operator.email,
      name: operator.name,
    },
    approvals: rows.map(approvalRecord),
  };
}

export async function decideRevenueWorkerApproval(input: {
  approvalId: string;
  operatorEmail: string;
  tenantSlug?: string;
  action: ApprovalDecisionAction;
  note?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperator(db, input.operatorEmail, input.tenantSlug);
  const now = new Date();
  const taskState = taskStateForDecision(input.action);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:approval:${input.approvalId}`}))`,
    );

    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, operator.tenantId), eq(approvalRequests.id, input.approvalId)))
      .limit(1);

    if (!approval) {
      throw new RevenueWorkerUnavailableError(
        "approval_not_found",
        "No Revenue Worker approval request matches this id.",
        404,
      );
    }

    if (approval.state !== "pending") {
      throw new RevenueWorkerUnavailableError(
        "approval_already_decided",
        "Revenue Worker approval request is no longer pending.",
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
        data: decision,
      })
      .returning({ id: auditEvents.id });

    const [approvalEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "approval",
        name: `Revenue Worker approval ${input.action}`,
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
          decision,
        },
      })
      .returning({ id: evidence.id });

    if (approval.taskId) {
      await tx
        .update(tasks)
        .set({
          state: taskState,
          outcome: {
            status: `approval_${input.action}`,
            approvalRequestId: approval.id,
            approvalEvidenceId: approvalEvidence.id,
            auditEventId: audit.id,
            externalExecution: "blocked",
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, approval.taskId));
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
    };
  });
}
