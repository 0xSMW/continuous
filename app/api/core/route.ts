import { env } from "../../../src/env";
import { getHealth } from "../../../src/core/health";
import { getCoreSummarySafe } from "../../../src/core/summary";
import { createCoreTask } from "../../../src/core/tasks";
import { PlatformUnavailableError } from "../../../src/core/errors";
import {
  authorizeWorkerRead,
  authorizeWorkerRun,
  normalizeIdempotencyKey,
} from "../../../src/worker/security";
import type { JsonObject } from "../../../src/db/schema";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.core.v1";

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

function coreErrorResponse(error: unknown, fallbackCode: string) {
  const coreError =
    error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.message,
        }
      : {
          status: 500,
          code: fallbackCode,
          message: error instanceof Error ? error.message : "Unknown core error.",
        };

  return errorResponse(
    {
      code: coreError.code,
      message: coreError.message,
    },
    coreError.status,
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

  const result = await getCoreSummarySafe();
  const health = getHealth({
    dbOk: result.ok,
    dbError: result.error,
    counts: result.summary.counts,
  });

  return Response.json(
    {
      api: apiVersion,
      health,
      data: result.summary,
      error: result.error,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
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
  const core = bodyObject(body.core);
  const config = bodyObject(body.config);

  if (command === "task.create") {
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
      const result = await createCoreTask({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug: optionalString(core.tenantSlug),
        title: optionalString(config.title) ?? "",
        objectId: optionalString(config.objectId),
        capabilityId: optionalString(config.capabilityId),
        triggerEventId: optionalString(config.triggerEventId),
        state: optionalString(config.state),
        priority: optionalString(config.priority),
        owner: jsonObject(config.owner),
        ownerRef: optionalString(config.ownerRef),
        reviewerUserId: optionalString(config.reviewerUserId),
        dueAt: optionalString(config.dueAt),
        evidence: jsonObject(config.evidence),
        outcome: jsonObject(config.outcome),
        cost: jsonObject(config.cost),
        kpi: jsonObject(config.kpi),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
              tenantSlug: optionalString(core.tenantSlug) ?? null,
            },
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
      return coreErrorResponse(error, "core_task_create_failed");
    }
  }

  return errorResponse(
    {
      code: "core_command_unsupported",
      message: "Core command must be task.create.",
    },
    400,
  );
}
