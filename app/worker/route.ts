import { env } from "../../src/env";
import type { WorkerTargetInput } from "../../src/worker/registry";
import {
  executeWorkerCommand,
  executeWorkerView,
  workerApiVersion,
  workerErrorStatus,
} from "../../src/worker/registry";
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

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configObject(value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }

  return {
    ok: false,
    error: {
      code: "invalid_worker_command_config",
      message: "config must be an object when provided.",
    },
  };
}

const workerCommandEnvelopeFields = new Set(["command", "worker", "idempotencyKey", "config"]);
const workerTargetEnvelopeFields = new Set(["role", "id", "tenantSlug"]);
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
        code: "invalid_worker_command_body",
        message: "POST /worker requires an application/json request body.",
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
          code: "invalid_worker_command_body",
          message: "Worker command body must be a JSON object.",
        },
      };
    }

    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      error: {
        code: "invalid_worker_command_body",
        message: "Worker command body must be valid JSON.",
      },
    };
  }
}

function targetFrom(value: unknown): WorkerTargetInput {
  const target = bodyObject(value);
  return {
    role: optionalString(target.role),
    id: optionalString(target.id),
    tenantSlug: optionalString(target.tenantSlug),
  };
}

function validateWorkerTarget(value: unknown):
  | { ok: true }
  | { ok: false; error: { code: string; message: string } } {
  if (value === undefined || value === null) {
    return { ok: true };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_worker_target",
        message: "worker must be an object with role, id, and tenantSlug selectors.",
      },
    };
  }

  const unexpectedFields = Object.keys(value as Record<string, unknown>).filter(
    (field) => !workerTargetEnvelopeFields.has(field),
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_worker_target",
        message: `worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
    };
  }

  return { ok: true };
}

function idempotencyKeyFrom(body: Record<string, unknown>, request: Request) {
  if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
    return body.idempotencyKey;
  }

  return request.headers.get("idempotency-key") ?? undefined;
}

function unexpectedWorkerPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !workerCommandEnvelopeFields.has(field));
}

function targetFromUrl(request: Request): WorkerTargetInput {
  const url = new URL(request.url);
  return {
    role: optionalString(url.searchParams.get("role")),
    id: optionalString(url.searchParams.get("id")),
    tenantSlug: optionalString(url.searchParams.get("tenantSlug")),
  };
}

function errorResponse(error: { code: string; message: string }, status: number) {
  return Response.json(
    {
      api: workerApiVersion,
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

function workerErrorResponse(error: unknown, fallbackCode: string) {
  const workerError = workerErrorStatus(error, fallbackCode);

  return errorResponse(
    {
      code: workerError.code,
      message: workerError.message,
    },
    workerError.status,
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = targetFromUrl(request);
  const view = optionalString(url.searchParams.get("view")) ?? "snapshot";
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
    route: "worker",
    access: "read",
    command: `view.${view}`,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "read",
      command: `view.${view}`,
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
    });
    return guardErrorResponse(auth);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    requireTenant: true,
    requireWorkerRole: true,
  });

  if (!scope.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "read",
      command: `view.${view}`,
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "worker",
    access: "read",
    command: `view.${view}`,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "read",
      command: `view.${view}`,
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "worker",
    access: "read",
    command: `view.${view}`,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
    scope,
  });

  try {
    const result = await executeWorkerView({
      operatorEmail: auth.operatorEmail,
      target,
      view,
      state: optionalString(url.searchParams.get("state")),
    });

    return Response.json(
      {
        api: workerApiVersion,
        data: result.data,
        error: result.error,
      },
      {
        status: result.status ?? 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_view_failed");
  }
}

export async function POST(request: Request) {
  const bodyResult = await readBody(request);
  const body = bodyResult.ok ? bodyResult.value : {};
  const unexpectedFields = unexpectedWorkerPayloadFields(body);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const target = targetFrom(body.worker);
  const targetResult = validateWorkerTarget(body.worker);
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
    route: "worker",
    access: "write",
    command: optionalString(body.command),
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      command: optionalString(body.command),
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
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
        code: "invalid_worker_command_envelope",
        message: `Worker command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  if (!targetResult.ok) {
    return errorResponse(targetResult.error, 400);
  }

  if (!configResult.ok) {
    return errorResponse(configResult.error, 400);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    requireTenant: true,
    requireWorkerRole: true,
  });

  if (!scope.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      command: optionalString(body.command),
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "worker",
    access: "write",
    command: optionalString(body.command),
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      command: optionalString(body.command),
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "worker",
    access: "write",
    command: optionalString(body.command),
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
    scope,
  });

  try {
    const result = await executeWorkerCommand({
      command: optionalString(body.command),
      target,
      config,
      idempotencyKey: idempotencyKeyFrom(body, request),
      operatorEmail: auth.operatorEmail,
    });

    return Response.json(
      {
        api: workerApiVersion,
        data: result,
        error: null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_command_failed");
  }
}
