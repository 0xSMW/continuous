import { env } from "../../../../../src/env";
import {
  decideRevenueWorkerApproval,
  normalizeApprovalDecision,
} from "../../../../../src/worker/approvals";
import { RevenueWorkerUnavailableError } from "../../../../../src/worker/revenue";
import { authorizeRevenueWorkerRun } from "../../../../../src/worker/security";

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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = authorizeRevenueWorkerRun({
    enabled: env.REVENUE_WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.REVENUE_WORKER_RUN_TOKEN,
    operatorEmail: env.REVENUE_WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return Response.json(
      {
        api: "continuous.revenue_worker.approvals.v0",
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

  const body = await readBody(request);
  const action = normalizeApprovalDecision(body.action);

  if (!action) {
    return Response.json(
      {
        api: "continuous.revenue_worker.approvals.v0",
        data: null,
        error: {
          code: "invalid_approval_decision",
          message: "Action must be approved, rejected, or revision_requested.",
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

  const { id } = await context.params;
  const url = new URL(request.url);

  try {
    const data = await decideRevenueWorkerApproval({
      approvalId: id,
      operatorEmail: auth.operatorEmail,
      tenantSlug: optionalString(body.tenantSlug) ?? optionalString(url.searchParams.get("tenantSlug")),
      action,
      note: optionalString(body.note),
    });

    return Response.json(
      {
        api: "continuous.revenue_worker.approvals.v0",
        data,
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
            code: "approval_decision_failed",
            message: error instanceof Error ? error.message : "Unknown approval decision error.",
          };

    return Response.json(
      {
        api: "continuous.revenue_worker.approvals.v0",
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
