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
  normalizeIdempotencyKey,
} from "../../src/worker/security";
import {
  authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt,
} from "../../src/core/control-plane-auth";
import { defaultMaxJsonBodyBytes, readJsonObjectBody } from "../../src/http/body";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.approval.v1";
const approvalCommandEnvelopeFields = new Set(["command", "approval", "idempotencyKey", "config"]);
const approvalViewEnvelopeFields = new Set(["view", "approval", "config"]);
const approvalSubjects = new Set<ApprovalSubject>(["all", "core", "worker", "workflow", "task"]);
function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configObject(value: unknown, errorCode = "invalid_approval_command_config") {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true as const, value: value as Record<string, unknown> };
  }

  return {
    ok: false as const,
    error: {
      code: errorCode,
      message: "config is required and must be an object.",
    },
  };
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: { code: string; message: string } }
> {
  return readJsonObjectBody(request, {
    invalidContentType: {
        code: "invalid_approval_command_body",
        message: "POST /approval requires an application/json request body.",
    },
    invalidJson: {
        code: "invalid_approval_command_body",
        message: "Approval command body must be valid JSON.",
    },
    invalidObject: {
      code: "invalid_approval_command_body",
      message: "Approval command body must be a JSON object.",
    },
    tooLarge: (maxBytes) => ({
      code: "approval_command_body_too_large",
      message: `Approval command body must be at most ${maxBytes} bytes.`,
    }),
    maxBytes: defaultMaxJsonBodyBytes,
  });
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

function optionalFilter(value: unknown) {
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
  const structuredError =
    error && typeof error === "object" && "status" in error && "code" in error
      ? (error as { status: unknown; code: unknown; message?: unknown })
      : null;
  const approvalError =
    error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.status >= 500 ? "Approval request failed." : error.message,
        }
      : structuredError &&
          typeof structuredError.status === "number" &&
          typeof structuredError.code === "string"
        ? {
            status: structuredError.status,
            code: structuredError.code,
            message:
              structuredError.status >= 500
                ? "Approval request failed."
                : typeof structuredError.message === "string"
                  ? structuredError.message
                  : "Approval request failed.",
          }
      : {
          status: 500,
          code: fallbackCode,
          message: "Approval request failed.",
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

function unexpectedApprovalViewPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !approvalViewEnvelopeFields.has(field));
}

function hasOwnField(body: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function approvalPayloadKind(body: Record<string, unknown>) {
  const hasCommand = hasOwnField(body, "command");
  const hasView = hasOwnField(body, "view");

  if (hasCommand && hasView) {
    return "mixed";
  }

  if (hasCommand) {
    return "command";
  }

  if (hasView) {
    return "view";
  }

  return "missing";
}

export async function GET() {
  return errorResponse(
    {
      code: "approval_view_payload_required",
      message:
        "Approval reads use POST /approval with a JSON payload containing view, approval, and config. Put read filters under config.",
    },
    405,
  );
}

export async function POST(request: Request) {
  const writePreAuth = authorizeControlPlaneAccess({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
    allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
    tokenCatalogJson: env.CONTROL_PLANE_TOKENS_JSON,
    tokenCatalogB64: env.CONTROL_PLANE_TOKEN_CATALOG_B64,
    route: "approval",
    access: "write",
  });
  const readPreAuth = writePreAuth.ok
    ? writePreAuth
    : authorizeControlPlaneAccess({
        appEnv: env.APP_ENV,
        expectedToken: env.WORKER_RUN_TOKEN,
        operatorEmail: env.WORKER_OPERATOR_EMAIL,
        authorization: request.headers.get("authorization"),
        allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
        allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
        tokenCatalogJson: env.CONTROL_PLANE_TOKENS_JSON,
        tokenCatalogB64: env.CONTROL_PLANE_TOKEN_CATALOG_B64,
        route: "approval",
        access: "read",
      });

  if (!writePreAuth.ok && !readPreAuth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "write",
      auth: writePreAuth,
    });
    return guardErrorResponse(writePreAuth);
  }

  const bodyResult = await readBody(request);

  if (!bodyResult.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "approval",
      access: "write",
      auth: writePreAuth.ok ? writePreAuth : readPreAuth,
    });
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  const body = bodyResult.value;
  const payloadKind = approvalPayloadKind(body);

  if (payloadKind === "mixed") {
    return errorResponse(
      {
        code: "invalid_approval_payload_envelope",
        message: "Approval payload must contain either command or view, not both.",
      },
      400,
    );
  }

  if (payloadKind === "missing") {
    return errorResponse(
      {
        code: "invalid_approval_payload_envelope",
        message: "Approval payload requires a non-empty command or view string.",
      },
      400,
    );
  }

  if (payloadKind === "view") {
    return handleApprovalView(request, body);
  }

  return handleApprovalCommand(request, body);
}

async function handleApprovalView(
  request: Request,
  body: Record<string, unknown>,
) {
  const unexpectedFields = unexpectedApprovalViewPayloadFields(body);
  const view = optionalString(body.view);
  const approval = bodyObject(body.approval);
  const configResult = configObject(body.config, "invalid_approval_view_config");
  const config = configResult.ok ? configResult.value : {};
  const tenantSlug = optionalString(approval.tenantSlug);
  const subject = parseSubject(approval.subject);

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_approval_view_envelope",
        message: `Approval view payload fields must be view, approval, and config. Move read filters into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  if (!view) {
    return errorResponse(
      {
        code: "invalid_approval_view_envelope",
        message: "Approval view payload requires a non-empty view string.",
      },
      400,
    );
  }

  if (!configResult.ok) {
    return errorResponse(configResult.error, 400);
  }

  const auth = authorizeControlPlaneAccess({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
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
    requireManagedCredential: true,
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
      state: optionalFilter(config.state),
      subject,
      priority: optionalFilter(config.priority),
      risk: optionalFilter(config.risk),
      kind: optionalFilter(config.kind),
    });

    return Response.json(
      {
        api: apiVersion,
        data: {
          view,
          approval: {
            tenantSlug: tenantSlug ?? null,
            subject,
          },
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

async function handleApprovalCommand(
  request: Request,
  body: Record<string, unknown>,
) {
  const unexpectedFields = unexpectedApprovalPayloadFields(body);
  const command = optionalString(body.command);
  const approval = bodyObject(body.approval);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const tenantSlug = optionalString(approval.tenantSlug);
  const subject = parseSubject(approval.subject, null);
  const auth = authorizeControlPlaneAccess({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
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
    requireManagedCredential: true,
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
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

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

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_approval_decision",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await decideApproval({
        approvalId,
        idempotencyKey: idempotency.key,
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
