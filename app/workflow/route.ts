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
  authorizeControlPlaneScope,
  authorizeWorkerRead,
  authorizeWorkerRun,
  controlPlaneScopeFromEnv,
  normalizeIdempotencyKey,
} from "../../src/worker/security";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.workflow.v1";
const workflowCommandEnvelopeFields = new Set(["command", "workflow", "idempotencyKey", "config"]);
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
  const view = optionalString(url.searchParams.get("view")) ?? "overview";
  const tenantSlug = optionalString(url.searchParams.get("tenantSlug"));
  const scope = authorizeControlPlaneScope({
    scope: controlPlaneScope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    return guardErrorResponse(scope);
  }

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
  const unexpectedFields = unexpectedWorkflowPayloadFields(body);

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_workflow_command_envelope",
        message: `Workflow command payload fields must be command, workflow, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  const workflow = bodyObject(body.workflow);
  const config = bodyObject(body.config);
  const command = optionalString(body.command);
  const tenantSlug = optionalString(workflow.tenantSlug);
  const scope = authorizeControlPlaneScope({
    scope: controlPlaneScope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    return guardErrorResponse(scope);
  }

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

    if (!runId || !toState) {
      return errorResponse(
        {
          code: "invalid_workflow_transition",
          message: "workflow.runId and config.toState are required for transition.",
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
