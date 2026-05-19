import { env } from "../../../../src/env";
import {
  decideRevenueWorkerApproval,
  listRevenueWorkerApprovals,
  normalizeApprovalDecision,
} from "../../../../src/worker/approvals";
import { RevenueWorkerUnavailableError } from "../../../../src/worker/revenue";
import { authorizeRevenueWorkerRead } from "../../../../src/worker/security";

export const dynamic = "force-dynamic";

function optionalString(value: string | null) {
  return value?.trim() || undefined;
}

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

  const url = new URL(request.url);

  try {
    const data = await listRevenueWorkerApprovals({
      operatorEmail: auth.operatorEmail,
      tenantSlug: optionalString(url.searchParams.get("tenantSlug")),
      state: optionalString(url.searchParams.get("state")),
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
            code: "approval_list_failed",
            message: error instanceof Error ? error.message : "Unknown approval list error.",
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

export async function POST(request: Request) {
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

  if (!action || typeof body.approvalId !== "string") {
    return Response.json(
      {
        api: "continuous.revenue_worker.approvals.v0",
        data: null,
        error: {
          code: "invalid_approval_decision",
          message: "approvalId and action are required. Action must be approved, rejected, or revision_requested.",
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
    const data = await decideRevenueWorkerApproval({
      approvalId: body.approvalId,
      operatorEmail: auth.operatorEmail,
      tenantSlug: typeof body.tenantSlug === "string" ? optionalString(body.tenantSlug) : undefined,
      action,
      note: typeof body.note === "string" ? optionalString(body.note) : undefined,
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
