import { env } from "../../../../src/env";
import { RevenueWorkerUnavailableError, runRevenueWorker } from "../../../../src/worker/revenue";
import { authorizeRevenueWorkerRun, normalizeIdempotencyKey } from "../../../../src/worker/security";

export const dynamic = "force-dynamic";

async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  const auth = authorizeRevenueWorkerRun({
    enabled: env.REVENUE_WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.REVENUE_WORKER_RUN_TOKEN,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return Response.json(
      {
        api: "continuous.revenue_worker.v0",
        error: auth,
      },
      {
        status: auth.status,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const body = await readBody(request);
  const idempotency = normalizeIdempotencyKey(
    request.headers.get("idempotency-key") ?? body.idempotencyKey,
  );

  if (!idempotency.ok) {
    return Response.json(
      {
        api: "continuous.revenue_worker.v0",
        error: {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
      },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  try {
    const result = await runRevenueWorker({
      idempotencyKey: idempotency.key,
      tenantSlug: optionalString(body.tenantSlug),
      workerId: optionalString(body.workerId),
    });

    return Response.json(
      {
        api: "continuous.revenue_worker.v0",
        data: result,
        error: null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    const workerError =
      error instanceof RevenueWorkerUnavailableError
        ? {
            status: error.status,
            code: error.code,
            message: error.message,
          }
        : {
            status: 500,
            code: "worker_run_failed",
            message: error instanceof Error ? error.message : "Unknown Revenue Worker run error.",
          };

    return Response.json(
      {
        api: "continuous.revenue_worker.v0",
        data: null,
        error: {
          code: workerError.code,
          message: workerError.message,
        },
      },
      {
        status: workerError.status,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
