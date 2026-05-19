import { env } from "../../../src/env";
import { getRevenueWorkerSnapshotSafe } from "../../../src/worker/revenue";
import { authorizeRevenueWorkerRead } from "../../../src/worker/security";

export const dynamic = "force-dynamic";

function selectorFromUrl(request: Request) {
  const url = new URL(request.url);
  const tenantSlug = url.searchParams.get("tenantSlug")?.trim();
  const workerId = url.searchParams.get("workerId")?.trim();

  return {
    tenantSlug: tenantSlug || undefined,
    workerId: workerId || undefined,
  };
}

export async function GET(request: Request) {
  const auth = authorizeRevenueWorkerRead({
    appEnv: env.APP_ENV,
    expectedToken: env.REVENUE_WORKER_RUN_TOKEN,
    operatorEmail: env.REVENUE_WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return Response.json(
      {
        api: "continuous.revenue_worker.v0",
        data: null,
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

  const result = await getRevenueWorkerSnapshotSafe(selectorFromUrl(request));

  return Response.json(
    {
      api: "continuous.revenue_worker.v0",
      data: result.snapshot,
      error: result.error,
    },
    {
      status: result.ok ? 200 : 500,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
