import { getHealth } from "../../../src/core/health";
import { getCoreSummarySafe } from "../../../src/core/summary";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await getCoreSummarySafe();
  const health = getHealth({
    dbOk: result.ok,
    dbError: result.error,
    counts: result.summary.counts,
  });

  return Response.json(
    {
      service: health.service,
      status: health.status,
      checkedAt: health.checkedAt,
      mode: health.mode,
      version: health.version,
      checks: health.checks.map((check) => ({
        id: check.id,
        state: check.state,
      })),
    },
    {
      status: health.status === "down" ? 503 : 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
