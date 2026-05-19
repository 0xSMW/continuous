import { and, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  evidence,
  tasks,
  workflowDefinitions,
  workflowRuns,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;

const source = "continuous.approvals";

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

function approvalSubject(row: typeof approvalRequests.$inferSelect): ApprovalRecord["subject"] {
  if (row.workflowRunId) {
    return { type: "workflow_run", id: row.workflowRunId };
  }

  if (row.workerRunId) {
    return { type: "worker_run", id: row.workerRunId };
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

    let workflowRunState: string | null = null;

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
        const nextState =
          input.action === "approved" &&
          canTransition(workflow.definition.transitions, workflow.run.state, "approved")
            ? "approved"
            : workflow.run.state;

        workflowRunState = nextState;

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
    };
  });
}
