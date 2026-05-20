import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
  type ApprovalSubject,
} from "../../src/core/approvals";
import { PlatformUnavailableError } from "../../src/core/errors";
import { env } from "../../src/env";
import {
  authorizeControlPlaneAccess,
  authorizeControlPlaneScope,
} from "../../src/worker/security";
import {
  authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt,
} from "../../src/core/control-plane-auth";
import { isJsonContentType } from "../../src/http/content";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.approval.v1";
const approvalCommandEnvelopeFields = new Set(["command", "approval", "idempotencyKey", "config"]);
const approvalSubjects = new Set<ApprovalSubject>(["all", "core", "worker", "workflow", "task"]);
function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configObject(value: unknown) {
  if (value === undefined || value === null) {
    return { ok: true as const, value: {} as Record<string, unknown> };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true as const, value: value as Record<string, unknown> };
  }

  return {
    ok: false as const,
    error: {
      code: "invalid_approval_command_config",
      message: "config must be an object when provided.",
    },
  };
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: { code: string; message: string } }
> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      status: 415,
      error: {
        code: "invalid_approval_command_body",
        message: "POST /approval requires an application/json request body.",
      },
    };
  }

  try {
    const value = await request.json();

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "invalid_approval_command_body",
          message: "Approval command body must be a JSON object.",
        },
      };
    }

    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      error: {
        code: "invalid_approval_command_body",
        message: "Approval command body must be valid JSON.",
      },
    };
  }
}

function parseSubject(
  value: unknown,
  defaultSubject: ApprovalSubject | null = "all",
): ApprovalSubject | null | undefined {
  const subject = optionalString(value);

  if (!subject) {
    return defaultSubject ?? undefined;
  }

  return approvalSubjects.has(subject as ApprovalSubject) ? (subject as ApprovalSubject) : null;
}

function optionalFilter(value: string | null) {
  const filter = optionalString(value);

  return filter && filter !== "all" ? filter : undefined;
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
  const url = new URL(request.url);
  const view = optionalString(url.searchParams.get("view")) ?? "inbox";
  const tenantSlug = optionalString(url.searchParams.get("tenantSlug"));
  const subject = parseSubject(url.searchParams.get("subject"));
  const auth = authorizeControlPlaneAccess({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
    allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
    allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
    tokenCatalogJson: env.CONTROL_PLANE_TOKENS_JSON,
    tokenCatalogB64: env.CONTROL_PLANE_TOKEN_CATALOG_B64,
    route: "approval",
    access: "read",
    command: `view.${view}`,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "read",
      command: `view.${view}`,
      tenantSlug,
      auth,
    });
    return guardErrorResponse(auth);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "read",
      command: `view.${view}`,
      tenantSlug,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "approval",
    access: "read",
    command: `view.${view}`,
    tenantSlug,
    auth,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "read",
      command: `view.${view}`,
      tenantSlug,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "approval",
    access: "read",
    command: `view.${view}`,
    tenantSlug,
    auth,
    scope,
  });

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
        message: "Approval subject must be all, core, worker, workflow, or task.",
      },
      400,
    );
  }

  try {
    const approvals = await listApprovals({
      operatorEmail: auth.operatorEmail,
      tenantSlug,
      state: optionalFilter(url.searchParams.get("state")),
      subject,
      priority: optionalFilter(url.searchParams.get("priority")),
      risk: optionalFilter(url.searchParams.get("risk")),
      kind: optionalFilter(url.searchParams.get("kind")),
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
  const bodyResult = await readBody(request);
  const body = bodyResult.ok ? bodyResult.value : {};
  const unexpectedFields = unexpectedApprovalPayloadFields(body);
  const command = optionalString(body.command);
  const approval = bodyObject(body.approval);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const tenantSlug = optionalString(approval.tenantSlug);
  const subject = parseSubject(approval.subject ?? config.subject, null);
  const auth = authorizeControlPlaneAccess({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
    allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
    allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
    tokenCatalogJson: env.CONTROL_PLANE_TOKENS_JSON,
    tokenCatalogB64: env.CONTROL_PLANE_TOKEN_CATALOG_B64,
    route: "approval",
    access: "write",
    command,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "write",
      command,
      tenantSlug,
      auth,
    });
    return guardErrorResponse(auth);
  }

  if (!bodyResult.ok) {
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_approval_command_envelope",
        message: `Approval command payload fields must be command, approval, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  if (!configResult.ok) {
    return errorResponse(configResult.error, 400);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "write",
      command,
      tenantSlug,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "approval",
    access: "write",
    command,
    tenantSlug,
    auth,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "write",
      command,
      tenantSlug,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "approval",
    access: "write",
    command,
    tenantSlug,
    auth,
    scope,
  });

  if (subject === undefined) {
    return errorResponse(
      {
        code: "approval_subject_required",
        message: "approval.subject is required for approval.decide.",
      },
      400,
    );
  }

  if (subject === null) {
    return errorResponse(
      {
        code: "invalid_approval_subject",
        message: "Approval subject must be all, core, worker, workflow, or task.",
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

    if (subject === "all") {
      return errorResponse(
        {
          code: "approval_subject_too_broad",
          message: "approval.subject must be core, worker, workflow, or task for approval.decide.",
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
