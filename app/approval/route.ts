import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
  type ApprovalSubject,
} from "../../src/core/approvals";
import { PlatformUnavailableError } from "../../src/core/errors";
import { env } from "../../src/env";
import {
  authorizeControlPlaneScope,
  authorizeWorkerRead,
  authorizeWorkerRun,
  controlPlaneScopeFromEnv,
} from "../../src/worker/security";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.approval.v1";
const approvalCommandEnvelopeFields = new Set(["command", "approval", "idempotencyKey", "config"]);
const approvalSubjects = new Set<ApprovalSubject>(["all", "worker", "workflow", "task"]);
const controlPlaneScope = controlPlaneScopeFromEnv({
  allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
  allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
});

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function parseSubject(value: unknown): ApprovalSubject | null {
  const subject = optionalString(value);

  if (!subject) {
    return "all";
  }

  return approvalSubjects.has(subject as ApprovalSubject) ? (subject as ApprovalSubject) : null;
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

function approvalErrorResponse(error: unknown, fallbackCode: string) {
  const approvalError =
    error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.message,
        }
      : {
          status: 500,
          code: fallbackCode,
          message: error instanceof Error ? error.message : "Unknown approval error.",
        };

  return errorResponse(
    {
      code: approvalError.code,
      message: approvalError.message,
    },
    approvalError.status,
  );
}

function guardErrorResponse(error: { code: string; message: string; status: number }) {
  return errorResponse(
    {
      code: error.code,
      message: error.message,
    },
    error.status,
  );
}

function unexpectedApprovalPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !approvalCommandEnvelopeFields.has(field));
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
    return guardErrorResponse(auth);
  }

  const url = new URL(request.url);
  const view = optionalString(url.searchParams.get("view")) ?? "inbox";
  const tenantSlug = optionalString(url.searchParams.get("tenantSlug"));
  const subject = parseSubject(url.searchParams.get("subject"));
  const scope = authorizeControlPlaneScope({
    scope: controlPlaneScope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    return guardErrorResponse(scope);
  }

  if (view !== "inbox") {
    return errorResponse(
      {
        code: "approval_view_unsupported",
        message: "Approval view must be inbox.",
      },
      400,
    );
  }

  if (!subject) {
    return errorResponse(
      {
        code: "invalid_approval_subject",
        message: "Approval subject must be all, worker, workflow, or task.",
      },
      400,
    );
  }

  try {
    const approvals = await listApprovals({
      operatorEmail: auth.operatorEmail,
      tenantSlug,
      state: optionalString(url.searchParams.get("state")),
      subject,
    });

    return Response.json(
      {
        api: apiVersion,
        data: {
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
  } catch (error) {
    return approvalErrorResponse(error, "approval_inbox_failed");
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
    return guardErrorResponse(auth);
  }

  const body = await readBody(request);
  const unexpectedFields = unexpectedApprovalPayloadFields(body);

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_approval_command_envelope",
        message: `Approval command payload fields must be command, approval, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  const command = optionalString(body.command);
  const approval = bodyObject(body.approval);
  const config = bodyObject(body.config);
  const tenantSlug = optionalString(approval.tenantSlug);
  const subject = parseSubject(approval.subject ?? config.subject);
  const scope = authorizeControlPlaneScope({
    scope: controlPlaneScope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    return guardErrorResponse(scope);
  }

  if (!subject) {
    return errorResponse(
      {
        code: "invalid_approval_subject",
        message: "Approval subject must be all, worker, workflow, or task.",
      },
      400,
    );
  }

  if (command === "approval.decide") {
    const approvalId = optionalString(approval.id);
    const action = normalizeApprovalDecision(config.action);

    if (!approvalId || !action) {
      return errorResponse(
        {
          code: "invalid_approval_decision",
          message: "approval.id and config.action are required for approval.decide.",
        },
        400,
      );
    }

    try {
      const result = await decideApproval({
        approvalId,
        operatorEmail: auth.operatorEmail,
        tenantSlug,
        action,
        note: optionalString(config.note),
        subject,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            approval: {
              id: approvalId,
              tenantSlug: tenantSlug ?? null,
              subject,
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
      return approvalErrorResponse(error, "approval_decision_failed");
    }
  }

  return errorResponse(
    {
      code: "approval_command_unsupported",
      message: "Approval command must be approval.decide.",
    },
    400,
  );
}
