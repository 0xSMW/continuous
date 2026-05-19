import { reconcileAdapterLedger } from "../core/adapters";
import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
} from "../core/approvals";
import { PlatformUnavailableError } from "../core/errors";
import type { JsonObject } from "../db/schema";
import {
  continueRevenueWorker,
  getRevenueWorkerSnapshotSafe,
  RevenueWorkerUnavailableError,
  runRevenueWorker,
} from "./revenue";
import { normalizeIdempotencyKey } from "./security";

export const workerApiVersion = "continuous.worker.v1";
const revenueWorkerRole = "revenue_operations";

export type WorkerTargetInput = {
  role?: string;
  id?: string;
  tenantSlug?: string;
};

export type WorkerTarget = {
  role: string;
  workerId?: string;
  tenantSlug?: string;
};

type WorkerResponseTarget = {
  role: string;
  id: string | null;
  tenantSlug: string | null;
};

type WorkerCommandContext = {
  target: WorkerTarget;
  operatorEmail: string;
  config: JsonObject;
  idempotencyKey?: string;
};

type WorkerCommandDefinition = {
  name: string;
  description: string;
  idempotency: "required" | "none";
  sideEffects: "internal" | "dry_run" | "approved_only" | "external" | "none";
  externalExecution: "blocked" | "dry_run" | "approved_only" | "enabled";
  requiresTenant?: boolean;
  handle: (context: WorkerCommandContext) => Promise<unknown>;
};

type WorkerViewContext = {
  target: WorkerTarget;
  operatorEmail: string;
  state?: string;
};

type WorkerViewDefinition = {
  name: string;
  description: string;
  handle: (context: WorkerViewContext) => Promise<WorkerViewResult>;
};

type WorkerDefinition = {
  role: string;
  commands: Record<string, WorkerCommandDefinition>;
  views: Record<string, WorkerViewDefinition>;
};

export type WorkerCommandResult = {
  worker: WorkerResponseTarget;
  command: string;
  result: unknown;
};

export type WorkerViewResult = {
  status?: number;
  data: {
    worker: WorkerResponseTarget;
    view: string;
    [key: string]: unknown;
  };
  error: string | null;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalLimit(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.limit must be an integer between 1 and 100.",
      400,
    );
  }

  return value;
}

function responseTarget(target: WorkerTarget, tenantSlug?: string | null): WorkerResponseTarget {
  return {
    role: target.role,
    id: target.workerId ?? null,
    tenantSlug: target.tenantSlug ?? tenantSlug ?? null,
  };
}

function unsupportedCommandMessage(definition: WorkerDefinition) {
  return `Worker command must be ${Object.keys(definition.commands).join(", ")}.`;
}

function unsupportedViewMessage(definition: WorkerDefinition) {
  return `Worker view must be ${Object.keys(definition.views).join(" or ")}.`;
}

function requireIdempotency(value: unknown) {
  const idempotency = normalizeIdempotencyKey(value);

  if (!idempotency.ok) {
    throw new PlatformUnavailableError("invalid_idempotency_key", idempotency.message, 400);
  }

  return idempotency.key;
}

const revenueDefinition: WorkerDefinition = {
  role: revenueWorkerRole,
  commands: {
    run: {
      name: "run",
      description: "Run the Revenue Operations Worker against persisted Core intake.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return runRevenueWorker({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    continue: {
      name: "continue",
      description: "Continue a worker-owned approval outcome without executing external actions.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);

        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        if (!approvalId) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId is required for continue.",
            400,
          );
        }

        return continueRevenueWorker({
          approvalId,
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
        });
      },
    },
    "approval.decide": {
      name: "approval.decide",
      description: "Decide a worker approval request without executing external actions.",
      idempotency: "none",
      sideEffects: "internal",
      externalExecution: "blocked",
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);
        const action = normalizeApprovalDecision(context.config.action);

        if (!approvalId || !action) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId and config.action are required for approval.decide.",
            400,
          );
        }

        return decideApproval({
          approvalId,
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          action,
          note: optionalString(context.config.note),
          subject: "worker",
        });
      },
    },
    "adapters.reconcile": {
      name: "adapters.reconcile",
      description: "Reconcile dry-run adapter records and capture receipts.",
      idempotency: "none",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      async handle(context) {
        if (!context.target.tenantSlug) {
          throw new PlatformUnavailableError(
            "invalid_worker_target",
            "worker.tenantSlug is required for adapter reconciliation.",
            400,
          );
        }

        return reconcileAdapterLedger({
          tenantSlug: context.target.tenantSlug,
          limit: optionalLimit(context.config.limit),
        });
      },
    },
  },
  views: {
    snapshot: {
      name: "snapshot",
      description: "Read the worker runtime snapshot.",
      async handle(context) {
        const result = await getRevenueWorkerSnapshotSafe({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          role: context.target.role,
        });

        return {
          status: result.ok ? 200 : 500,
          data: {
            worker: responseTarget(context.target),
            view: "snapshot",
            snapshot: result.snapshot,
          },
          error: result.error,
        };
      },
    },
    approvals: {
      name: "approvals",
      description: "List worker approval requests.",
      async handle(context) {
        const approvals = await listApprovals({
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          state: context.state,
          subject: "worker",
        });

        return {
          data: {
            worker: responseTarget(context.target, approvals.operator.tenantSlug),
            view: "approvals",
            approvals,
          },
          error: null,
        };
      },
    },
  },
};

const workerDefinitions: Record<string, WorkerDefinition> = {
  [revenueDefinition.role]: revenueDefinition,
};

export function registeredWorkerCommands() {
  return Object.values(workerDefinitions).flatMap((definition) =>
    Object.values(definition.commands).map((command) => ({
      role: definition.role,
      name: command.name,
      description: command.description,
      idempotency: command.idempotency,
      sideEffects: command.sideEffects,
      externalExecution: command.externalExecution,
      requiresTenant: command.requiresTenant === true,
    })),
  );
}

export function registeredWorkerViews() {
  return Object.values(workerDefinitions).flatMap((definition) =>
    Object.values(definition.views).map((view) => ({
      role: definition.role,
      name: view.name,
      description: view.description,
    })),
  );
}

export function resolveWorkerTarget(target: WorkerTargetInput = {}): WorkerTarget {
  const role = optionalString(target.role);

  if (!role) {
    throw new PlatformUnavailableError(
      "invalid_worker_target",
      "worker.role is required.",
      400,
    );
  }

  if (!workerDefinitions[role]) {
    throw new PlatformUnavailableError(
      "worker_role_unsupported",
      `Worker role ${role} is not available yet.`,
      400,
    );
  }

  return {
    role,
    workerId: target.id,
    tenantSlug: target.tenantSlug,
  };
}

export function workerErrorStatus(error: unknown, fallbackCode: string) {
  if (error instanceof RevenueWorkerUnavailableError || error instanceof PlatformUnavailableError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  return {
    status: 500,
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown worker error.",
  };
}

export async function executeWorkerCommand(input: {
  command?: string;
  target?: WorkerTargetInput;
  operatorEmail: string;
  config?: unknown;
  idempotencyKey?: unknown;
}): Promise<WorkerCommandResult> {
  const target = resolveWorkerTarget(input.target);
  const definition = workerDefinitions[target.role];
  const commandName = optionalString(input.command);
  const command = commandName ? definition.commands[commandName] : undefined;

  if (!command) {
    throw new PlatformUnavailableError(
      "worker_command_unsupported",
      unsupportedCommandMessage(definition),
      400,
    );
  }

  if (command.requiresTenant && !target.tenantSlug) {
    throw new PlatformUnavailableError(
      "invalid_worker_target",
      "worker.tenantSlug is required for adapter reconciliation.",
      400,
    );
  }

  const idempotencyKey =
    command.idempotency === "required" ? requireIdempotency(input.idempotencyKey) : undefined;
  const result = await command.handle({
    target,
    operatorEmail: input.operatorEmail,
    config: jsonObject(input.config),
    idempotencyKey,
  });

  return {
    worker: responseTarget(target),
    command: command.name,
    result,
  };
}

export async function executeWorkerView(input: {
  view?: string;
  target?: WorkerTargetInput;
  operatorEmail: string;
  state?: string;
}): Promise<WorkerViewResult> {
  const target = resolveWorkerTarget(input.target);
  const definition = workerDefinitions[target.role];
  const viewName = optionalString(input.view) ?? "snapshot";
  const view = definition.views[viewName];

  if (!view) {
    throw new PlatformUnavailableError(
      "worker_view_unsupported",
      unsupportedViewMessage(definition),
      400,
    );
  }

  return view.handle({
    target,
    operatorEmail: input.operatorEmail,
    state: input.state,
  });
}
