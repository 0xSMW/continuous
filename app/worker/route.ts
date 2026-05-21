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
  type ControlPlaneAccess,
  type ControlPlaneAccessResult,
} from "../../src/worker/security";
import {
  authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt,
} from "../../src/core/control-plane-auth";
import { defaultMaxJsonBodyBytes, readJsonObjectBody } from "../../src/http/body";
import {
  unexpectedEnvelopeFields,
  isWorkerOperationIdentifier,
  validateWorkerConfigEnvelope,
  validateWorkerTargetEnvelope,
  workerCommandEnvelopeDescription,
  workerCommandEnvelopeFieldSet,
  workerEnvelopeFieldError,
  workerOperationDescription,
  workerViewEnvelopeDescription,
  workerViewEnvelopeFieldSet,
} from "../../src/worker/envelope";

export const dynamic = "force-dynamic";

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configObject(value: unknown, errorCode: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } } {
  const result = validateWorkerConfigEnvelope(value);

  if (result.ok) {
    return result;
  }

  return {
    ok: false,
    error: {
      code: errorCode,
      message: result.message,
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
      code: "invalid_worker_payload_body",
      message: "POST /worker requires an application/json request body.",
    },
    invalidJson: {
      code: "invalid_worker_payload_body",
      message: "Worker payload body must be valid JSON.",
    },
    invalidObject: {
      code: "invalid_worker_payload_body",
      message: "Worker payload body must be a JSON object.",
    },
    tooLarge: (maxBytes) => ({
      code: "worker_payload_body_too_large",
      message: `Worker payload body must be at most ${maxBytes} bytes.`,
    }),
    maxBytes: defaultMaxJsonBodyBytes,
  });
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
  const result = validateWorkerTargetEnvelope(value);

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_worker_target",
        message: result.message,
      },
    };
  }

  return { ok: true };
}

function idempotencyKeyFrom(body: Record<string, unknown>) {
  return body.idempotencyKey;
}

function unexpectedWorkerPayloadFields(body: Record<string, unknown>) {
  return unexpectedEnvelopeFields(body, workerCommandEnvelopeFieldSet);
}

function unexpectedWorkerViewPayloadFields(body: Record<string, unknown>) {
  return unexpectedEnvelopeFields(body, workerViewEnvelopeFieldSet);
}

function hasOwnField(body: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function workerPayloadKind(body: Record<string, unknown>) {
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

function validationGuard(error: { code: string; message: string }) {
  return {
    ok: false as const,
    status: 403 as const,
    code: error.code,
    message: error.message,
  };
}

async function recordWorkerValidationFailure(input: {
  request: Request;
  access: ControlPlaneAccess;
  command?: string;
  target: WorkerTargetInput;
  auth: ControlPlaneAccessResult;
  error: { code: string; message: string };
}) {
  await recordControlPlaneAuthAttempt({
    request: input.request,
    route: "worker",
    access: input.access,
    command: input.command,
    tenantSlug: input.target.tenantSlug,
    workerRole: input.target.role,
    auth: input.auth,
    guard: validationGuard(input.error),
  });
}

export async function GET() {
  return errorResponse(
    {
      code: "worker_view_payload_required",
      message:
        "Worker reads use POST /worker with a JSON payload containing view, worker, and config. Put read filters under config.",
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
    route: "worker",
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
        route: "worker",
        access: "read",
      });

  if (!writePreAuth.ok && !readPreAuth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      auth: writePreAuth,
    });
    return guardErrorResponse(writePreAuth);
  }

  const bodyResult = await readBody(request);

  if (!bodyResult.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      auth: writePreAuth.ok ? writePreAuth : readPreAuth,
    });
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  const body = bodyResult.value;
  const payloadKind = workerPayloadKind(body);
  const acceptedPreAuth = writePreAuth.ok ? writePreAuth : readPreAuth;

  if (payloadKind === "mixed") {
    const error = {
      code: "invalid_worker_payload_envelope",
      message: "Worker payload must contain either command or view, not both.",
    };
    await recordWorkerValidationFailure({
      request,
      access: "write",
      command: optionalString(body.command) ?? optionalString(body.view),
      target: targetFrom(body.worker),
      auth: acceptedPreAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
  }

  if (payloadKind === "missing") {
    const error = {
      code: "invalid_worker_payload_envelope",
      message: "Worker payload requires a non-empty command or view string.",
    };
    await recordWorkerValidationFailure({
      request,
      access: "write",
      target: targetFrom(body.worker),
      auth: acceptedPreAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
  }

  if (payloadKind === "view") {
    return handleWorkerView(request, body, readPreAuth);
  }

  return handleWorkerCommand(request, body, writePreAuth);
}

async function handleWorkerCommand(
  request: Request,
  body: Record<string, unknown>,
  preAuth: ControlPlaneAccessResult,
) {
  const unexpectedFields = unexpectedWorkerPayloadFields(body);
  const command = optionalString(body.command);
  const configResult = configObject(body.config, "invalid_worker_command_config");
  const config = configResult.ok ? configResult.value : {};
  const target = targetFrom(body.worker);
  const targetResult = validateWorkerTarget(body.worker);

  if (unexpectedFields.length > 0) {
    const error = {
      code: "invalid_worker_command_envelope",
      message: workerEnvelopeFieldError(
        "Worker command payload",
        workerCommandEnvelopeDescription,
        unexpectedFields,
      ),
    };
    await recordWorkerValidationFailure({
      request,
      access: "write",
      command,
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(error, 400);
  }

  if (!command) {
    const error = {
      code: "invalid_worker_command_envelope",
      message: "Worker command payload requires a non-empty command string.",
    };
    await recordWorkerValidationFailure({
      request,
      access: "write",
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
  }

  if (!isWorkerOperationIdentifier(command)) {
    const error = {
      code: "invalid_worker_command_envelope",
      message: workerOperationDescription,
    };
    await recordWorkerValidationFailure({
      request,
      access: "write",
      command,
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
  }

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
    route: "worker",
    access: "write",
    command,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      command,
      tenantSlug: target.tenantSlug,
      workerRole: target.role,
      auth,
    });
    return guardErrorResponse(auth);
  }

  if (!targetResult.ok) {
    await recordWorkerValidationFailure({
      request,
      access: "write",
      command,
      target,
      auth,
      error: targetResult.error,
    });
    return errorResponse(targetResult.error, 400);
  }

  if (!configResult.ok) {
    await recordWorkerValidationFailure({
      request,
      access: "write",
      command,
      target,
      auth,
      error: configResult.error,
    });
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
      command,
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
    command,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
    requireManagedCredential: true,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "worker",
      access: "write",
      command,
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
    command,
    tenantSlug: target.tenantSlug,
    workerRole: target.role,
    auth,
    scope,
  });

  try {
    const result = await executeWorkerCommand({
      command,
      target,
      config,
      idempotencyKey: idempotencyKeyFrom(body),
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

async function handleWorkerView(
  request: Request,
  body: Record<string, unknown>,
  preAuth: ControlPlaneAccessResult,
) {
  const unexpectedFields = unexpectedWorkerViewPayloadFields(body);
  const view = optionalString(body.view);
  const configResult = configObject(body.config, "invalid_worker_view_config");
  const config = configResult.ok ? configResult.value : {};
  const target = targetFrom(body.worker);
  const targetResult = validateWorkerTarget(body.worker);

  if (unexpectedFields.length > 0) {
    const error = {
      code: "invalid_worker_view_envelope",
      message: workerEnvelopeFieldError(
        "Worker view payload",
        workerViewEnvelopeDescription,
        unexpectedFields,
      ),
    };
    await recordWorkerValidationFailure({
      request,
      access: "read",
      command: view ? `view.${view}` : undefined,
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(error, 400);
  }

  if (!view) {
    const error = {
      code: "invalid_worker_view_envelope",
      message: "Worker view payload requires a non-empty view string.",
    };
    await recordWorkerValidationFailure({
      request,
      access: "read",
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
  }

  if (!isWorkerOperationIdentifier(view)) {
    const error = {
      code: "invalid_worker_view_envelope",
      message: workerOperationDescription,
    };
    await recordWorkerValidationFailure({
      request,
      access: "read",
      command: `view.${view}`,
      target,
      auth: preAuth,
      error,
    });
    return errorResponse(
      error,
      400,
    );
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

  if (!targetResult.ok) {
    await recordWorkerValidationFailure({
      request,
      access: "read",
      command: `view.${view}`,
      target,
      auth,
      error: targetResult.error,
    });
    return errorResponse(targetResult.error, 400);
  }

  if (!configResult.ok) {
    await recordWorkerValidationFailure({
      request,
      access: "read",
      command: `view.${view}`,
      target,
      auth,
      error: configResult.error,
    });
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
    requireManagedCredential: true,
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
      config,
    });
    const status = result.status ?? 200;

    return Response.json(
      {
        api: workerApiVersion,
        data: status >= 500 ? null : result.data,
        error: status >= 500 ? "Worker view failed." : result.error,
      },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_view_failed");
  }
}
