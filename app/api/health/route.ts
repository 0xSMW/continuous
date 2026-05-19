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

  return Response.json(health, {
    status: health.status === "down" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
