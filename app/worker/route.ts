import { env } from "../../src/env";
import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
} from "../../src/core/approvals";
import { reconcileAdapterLedger } from "../../src/core/adapters";
import { PlatformUnavailableError } from "../../src/core/errors";
import type { JsonObject } from "../../src/db/schema";
import {
  getRevenueWorkerSnapshotSafe,
  RevenueWorkerUnavailableError,
  runRevenueWorker,
} from "../../src/worker/revenue";
import {
  authorizeWorkerRead,
  authorizeWorkerRun,
  normalizeIdempotencyKey,
} from "../../src/worker/security";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.worker.v1";
const revenueRole = "revenue_operations";

type WorkerTarget = {
  role?: string;
  id?: string;
  tenantSlug?: string;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalLimit(value: unknown) {
  if (value === undefined || value === null) {
    return { ok: true as const, value: undefined };
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    return {
      ok: false as const,
      error: {
        code: "invalid_worker_command_config",
        message: "config.limit must be an integer between 1 and 100.",
      },
    };
  }

  return { ok: true as const, value };
}

async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  try {
    return bodyObject(await request.json());
  } catch {
    return {};
  }
}

function targetFrom(value: unknown): WorkerTarget {
  const target = bodyObject(value);
  return {
    role: optionalString(target.role),
    id: optionalString(target.id),
    tenantSlug: optionalString(target.tenantSlug),
  };
}

function targetFromUrl(request: Request): WorkerTarget {
  const url = new URL(request.url);
  return {
    role: optionalString(url.searchParams.get("role")),
    id: optionalString(url.searchParams.get("id")),
    tenantSlug: optionalString(url.searchParams.get("tenantSlug")),
  };
}

function validateTarget(target: WorkerTarget) {
  const role = target.role ?? revenueRole;

  if (role !== revenueRole) {
    return {
      ok: false as const,
      error: {
        code: "worker_role_unsupported",
        message: `Worker role ${role} is not available yet.`,
      },
    };
  }

  return {
    ok: true as const,
    target: {
      role,
      workerId: target.id,
      tenantSlug: target.tenantSlug,
    },
  };
}

function errorResponse(error: { code: string; message: string }, status: number) {
  return Response.json(
    {
      api: apiVersion,
      data: null,
      error,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function workerErrorResponse(error: unknown, fallbackCode: string) {
  const workerError =
    error instanceof RevenueWorkerUnavailableError || error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.message,
        }
      : {
          status: 500,
          code: fallbackCode,
          message: error instanceof Error ? error.message : "Unknown worker error.",
        };

  return errorResponse(
    {
      code: workerError.code,
      message: workerError.message,
    },
    workerError.status,
  );
}

export async function GET(request: Request) {
  const auth = authorizeWorkerRead({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
  }

  const url = new URL(request.url);
  const view = optionalString(url.searchParams.get("view")) ?? "snapshot";
  const target = validateTarget(targetFromUrl(request));

  if (!target.ok) {
    return errorResponse(target.error, 400);
  }

  try {
    if (view === "approvals") {
      const approvals = await listApprovals({
        operatorEmail: auth.operatorEmail,
        tenantSlug: target.target.tenantSlug,
        state: optionalString(url.searchParams.get("state")),
        subject: "worker",
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            worker: {
              role: target.target.role,
              id: target.target.workerId ?? null,
              tenantSlug: target.target.tenantSlug ?? approvals.operator.tenantSlug,
            },
            view,
            approvals,
          },
          error: null,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    if (view !== "snapshot") {
      return errorResponse(
        {
          code: "worker_view_unsupported",
          message: "Worker view must be snapshot or approvals.",
        },
        400,
      );
    }

    const result = await getRevenueWorkerSnapshotSafe({
      tenantSlug: target.target.tenantSlug,
      workerId: target.target.workerId,
      role: target.target.role,
    });

    return Response.json(
      {
        api: apiVersion,
        data: {
          worker: {
            role: target.target.role,
            id: target.target.workerId ?? null,
            tenantSlug: target.target.tenantSlug ?? null,
          },
          view,
          snapshot: result.snapshot,
        },
        error: result.error,
      },
      {
        status: result.ok ? 200 : 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_view_failed");
  }
}

export async function POST(request: Request) {
  const auth = authorizeWorkerRun({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
  }

  const body = await readBody(request);
  const command = optionalString(body.command);
  const target = validateTarget(targetFrom(body.worker));
  const config = jsonObject(body.config);

  if (!target.ok) {
    return errorResponse(target.error, 400);
  }

  if (command === "run") {
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await runRevenueWorker({
        idempotencyKey: idempotency.key,
        tenantSlug: target.target.tenantSlug,
        workerId: target.target.workerId,
        operatorEmail: auth.operatorEmail,
        config,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            worker: {
              role: target.target.role,
              id: target.target.workerId ?? null,
              tenantSlug: target.target.tenantSlug ?? null,
            },
            command,
            result,
          },
          error: null,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      return workerErrorResponse(error, "worker_run_failed");
    }
  }

  if (command === "approval.decide") {
    const approvalId = optionalString(config.approvalId);
    const action = normalizeApprovalDecision(config.action);

    if (!approvalId || !action) {
      return errorResponse(
        {
          code: "invalid_worker_command_config",
          message: "config.approvalId and config.action are required for approval.decide.",
        },
        400,
      );
    }

    try {
      const result = await decideApproval({
        approvalId,
        operatorEmail: auth.operatorEmail,
        tenantSlug: target.target.tenantSlug,
        action,
        note: optionalString(config.note),
        subject: "worker",
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            worker: {
              role: target.target.role,
              id: target.target.workerId ?? null,
              tenantSlug: target.target.tenantSlug ?? null,
            },
            command,
            result,
          },
          error: null,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      return workerErrorResponse(error, "worker_approval_decision_failed");
    }
  }

  if (command === "adapters.reconcile") {
    if (!target.target.tenantSlug) {
      return errorResponse(
        {
          code: "invalid_worker_target",
          message: "worker.tenantSlug is required for adapters.reconcile.",
        },
        400,
      );
    }

    const limit = optionalLimit(config.limit);

    if (!limit.ok) {
      return errorResponse(limit.error, 400);
    }

    try {
      const result = await reconcileAdapterLedger({
        tenantSlug: target.target.tenantSlug,
        limit: limit.value,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            worker: {
              role: target.target.role,
              id: target.target.workerId ?? null,
              tenantSlug: target.target.tenantSlug,
            },
            command,
            result,
          },
          error: null,
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      return workerErrorResponse(error, "worker_adapter_reconciliation_failed");
    }
  }

  return errorResponse(
    {
      code: "worker_command_unsupported",
      message: "Worker command must be run, approval.decide, or adapters.reconcile.",
    },
    400,
  );
}
