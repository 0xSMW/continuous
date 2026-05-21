import { env } from "../../src/env";
import {
  coreOperationDescription,
  coreTargetFrom,
  executeAppServerCoreDynamicToolCall,
  isAppServerCoreCommand,
  isAppServerCoreView,
  isCoreOperationIdentifier,
  validateAppServerCoreArguments,
  type AppServerCoreTransportContext,
} from "../../src/core/app-server-tools";
import {
  executeAppServerWorkerDynamicToolCall,
  type AppServerDynamicToolCallParams,
  type AppServerWorkerTransportContext,
} from "../../src/worker/app-server-tools";
import {
  authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt,
} from "../../src/core/control-plane-auth";
import { defaultMaxJsonBodyBytes, readJsonObjectBody } from "../../src/http/body";
import {
  authorizeControlPlaneAccess,
  authorizeControlPlaneScope,
  type ControlPlaneAccess,
} from "../../src/worker/security";
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

const apiVersion = "continuous.app_server.v1";
const appServerDynamicToolCallFields = new Set([
  "tool",
  "arguments",
  "callId",
  "threadId",
  "turnId",
]);

type AppServerBridgeTarget = {
  kind: "core" | "worker";
  access: ControlPlaneAccess;
  controlCommand: string;
  innerCommand?: string;
  tenantSlug?: string;
  workerRole?: string;
  requireTenantScope: boolean;
  requireWorkerRoleScope: boolean;
  requireManagedCredential: boolean;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function appServerArguments(value: unknown):
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, args: value as Record<string, unknown> };
  }

  return {
    ok: false,
    error: {
      code: "invalid_app_server_tool_call",
      message: "App-server dynamic calls require arguments to be an object.",
    },
  };
}

function appServerWorkerArgumentsEnvelopeError(
  subject: string,
  allowedDescription: string,
  unexpectedFields: string[],
) {
  return workerEnvelopeFieldError(subject, allowedDescription, unexpectedFields).replace(
    "Move operation inputs into config.",
    "Put worker operation inputs under arguments.config.",
  );
}

function validateAppServerWorkerArguments(
  args: Record<string, unknown>,
  kind: "command" | "view",
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  const fields = kind === "command" ? workerCommandEnvelopeFieldSet : workerViewEnvelopeFieldSet;
  const description =
    kind === "command" ? workerCommandEnvelopeDescription : workerViewEnvelopeDescription;
  const subject =
    kind === "command"
      ? "continuous.worker.command arguments"
      : "continuous.worker.view arguments";
  const unexpectedFields = unexpectedEnvelopeFields(args, fields);

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: appServerWorkerArgumentsEnvelopeError(subject, description, unexpectedFields),
      },
    };
  }

  const targetResult = validateWorkerTargetEnvelope(args.worker);

  if (!targetResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: targetResult.message,
      },
    };
  }

  const configResult = validateWorkerConfigEnvelope(args.config);

  if (!configResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: configResult.message,
      },
    };
  }

  return { ok: true };
}

async function readBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: { code: string; message: string } }
> {
  return readJsonObjectBody(request, {
    invalidContentType: {
      code: "invalid_app_server_payload_body",
      message: "POST /app-server requires an application/json request body.",
    },
    invalidJson: {
      code: "invalid_app_server_payload_body",
      message: "App-server payload body must be valid JSON.",
    },
    invalidObject: {
      code: "invalid_app_server_payload_body",
      message: "App-server payload body must be a JSON object.",
    },
    tooLarge: (maxBytes) => ({
      code: "app_server_payload_body_too_large",
      message: `App-server payload body must be at most ${maxBytes} bytes.`,
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

function guardErrorResponse(error: { code: string; message: string; status: number }) {
  return errorResponse(
    {
      code: error.code,
      message: error.message,
    },
    error.status,
  );
}

function appServerBridgeTarget(body: Record<string, unknown>):
  | { ok: true; payload: AppServerDynamicToolCallParams; target: AppServerBridgeTarget }
  | { ok: false; error: { code: string; message: string } } {
  const unexpectedFields = Object.keys(body).filter(
    (field) => !appServerDynamicToolCallFields.has(field),
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: `App-server dynamic calls accept only tool, arguments, callId, threadId, and turnId. Put worker operation inputs under arguments.config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
    };
  }

  const tool = optionalString(body.tool);
  const callId = optionalString(body.callId);
  const threadId = optionalString(body.threadId);
  const turnId = optionalString(body.turnId);

  if (!tool) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: "App-server dynamic calls require a non-empty tool name.",
      },
    };
  }

  if (!callId || !threadId || !turnId) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: "App-server dynamic calls require non-empty callId, threadId, and turnId.",
      },
    };
  }

  const argumentsResult = appServerArguments(body.arguments);

  if (!argumentsResult.ok) {
    return {
      ok: false,
      error: argumentsResult.error,
    };
  }

  const args = argumentsResult.args;

  if (tool === "continuous.worker.schema" && Object.keys(args).length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: "continuous.worker.schema does not accept arguments.",
      },
    };
  }

  const worker = bodyObject(args.worker);
  const tenantSlug = optionalString(worker.tenantSlug);
  const workerRole = optionalString(worker.role);

  if (tool === "continuous.worker.command") {
    const envelope = validateAppServerWorkerArguments(args, "command");

    if (!envelope.ok) {
      return {
        ok: false,
        error: envelope.error,
      };
    }

    const command = optionalString(args.command);

    if (!command) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.worker.command requires arguments.command.",
        },
      };
    }

    if (!isWorkerOperationIdentifier(command)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: workerOperationDescription,
        },
      };
    }

    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "write",
        kind: "worker",
        controlCommand: `worker.command.${command}`,
        innerCommand: `worker:${command}`,
        tenantSlug,
        workerRole,
        requireTenantScope: true,
        requireWorkerRoleScope: true,
        requireManagedCredential: true,
      },
    };
  }

  if (tool === "continuous.worker.view") {
    const envelope = validateAppServerWorkerArguments(args, "view");

    if (!envelope.ok) {
      return {
        ok: false,
        error: envelope.error,
      };
    }

    const view = optionalString(args.view);

    if (!view) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.worker.view requires arguments.view.",
        },
      };
    }

    if (!isWorkerOperationIdentifier(view)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: workerOperationDescription,
        },
      };
    }

    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "read",
        kind: "worker",
        controlCommand: `worker.view.${view}`,
        innerCommand: `worker:view.${view}`,
        tenantSlug,
        workerRole,
        requireTenantScope: true,
        requireWorkerRoleScope: true,
        requireManagedCredential: true,
      },
    };
  }

  if (tool === "continuous.worker.schema") {
    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "read",
        kind: "worker",
        controlCommand: "worker.schema",
        requireTenantScope: false,
        requireWorkerRoleScope: false,
        requireManagedCredential: false,
      },
    };
  }

  if (tool === "continuous.core.command") {
    const envelope = validateAppServerCoreArguments(args, "command");

    if (!envelope.ok) {
      return {
        ok: false,
        error: envelope.error,
      };
    }

    const command = optionalString(args.command);

    if (!command) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.core.command requires arguments.command.",
        },
      };
    }

    if (!isCoreOperationIdentifier(command)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: coreOperationDescription,
        },
      };
    }

    if (!isAppServerCoreCommand(command)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server Core command: ${command}`,
        },
      };
    }

    const core = coreTargetFrom(args);
    const workerRole = coreWorkerRoleFromCommandArgs(command, args);

    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "write",
        kind: "core",
        controlCommand: `core.command.${command}`,
        innerCommand: `core:${command}`,
        tenantSlug: core.tenantSlug,
        workerRole,
        requireTenantScope: true,
        requireWorkerRoleScope: coreCommandRequiresWorkerRoleScope(command),
        requireManagedCredential: true,
      },
    };
  }

  if (tool === "continuous.core.view") {
    const envelope = validateAppServerCoreArguments(args, "view");

    if (!envelope.ok) {
      return {
        ok: false,
        error: envelope.error,
      };
    }

    const view = optionalString(args.view);

    if (!view) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.core.view requires arguments.view.",
        },
      };
    }

    if (!isCoreOperationIdentifier(view)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: coreOperationDescription,
        },
      };
    }

    if (!isAppServerCoreView(view)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server Core view: ${view}`,
        },
      };
    }

    const core = coreTargetFrom(args);

    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "read",
        kind: "core",
        controlCommand: `core.view.${view}`,
        innerCommand: `core:view.${view}`,
        tenantSlug: core.tenantSlug,
        requireTenantScope: true,
        requireWorkerRoleScope: false,
        requireManagedCredential: true,
      },
    };
  }

  if (tool === "continuous.core.schema") {
    return {
      ok: true,
      payload: body as AppServerDynamicToolCallParams,
      target: {
        access: "read",
        kind: "core",
        controlCommand: "core.schema",
        requireTenantScope: false,
        requireWorkerRoleScope: false,
        requireManagedCredential: false,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "unknown_app_server_tool",
      message: `Unknown app-server tool: ${tool}`,
    },
  };
}

function preAuthorize(request: Request) {
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
    route: "app_server",
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
        route: "app_server",
        access: "read",
      });

  return { writePreAuth, readPreAuth };
}

function transportContextFor(input: {
  operatorEmail: string;
  target: AppServerBridgeTarget;
}): AppServerWorkerTransportContext {
  return {
    operatorEmail: input.operatorEmail,
    source: "control_plane",
    allowedAccess: [input.target.access],
    allowedCommands: input.target.innerCommand ? [input.target.innerCommand] : [],
    allowedTenants: input.target.tenantSlug ? [input.target.tenantSlug] : ["*"],
    allowedWorkerRoles: input.target.workerRole ? [input.target.workerRole] : ["*"],
  };
}

function coreTransportContextFor(input: {
  operatorEmail: string;
  target: AppServerBridgeTarget;
}): AppServerCoreTransportContext {
  return {
    operatorEmail: input.operatorEmail,
    source: "control_plane",
    allowedAccess: [input.target.access],
    allowedCommands: input.target.innerCommand ? [input.target.innerCommand] : [],
    allowedTenants: input.target.tenantSlug ? [input.target.tenantSlug] : ["*"],
  };
}

function coreWorkerRoleFromCommandArgs(command: string, args: Record<string, unknown>) {
  const config = bodyObject(args.config);

  if (command === "worker.upsert") {
    return optionalString(config.role);
  }

  if (command === "worker.transition") {
    return optionalString(config.role) ?? optionalString(bodyObject(config.worker).role);
  }

  if (command === "worker.run.start" || command === "worker.run.complete") {
    return optionalString(bodyObject(config.worker).role);
  }

  return undefined;
}

function coreCommandRequiresWorkerRoleScope(command: string) {
  return command === "worker.upsert" || command === "worker.run.start" || command === "worker.run.complete";
}

export async function GET() {
  return errorResponse(
    {
      code: "app_server_post_required",
      message: "App-server dynamic tool calls use POST /app-server.",
    },
    405,
  );
}

export async function POST(request: Request) {
  const { writePreAuth, readPreAuth } = preAuthorize(request);

  if (!writePreAuth.ok && !readPreAuth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "app_server",
      access: "write",
      auth: writePreAuth,
    });
    return guardErrorResponse(writePreAuth);
  }

  const bodyResult = await readBody(request);

  if (!bodyResult.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "app_server",
      access: "write",
      auth: writePreAuth.ok ? writePreAuth : readPreAuth,
    });
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  const bridgeTarget = appServerBridgeTarget(bodyResult.value);

  if (!bridgeTarget.ok) {
    return errorResponse(bridgeTarget.error, 400);
  }

  const { target, payload } = bridgeTarget;
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
    route: "app_server",
    access: target.access,
    command: target.controlCommand,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "app_server",
      access: target.access,
      command: target.controlCommand,
      tenantSlug: target.tenantSlug,
      workerRole: target.workerRole,
      auth,
    });
    return guardErrorResponse(auth);
  }

  if (target.requireTenantScope || target.requireWorkerRoleScope) {
    const scope = authorizeControlPlaneScope({
      scope: auth.scope,
      tenantSlug: target.tenantSlug,
      workerRole: target.workerRole,
      requireTenant: target.requireTenantScope,
      requireWorkerRole: target.requireWorkerRoleScope,
    });

    if (!scope.ok) {
      await recordControlPlaneAuthAttempt({
        request,
        route: "app_server",
        access: target.access,
        command: target.controlCommand,
        tenantSlug: target.tenantSlug,
        workerRole: target.workerRole,
        auth,
        scope,
      });
      return guardErrorResponse(scope);
    }
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "app_server",
    access: target.access,
    command: target.controlCommand,
    tenantSlug: target.tenantSlug,
    workerRole: target.workerRole,
    auth,
    requireManagedCredential: target.requireManagedCredential,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "app_server",
      access: target.access,
      command: target.controlCommand,
      tenantSlug: target.tenantSlug,
      workerRole: target.workerRole,
      auth,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "app_server",
    access: target.access,
    command: target.controlCommand,
    tenantSlug: target.tenantSlug,
    workerRole: target.workerRole,
    auth,
  });

  const result =
    target.kind === "core"
      ? await executeAppServerCoreDynamicToolCall(
          payload,
          payload.tool === "continuous.core.schema"
            ? undefined
            : coreTransportContextFor({ operatorEmail: auth.operatorEmail, target }),
        )
      : await executeAppServerWorkerDynamicToolCall(
          payload,
          payload.tool === "continuous.worker.schema"
            ? undefined
            : transportContextFor({ operatorEmail: auth.operatorEmail, target }),
        );

  return Response.json(
    {
      api: apiVersion,
      data: result,
      error: null,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
