import { env } from "../../../src/env";
import { getHealth } from "../../../src/core/health";
import { getCoreSummarySafe } from "../../../src/core/summary";
import { authorizeRevenueWorkerRead } from "../../../src/worker/security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authorizeRevenueWorkerRead({
    appEnv: env.APP_ENV,
    expectedToken: env.REVENUE_WORKER_RUN_TOKEN,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return Response.json(
      {
        api: "continuous.core.v0",
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

  const result = await getCoreSummarySafe();
  const health = getHealth({
    dbOk: result.ok,
    dbError: result.error,
    counts: result.summary.counts,
  });

  return Response.json(
    {
      api: "continuous.core.v0",
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
