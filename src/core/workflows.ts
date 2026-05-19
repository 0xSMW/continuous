import { and, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  events,
  evidence,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  type JsonObject,
} from "../db/schema";
import { RevenueWorkerUnavailableError } from "../worker/revenue";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;

const source = "continuous.workflow";

export type WorkflowDefinitionRecord = {
  id: string;
  key: string;
  version: string;
  name: string;
  purpose: string;
  domain: string;
  states: JsonObject;
  transitions: JsonObject;
  objects: JsonObject;
  approvals: JsonObject;
  evidence: JsonObject;
  tests: JsonObject;
};

export type WorkflowRunRecord = {
  id: string;
  definitionId: string;
  workflowKey: string;
  workflowName: string;
  domain: string;
  state: string;
  objectId: string | null;
  workerId: string | null;
  idempotencyKey: string | null;
  data: JsonObject;
  blockers: JsonObject;
  metrics: JsonObject;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type WorkflowStepRecord = {
  id: string;
  workflowRunId: string;
  definitionId: string;
  eventId: string | null;
  approvalRequestId: string | null;
  kind: string;
  name: string;
  state: string;
  fromState: string | null;
  toState: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leasedUntil: string | null;
  nextAttemptAt: string | null;
  input: JsonObject;
  output: JsonObject;
  error: JsonObject;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function workflowStateOrder(definition: Pick<WorkflowDefinitionRecord, "states">) {
  return stringArray(definition.states.order);
}

export function allowedWorkflowTransitions(
  definition: Pick<WorkflowDefinitionRecord, "transitions">,
  fromState: string,
) {
  return stringArray(definition.transitions[fromState]);
}

export function isKnownWorkflowState(
  definition: Pick<WorkflowDefinitionRecord, "states" | "transitions">,
  state: string,
) {
  const states = workflowStateOrder(definition);
  const transitionTargets = Object.values(definition.transitions).flatMap((value) => stringArray(value));
  return (
    states.includes(state) ||
    Object.prototype.hasOwnProperty.call(definition.transitions, state) ||
    transitionTargets.includes(state)
  );
}

export function canTransitionWorkflow(
  definition: Pick<WorkflowDefinitionRecord, "states" | "transitions">,
  fromState: string,
  toState: string,
) {
  return allowedWorkflowTransitions(definition, fromState).includes(toState);
}

export function workflowApprovalRequirements(
  definition: Pick<WorkflowDefinitionRecord, "approvals">,
  state?: string,
) {
  const globalRequirements = stringArray(definition.approvals.required);
  const statePolicies = jsonObject(definition.approvals.states);
  const stateRequirements = state ? stringArray(statePolicies[state]) : [];

  return Array.from(new Set([...globalRequirements, ...stateRequirements]));
}

export function shouldRequestWorkflowApproval(
  definition: Pick<WorkflowDefinitionRecord, "approvals">,
  toState: string,
) {
  return (
    workflowApprovalRequirements(definition, toState).length > 0 &&
    toState.includes("approval") &&
    toState !== "approved"
  );
}

function isTerminalWorkflowState(
  definition: Pick<WorkflowDefinitionRecord, "transitions">,
  state: string,
) {
  return allowedWorkflowTransitions(definition, state).length === 0;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function definitionRecord(row: typeof workflowDefinitions.$inferSelect): WorkflowDefinitionRecord {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    purpose: row.purpose,
    domain: row.domain,
    states: row.states,
    transitions: row.transitions,
    objects: row.objects,
    approvals: row.approvals,
    evidence: row.evidence,
    tests: row.tests,
  };
}

function runRecord(row: {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
}): WorkflowRunRecord {
  return {
    id: row.run.id,
    definitionId: row.run.definitionId,
    workflowKey: row.definition.key,
    workflowName: row.definition.name,
    domain: row.definition.domain,
    state: row.run.state,
    objectId: row.run.objectId,
    workerId: row.run.workerId,
    idempotencyKey: row.run.idempotencyKey,
    data: row.run.data,
    blockers: row.run.blockers,
    metrics: row.run.metrics,
    startedAt: row.run.startedAt.toISOString(),
    updatedAt: row.run.updatedAt.toISOString(),
    completedAt: row.run.completedAt?.toISOString() ?? null,
  };
}

function stepRecord(row: typeof workflowSteps.$inferSelect): WorkflowStepRecord {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    definitionId: row.definitionId,
    eventId: row.eventId,
    approvalRequestId: row.approvalRequestId,
    kind: row.kind,
    name: row.name,
    state: row.state,
    fromState: row.fromState,
    toState: row.toState,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner,
    leasedUntil: row.leasedUntil?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listWorkflows(input: {
  operatorEmail: string;
  tenantSlug?: string;
  state?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  const runConditions = [eq(workflowRuns.tenantId, operator.tenantId)];

  if (input.state) {
    runConditions.push(eq(workflowRuns.state, input.state));
  }

  const [definitionRows, runRows, stepRows] = await Promise.all([
    db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.active, true))
      .orderBy(workflowDefinitions.domain, workflowDefinitions.key),
    db
      .select({
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
      .where(and(...runConditions))
      .orderBy(desc(workflowRuns.updatedAt))
      .limit(50),
    db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.tenantId, operator.tenantId))
      .orderBy(desc(workflowSteps.updatedAt))
      .limit(100),
  ]);

  return {
    operator: {
      tenantId: operator.tenantId,
      tenantSlug: operator.tenantSlug,
      userId: operator.userId,
      email: operator.email,
      name: operator.name,
    },
    definitions: definitionRows.map(definitionRecord),
    runs: runRows.map(runRecord),
    steps: stepRows.map(stepRecord),
  };
}

export async function startWorkflowRun(input: {
  operatorEmail: string;
  workflowKey: string;
  idempotencyKey: string;
  tenantSlug?: string;
  objectId?: string;
  workerId?: string;
  initialState?: string;
  data?: JsonObject;
  blockers?: JsonObject;
  metrics?: JsonObject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  const [definition] = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.key, input.workflowKey), eq(workflowDefinitions.active, true)))
    .orderBy(workflowDefinitions.version)
    .limit(1);

  if (!definition) {
    throw new RevenueWorkerUnavailableError(
      "workflow_definition_not_found",
      "No active workflow definition matches this key.",
      404,
    );
  }

  const definitionView = definitionRecord(definition);
  const orderedStates = workflowStateOrder(definitionView);
  const initialState = input.initialState ?? orderedStates[0] ?? "draft";

  if (!isKnownWorkflowState(definitionView, initialState)) {
    throw new RevenueWorkerUnavailableError(
      "workflow_state_unknown",
      `Workflow definition ${definition.key} does not define state ${initialState}.`,
      400,
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:start:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select({
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
      .where(
        and(
          eq(workflowRuns.tenantId, operator.tenantId),
          eq(workflowRuns.definitionId, definition.id),
          eq(workflowRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      return {
        created: false,
        run: runRecord(existingRun),
        stepId: null,
        eventId: null,
        auditEventId: null,
      };
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const [run] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: operator.tenantId,
        definitionId: definition.id,
        objectId: input.objectId,
        workerId: input.workerId,
        state: initialState,
        idempotencyKey: input.idempotencyKey,
        data: {
          ...jsonObject(input.data),
          startedByUserId: operator.userId,
          workflowKey: definition.key,
        },
        blockers: jsonObject(input.blockers),
        metrics: jsonObject(input.metrics),
        startedAt: now,
        updatedAt: now,
        completedAt: isTerminalWorkflowState(definitionView, initialState) ? now : null,
      })
      .returning();

    const [step] = await tx
      .insert(workflowSteps)
      .values({
        tenantId: operator.tenantId,
        definitionId: definition.id,
        workflowRunId: run.id,
        objectId: run.objectId,
        workerId: run.workerId,
        kind: "start",
        name: `${definition.key}:start:${initialState}`,
        state: "running",
        toState: initialState,
        attempt: 1,
        maxAttempts: 3,
        leaseOwner: operator.actorRef,
        leasedUntil: leaseExpiresAt,
        idempotencyKey: `${input.idempotencyKey}:start`,
        input: {
          workflowKey: definition.key,
          state: initialState,
          operatorUserId: operator.userId,
          operatorEmail: operator.email,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "workflow.run.started",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: run.objectId,
        idempotencyKey: `${input.idempotencyKey}:workflow_started`,
        data: {
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          state: initialState,
          operatorEmail: operator.email,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "workflow.run.started",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "workflow_run",
        targetId: run.id,
        eventId: event.id,
        objectId: run.objectId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:workflow_started`,
        data: {
          workflowKey: definition.key,
          workflowName: definition.name,
          workflowStepId: step.id,
          state: initialState,
        },
      })
      .returning({ id: auditEvents.id });

    await tx
      .update(workflowSteps)
      .set({
        eventId: event.id,
        state: "done",
        output: {
          eventId: event.id,
          auditEventId: audit.id,
          state: initialState,
        },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(workflowSteps.id, step.id));

    return {
      created: true,
      run: runRecord({ run, definition }),
      stepId: step.id,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function transitionWorkflowRun(input: {
  operatorEmail: string;
  runId: string;
  toState: string;
  tenantSlug?: string;
  reason?: string;
  data?: JsonObject;
  blockers?: JsonObject;
  metrics?: JsonObject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:transition:${input.runId}`}))`,
    );

    const [row] = await tx
      .select({
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
      .where(and(eq(workflowRuns.tenantId, operator.tenantId), eq(workflowRuns.id, input.runId)))
      .limit(1);

    if (!row) {
      throw new RevenueWorkerUnavailableError(
        "workflow_run_not_found",
        "No workflow run matches this id.",
        404,
      );
    }

    const definition = definitionRecord(row.definition);

    if (!isKnownWorkflowState(definition, input.toState)) {
      throw new RevenueWorkerUnavailableError(
        "workflow_state_unknown",
        `Workflow definition ${definition.key} does not define state ${input.toState}.`,
        400,
      );
    }

    if (!canTransitionWorkflow(definition, row.run.state, input.toState)) {
      throw new RevenueWorkerUnavailableError(
        "workflow_transition_invalid",
        `Workflow ${definition.key} cannot transition from ${row.run.state} to ${input.toState}.`,
        409,
      );
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const completedAt = isTerminalWorkflowState(definition, input.toState) ? now : null;
    const transitionData = {
      fromState: row.run.state,
      toState: input.toState,
      reason: input.reason ?? "",
      operatorUserId: operator.userId,
      operatorEmail: operator.email,
    };
    const transitionStepKey = `${row.run.id}:${row.run.state}:${input.toState}`;

    const [step] = await tx
      .insert(workflowSteps)
      .values({
        tenantId: operator.tenantId,
        definitionId: definition.id,
        workflowRunId: row.run.id,
        objectId: row.run.objectId,
        workerId: row.run.workerId,
        kind: "transition",
        name: `${definition.key}:${row.run.state}->${input.toState}`,
        state: "running",
        fromState: row.run.state,
        toState: input.toState,
        attempt: 1,
        maxAttempts: 3,
        leaseOwner: operator.actorRef,
        leasedUntil: leaseExpiresAt,
        idempotencyKey: transitionStepKey,
        input: {
          workflowKey: definition.key,
          workflowName: definition.name,
          ...transitionData,
          data: jsonObject(input.data),
          blockers: jsonObject(input.blockers),
          metrics: jsonObject(input.metrics),
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });

    const [updatedRun] = await tx
      .update(workflowRuns)
      .set({
        state: input.toState,
        data: {
          ...row.run.data,
          ...jsonObject(input.data),
          lastTransition: transitionData,
        },
        blockers: {
          ...row.run.blockers,
          ...jsonObject(input.blockers),
        },
        metrics: {
          ...row.run.metrics,
          ...jsonObject(input.metrics),
        },
        updatedAt: now,
        completedAt,
      })
      .where(eq(workflowRuns.id, row.run.id))
      .returning();

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "workflow.run.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: updatedRun.objectId,
        idempotencyKey: `${row.run.id}:${row.run.state}:${input.toState}:${now.toISOString()}`,
        data: {
          workflowStepId: step.id,
          workflowRunId: row.run.id,
          workflowKey: definition.key,
          ...transitionData,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "workflow.run.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "workflow_run",
        targetId: row.run.id,
        eventId: event.id,
        objectId: updatedRun.objectId,
        risk: "medium",
        data: {
          workflowKey: definition.key,
          workflowName: definition.name,
          workflowStepId: step.id,
          ...transitionData,
        },
      })
      .returning({ id: auditEvents.id });

    const [transitionEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Workflow transition ${row.run.state} to ${input.toState}`,
        objectId: updatedRun.objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${row.run.id}:${row.run.state}:${input.toState}:${now.toISOString()}`,
        data: {
          workflowRunId: row.run.id,
          workflowStepId: step.id,
          auditEventId: audit.id,
          transition: transitionData,
        },
      })
      .returning({ id: evidence.id });

    let approvalRequestId: string | null = null;
    let approvalAuditEventId: string | null = null;
    let approvalEvidenceId: string | null = null;
    const approvalRequirements = workflowApprovalRequirements(definition, input.toState);

    if (shouldRequestWorkflowApproval(definition, input.toState)) {
      const [approval] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: operator.tenantId,
          workflowRunId: row.run.id,
          eventId: event.id,
          objectId: updatedRun.objectId,
          requesterType: "user",
          requesterId: operator.userId,
          requesterRef: operator.actorRef,
          reviewerUserId: operator.userId,
          kind: `${definition.key}_approval`,
          state: "pending",
          priority: "high",
          risk: "medium",
          title: `${definition.name} approval required`,
          summary: `Workflow ${definition.name} is waiting for approval at ${input.toState}.`,
          requestedAction: {
            action: "approve_workflow_transition",
            workflowRunId: row.run.id,
            workflowStepId: step.id,
            workflowKey: definition.key,
            fromState: row.run.state,
            toState: input.toState,
            externalExecution: "blocked",
          },
          evidence: {
            eventId: event.id,
            auditEventId: audit.id,
            evidenceId: transitionEvidence.id,
            workflowStepId: step.id,
          },
          policy: {
            source: "workflow_definitions.approvals",
            requirements: approvalRequirements,
            approvalState: input.toState,
          },
          data: {
            workflowRunId: row.run.id,
            workflowStepId: step.id,
            workflowDefinitionId: definition.id,
            workflowKey: definition.key,
            workflowName: definition.name,
            transition: transitionData,
          },
        })
        .returning({ id: approvalRequests.id });

      approvalRequestId = approval.id;

      const [approvalAudit] = await tx
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
          approvalRequestId: approval.id,
          eventId: event.id,
          objectId: updatedRun.objectId,
          risk: "medium",
          idempotencyKey: `${row.run.id}:${row.run.state}:${input.toState}:approval_requested`,
          data: {
            workflowRunId: row.run.id,
            workflowStepId: step.id,
            workflowKey: definition.key,
            workflowName: definition.name,
            reviewerUserId: operator.userId,
            requirements: approvalRequirements,
            externalExecution: "blocked",
          },
        })
        .returning({ id: auditEvents.id });

      approvalAuditEventId = approvalAudit.id;

      const [approvalEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: operator.tenantId,
          kind: "approval",
          name: `Workflow approval requested for ${definition.name}`,
          objectId: updatedRun.objectId,
          eventId: event.id,
          actorType: "user",
          actorId: operator.userId,
          hash: `${source}:approval:${approval.id}`,
          data: {
            workflowRunId: row.run.id,
            workflowStepId: step.id,
            workflowKey: definition.key,
            approvalRequestId: approval.id,
            approvalAuditEventId: approvalAudit.id,
            transitionEvidenceId: transitionEvidence.id,
            requirements: approvalRequirements,
          },
        })
        .returning({ id: evidence.id });

      approvalEvidenceId = approvalEvidence.id;
    }

    await tx
      .update(workflowSteps)
      .set({
        eventId: event.id,
        approvalRequestId,
        state: "done",
        output: {
          eventId: event.id,
          auditEventId: audit.id,
          evidenceId: transitionEvidence.id,
          approvalRequestId,
          approvalAuditEventId,
          approvalEvidenceId,
          transition: transitionData,
        },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(workflowSteps.id, step.id));

    return {
      run: runRecord({ run: updatedRun, definition: row.definition }),
      stepId: step.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: transitionEvidence.id,
      approvalRequestId,
      approvalAuditEventId,
      approvalEvidenceId,
    };
  });
}
