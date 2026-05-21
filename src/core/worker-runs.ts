import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  events,
  evidence,
  tasks,
  usageEvents,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type RunState = "done" | "failed" | "canceled";

const source = "continuous.core.worker_runs";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operationPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const modePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const terminalStates = new Set<RunState>(["done", "failed", "canceled"]);

export type StartCoreWorkerRunInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  worker?: unknown;
  command?: string;
  mode?: string;
  taskId?: string;
  capabilityId?: string;
  capabilityKey?: string;
  capabilityVersion?: string;
  connectionId?: string;
  budgetAccountId?: string;
  units?: unknown;
  expiresAt?: string;
  input?: unknown;
  policy?: unknown;
  evidence?: unknown;
  db?: Database;
};

export type CompleteCoreWorkerRunInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  worker?: unknown;
  workerRunId?: string;
  state?: string;
  output?: unknown;
  reason?: string;
  costUsd?: unknown;
  evidence?: unknown;
  db?: Database;
};

type WorkerSelector = {
  id?: string;
  role: string;
};

type ResolvedWorker = typeof workers.$inferSelect;

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("worker_run_field_required", `${field} is required.`, 400);
  }

  return output;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError("worker_run_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return value;
}

function requiredUuid(value: unknown, field: string) {
  const output = optionalUuid(requiredString(value, field), field);

  if (!output) {
    throw new PlatformUnavailableError("worker_run_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return output;
}

function parseWorkerSelector(value: unknown): WorkerSelector {
  const worker = objectValue(value);
  const role = requiredString(worker.role, "config.worker.role");
  const id = optionalUuid(cleanString(worker.id), "config.worker.id");

  if (!modePattern.test(role) || role.endsWith("_worker")) {
    throw new PlatformUnavailableError(
      "worker_run_worker_role_invalid",
      "config.worker.role must be a lower_snake_case role identifier.",
      400,
    );
  }

  return { id, role };
}

function parseCommand(value: unknown) {
  const command = requiredString(value, "config.command");

  if (!operationPattern.test(command) || command.includes("_worker")) {
    throw new PlatformUnavailableError(
      "worker_run_command_invalid",
      "config.command must be a registered lower_snake_case or dotted operation identifier.",
      400,
    );
  }

  return command;
}

function parseMode(value: unknown) {
  const mode = cleanString(value) ?? "simulation";

  if (!modePattern.test(mode) || mode.includes("_worker")) {
    throw new PlatformUnavailableError(
      "worker_run_mode_invalid",
      "config.mode must be a lower_snake_case or dotted mode identifier.",
      400,
    );
  }

  return mode;
}

function parseUnits(value: unknown) {
  const units = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(units) || units < 1) {
    throw new PlatformUnavailableError("worker_run_units_invalid", "config.units must be a positive integer.", 400);
  }

  return units;
}

function parseCostUsd(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "0.000000";
  }

  const cost = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(cost) || cost < 0) {
    throw new PlatformUnavailableError(
      "worker_run_cost_invalid",
      "config.costUsd must be a non-negative number.",
      400,
    );
  }

  return cost.toFixed(6);
}

function optionalDate(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("worker_run_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function parseTerminalState(value: unknown): RunState {
  const state = requiredString(value, "config.state");

  if (!terminalStates.has(state as RunState)) {
    throw new PlatformUnavailableError(
      "worker_run_state_invalid",
      "config.state must be done, failed, or canceled.",
      400,
    );
  }

  return state as RunState;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function workerRunView(row: typeof workerRuns.$inferSelect, worker: ResolvedWorker) {
  return {
    id: row.id,
    worker: {
      id: worker.id,
      role: worker.role,
      state: worker.state,
    },
    state: row.state,
    mode: row.mode,
    taskId: row.taskId,
    eventId: row.eventId,
    capabilityId: row.capabilityId,
    connectionId: row.connectionId,
    budgetAccountId: row.budgetAccountId,
    source: row.source,
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

async function evidenceForAudit(tx: Pick<Database, "select">, tenantId: string, auditEventId: string) {
  const [item] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.data}->>'auditEventId' = ${auditEventId}`))
    .limit(1);

  return item?.id ?? null;
}

async function resolveWorker(input: {
  tx: Pick<Database, "select">;
  tenantId: string;
  selector: WorkerSelector;
}) {
  const conditions = [
    eq(workers.tenantId, input.tenantId),
    eq(workers.role, input.selector.role),
    sql`${workers.state} in ('training', 'active')`,
  ];

  if (input.selector.id) {
    conditions.push(eq(workers.id, input.selector.id));
  }

  const rows = await input.tx
    .select()
    .from(workers)
    .where(and(...conditions))
    .orderBy(workers.createdAt)
    .limit(input.selector.id ? 1 : 2);

  if (rows.length === 0) {
    throw new PlatformUnavailableError(
      "worker_run_worker_not_found",
      "config.worker does not match a training or active worker in this tenant.",
      404,
    );
  }

  if (!input.selector.id && rows.length > 1) {
    throw new PlatformUnavailableError(
      "worker_run_worker_selector_ambiguous",
      "Multiple workers match config.worker.role. Provide config.worker.id.",
      409,
    );
  }

  return rows[0];
}

async function resolveCapability(input: {
  tx: Pick<Database, "select">;
  requestedCapabilityId?: string;
  capabilityKey?: string;
  capabilityVersion?: string;
}) {
  if (!input.requestedCapabilityId && !input.capabilityKey) {
    throw new PlatformUnavailableError(
      "worker_run_capability_required",
      "config.capabilityId or config.capabilityKey is required.",
      400,
    );
  }

  const conditions = input.requestedCapabilityId
    ? [eq(capabilities.id, input.requestedCapabilityId)]
    : [
        eq(capabilities.key, input.capabilityKey ?? ""),
        eq(capabilities.version, input.capabilityVersion ?? "1.0.0"),
      ];

  const [capability] = await input.tx
    .select()
    .from(capabilities)
    .where(and(...conditions, eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_run_capability_not_found",
      "config.capabilityId or config.capabilityKey does not match an active capability.",
      404,
    );
  }

  return capability;
}

async function assertCapabilityGrant(input: {
  tx: Pick<Database, "select">;
  tenantId: string;
  workerId: string;
  capabilityId: string;
  now: Date;
}) {
  const [grant] = await input.tx
    .select({ id: capabilityGrants.id })
    .from(capabilityGrants)
    .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
    .where(
      and(
        eq(capabilityGrants.tenantId, input.tenantId),
        eq(capabilityGrants.actorType, "worker"),
        eq(capabilityGrants.actorId, input.workerId),
        eq(capabilityGrants.capabilityId, input.capabilityId),
        eq(capabilityGrants.active, true),
        eq(capabilities.active, true),
        sql`(${capabilityGrants.startsAt} is null or ${capabilityGrants.startsAt} <= ${input.now})`,
        sql`(${capabilityGrants.endsAt} is null or ${capabilityGrants.endsAt} > ${input.now})`,
      ),
    )
    .limit(1);

  if (!grant) {
    throw new PlatformUnavailableError(
      "worker_run_capability_not_granted",
      "The selected worker is not actively granted the required capability.",
      403,
    );
  }

  return grant;
}

async function assertTask(tx: Pick<Database, "select">, tenantId: string, taskId?: string) {
  if (!taskId) {
    return;
  }

  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
    .limit(1);

  if (!task) {
    throw new PlatformUnavailableError(
      "worker_run_task_not_found",
      "config.taskId does not match a task in this tenant.",
      404,
    );
  }
}

async function assertConnection(tx: Pick<Database, "select">, tenantId: string, connectionId?: string) {
  if (!connectionId) {
    return;
  }

  const [connection] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "worker_run_connection_not_found",
      "config.connectionId does not match a connection in this tenant.",
      404,
    );
  }
}

async function assertBudgetCapacity(input: {
  tx: Pick<Database, "select">;
  tenantId: string;
  accountId: string;
  workerId: string;
  units: number;
  now: Date;
}) {
  const [budgetState] = await input.tx
    .select({
      id: budgetAccounts.id,
      target: budgetAccounts.target,
      targetId: budgetAccounts.targetId,
      policyId: budgetAccounts.policyId,
      policyActive: budgetPolicies.active,
      monthlyUnits: budgetPolicies.monthlyUnits,
      perTaskUnits: budgetPolicies.perTaskUnits,
      hardLimit: budgetPolicies.hardLimit,
    })
    .from(budgetAccounts)
    .leftJoin(budgetPolicies, eq(budgetAccounts.policyId, budgetPolicies.id))
    .where(
      and(
        eq(budgetAccounts.tenantId, input.tenantId),
        eq(budgetAccounts.id, input.accountId),
        eq(budgetAccounts.active, true),
      ),
    )
    .limit(1);

  if (!budgetState) {
    throw new PlatformUnavailableError(
      "worker_run_budget_account_not_found",
      "config.budgetAccountId does not match an active budget account in this tenant.",
      404,
    );
  }

  if (budgetState.target !== "worker" || budgetState.targetId !== input.workerId) {
    throw new PlatformUnavailableError(
      "worker_run_budget_account_mismatch",
      "config.budgetAccountId must belong to config.worker.",
      403,
    );
  }

  if (!budgetState.policyId || !budgetState.policyActive) {
    throw new PlatformUnavailableError(
      "worker_run_budget_policy_missing",
      "config.budgetAccountId has no active budget policy.",
      409,
    );
  }

  const perTaskUnits = budgetState.perTaskUnits === null ? null : numberValue(budgetState.perTaskUnits);

  if (perTaskUnits !== null && input.units > perTaskUnits) {
    throw new PlatformUnavailableError(
      "worker_run_budget_per_task_exceeded",
      `Worker run requires ${input.units} units, above the per-task limit of ${perTaskUnits}.`,
      409,
    );
  }

  const [allocation] = await input.tx
    .select({
      units: sql<number>`coalesce(sum(${budgetAllocations.units}), 0)`,
      startsAt: sql<Date | null>`min(${budgetAllocations.startsAt})`,
      endsAt: sql<Date | null>`max(${budgetAllocations.endsAt})`,
    })
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.accountId, input.accountId),
        sql`${budgetAllocations.startsAt} <= ${input.now}`,
        sql`${budgetAllocations.endsAt} > ${input.now}`,
      ),
    );
  const usageConditions = [eq(usageEvents.accountId, input.accountId)];

  if (allocation?.startsAt && allocation.endsAt) {
    usageConditions.push(sql`${usageEvents.createdAt} >= ${allocation.startsAt}`);
    usageConditions.push(sql`${usageEvents.createdAt} < ${allocation.endsAt}`);
  }

  const [used] = await input.tx
    .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
    .from(usageEvents)
    .where(and(...usageConditions));
  const [held] = await input.tx
    .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.accountId, input.accountId),
        eq(budgetReservations.state, "held"),
        sql`(${budgetReservations.expiresAt} is null or ${budgetReservations.expiresAt} > ${input.now})`,
      ),
    );
  const monthlyUnits = numberValue(budgetState.monthlyUnits);
  const allocatedUnits = numberValue(allocation?.units);
  const allowanceUnits =
    allocatedUnits > 0 && monthlyUnits > 0
      ? Math.min(allocatedUnits, monthlyUnits)
      : allocatedUnits > 0
        ? allocatedUnits
        : monthlyUnits;
  const hardLimit = numberValue(budgetState.hardLimit) || 100;
  const maxUnits = Math.floor((allowanceUnits * hardLimit) / 100);
  const committedUnits = numberValue(used?.units) + numberValue(held?.units);

  if (maxUnits <= 0 || committedUnits + input.units > maxUnits) {
    throw new PlatformUnavailableError(
      "worker_run_budget_exceeded",
      `Worker run requires ${input.units} units, with ${Math.max(maxUnits - committedUnits, 0)} units available.`,
      409,
    );
  }
}

function resultFromExisting(input: {
  action: "start" | "complete";
  run: typeof workerRuns.$inferSelect;
  worker: ResolvedWorker;
  auditEventId: string;
  evidenceId: string | null;
}) {
  const data = objectValue(input.run.data);

  return {
    recorded: false,
    started: input.action === "start" ? false : undefined,
    completed: input.action === "complete" ? false : undefined,
    workerRunId: input.run.id,
    eventId: input.run.eventId,
    auditEventId: input.auditEventId,
    evidenceId: input.evidenceId,
    budget: objectValue(data.budget),
    capability: objectValue(data.capability),
    run: workerRunView(input.run, input.worker),
  };
}

export async function startCoreWorkerRun(input: StartCoreWorkerRunInput) {
  const db = input.db ?? defaultDb;
  const selector = parseWorkerSelector(input.worker);
  const command = parseCommand(input.command);
  const mode = parseMode(input.mode);
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");
  const connectionId = optionalUuid(cleanString(input.connectionId), "config.connectionId");
  const requestedCapabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const capabilityKey = cleanString(input.capabilityKey);
  const capabilityVersion = cleanString(input.capabilityVersion) ?? "1.0.0";
  const budgetAccountId = requiredUuid(input.budgetAccountId, "config.budgetAccountId");
  const units = parseUnits(input.units);
  const runInput = objectValue(input.input);
  const policy = objectValue(input.policy);
  const evidenceInput = objectValue(input.evidence);
  const requestedExpiresAt = optionalDate(cleanString(input.expiresAt), "config.expiresAt");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const fingerprint = coreIdempotencyFingerprint("worker.run.start", {
    worker: selector,
    command,
    mode,
    taskId: taskId ?? null,
    connectionId: connectionId ?? null,
    capabilityId: requestedCapabilityId ?? null,
    capabilityKey: capabilityKey ?? null,
    capabilityVersion,
    budgetAccountId,
    units,
    expiresAt: requestedExpiresAt?.toISOString() ?? null,
    input: runInput,
    policy,
    evidence: evidenceInput,
    externalExecution: "blocked",
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
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
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:worker_run_started`),
          eq(auditEvents.targetType, "worker_run"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "worker.run.start",
        fingerprint,
        storedData: existingAudit.data,
      });

      const [existing] = await tx
        .select({ run: workerRuns, worker: workers })
        .from(workerRuns)
        .innerJoin(workers, eq(workerRuns.workerId, workers.id))
        .where(and(eq(workerRuns.tenantId, operator.tenantId), eq(workerRuns.id, existingAudit.targetId)))
        .limit(1);

      if (existing) {
        return resultFromExisting({
          action: "start",
          run: existing.run,
          worker: existing.worker,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        });
      }
    }

    const worker = await resolveWorker({ tx, tenantId: operator.tenantId, selector });
    const capability = await resolveCapability({
      tx,
      requestedCapabilityId,
      capabilityKey,
      capabilityVersion,
    });
    const now = new Date();
    const grant = await assertCapabilityGrant({
      tx,
      tenantId: operator.tenantId,
      workerId: worker.id,
      capabilityId: capability.id,
      now,
    });
    await Promise.all([
      assertTask(tx, operator.tenantId, taskId),
      assertConnection(tx, operator.tenantId, connectionId),
      assertBudgetCapacity({
        tx,
        tenantId: operator.tenantId,
        accountId: budgetAccountId,
        workerId: worker.id,
        units,
        now,
      }),
    ]);

    const expiresAt = requestedExpiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);

    if (expiresAt <= now) {
      throw new PlatformUnavailableError("worker_run_expiration_invalid", "config.expiresAt must be in the future.", 400);
    }

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: operator.tenantId,
        accountId: budgetAccountId,
        taskId,
        units,
        state: "held",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const runData = {
      input: {
        command,
        worker: {
          id: worker.id,
          role: worker.role,
        },
        request: runInput,
        idempotency: fingerprint,
      },
      policy: {
        externalExecution: "blocked",
        ...policy,
      },
      budget: {
        reservationId: reservation.id,
        budgetAccountId,
        units,
        expiresAt: expiresAt.toISOString(),
      },
      capability: {
        capabilityId: capability.id,
        capabilityKey: capability.key,
        capabilityGrantId: grant.id,
      },
      evidence: evidenceInput,
      externalExecution: "blocked",
    };
    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: operator.tenantId,
        workerId: worker.id,
        taskId,
        capabilityId: capability.id,
        connectionId,
        budgetAccountId,
        source,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode,
        data: runData,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const payload = {
      workerRunId: run.id,
      worker: {
        id: worker.id,
        role: worker.role,
      },
      command,
      mode,
      taskId: taskId ?? null,
      connectionId: connectionId ?? null,
      capabilityId: capability.id,
      capabilityKey: capability.key,
      capabilityGrantId: grant.id,
      budgetAccountId,
      reservationId: reservation.id,
      units,
      idempotency: fingerprint,
      externalExecution: "blocked",
      evidence: evidenceInput,
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "worker.run.started",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        taskId,
        capabilityId: capability.id,
        connectionId,
        idempotencyKey: `${input.idempotencyKey}:worker_run_started`,
        data: payload,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "worker.run.started",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "worker_run",
        targetId: run.id,
        taskId,
        workerRunId: run.id,
        eventId: event.id,
        capabilityId: capability.id,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:worker_run_started`,
        data: payload,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Worker run started: ${worker.role} ${command}`,
        taskId,
        eventId: event.id,
        capabilityId: capability.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${run.id}:started:${now.toISOString()}`,
        data: {
          ...payload,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });
    const [updatedRun] = await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        data: {
          ...runData,
          eventId: event.id,
          auditEventId: audit.id,
          evidenceId: proof.id,
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id))
      .returning();

    return {
      recorded: true,
      started: true,
      workerRunId: run.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      budget: {
        reservationId: reservation.id,
        budgetAccountId,
        units,
        state: reservation.state,
        expiresAt: expiresAt.toISOString(),
      },
      capability: {
        capabilityId: capability.id,
        capabilityKey: capability.key,
        capabilityGrantId: grant.id,
      },
      run: workerRunView(updatedRun, worker),
    };
  });
}

export async function completeCoreWorkerRun(input: CompleteCoreWorkerRunInput) {
  const db = input.db ?? defaultDb;
  const selector = parseWorkerSelector(input.worker);
  const workerRunId = requiredUuid(input.workerRunId, "config.workerRunId");
  const state = parseTerminalState(input.state);
  const output = objectValue(input.output);
  const reason = requiredString(input.reason, "config.reason");
  const costUsd = parseCostUsd(input.costUsd);
  const evidenceInput = objectValue(input.evidence);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const fingerprint = coreIdempotencyFingerprint("worker.run.complete", {
    worker: selector,
    workerRunId,
    state,
    output,
    reason,
    costUsd,
    evidence: evidenceInput,
    externalExecution: "blocked",
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:complete:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
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
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:worker_run_completed`),
          eq(auditEvents.targetType, "worker_run"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "worker.run.complete",
        fingerprint,
        storedData: existingAudit.data,
      });

      const [existing] = await tx
        .select({ run: workerRuns, worker: workers })
        .from(workerRuns)
        .innerJoin(workers, eq(workerRuns.workerId, workers.id))
        .where(and(eq(workerRuns.tenantId, operator.tenantId), eq(workerRuns.id, existingAudit.targetId)))
        .limit(1);

      if (existing) {
        return resultFromExisting({
          action: "complete",
          run: existing.run,
          worker: existing.worker,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        });
      }
    }

    await tx.execute(
      sql`select id from worker_runs where tenant_id = ${operator.tenantId} and id = ${workerRunId} for update`,
    );

    const [selected] = await tx
      .select({ run: workerRuns, worker: workers })
      .from(workerRuns)
      .innerJoin(workers, eq(workerRuns.workerId, workers.id))
      .where(and(eq(workerRuns.tenantId, operator.tenantId), eq(workerRuns.id, workerRunId)))
      .limit(1);

    if (!selected) {
      throw new PlatformUnavailableError(
        "worker_run_not_found",
        "config.workerRunId does not match a worker run in this tenant.",
        404,
      );
    }

    if (selected.worker.role !== selector.role || (selector.id && selected.worker.id !== selector.id)) {
      throw new PlatformUnavailableError(
        "worker_run_worker_mismatch",
        "config.worker does not match the worker that owns config.workerRunId.",
        403,
      );
    }

    if (selected.run.state !== "running") {
      throw new PlatformUnavailableError(
        "worker_run_not_running",
        "Only running worker runs can be completed.",
        409,
      );
    }

    const runData = objectValue(selected.run.data);
    const runBudget = objectValue(runData.budget);
    const reservationId = cleanString(runBudget.reservationId);
    const now = new Date();
    let budgetSettlement: JsonObject = {
      state: "none",
    };

    if (reservationId) {
      await tx.execute(
        sql`select id from budget_reservations where tenant_id = ${operator.tenantId} and id = ${reservationId} for update`,
      );

      const [reservation] = await tx
        .select()
        .from(budgetReservations)
        .where(and(eq(budgetReservations.tenantId, operator.tenantId), eq(budgetReservations.id, reservationId)))
        .limit(1);

      if (!reservation) {
        throw new PlatformUnavailableError(
          "worker_run_budget_reservation_not_found",
          "The worker run budget reservation is missing.",
          404,
        );
      }

      if (reservation.state !== "held") {
        throw new PlatformUnavailableError(
          "worker_run_budget_reservation_not_held",
          "The worker run budget reservation is not held.",
          409,
        );
      }

      if (reservation.expiresAt && reservation.expiresAt <= now) {
        await tx
          .update(budgetReservations)
          .set({ state: "expired", updatedAt: now })
          .where(eq(budgetReservations.id, reservation.id));
        throw new PlatformUnavailableError(
          "worker_run_budget_reservation_expired",
          "Expired worker run budget reservations cannot be settled.",
          409,
        );
      }

      if (state === "done") {
        const [usage] = await tx
          .insert(usageEvents)
          .values({
            tenantId: operator.tenantId,
            accountId: reservation.accountId,
            reservationId: reservation.id,
            taskId: selected.run.taskId ?? reservation.taskId,
            capabilityId: selected.run.capabilityId,
            actorType: "worker",
            actorId: selected.worker.id,
            units: reservation.units,
            costUsd,
            data: {
              workerRunId,
              reason,
              output,
              externalExecution: "blocked",
            },
            createdAt: now,
          })
          .returning();

        await tx
          .update(budgetReservations)
          .set({ state: "used", updatedAt: now })
          .where(eq(budgetReservations.id, reservation.id));
        budgetSettlement = {
          state: "used",
          reservationId: reservation.id,
          usageEventId: usage.id,
          units: usage.units,
          costUsd,
        };
      } else {
        await tx
          .update(budgetReservations)
          .set({ state: "released", updatedAt: now })
          .where(eq(budgetReservations.id, reservation.id));
        budgetSettlement = {
          state: "released",
          reservationId: reservation.id,
          units: reservation.units,
        };
      }
    }

    const payload = {
      workerRunId,
      worker: {
        id: selected.worker.id,
        role: selected.worker.role,
      },
      state,
      reason,
      output,
      budget: budgetSettlement,
      idempotency: fingerprint,
      externalExecution: "blocked",
      evidence: evidenceInput,
    };
    const eventType =
      state === "done" ? "worker.run.completed" : state === "failed" ? "worker.run.failed" : "worker.run.canceled";
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        taskId: selected.run.taskId,
        capabilityId: selected.run.capabilityId,
        connectionId: selected.run.connectionId,
        idempotencyKey: `${input.idempotencyKey}:worker_run_completed`,
        data: payload,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "worker_run",
        targetId: workerRunId,
        taskId: selected.run.taskId,
        workerRunId,
        eventId: event.id,
        capabilityId: selected.run.capabilityId,
        risk: state === "done" ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:worker_run_completed`,
        data: payload,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: state === "done" ? "receipt" : "trace",
        name: `Worker run ${state}: ${selected.worker.role}`,
        taskId: selected.run.taskId,
        eventId: event.id,
        capabilityId: selected.run.capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${workerRunId}:${state}:${now.toISOString()}`,
        data: {
          ...payload,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });
    const [updatedRun] = await tx
      .update(workerRuns)
      .set({
        state,
        eventId: event.id,
        data: {
          ...runData,
          output,
          completion: {
            ...payload,
            eventId: event.id,
            auditEventId: audit.id,
            evidenceId: proof.id,
          },
          externalExecution: "blocked",
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRunId))
      .returning();

    return {
      recorded: true,
      completed: true,
      workerRunId,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      budget: budgetSettlement,
      run: workerRunView(updatedRun, selected.worker),
    };
  });
}
