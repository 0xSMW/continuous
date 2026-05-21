import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  capabilities,
  capabilityGrants,
  events,
  evidence,
  tasks,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  type Json,
  type JsonObject,
} from "../db/schema";
import { RevenueWorkerUnavailableError } from "../worker/revenue";
import { executeWorkerCommand, type WorkerCommandResult } from "../worker/registry";
import { PlatformUnavailableError } from "./errors";
import { scanObligationsForOperator } from "./obligations";
import { loadOperatorContext } from "./operators";
import {
  prepareCorePacketForOperator,
  recordAdapterIntentForOperator,
  recordRuleChangeForOperator,
} from "./primitives";

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
  taskId: string | null;
  objectId: string | null;
  workerId: string | null;
  capabilityId: string | null;
  kind: string;
  name: string;
  state: string;
  priority: string;
  risk: string;
  fromState: string | null;
  toState: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leasedUntil: string | null;
  dueAt: string | null;
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

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  }

  return value;
}

function hashJson(value: JsonObject) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    taskId: row.taskId,
    objectId: row.objectId,
    workerId: row.workerId,
    capabilityId: row.capabilityId,
    kind: row.kind,
    name: row.name,
    state: row.state,
    priority: row.priority,
    risk: row.risk,
    fromState: row.fromState,
    toState: row.toState,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner,
    leasedUntil: row.leasedUntil?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
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

type ClaimedWorkflowStep = {
  step: typeof workflowSteps.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
};

type WorkflowPriority = "low" | "normal" | "high" | "urgent";
type WorkflowRisk = "low" | "medium" | "high" | "critical";

const executableWorkflowStepKinds = new Set([
  "transition",
  "workflow_transition",
  "worker_command",
  "worker_transition",
  "capability_execution",
  "approval_request",
  "adapter_intent_record",
  "rule_change_record",
  "obligation_scan",
  "packet_prepare",
  "document_packet_prepare",
  "evidence_packet_prepare",
  "seed_state",
]);
const packetWorkflowStepKinds = new Set([
  "packet_prepare",
  "document_packet_prepare",
  "evidence_packet_prepare",
]);

class WorkflowStepLeaseLostError extends Error {
  readonly code = "workflow_step_lease_lost";
  readonly status = 409;

  constructor(message = "Workflow step lease was lost before execution completed.") {
    super(message);
    this.name = "WorkflowStepLeaseLostError";
  }
}

function workflowStepPriorityRank() {
  return sql`case ${workflowSteps.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
}

function optionalDate(value: unknown, field: string) {
  const string = stringValue(value);

  if (!string) {
    return undefined;
  }

  const date = new Date(string);

  if (Number.isNaN(date.getTime())) {
    throw new RevenueWorkerUnavailableError(
      "workflow_step_date_invalid",
      `${field} must be an ISO date string.`,
      400,
    );
  }

  return date;
}

function priorityValue(value: unknown, fallback: WorkflowPriority): WorkflowPriority {
  const priority = stringValue(value);

  return priority === "low" || priority === "normal" || priority === "high" || priority === "urgent"
    ? priority
    : fallback;
}

function riskValue(value: unknown, fallback: WorkflowRisk): WorkflowRisk {
  const risk = stringValue(value);

  return risk === "low" || risk === "medium" || risk === "high" || risk === "critical"
    ? risk
    : fallback;
}

function workflowWorkerCommandInput(
  step: typeof workflowSteps.$inferSelect,
  operator: Awaited<ReturnType<typeof loadOperatorContext>>,
) {
  const commandInput = jsonObject(step.input.workerCommand ?? step.input);
  const workerInput = jsonObject(commandInput.worker ?? commandInput.target);
  const command = stringValue(commandInput.command);
  const role = stringValue(workerInput.role);

  if (!command) {
    throw new RevenueWorkerUnavailableError(
      "workflow_worker_command_missing",
      "Workflow worker_command steps require input.command.",
      400,
    );
  }

  if (!role) {
    throw new RevenueWorkerUnavailableError(
      "workflow_worker_role_missing",
      "Workflow worker_command steps require input.worker.role.",
      400,
    );
  }

  const tenantSlug = stringValue(workerInput.tenantSlug);

  if (tenantSlug && tenantSlug !== operator.tenantSlug) {
    throw new RevenueWorkerUnavailableError(
      "workflow_worker_tenant_mismatch",
      "Workflow worker_command steps cannot target a different tenant.",
      403,
    );
  }

  return {
    command,
    target: {
      role,
      id: stringValue(workerInput.id) ?? step.workerId ?? undefined,
      tenantSlug: operator.tenantSlug,
    },
    idempotencyKey: stringValue(commandInput.idempotencyKey) ?? `${step.id}:worker_command`,
    config: jsonObject(commandInput.config),
  };
}

function jsonValue(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as Json;
  } catch {
    throw new RevenueWorkerUnavailableError(
      "workflow_worker_result_invalid",
      "Workflow worker_command results must be JSON-serializable.",
      500,
    );
  }
}

type WorkflowWorkerCommandInput = ReturnType<typeof workflowWorkerCommandInput>;
type WorkflowWorkerCommandExecution = {
  input: WorkflowWorkerCommandInput;
  result: WorkerCommandResult;
};

async function runWorkflowWorkerCommand(input: {
  operator: Awaited<ReturnType<typeof loadOperatorContext>>;
  step: typeof workflowSteps.$inferSelect;
}): Promise<WorkflowWorkerCommandExecution> {
  const commandInput = workflowWorkerCommandInput(input.step, input.operator);
  const result = await executeWorkerCommand({
    command: commandInput.command,
    target: commandInput.target,
    operatorEmail: input.operator.email,
    idempotencyKey: commandInput.idempotencyKey,
    config: commandInput.config,
  });

  return {
    input: commandInput,
    result,
  };
}

function errorData(error: unknown, attempt: number, maxAttempts: number): JsonObject {
  return {
    message: error instanceof Error ? error.message : "Unknown workflow step execution error.",
    code:
      error instanceof RevenueWorkerUnavailableError
        ? error.code
        : error instanceof WorkflowStepLeaseLostError
          ? error.code
          : error instanceof PlatformUnavailableError
            ? error.code
            : "workflow_step_execution_failed",
    attempt,
    maxAttempts,
    retryable: attempt < maxAttempts,
  };
}

async function claimWorkflowStep(input: {
  db: Database;
  tenantId: string;
  leaseOwner: string;
  leaseMs: number;
  now: Date;
}): Promise<ClaimedWorkflowStep | null> {
  return input.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        step: workflowSteps,
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowSteps)
      .innerJoin(workflowRuns, eq(workflowSteps.workflowRunId, workflowRuns.id))
      .innerJoin(workflowDefinitions, eq(workflowSteps.definitionId, workflowDefinitions.id))
      .where(
        and(
          eq(workflowSteps.tenantId, input.tenantId),
          sql`(
            ${workflowSteps.state} = 'queued'
            or (
              ${workflowSteps.state} in ('failed', 'running')
              and ${workflowSteps.attempt} < ${workflowSteps.maxAttempts}
              and (${workflowSteps.leasedUntil} is null or ${workflowSteps.leasedUntil} <= ${input.now})
            )
          )`,
          sql`(${workflowSteps.dueAt} is null or ${workflowSteps.dueAt} <= ${input.now})`,
          sql`(${workflowSteps.nextAttemptAt} is null or ${workflowSteps.nextAttemptAt} <= ${input.now})`,
        ),
      )
      .orderBy(workflowStepPriorityRank(), workflowSteps.dueAt, workflowSteps.createdAt)
      .limit(1)
      .for("update", { of: workflowSteps, skipLocked: true });

    if (!candidate) {
      return null;
    }

    const nextAttempt =
      candidate.step.state === "queued" ? candidate.step.attempt : candidate.step.attempt + 1;
    const leasedUntil = new Date(input.now.getTime() + input.leaseMs);
    const [claimedStep] = await tx
      .update(workflowSteps)
      .set({
        state: "running",
        attempt: nextAttempt,
        leaseOwner: input.leaseOwner,
        leasedUntil,
        startedAt: candidate.step.startedAt ?? input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workflowSteps.id, candidate.step.id),
          eq(workflowSteps.state, candidate.step.state),
          eq(workflowSteps.attempt, candidate.step.attempt),
        ),
      )
      .returning();

    if (!claimedStep) {
      return null;
    }

    return {
      step: claimedStep,
      run: candidate.run,
      definition: candidate.definition,
    };
  });
}

async function completeWorkflowStep(input: {
  db: Database;
  operator: Awaited<ReturnType<typeof loadOperatorContext>>;
  claimed: ClaimedWorkflowStep;
  now: Date;
  workerCommandExecution?: WorkflowWorkerCommandExecution;
}) {
  const { step: claimedStep, definition } = input.claimed;
  const claimOwner = claimedStep.leaseOwner;

  if (!claimOwner) {
    throw new WorkflowStepLeaseLostError();
  }

  if (!executableWorkflowStepKinds.has(claimedStep.kind)) {
    throw new RevenueWorkerUnavailableError(
      "workflow_step_handler_missing",
      `Workflow step kind ${claimedStep.kind} does not have a registered executor.`,
      409,
    );
  }

  return input.db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.id, claimedStep.id),
          eq(workflowSteps.state, "running"),
          eq(workflowSteps.leaseOwner, claimOwner),
          eq(workflowSteps.attempt, claimedStep.attempt),
        ),
      )
      .limit(1)
      .for("update", { of: workflowSteps });

    if (!step) {
      throw new WorkflowStepLeaseLostError();
    }

    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.id, step.workflowRunId),
          eq(workflowRuns.tenantId, input.operator.tenantId),
        ),
      )
      .limit(1)
      .for("update", { of: workflowRuns });

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "workflow_run_not_found",
        "No workflow run matches this step.",
        404,
      );
    }

    const definitionView = definitionRecord(definition);
    let executionActor: {
      type: "user" | "worker";
      id: string;
      ref: string;
    } = {
      type: "user",
      id: input.operator.userId,
      ref: input.operator.actorRef,
    };
    let capabilityExecution: JsonObject | null = null;
    let task: typeof tasks.$inferSelect | null = null;

    if (step.kind === "capability_execution") {
      if (step.taskId) {
        const [taskRow] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, step.taskId)))
          .limit(1)
          .for("update", { of: tasks });

        if (!taskRow) {
          throw new RevenueWorkerUnavailableError(
            "workflow_step_task_not_found",
            "Workflow step task does not exist in this tenant.",
            404,
          );
        }

        task = taskRow;
      }

      if (step.workerId) {
        executionActor = {
          type: "worker",
          id: step.workerId,
          ref: `worker:${step.workerId}`,
        };
      } else if (
        task?.ownerId &&
        (task.ownerType === "user" || task.ownerType === "worker")
      ) {
        executionActor = {
          type: task.ownerType,
          id: task.ownerId,
          ref: task.ownerRef,
        };
      }

      if (!step.capabilityId) {
        throw new RevenueWorkerUnavailableError(
          "workflow_step_capability_required",
          "Capability execution steps require capabilityId.",
          400,
        );
      }

      const [capability] = await tx
        .select()
        .from(capabilities)
        .where(and(eq(capabilities.id, step.capabilityId), eq(capabilities.active, true)))
        .limit(1);

      if (!capability) {
        throw new RevenueWorkerUnavailableError(
          "workflow_step_capability_not_found",
          "Workflow step capability does not match an active capability.",
          404,
        );
      }

      const [grant] = await tx
        .select()
        .from(capabilityGrants)
        .where(
          and(
            eq(capabilityGrants.tenantId, input.operator.tenantId),
            eq(capabilityGrants.capabilityId, capability.id),
            eq(capabilityGrants.actorType, executionActor.type),
            eq(capabilityGrants.actorId, executionActor.id),
            eq(capabilityGrants.active, true),
            sql`(${capabilityGrants.startsAt} is null or ${capabilityGrants.startsAt} <= ${input.now})`,
            sql`(${capabilityGrants.endsAt} is null or ${capabilityGrants.endsAt} > ${input.now})`,
          ),
        )
        .limit(1);

      if (!grant) {
        throw new RevenueWorkerUnavailableError(
          "workflow_step_capability_grant_missing",
          `No active grant allows ${executionActor.ref} to use ${capability.key}.`,
          403,
        );
      }

      capabilityExecution = {
        capabilityId: capability.id,
        capabilityKey: capability.key,
        capabilityVersion: capability.version,
        capabilityClass: capability.class,
        capabilityRisk: capability.risk,
        sideEffect: capability.sideEffect,
        capabilityGrantId: grant.id,
        actor: executionActor,
        scope: grant.scope,
        policy: grant.policy,
        taskId: task?.id ?? null,
        externalExecution: "blocked",
      };
    }

    const currentFromState = run.state;
    const lastExecutedStep = {
      stepId: step.id,
      kind: step.kind,
      name: step.name,
      fromState: currentFromState,
      toState: step.toState,
      executedBy: executionActor.ref,
      triggeredBy: input.operator.actorRef,
      executedAt: input.now.toISOString(),
      ...(capabilityExecution ? { capabilityExecution } : {}),
    };

    if (currentFromState !== step.toState) {
      if (step.fromState && currentFromState !== step.fromState) {
        throw new RevenueWorkerUnavailableError(
          "workflow_step_state_mismatch",
          `Workflow step expected ${step.fromState}, but run is ${currentFromState}.`,
          409,
        );
      }

      if (!canTransitionWorkflow(definitionView, currentFromState, step.toState)) {
        throw new RevenueWorkerUnavailableError(
          "workflow_step_transition_invalid",
          `Workflow ${definition.key} cannot execute ${currentFromState} to ${step.toState}.`,
          409,
        );
      }

      await tx
        .update(workflowRuns)
        .set({
          state: step.toState,
          data: {
            ...run.data,
            lastExecutedStep,
          },
          updatedAt: input.now,
          completedAt: isTerminalWorkflowState(definitionView, step.toState) ? input.now : run.completedAt,
        })
        .where(eq(workflowRuns.id, run.id));
    }

    const executionData = {
      workflowRunId: run.id,
      workflowStepId: step.id,
      workflowKey: definition.key,
      handler: step.kind,
      fromState: currentFromState,
      toState: step.toState,
      attempt: step.attempt,
      triggeredBy: input.operator.actorRef,
      actor: executionActor,
      ...(capabilityExecution ? { capabilityExecution } : {}),
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: input.operator.tenantId,
        type: "workflow.step.executed",
        source,
        actorType: executionActor.type,
        actorId: executionActor.id,
        actorRef: executionActor.ref,
        taskId: step.taskId,
        objectId: step.objectId ?? run.objectId,
        capabilityId: step.capabilityId,
        idempotencyKey: `${step.id}:executed:${step.attempt}`,
        data: executionData,
        occurredAt: input.now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: input.operator.tenantId,
        type: "workflow.step.executed",
        source,
        actorType: executionActor.type,
        actorId: executionActor.id,
        actorRef: executionActor.ref,
        targetType: "workflow_step",
        targetId: step.id,
        eventId: event.id,
        taskId: step.taskId,
        objectId: step.objectId ?? run.objectId,
        capabilityId: step.capabilityId,
        risk: step.risk,
        idempotencyKey: `${step.id}:executed:${step.attempt}`,
        data: executionData,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: input.operator.tenantId,
        kind: "trace",
        name: `Workflow step executed: ${step.name}`,
        taskId: step.taskId,
        objectId: step.objectId ?? run.objectId,
        eventId: event.id,
        capabilityId: step.capabilityId,
        actorType: executionActor.type,
        actorId: executionActor.id,
        hash: `${source}:${step.id}:executed:${step.attempt}:${input.now.toISOString()}`,
        data: {
          ...executionData,
          auditEventId: audit.id,
          input: step.input,
        },
      })
      .returning({ id: evidence.id });
    let packetPreparation: Awaited<ReturnType<typeof prepareCorePacketForOperator>> | null = null;
    let approvalRequest:
      | {
          approvalRequestId: string;
          approvalEventId: string;
          approvalAuditEventId: string;
          approvalEvidenceId: string;
          reviewerUserId: string;
          requirements: string[];
          policy: JsonObject;
          requestedAction: JsonObject;
        }
      | null = null;
    let adapterIntentRecord: Awaited<ReturnType<typeof recordAdapterIntentForOperator>> | null =
      null;
    let ruleChangeRecord: Awaited<ReturnType<typeof recordRuleChangeForOperator>> | null =
      null;
    let obligationScanRecord: Awaited<ReturnType<typeof scanObligationsForOperator>> | null =
      null;
    let workerCommand: WorkerCommandResult | null = null;
    let workerCommandData: JsonObject | null = null;

    if (step.kind === "adapter_intent_record") {
      const adapterInput = jsonObject(step.input.adapterIntent ?? step.input.adapter ?? {});
      const adapterTaskId = stringValue(adapterInput.taskId) ?? step.taskId ?? undefined;

      adapterIntentRecord = await recordAdapterIntentForOperator(tx, input.operator, {
        idempotencyKey: `${step.id}:adapter_intent_record`,
        connectionId: stringValue(adapterInput.connectionId) ?? "",
        operation: stringValue(adapterInput.operation) ?? "",
        mode: stringValue(adapterInput.mode),
        taskId: adapterTaskId,
        eventId: stringValue(adapterInput.eventId) ?? event.id,
        capabilityId: stringValue(adapterInput.capabilityId) ?? step.capabilityId ?? undefined,
        request: {
          ...jsonObject(adapterInput.request),
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          externalExecution: "blocked",
        },
        data: {
          ...jsonObject(adapterInput.data),
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          source,
          externalExecution: "blocked",
        },
        maxAttempts: adapterInput.maxAttempts,
      });

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              adapterIntentRecord,
            },
            lastAdapterIntentRecord: {
              ...adapterIntentRecord,
              workflowStepId: step.id,
              recordedAt: input.now.toISOString(),
              externalExecution: "blocked",
            },
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (adapterTaskId) {
        const adapterTask =
          task?.id === adapterTaskId
            ? task
            : (
                await tx
                  .select()
                  .from(tasks)
                  .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, adapterTaskId)))
                  .limit(1)
              )[0] ?? null;

        if (adapterTask) {
          await tx
            .update(tasks)
            .set({
              outcome: {
                ...adapterTask.outcome,
                lastWorkflowAdapterIntent: {
                  ...adapterIntentRecord,
                  workflowRunId: run.id,
                  workflowStepId: step.id,
                  recordedAt: input.now.toISOString(),
                  externalExecution: "blocked",
                },
              },
              updatedAt: input.now,
            })
            .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, adapterTask.id)));
        }
      }
    }

    if (step.kind === "rule_change_record") {
      const ruleInput = jsonObject(step.input.ruleChange ?? step.input.rule ?? {});
      const ruleTaskId = stringValue(ruleInput.taskId) ?? step.taskId ?? undefined;

      ruleChangeRecord = await recordRuleChangeForOperator(tx, input.operator, {
        idempotencyKey: `${step.id}:rule_change_record`,
        rulePackId: stringValue(ruleInput.rulePackId),
        ruleKey: stringValue(ruleInput.ruleKey) ?? "",
        changeType: stringValue(ruleInput.changeType) ?? "",
        title: stringValue(ruleInput.title) ?? "",
        summary: stringValue(ruleInput.summary),
        state: stringValue(ruleInput.state),
        decision: stringValue(ruleInput.decision),
        rationale: stringValue(ruleInput.rationale),
        taskId: ruleTaskId,
        workflowRunId: stringValue(ruleInput.workflowRunId) ?? run.id,
        capabilityId: stringValue(ruleInput.capabilityId) ?? step.capabilityId ?? undefined,
        sourceRefs: jsonObject(ruleInput.sourceRefs),
        before: jsonObject(ruleInput.before),
        after: jsonObject(ruleInput.after),
        impact: jsonObject(ruleInput.impact),
        data: {
          ...jsonObject(ruleInput.data),
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          workflowEventId: event.id,
          source,
          externalExecution: "blocked",
        },
        effectiveAt: stringValue(ruleInput.effectiveAt),
      });

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              ruleChangeRecord,
            },
            lastRuleChangeRecord: {
              ...ruleChangeRecord,
              workflowStepId: step.id,
              recordedAt: input.now.toISOString(),
              externalExecution: "blocked",
            },
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (ruleTaskId) {
        const ruleTask =
          task?.id === ruleTaskId
            ? task
            : (
                await tx
                  .select()
                  .from(tasks)
                  .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, ruleTaskId)))
                  .limit(1)
              )[0] ?? null;

        if (ruleTask) {
          await tx
            .update(tasks)
            .set({
              outcome: {
                ...ruleTask.outcome,
                lastWorkflowRuleChange: {
                  ...ruleChangeRecord,
                  workflowRunId: run.id,
                  workflowStepId: step.id,
                  recordedAt: input.now.toISOString(),
                  externalExecution: "blocked",
                },
              },
              updatedAt: input.now,
            })
            .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, ruleTask.id)));
        }
      }
    }

    if (step.kind === "obligation_scan") {
      const obligationInput = jsonObject(step.input.obligationScan ?? step.input.obligation ?? {});
      const forbiddenLineageFields = ["workflowRunId", "taskId"].filter((field) => obligationInput[field] !== undefined);

      if (forbiddenLineageFields.length > 0) {
        throw new PlatformUnavailableError(
          "workflow_obligation_scan_lineage_forbidden",
          `Workflow obligation_scan lineage is derived from the claimed workflow step. Unexpected input fields: ${forbiddenLineageFields.join(", ")}.`,
          400,
        );
      }
      const linkedTaskId = step.taskId ?? undefined;

      obligationScanRecord = await scanObligationsForOperator(tx, input.operator, {
        idempotencyKey: `${step.id}:obligation_scan`,
        scope: jsonObject(obligationInput.scope),
        jurisdiction: stringValue(obligationInput.jurisdiction),
        asOf: stringValue(obligationInput.asOf),
        dueAt: stringValue(obligationInput.dueAt),
        rulePackId: stringValue(obligationInput.rulePackId),
        filingRequirementId: stringValue(obligationInput.filingRequirementId),
        workflowRunId: run.id,
        facts: jsonObject(obligationInput.facts),
        data: {
          ...jsonObject(obligationInput.data),
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          workflowEventId: event.id,
          source,
          externalExecution: "blocked",
        },
      });

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              obligationScanRecord,
            },
            lastObligationScan: {
              ...obligationScanRecord,
              workflowStepId: step.id,
              recordedAt: input.now.toISOString(),
              externalExecution: "blocked",
            },
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (linkedTaskId) {
        const [obligationTask] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, linkedTaskId)))
          .limit(1);

        if (obligationTask) {
          await tx
            .update(tasks)
            .set({
              outcome: {
                ...obligationTask.outcome,
                lastWorkflowObligationScan: {
                  ...obligationScanRecord,
                  workflowRunId: run.id,
                  workflowStepId: step.id,
                  recordedAt: input.now.toISOString(),
                  externalExecution: "blocked",
                },
              },
              updatedAt: input.now,
            })
            .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, obligationTask.id)));
        }
      }
    }

    if (step.kind === "approval_request") {
      const approvalInput = jsonObject(step.input.approval ?? step.input.approvalRequest ?? {});
      const requirements = workflowApprovalRequirements(definitionView, step.toState);
      const reviewerUserId = stringValue(approvalInput.reviewerUserId) ?? input.operator.userId;
      const approvalKind = stringValue(approvalInput.kind) ?? `${definition.key}_approval`;
      const approvalTitle =
        stringValue(approvalInput.title) ?? `${definition.name} approval required`;
      const approvalSummary =
        stringValue(approvalInput.summary) ??
        `Workflow ${definition.name} is waiting for approval at ${step.toState}.`;
      const approvalPriority = priorityValue(approvalInput.priority, step.priority as WorkflowPriority);
      const approvalRisk = riskValue(approvalInput.risk, step.risk as WorkflowRisk);
      const approvalTask =
        task ??
        (step.taskId
          ? (
              await tx
                .select()
                .from(tasks)
                .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, step.taskId)))
                .limit(1)
                .for("update", { of: tasks })
            )[0] ?? null
          : null);
      const requestedAction = {
        action: stringValue(approvalInput.action) ?? "approve_workflow_step",
        ...jsonObject(approvalInput.requestedAction),
        workflowRunId: run.id,
        workflowStepId: step.id,
        workflowKey: definition.key,
        fromState: currentFromState,
        toState: step.toState,
        externalExecution: "blocked",
      };
      const policy = {
        source: "workflow_steps.input.approval",
        requirements,
        approvalState: step.toState,
        ...jsonObject(approvalInput.policy),
      };
      const approvalData = {
        ...jsonObject(approvalInput.data),
        workflowRunId: run.id,
        workflowStepId: step.id,
        workflowDefinitionId: definition.id,
        workflowKey: definition.key,
        workflowName: definition.name,
        taskId: step.taskId ?? null,
        objectId: step.objectId ?? run.objectId ?? null,
        capabilityId: step.capabilityId ?? null,
        externalExecution: "blocked",
      };
      const [approval] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: input.operator.tenantId,
          workflowRunId: run.id,
          taskId: step.taskId,
          eventId: event.id,
          objectId: step.objectId ?? run.objectId,
          capabilityId: step.capabilityId,
          requesterType: executionActor.type,
          requesterId: executionActor.id,
          requesterRef: executionActor.ref,
          reviewerUserId,
          kind: approvalKind,
          state: "pending",
          priority: approvalPriority,
          risk: approvalRisk,
          title: approvalTitle,
          summary: approvalSummary,
          requestedAction,
          evidence: {
            ...jsonObject(approvalInput.evidence),
            eventId: event.id,
            auditEventId: audit.id,
            evidenceId: proof.id,
            workflowStepId: step.id,
          },
          policy,
          data: approvalData,
          dueAt: optionalDate(approvalInput.dueAt, "approval.dueAt"),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: approvalRequests.id });
      const [approvalAudit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: input.operator.tenantId,
          type: "approval.requested",
          source,
          actorType: executionActor.type,
          actorId: executionActor.id,
          actorRef: executionActor.ref,
          targetType: "approval_request",
          targetId: approval.id,
          approvalRequestId: approval.id,
          eventId: event.id,
          taskId: step.taskId,
          objectId: step.objectId ?? run.objectId,
          capabilityId: step.capabilityId,
          risk: approvalRisk,
          idempotencyKey: `${step.id}:approval_requested`,
          data: {
            approvalRequestId: approval.id,
            workflowRunId: run.id,
            workflowStepId: step.id,
            workflowKey: definition.key,
            workflowName: definition.name,
            reviewerUserId,
            requirements,
            externalExecution: "blocked",
          },
        })
        .returning({ id: auditEvents.id });
      const [approvalEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: input.operator.tenantId,
          kind: "approval",
          name: `Workflow approval requested: ${approvalTitle}`,
          taskId: step.taskId,
          objectId: step.objectId ?? run.objectId,
          eventId: event.id,
          capabilityId: step.capabilityId,
          actorType: executionActor.type,
          actorId: executionActor.id,
          hash: `${source}:approval:${approval.id}`,
          data: {
            approvalRequestId: approval.id,
            workflowRunId: run.id,
            workflowStepId: step.id,
            workflowKey: definition.key,
            approvalAuditEventId: approvalAudit.id,
            workflowStepEvidenceId: proof.id,
            requirements,
            requestedAction,
            externalExecution: "blocked",
          },
        })
        .returning({ id: evidence.id });

      approvalRequest = {
        approvalRequestId: approval.id,
        approvalEventId: event.id,
        approvalAuditEventId: approvalAudit.id,
        approvalEvidenceId: approvalEvidence.id,
        reviewerUserId,
        requirements,
        policy,
        requestedAction,
      };

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              approvalRequest,
            },
            lastWorkflowApprovalRequest: {
              ...approvalRequest,
              requestedAt: input.now.toISOString(),
              externalExecution: "blocked",
            },
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (approvalTask) {
        await tx
          .update(tasks)
          .set({
            state: "approval_required",
            outcome: {
              ...approvalTask.outcome,
              lastWorkflowApprovalRequest: {
                ...approvalRequest,
                workflowRunId: run.id,
                workflowStepId: step.id,
                requestedAt: input.now.toISOString(),
                externalExecution: "blocked",
              },
            },
            updatedAt: input.now,
          })
          .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, approvalTask.id)));
      }
    }

    if (packetWorkflowStepKinds.has(step.kind)) {
      const packetInput = jsonObject(step.input.packet ?? step.input.corePacket ?? {});
      const definitionEvidence = jsonObject(definition.evidence);
      const evidenceIds = Array.from(
        new Set([...stringArray(packetInput.evidenceIds), proof.id]),
      );
      const packetTaskId = stringValue(packetInput.taskId) ?? step.taskId ?? undefined;

      packetPreparation = await prepareCorePacketForOperator(tx, input.operator, {
        idempotencyKey: `${step.id}:packet_prepare`,
        kind:
          stringValue(packetInput.kind) ??
          stringValue(definitionEvidence.packet) ??
          `${definition.key}_packet`,
        name: stringValue(packetInput.name) ?? `${definition.name}: ${step.name}`,
        state: stringValue(packetInput.state) ?? "prepared",
        sensitivity: stringValue(packetInput.sensitivity) ?? step.risk,
        objectId: stringValue(packetInput.objectId) ?? step.objectId ?? run.objectId ?? undefined,
        taskId: packetTaskId,
        workflowRunId: stringValue(packetInput.workflowRunId) ?? run.id,
        eventId: stringValue(packetInput.eventId) ?? event.id,
        capabilityId: stringValue(packetInput.capabilityId) ?? step.capabilityId ?? undefined,
        evidenceIds,
        documentIds: packetInput.documentIds,
        sections: jsonObject(packetInput.sections),
        data: {
          ...jsonObject(packetInput.data),
          workflowRunId: run.id,
          workflowStepId: step.id,
          workflowKey: definition.key,
          workflowStepKind: step.kind,
          source: source,
          externalExecution: "blocked",
        },
        hash: stringValue(packetInput.hash),
        retainedUntil: stringValue(packetInput.retainedUntil),
      });

      const packetData = {
        ...packetPreparation,
        workflowRunId: run.id,
        workflowStepId: step.id,
        workflowKey: definition.key,
        preparedAt: input.now.toISOString(),
        externalExecution: "blocked",
      };

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              packetPreparation: packetData,
            },
            lastPacketPreparation: packetData,
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (packetTaskId) {
        const packetTask =
          task?.id === packetTaskId
            ? task
            : (
                await tx
                  .select()
                  .from(tasks)
                  .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, packetTaskId)))
                  .limit(1)
              )[0] ?? null;

        if (packetTask) {
          await tx
            .update(tasks)
            .set({
              outcome: {
                ...packetTask.outcome,
                lastWorkflowPacket: packetData,
              },
              updatedAt: input.now,
            })
            .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, packetTask.id)));
        }
      }
    }

    if (step.kind === "worker_command") {
      if (!input.workerCommandExecution) {
        throw new RevenueWorkerUnavailableError(
          "workflow_worker_command_runner_missing",
          "Workflow worker_command steps require a command-runner result.",
          500,
        );
      }

      const workerCommandInput = input.workerCommandExecution.input;
      workerCommand = input.workerCommandExecution.result;

      workerCommandData = {
        worker: jsonValue(workerCommand.worker),
        command: workerCommand.command,
        result: jsonValue(workerCommand.result),
        workflowRunId: run.id,
        workflowStepId: step.id,
        workflowKey: definition.key,
        idempotencyKey: workerCommandInput.idempotencyKey,
        executedAt: input.now.toISOString(),
        runner: {
          boundary: "outside_workflow_row_lock",
          leaseOwner: claimOwner,
        },
        externalExecution: "registry_controlled",
      };

      await tx
        .update(workflowRuns)
        .set({
          data: {
            ...run.data,
            lastExecutedStep: {
              ...lastExecutedStep,
              workerCommand: workerCommandData,
            },
            lastWorkflowWorkerCommand: workerCommandData,
          },
          updatedAt: input.now,
        })
        .where(eq(workflowRuns.id, run.id));

      if (step.taskId) {
        const workerCommandTask =
          task?.id === step.taskId
            ? task
            : (
                await tx
                  .select()
                  .from(tasks)
                  .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, step.taskId)))
                  .limit(1)
              )[0] ?? null;

        if (workerCommandTask) {
          await tx
            .update(tasks)
            .set({
              outcome: {
                ...workerCommandTask.outcome,
                lastWorkflowWorkerCommand: workerCommandData,
              },
              updatedAt: input.now,
            })
            .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, workerCommandTask.id)));
        }
      }
    }

    const output = {
      ...step.output,
      ...executionData,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      ...(approvalRequest
        ? {
            approvalRequest: {
              ...approvalRequest,
              externalExecution: "blocked",
            },
          }
        : {}),
      ...(adapterIntentRecord
        ? {
            adapterIntentRecord: {
              ...adapterIntentRecord,
              externalExecution: "blocked",
            },
          }
        : {}),
      ...(ruleChangeRecord
        ? {
            ruleChangeRecord: {
              ...ruleChangeRecord,
              externalExecution: "blocked",
            },
          }
        : {}),
      ...(obligationScanRecord
        ? {
            obligationScanRecord: {
              ...obligationScanRecord,
              externalExecution: "blocked",
            },
          }
        : {}),
      ...(packetPreparation
        ? {
            packetPreparation: {
              ...packetPreparation,
              externalExecution: "blocked",
            },
          }
        : {}),
      ...(workerCommandData
        ? {
            workerCommand: {
              ...workerCommandData,
              externalExecution: "registry_controlled",
            },
          }
        : {}),
    };

    if (capabilityExecution && task) {
      await tx
        .update(tasks)
        .set({
          outcome: {
            ...task.outcome,
            lastCapabilityExecution: {
              ...capabilityExecution,
              workflowRunId: run.id,
              workflowStepId: step.id,
              eventId: event.id,
              auditEventId: audit.id,
              evidenceId: proof.id,
              executedAt: input.now.toISOString(),
            },
          },
          updatedAt: input.now,
        })
        .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, task.id)));
    }

    const [updatedStep] = await tx
      .update(workflowSteps)
      .set({
        eventId: event.id,
        approvalRequestId: approvalRequest?.approvalRequestId ?? step.approvalRequestId,
        state: "done",
        leaseOwner: null,
        leasedUntil: null,
        nextAttemptAt: null,
        output,
        error: {},
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workflowSteps.id, step.id),
          eq(workflowSteps.state, "running"),
          eq(workflowSteps.leaseOwner, claimOwner),
          eq(workflowSteps.attempt, step.attempt),
        ),
      )
      .returning();

    if (!updatedStep) {
      throw new WorkflowStepLeaseLostError();
    }

    return {
      step: updatedStep,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      output,
    };
  });
}

async function failWorkflowStep(input: {
  db: Database;
  claimed: ClaimedWorkflowStep;
  error: unknown;
  now: Date;
}) {
  const claimOwner = input.claimed.step.leaseOwner;
  const retryable = input.claimed.step.attempt < input.claimed.step.maxAttempts;
  const nextAttemptAt = retryable
    ? new Date(input.now.getTime() + Math.min(5 * 60 * 1000, 30 * 1000 * input.claimed.step.attempt))
    : null;
  const data = errorData(input.error, input.claimed.step.attempt, input.claimed.step.maxAttempts);

  if (!claimOwner) {
    return {
      step: null,
      error: data,
      skipped: true,
    };
  }

  const [updatedStep] = await input.db
    .update(workflowSteps)
    .set({
      state: "failed",
      leaseOwner: null,
      leasedUntil: null,
      nextAttemptAt,
      error: data,
      completedAt: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workflowSteps.id, input.claimed.step.id),
        eq(workflowSteps.state, "running"),
        eq(workflowSteps.leaseOwner, claimOwner),
        eq(workflowSteps.attempt, input.claimed.step.attempt),
      ),
    )
    .returning();

  if (!updatedStep) {
    return {
      step: null,
      error: data,
      skipped: true,
    };
  }

  return {
    step: updatedStep,
    error: data,
    skipped: false,
  };
}

export async function executeWorkflowSteps(input: {
  operatorEmail: string;
  tenantSlug?: string;
  limit?: number;
  leaseOwner?: string;
  leaseMs?: number;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const leaseOwner = input.leaseOwner ?? `workflow-executor:${operator.actorRef}`;
  const leaseMs = Math.max(30_000, Math.min(input.leaseMs ?? 5 * 60_000, 15 * 60_000));
  const results: Array<{
    stepId: string;
    state: "done" | "failed" | "skipped";
    attempt: number;
    handler: string;
    eventId?: string;
    auditEventId?: string;
    evidenceId?: string;
    error?: JsonObject;
  }> = [];

  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const claimed = await claimWorkflowStep({
      db,
      tenantId: operator.tenantId,
      leaseOwner,
      leaseMs,
      now,
    });

    if (!claimed) {
      break;
    }

    try {
      const workerCommandExecution =
        claimed.step.kind === "worker_command"
          ? await runWorkflowWorkerCommand({ operator, step: claimed.step })
          : undefined;
      const completed = await completeWorkflowStep({
        db,
        operator,
        claimed,
        now: new Date(),
        workerCommandExecution,
      });
      results.push({
        stepId: claimed.step.id,
        state: "done",
        attempt: claimed.step.attempt,
        handler: claimed.step.kind,
        eventId: completed.eventId,
        auditEventId: completed.auditEventId,
        evidenceId: completed.evidenceId,
      });
    } catch (error) {
      const failed = await failWorkflowStep({ db, claimed, error, now: new Date() });
      results.push({
        stepId: claimed.step.id,
        state: failed.skipped ? "skipped" : "failed",
        attempt: claimed.step.attempt,
        handler: claimed.step.kind,
        error: failed.error,
      });
    }
  }

  return {
    operator: {
      tenantId: operator.tenantId,
      tenantSlug: operator.tenantSlug,
      userId: operator.userId,
      email: operator.email,
    },
    leaseOwner,
    processed: results.length,
    completed: results.filter((result) => result.state === "done").length,
    failed: results.filter((result) => result.state === "failed").length,
    skipped: results.filter((result) => result.state === "skipped").length,
    results,
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
  idempotencyKey: string;
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
    const transitionInput = {
      schemaVersion: "workflow.transition.v1",
      runId: row.run.id,
      toState: input.toState,
      reason: input.reason ?? "",
      data: jsonObject(input.data),
      blockers: jsonObject(input.blockers),
      metrics: jsonObject(input.metrics),
    } satisfies JsonObject;
    const inputHash = hashJson(transitionInput);
    const transitionStepKey = `transition:${input.idempotencyKey}`;
    const [existingStep] = await tx
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.tenantId, operator.tenantId),
          eq(workflowSteps.workflowRunId, row.run.id),
          eq(workflowSteps.idempotencyKey, transitionStepKey),
        ),
      )
      .limit(1);

    if (existingStep) {
      const existingInput = jsonObject(existingStep.input);
      const existingOutput = jsonObject(existingStep.output);
      const existingHash = stringValue(existingInput.inputHash);

      if (
        (existingHash && existingHash !== inputHash) ||
        (!existingHash && stringValue(existingInput.toState) !== input.toState)
      ) {
        throw new RevenueWorkerUnavailableError(
          "workflow_transition_idempotency_conflict",
          "A workflow transition already exists for this idempotency key with different input.",
          409,
        );
      }

      return {
        created: false,
        replayed: true,
        run: runRecord(row),
        stepId: existingStep.id,
        eventId: existingStep.eventId,
        auditEventId: stringValue(existingOutput.auditEventId) ?? null,
        evidenceId: stringValue(existingOutput.evidenceId) ?? null,
        approvalRequestId: existingStep.approvalRequestId,
        approvalAuditEventId: stringValue(existingOutput.approvalAuditEventId) ?? null,
        approvalEvidenceId: stringValue(existingOutput.approvalEvidenceId) ?? null,
      };
    }

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
          idempotencyKey: input.idempotencyKey,
          inputHash,
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
        idempotencyKey: `${transitionStepKey}:event`,
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
        idempotencyKey: `${transitionStepKey}:audit`,
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
        hash: `${source}:${transitionStepKey}:transition`,
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
          idempotencyKey: `${transitionStepKey}:approval_requested`,
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
      created: true,
      replayed: false,
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
