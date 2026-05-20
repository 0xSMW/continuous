import { env } from "../../src/env";
import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
} from "../../src/core/approvals";
import { PlatformUnavailableError } from "../../src/core/errors";
import {
  executeWorkflowSteps,
  listWorkflows,
  startWorkflowRun,
  transitionWorkflowRun,
} from "../../src/core/workflows";
import type { JsonObject } from "../../src/db/schema";
import { RevenueWorkerUnavailableError } from "../../src/worker/revenue";
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

const apiVersion = "continuous.workflow.v1";
const workflowCommandEnvelopeFields = new Set(["command", "workflow", "idempotencyKey", "config"]);
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
      code: "invalid_workflow_command_config",
      message: "config must be an object when provided.",
    },
  };
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
) {
  if (value === undefined || value === null || value === "") {
    return { ok: true as const, value: undefined };
  }

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue < min || numericValue > max) {
    return {
      ok: false as const,
      message: `${field} must be an integer between ${min} and ${max}.`,
    };
  }

  return { ok: true as const, value: numericValue };
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: { code: string; message: string } }
> {
  return readJsonObjectBody(request, {
    invalidContentType: {
        code: "invalid_workflow_command_body",
        message: "POST /workflow requires an application/json request body.",
    },
    invalidJson: {
        code: "invalid_workflow_command_body",
        message: "Workflow command body must be valid JSON.",
    },
    invalidObject: {
      code: "invalid_workflow_command_body",
      message: "Workflow command body must be a JSON object.",
    },
    tooLarge: (maxBytes) => ({
      code: "workflow_command_body_too_large",
      message: `Workflow command body must be at most ${maxBytes} bytes.`,
    }),
    maxBytes: defaultMaxJsonBodyBytes,
  });
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

function workflowErrorResponse(error: unknown, fallbackCode: string) {
  const workflowError =
    error instanceof RevenueWorkerUnavailableError || error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.message,
        }
      : {
          status: 500,
          code: fallbackCode,
          message: error instanceof Error ? error.message : "Unknown workflow error.",
        };

  return errorResponse(
    {
      code: workflowError.code,
      message: workflowError.message,
    },
    workflowError.status,
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

function unexpectedWorkflowPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !workflowCommandEnvelopeFields.has(field));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = optionalString(url.searchParams.get("view")) ?? "overview";
  const tenantSlug = optionalString(url.searchParams.get("tenantSlug"));
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
    route: "workflow",
    access: "read",
    command: `view.${view}`,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
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
      route: "workflow",
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
    route: "workflow",
    access: "read",
    command: `view.${view}`,
    tenantSlug,
    auth,
    requireManagedCredential: true,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
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
    route: "workflow",
    access: "read",
    command: `view.${view}`,
    tenantSlug,
    auth,
    scope,
  });

  try {
    if (view === "approvals") {
      const approvals = await listApprovals({
        operatorEmail: auth.operatorEmail,
        tenantSlug,
        state: optionalString(url.searchParams.get("state")),
        subject: "workflow",
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
    }

    if (view !== "overview") {
      return errorResponse(
        {
          code: "workflow_view_unsupported",
          message: "Workflow view must be overview or approvals.",
        },
        400,
      );
    }

    const data = await listWorkflows({
      operatorEmail: auth.operatorEmail,
      tenantSlug,
      state: optionalString(url.searchParams.get("state")),
    });

    return Response.json(
      {
        api: apiVersion,
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
    return workflowErrorResponse(error, "workflow_list_failed");
  }
}

export async function POST(request: Request) {
  const preAuth = authorizeControlPlaneAccess({
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
    route: "workflow",
    access: "write",
  });

  if (!preAuth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
      access: "write",
      auth: preAuth,
    });
    return guardErrorResponse(preAuth);
  }

  const bodyResult = await readBody(request);

  if (!bodyResult.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
      access: "write",
      auth: preAuth,
    });
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  const body = bodyResult.value;
  const unexpectedFields = unexpectedWorkflowPayloadFields(body);
  const workflow = bodyObject(body.workflow);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const command = optionalString(body.command);
  const tenantSlug = optionalString(workflow.tenantSlug);
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
    route: "workflow",
    access: "write",
    command,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
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
        code: "invalid_workflow_command_envelope",
        message: `Workflow command payload fields must be command, workflow, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
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
      route: "workflow",
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
    route: "workflow",
    access: "write",
    command,
    tenantSlug,
    auth,
    requireManagedCredential: true,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "workflow",
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
    route: "workflow",
    access: "write",
    command,
    tenantSlug,
    auth,
    scope,
  });

  if (command === "start") {
    const workflowKey = optionalString(workflow.key);
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

    if (!workflowKey || !idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_workflow_start",
          message: workflowKey
            ? idempotency.ok
              ? "Workflow start request is invalid."
              : idempotency.message
            : "workflow.key is required for start.",
        },
        400,
      );
    }

    try {
      const result = await startWorkflowRun({
        operatorEmail: auth.operatorEmail,
        workflowKey,
        idempotencyKey: idempotency.key,
        tenantSlug,
        objectId: optionalString(workflow.objectId),
        workerId: optionalString(workflow.workerId),
        initialState: optionalString(config.initialState),
        data: jsonObject(config.data),
        blockers: jsonObject(config.blockers),
        metrics: jsonObject(config.metrics),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            workflow: {
              key: workflowKey,
              tenantSlug: tenantSlug ?? null,
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
      return workflowErrorResponse(error, "workflow_start_failed");
    }
  }

  if (command === "transition") {
    const runId = optionalString(workflow.runId);
    const toState = optionalString(config.toState);
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

    if (!runId || !toState || !idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_workflow_transition",
          message:
            runId && toState
              ? idempotency.ok
                ? "Workflow transition request is invalid."
                : idempotency.message
              : "workflow.runId, idempotencyKey, and config.toState are required for transition.",
        },
        400,
      );
    }

    try {
      const result = await transitionWorkflowRun({
        operatorEmail: auth.operatorEmail,
        tenantSlug,
        runId,
        toState,
        idempotencyKey: idempotency.key,
        reason: optionalString(config.reason),
        data: jsonObject(config.data),
        blockers: jsonObject(config.blockers),
        metrics: jsonObject(config.metrics),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            workflow: {
              runId,
              tenantSlug: tenantSlug ?? null,
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
      return workflowErrorResponse(error, "workflow_transition_failed");
    }
  }

  if (command === "steps.execute") {
    const limit = optionalBoundedInteger(config.limit, "config.limit", 1, 50);
    const leaseMs = optionalBoundedInteger(config.leaseMs, "config.leaseMs", 30_000, 900_000);

    if (!limit.ok) {
      return errorResponse(
        {
          code: "invalid_workflow_step_execution",
          message: limit.message,
        },
        400,
      );
    }

    if (!leaseMs.ok) {
      return errorResponse(
        {
          code: "invalid_workflow_step_execution",
          message: leaseMs.message,
        },
        400,
      );
    }

    try {
      const result = await executeWorkflowSteps({
        operatorEmail: auth.operatorEmail,
        tenantSlug,
        limit: limit.value,
        leaseOwner: optionalString(config.leaseOwner),
        leaseMs: leaseMs.value,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            workflow: {
              tenantSlug: tenantSlug ?? null,
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
      return workflowErrorResponse(error, "workflow_step_execution_failed");
    }
  }

  if (command === "approval.decide") {
    const approvalId = optionalString(config.approvalId);
    const action = normalizeApprovalDecision(config.action);

    if (!approvalId || !action) {
      return errorResponse(
        {
          code: "invalid_workflow_approval_decision",
          message: "config.approvalId and config.action are required for approval.decide.",
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
        subject: "workflow",
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            workflow: {
              tenantSlug: tenantSlug ?? null,
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
      return workflowErrorResponse(error, "workflow_approval_decision_failed");
    }
  }

  return errorResponse(
    {
      code: "workflow_command_unsupported",
      message: "Workflow command must be start, transition, steps.execute, or approval.decide.",
    },
    400,
  );
}
