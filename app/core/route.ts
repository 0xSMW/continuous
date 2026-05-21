import { env } from "../../src/env";
import { executeAiInference } from "../../src/core/ai-gateway";
import { requestApproval } from "../../src/core/approvals";
import { reserveBudget, chargeBudget, releaseBudget } from "../../src/core/budgets";
import { grantCapability } from "../../src/core/capabilities";
import { recordEntitySetup } from "../../src/core/entity";
import { getHealth } from "../../src/core/health";
import { preparePayrollPreviewPacket, recordPayrollPreview } from "../../src/core/payroll";
import { getCoreSummarySafe } from "../../src/core/summary";
import { transitionCoreWorker, upsertCoreWorker } from "../../src/core/workers";
import { completeCoreWorkerRun, startCoreWorkerRun } from "../../src/core/worker-runs";
import {
  authorizeManagedControlPlaneCredential,
  attestControlPlaneTokenRotation,
  recordControlPlaneAuthAttempt,
  reviewControlPlaneSessions,
  revokeControlPlaneCredential,
  upsertControlPlaneCredential,
} from "../../src/core/control-plane-auth";
import {
  attachCoreEvidence,
  createCoreDocument,
  ingestCoreEvent,
  linkCoreObjects,
  prepareCorePacket,
  publishCoreView,
  recordCoreConnectionHealth,
  upsertCoreAdapter,
  upsertCoreConnection,
  recordAdapterIntent,
  recordCustomerSignal,
  recordCoreDecision,
  recordExternalAction,
  recordRuleChange,
  upsertCoreObject,
} from "../../src/core/primitives";
import { createCoreTask, transitionCoreTask } from "../../src/core/tasks";
import { PlatformUnavailableError } from "../../src/core/errors";
import { defaultMaxJsonBodyBytes, readJsonObjectBody } from "../../src/http/body";
import {
  authorizeControlPlaneAccess,
  authorizeControlPlaneScope,
  normalizeIdempotencyKey,
} from "../../src/worker/security";
import type { JsonObject } from "../../src/db/schema";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.core.v1";
const coreCommandEnvelopeFieldList = ["command", "core", "idempotencyKey", "config"] as const;
const coreViewEnvelopeFieldList = ["view", "core", "config"] as const;
const coreTargetEnvelopeFields = new Set(["tenantSlug"]);
const coreCommandEnvelopeFields = new Set<string>(coreCommandEnvelopeFieldList);
const coreViewEnvelopeFields = new Set<string>(coreViewEnvelopeFieldList);
const coreOperationPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const coreOperationDescription =
  "Core command and view names must be registered lower_snake_case or dotted operation identifiers such as object.upsert or summary; do not use URL paths, route names, family-worker names, or query strings.";
const coreCommandEnvelopeDescription = describeEnvelopeFields(coreCommandEnvelopeFieldList);
const coreViewEnvelopeDescription = describeEnvelopeFields(coreViewEnvelopeFieldList);
const coreTargetEnvelopeDescription = describeEnvelopeFields(["tenantSlug"]);
const forbiddenTokenRotationFields = new Set([
  "token",
  "nextToken",
  "previousToken",
  "tokenSha256",
  "nextTokenSha256",
  "previousTokenSha256",
]);
const forbiddenControlPlaneCredentialFields = new Set([
  "operatorEmail",
  "token",
  "nextToken",
  "previousToken",
  "tokenSha256",
  "nextTokenSha256",
  "previousTokenSha256",
]);
function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function describeEnvelopeFields(fields: readonly string[]) {
  if (fields.length === 1) {
    return fields[0] ?? "";
  }

  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwnField(body: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function corePayloadKind(body: Record<string, unknown>) {
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

function coreEnvelopeFieldError(subject: string, allowedDescription: string, unexpectedFields: string[]) {
  return `${subject} fields must be ${allowedDescription}. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`;
}

function isCoreOperationIdentifier(value: string) {
  const operation = value.trim();
  const reservedRouteSegments = new Set(["api", "app_server", "core", "workers"]);

  return (
    coreOperationPattern.test(operation) &&
    !operation.includes("_worker") &&
    operation.split(".").every((segment) => !reservedRouteSegments.has(segment))
  );
}

function validateCoreTargetEnvelope(value: unknown):
  | { ok: true }
  | { ok: false; error: { code: string; message: string } } {
  if (value === undefined || value === null || !value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_core_target",
        message: "core must be an object with tenantSlug selector.",
      },
    };
  }

  const core = value as Record<string, unknown>;
  const unexpectedFields = Object.keys(core).filter((field) => !coreTargetEnvelopeFields.has(field));

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_core_target",
        message: coreEnvelopeFieldError(
          "Core target",
          coreTargetEnvelopeDescription,
          unexpectedFields,
        ),
      },
    };
  }

  if (typeof core.tenantSlug !== "string" || !core.tenantSlug.trim()) {
    return {
      ok: false,
      error: {
        code: "invalid_core_target",
        message: "core.tenantSlug is required.",
      },
    };
  }

  return { ok: true };
}

function configObject(value: unknown, errorCode = "invalid_core_command_config") {
  if (value === undefined || value === null) {
    return { ok: true as const, value: {} as Record<string, unknown> };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true as const, value: value as Record<string, unknown> };
  }

  return {
    ok: false as const,
    error: {
      code: errorCode,
      message: "config must be an object when provided.",
    },
  };
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean),
      ),
    );
  }

  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
  }

  return [];
}

function listAllows(allowed: string[], requested: string) {
  return allowed.some((item) => item === "*" || item === requested);
}

function patternListAllows(allowed: string[], requested: string) {
  return allowed.some((item) => {
    if (item === "*" || item === requested) {
      return true;
    }

    if (item.endsWith(":*")) {
      return requested.startsWith(item.slice(0, -1));
    }

    return false;
  });
}

function credentialScopePolicyError(input: {
  config: Record<string, unknown>;
  auth: Extract<ReturnType<typeof authorizeControlPlaneAccess>, { ok: true }>;
}) {
  const requestedTenants = stringList(input.config.allowedTenants);
  const requestedWorkerRoles = stringList(input.config.allowedWorkerRoles);
  const requestedRoutes = stringList(input.config.allowedRoutes);
  const requestedAccess = stringList(input.config.allowedAccess);
  const requestedCommands = stringList(input.config.allowedCommands);
  const callerTenants = input.auth.scope.tenantSlugs;
  const callerWorkerRoles = input.auth.scope.workerRoles;
  const callerRoutes = input.auth.routes ?? [];
  const callerAccess = input.auth.access ?? [];
  const callerCommands = input.auth.commands ?? [];

  if (requestedTenants.length === 0) {
    return "config.allowedTenants must include at least one tenant slug.";
  }

  if (requestedRoutes.length === 0) {
    return "config.allowedRoutes must include at least one route.";
  }

  if (requestedAccess.length === 0) {
    return "config.allowedAccess must include at least one access mode.";
  }

  if (requestedCommands.length === 0) {
    return "config.allowedCommands must include at least one exact route-qualified command.";
  }

  const tenantEscalation =
    callerTenants.length > 0
      ? requestedTenants.find((tenant) => !listAllows(callerTenants, tenant))
      : undefined;

  if (tenantEscalation) {
    return `config.allowedTenants includes ${tenantEscalation}, which is outside the caller's tenant scope.`;
  }

  const workerRoleEscalation =
    callerWorkerRoles.length > 0
      ? requestedWorkerRoles.find((role) => !listAllows(callerWorkerRoles, role))
      : undefined;

  if (workerRoleEscalation) {
    return `config.allowedWorkerRoles includes ${workerRoleEscalation}, which is outside the caller's worker-role scope.`;
  }

  const routeEscalation = requestedRoutes.find((route) => !patternListAllows(callerRoutes, route));

  if (routeEscalation) {
    return `config.allowedRoutes includes ${routeEscalation}, which is outside the caller's route scope.`;
  }

  const accessEscalation = requestedAccess.find((access) => !patternListAllows(callerAccess, access));

  if (accessEscalation) {
    return `config.allowedAccess includes ${accessEscalation}, which is outside the caller's access scope.`;
  }

  const commandEscalation = requestedCommands.find(
    (command) => !callerCommands.includes(command),
  );

  if (commandEscalation) {
    return `config.allowedCommands includes ${commandEscalation}, which is outside the caller's command scope.`;
  }

  return null;
}

function actorFrom(value: unknown) {
  const actor = bodyObject(value);
  return {
    type: optionalString(actor.type),
    id: optionalString(actor.id),
    ref: optionalString(actor.ref),
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
      code: "invalid_core_payload_body",
      message: "POST /core requires an application/json request body.",
    },
    invalidJson: {
      code: "invalid_core_payload_body",
      message: "Core payload body must be valid JSON.",
    },
    invalidObject: {
      code: "invalid_core_payload_body",
      message: "Core payload body must be a JSON object.",
    },
    tooLarge: (maxBytes) => ({
      code: "core_payload_body_too_large",
      message: `Core payload body must be at most ${maxBytes} bytes.`,
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

function coreErrorResponse(error: unknown, fallbackCode: string) {
  const structuredError =
    error && typeof error === "object" && "status" in error && "code" in error
      ? (error as { status: unknown; code: unknown; message?: unknown })
      : null;
  const coreError =
    error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.status >= 500 ? "Core command failed." : error.message,
        }
      : structuredError &&
          typeof structuredError.status === "number" &&
          typeof structuredError.code === "string"
        ? {
            status: structuredError.status,
            code: structuredError.code,
            message:
              structuredError.status >= 500
                ? "Core command failed."
                : typeof structuredError.message === "string"
                ? structuredError.message
                : "Core command failed.",
          }
      : {
          status: 500,
          code: fallbackCode,
          message: "Core command failed.",
        };

  return errorResponse(
    {
      code: coreError.code,
      message: coreError.message,
    },
    coreError.status,
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

function unexpectedCoreCommandPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !coreCommandEnvelopeFields.has(field));
}

function unexpectedCoreViewPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !coreViewEnvelopeFields.has(field));
}

function unexpectedTokenRotationFields(config: Record<string, unknown>) {
  return Object.keys(config).filter((field) => forbiddenTokenRotationFields.has(field));
}

function unexpectedControlPlaneCredentialFields(config: Record<string, unknown>) {
  return Object.keys(config).filter((field) => forbiddenControlPlaneCredentialFields.has(field));
}

function coreCommandRequiresManagedCredential(command?: string) {
  return command !== "control_plane.token_rotation.attest" && command !== "control_plane.credential.upsert";
}

function workerRoleFromCoreCommandConfig(command: string | undefined, config: Record<string, unknown>) {
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

function coreCommandRequiresWorkerRoleScope(command?: string) {
  return (
    command === "worker.upsert" ||
    command === "worker.transition" ||
    command === "worker.run.start" ||
    command === "worker.run.complete"
  );
}

async function handleCoreSummaryRead(request: Request, tenantSlug: string | undefined) {
  const auth = authorizeControlPlaneAccess({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    allowedTenants: env.CONTROL_PLANE_ALLOWED_TENANTS,
    allowedWorkerRoles: env.CONTROL_PLANE_ALLOWED_WORKER_ROLES,
    tokenCatalogJson: env.CONTROL_PLANE_TOKENS_JSON,
    tokenCatalogB64: env.CONTROL_PLANE_TOKEN_CATALOG_B64,
    route: "core",
    access: "read",
    command: "view.summary",
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "read",
      command: "view.summary",
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
      route: "core",
      access: "read",
      command: "view.summary",
      tenantSlug,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "core",
    access: "read",
    command: "view.summary",
    tenantSlug,
    auth,
    requireManagedCredential: true,
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "read",
      command: "view.summary",
      tenantSlug,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  await recordControlPlaneAuthAttempt({
    request,
    route: "core",
    access: "read",
    command: "view.summary",
    tenantSlug,
    auth,
    scope,
  });

  const result = await getCoreSummarySafe({ tenantSlug });
  const summaryError = result.ok ? null : "Core summary is unavailable.";
  const health = getHealth({
    dbOk: result.ok,
    dbError: summaryError,
    counts: result.summary.counts,
  });

  return Response.json(
    {
      api: apiVersion,
      health,
      data: result.summary,
      error: summaryError,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handleCoreSummaryRead(request, optionalString(url.searchParams.get("tenantSlug")));
}

async function handleCoreView(request: Request, body: Record<string, unknown>) {
  const unexpectedFields = unexpectedCoreViewPayloadFields(body);
  const view = optionalString(body.view);
  const core = bodyObject(body.core);
  const tenantSlug = optionalString(core.tenantSlug);
  const targetResult = validateCoreTargetEnvelope(body.core);
  const configResult = configObject(body.config, "invalid_core_view_config");

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_core_view_envelope",
        message: coreEnvelopeFieldError(
          "Core view payload",
          coreViewEnvelopeDescription,
          unexpectedFields,
        ),
      },
      400,
    );
  }

  if (!view) {
    return errorResponse(
      {
        code: "invalid_core_view_envelope",
        message: "Core view payload requires a non-empty view string.",
      },
      400,
    );
  }

  if (!isCoreOperationIdentifier(view)) {
    return errorResponse(
      {
        code: "invalid_core_view_envelope",
        message: coreOperationDescription,
      },
      400,
    );
  }

  if (!targetResult.ok) {
    return errorResponse(targetResult.error, 400);
  }

  if (!hasOwnField(body, "config")) {
    return errorResponse(
      {
        code: "invalid_core_view_config",
        message: "config is required and must be an object.",
      },
      400,
    );
  }

  if (!configResult.ok) {
    return errorResponse(configResult.error, 400);
  }

  if (view !== "summary") {
    return errorResponse(
      {
        code: "core_view_unsupported",
        message: "Core view must be summary.",
      },
      400,
    );
  }

  return handleCoreSummaryRead(request, tenantSlug);
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
    route: "core",
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
        route: "core",
        access: "read",
      });

  if (!writePreAuth.ok && !readPreAuth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "write",
      auth: writePreAuth,
    });
    return guardErrorResponse(writePreAuth);
  }

  const bodyResult = await readBody(request);

  if (!bodyResult.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "write",
      auth: writePreAuth.ok ? writePreAuth : readPreAuth,
    });
    return errorResponse(bodyResult.error, bodyResult.status);
  }

  const body = bodyResult.value;
  const payloadKind = corePayloadKind(body);

  if (payloadKind === "mixed") {
    return errorResponse(
      {
        code: "invalid_core_payload_envelope",
        message: "Core payload must contain either command or view, not both.",
      },
      400,
    );
  }

  if (payloadKind === "missing") {
    return errorResponse(
      {
        code: "invalid_core_payload_envelope",
        message: "Core payload requires a non-empty command or view string.",
      },
      400,
    );
  }

  if (payloadKind === "view") {
    return handleCoreView(request, body);
  }

  const unexpectedFields = unexpectedCoreCommandPayloadFields(body);
  const command = optionalString(body.command);
  const core = bodyObject(body.core);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const tenantSlug = optionalString(core.tenantSlug);
  const workerRole = workerRoleFromCoreCommandConfig(command, config);
  const requireWorkerRoleScope = coreCommandRequiresWorkerRoleScope(command);

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_core_command_envelope",
        message: coreEnvelopeFieldError(
          "Core command payload",
          coreCommandEnvelopeDescription,
          unexpectedFields,
        ),
      },
      400,
    );
  }

  if (!command) {
    return errorResponse(
      {
        code: "invalid_core_command_envelope",
        message: "Core command payload requires a non-empty command string.",
      },
      400,
    );
  }

  if (!isCoreOperationIdentifier(command)) {
    return errorResponse(
      {
        code: "invalid_core_command_envelope",
        message: coreOperationDescription,
      },
      400,
    );
  }

  const targetResult = validateCoreTargetEnvelope(body.core);

  if (!targetResult.ok) {
    return errorResponse(targetResult.error, 400);
  }

  if (!configResult.ok) {
    return errorResponse(configResult.error, 400);
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
    route: "core",
    access: "write",
    command,
  });

  if (!auth.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "write",
      command,
      tenantSlug,
      workerRole,
      auth,
    });
    return guardErrorResponse(auth);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug,
    workerRole,
    requireTenant: true,
    requireWorkerRole: requireWorkerRoleScope,
  });

  if (!scope.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "write",
      command,
      tenantSlug,
      workerRole,
      auth,
      scope,
    });
    return guardErrorResponse(scope);
  }

  const managedCredential = await authorizeManagedControlPlaneCredential({
    request,
    route: "core",
    access: "write",
    command,
    tenantSlug,
    workerRole,
    auth,
    requireManagedCredential: coreCommandRequiresManagedCredential(command),
  });

  if (!managedCredential.ok) {
    await recordControlPlaneAuthAttempt({
      request,
      route: "core",
      access: "write",
      command,
      tenantSlug,
      workerRole,
      auth,
      scope,
      guard: managedCredential,
    });
    return guardErrorResponse(managedCredential);
  }

  const controlPlaneAuthSession = await recordControlPlaneAuthAttempt({
    request,
    route: "core",
    access: "write",
    command,
    tenantSlug,
    workerRole,
    auth,
    scope,
  });

  if (command === "control_plane.token_rotation.attest") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);
    const forbiddenFields = unexpectedTokenRotationFields(config);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    if (forbiddenFields.length > 0) {
      return errorResponse(
        {
          code: "invalid_control_plane_token_rotation",
          message: `Token rotation attestations accept credential ids and token fingerprints only. Remove raw token fields: ${forbiddenFields.join(", ")}.`,
        },
        400,
      );
    }

    try {
      const result = await attestControlPlaneTokenRotation({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        credentialId: optionalString(config.credentialId) ?? auth.credentialId,
        previousCredentialId: optionalString(config.previousCredentialId),
        previousTokenFingerprint: optionalString(config.previousTokenFingerprint),
        nextTokenFingerprint: optionalString(config.nextTokenFingerprint),
        rotatedAt: optionalString(config.rotatedAt),
        reason: optionalString(config.reason),
        evidence: jsonObject(config.evidence),
        authSessionId: controlPlaneAuthSession?.id ?? null,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "control_plane_token_rotation_attest_failed");
    }
  }

  if (command === "control_plane.credential.upsert") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);
    const forbiddenFields = unexpectedControlPlaneCredentialFields(config);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    if (forbiddenFields.length > 0) {
      return errorResponse(
        {
          code: "invalid_control_plane_credential",
          message: `Control-plane credential inventory accepts credential ids, token fingerprints, scopes, and evidence only. Remove unsupported or secret fields: ${forbiddenFields.join(", ")}.`,
        },
        400,
      );
    }

    const policyError = credentialScopePolicyError({ config, auth });

    if (policyError) {
      return errorResponse(
        {
          code: "invalid_control_plane_credential_scope",
          message: `Control-plane credential upserts cannot persist broader durable scopes than the caller has. ${policyError}`,
        },
        403,
      );
    }

    try {
      const result = await upsertControlPlaneCredential({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        credentialId: optionalString(config.credentialId) ?? auth.credentialId,
        displayName: optionalString(config.displayName),
        state: optionalString(config.state),
        tokenFingerprint: optionalString(config.tokenFingerprint),
        allowedTenants: config.allowedTenants,
        allowedWorkerRoles: config.allowedWorkerRoles,
        allowedRoutes: config.allowedRoutes,
        allowedAccess: config.allowedAccess,
        allowedCommands: config.allowedCommands,
        expiresAt: optionalString(config.expiresAt),
        evidence: jsonObject(config.evidence),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "control_plane_credential_upsert_failed");
    }
  }

  if (command === "control_plane.credential.revoke") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);
    const forbiddenFields = unexpectedControlPlaneCredentialFields(config);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    if (forbiddenFields.length > 0) {
      return errorResponse(
        {
          code: "invalid_control_plane_credential",
          message: `Control-plane credential revocation accepts credential ids and evidence only. Remove unsupported or secret fields: ${forbiddenFields.join(", ")}.`,
        },
        400,
      );
    }

    try {
      const result = await revokeControlPlaneCredential({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        credentialId: optionalString(config.credentialId) ?? auth.credentialId,
        reason: optionalString(config.reason),
        evidence: jsonObject(config.evidence),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "control_plane_credential_revoke_failed");
    }
  }

  if (command === "control_plane.session.review") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await reviewControlPlaneSessions({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        credentialId: optionalString(config.credentialId),
        outcome: optionalString(config.outcome),
        since: optionalString(config.since),
        limit: config.limit,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "control_plane_session_review_failed");
    }
  }

  if (command === "task.create") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await createCoreTask({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        title: optionalString(config.title) ?? "",
        objectId: optionalString(config.objectId),
        capabilityId: optionalString(config.capabilityId),
        triggerEventId: optionalString(config.triggerEventId),
        state: optionalString(config.state),
        priority: optionalString(config.priority),
        owner: jsonObject(config.owner),
        ownerRef: optionalString(config.ownerRef),
        reviewerUserId: optionalString(config.reviewerUserId),
        dueAt: optionalString(config.dueAt),
        evidence: jsonObject(config.evidence),
        outcome: jsonObject(config.outcome),
        cost: jsonObject(config.cost),
        kpi: jsonObject(config.kpi),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_task_create_failed");
    }
  }

  if (command === "task.transition") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await transitionCoreTask({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        taskId: optionalString(config.taskId) ?? "",
        toState: optionalString(config.toState) ?? optionalString(config.state),
        reason: optionalString(config.reason),
        evidence: jsonObject(config.evidence),
        outcome: jsonObject(config.outcome),
        cost: jsonObject(config.cost),
        kpi: jsonObject(config.kpi),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_task_transition_failed");
    }
  }

  if (command === "object.upsert") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const rawVersion = config.version;
      const version = bodyObject(rawVersion);
      const versionConfig =
        rawVersion && typeof rawVersion === "object" && !Array.isArray(rawVersion)
          ? {
              data: jsonObject(version.data),
              reason: optionalString(version.reason) ?? null,
            }
          : undefined;
      const result = await upsertCoreObject({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        objectId: optionalString(config.objectId) ?? optionalString(config.id),
        type: optionalString(config.type) ?? "",
        name: optionalString(config.name) ?? "",
        state: optionalString(config.state),
        source: optionalString(config.source),
        externalId: optionalString(config.externalId),
        data: jsonObject(config.data),
        effectiveAt: optionalString(config.effectiveAt),
        archivedAt: optionalString(config.archivedAt),
        reason: optionalString(config.reason),
        version: versionConfig,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_object_upsert_failed");
    }
  }

  if (command === "adapter.upsert") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await upsertCoreAdapter({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        adapterId: optionalString(config.adapterId) ?? optionalString(config.id),
        key: optionalString(config.key) ?? "",
        name: optionalString(config.name) ?? "",
        kind: optionalString(config.kind) ?? "",
        auth: optionalString(config.auth) ?? "",
        configSchema: jsonObject(config.configSchema),
        eventSchema: jsonObject(config.eventSchema),
        capabilities: jsonObject(config.capabilities),
        active: optionalBoolean(config.active),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_adapter_upsert_failed");
    }
  }

  if (command === "connection.upsert") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await upsertCoreConnection({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        connectionId: optionalString(config.connectionId) ?? optionalString(config.id),
        adapterId: optionalString(config.adapterId),
        adapterKey: optionalString(config.adapterKey),
        name: optionalString(config.name) ?? "",
        state: optionalString(config.state),
        externalAccountId: optionalString(config.externalAccountId),
        scopes: jsonObject(config.scopes),
        config: jsonObject(config.config),
        lastSyncAt: optionalString(config.lastSyncAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_connection_upsert_failed");
    }
  }

  if (command === "connection.health.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordCoreConnectionHealth({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        connectionId: optionalString(config.connectionId) ?? "",
        checks: config.checks,
        observedAt: optionalString(config.observedAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_connection_health_record_failed");
    }
  }

  if (command === "entity.setup.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordEntitySetup({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        legalEntity: config.legalEntity,
        identifiers: config.identifiers,
        locations: config.locations,
        bankAccount: config.bankAccount,
        bankAccounts: config.bankAccounts,
        paymentInstruction: config.paymentInstruction,
        paymentInstructions: config.paymentInstructions,
        workflow: config.workflow,
        packet: config.packet,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_entity_setup_record_failed");
    }
  }

  if (command === "worker.upsert") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await upsertCoreWorker({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        workerId: optionalString(config.workerId) ?? optionalString(config.id),
        kind: optionalString(config.kind),
        state: optionalString(config.state),
        name: optionalString(config.name),
        role: optionalString(config.role),
        mission: optionalString(config.mission),
        managerUserId: config.managerUserId,
        scope: config.scope,
        memory: config.memory,
        policy: config.policy,
        kpis: config.kpis,
        autonomyLevel: config.autonomyLevel,
        lifecycle: config.lifecycle,
        evidence: config.evidence,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_worker_upsert_failed");
    }
  }

  if (command === "worker.transition") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await transitionCoreWorker({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        workerId: optionalString(config.workerId) ?? optionalString(config.id) ?? "",
        state: optionalString(config.state),
        toState: optionalString(config.toState),
        reason: optionalString(config.reason),
        lifecycle: config.lifecycle,
        evidence: config.evidence,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_worker_transition_failed");
    }
  }

  if (command === "event.ingest") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await ingestCoreEvent({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        type: optionalString(config.type) ?? "",
        source: optionalString(config.source),
        actor: actorFrom(config.actor),
        objectId: optionalString(config.objectId),
        taskId: optionalString(config.taskId),
        capabilityId: optionalString(config.capabilityId),
        adapterId: optionalString(config.adapterId),
        connectionId: optionalString(config.connectionId),
        data: jsonObject(config.data),
        occurredAt: optionalString(config.occurredAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_event_ingest_failed");
    }
  }

  if (command === "evidence.attach") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await attachCoreEvidence({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        kind: optionalString(config.kind) ?? "",
        name: optionalString(config.name) ?? "",
        actor: actorFrom(config.actor),
        objectId: optionalString(config.objectId),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        capabilityId: optionalString(config.capabilityId),
        uri: optionalString(config.uri),
        hash: optionalString(config.hash),
        data: jsonObject(config.data),
        redaction: jsonObject(config.redaction),
        retainedUntil: optionalString(config.retainedUntil),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_evidence_attach_failed");
    }
  }

  if (command === "document.create") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await createCoreDocument({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        kind: optionalString(config.kind) ?? "",
        name: optionalString(config.name) ?? "",
        state: optionalString(config.state),
        sensitivity: optionalString(config.sensitivity),
        objectId: optionalString(config.objectId),
        workflowRunId: optionalString(config.workflowRunId),
        hash: optionalString(config.hash),
        data: jsonObject(config.data),
        retainedUntil: optionalString(config.retainedUntil),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_document_create_failed");
    }
  }

  if (command === "packet.prepare" || command === "document.packet.prepare") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await prepareCorePacket({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        kind: optionalString(config.kind) ?? "",
        name: optionalString(config.name) ?? "",
        state: optionalString(config.state),
        sensitivity: optionalString(config.sensitivity),
        objectId: optionalString(config.objectId),
        taskId: optionalString(config.taskId),
        workflowRunId: optionalString(config.workflowRunId),
        eventId: optionalString(config.eventId),
        capabilityId: optionalString(config.capabilityId),
        evidenceIds: config.evidenceIds,
        documentIds: config.documentIds,
        sections: jsonObject(config.sections),
        hash: optionalString(config.hash),
        data: jsonObject(config.data),
        retainedUntil: optionalString(config.retainedUntil),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_packet_prepare_failed");
    }
  }

  if (command === "decision.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordCoreDecision({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        kind: optionalString(config.kind) ?? "",
        decision: optionalString(config.decision) ?? "",
        rationale: optionalString(config.rationale),
        state: optionalString(config.state),
        actor: actorFrom(config.actor),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        workflowRunId: optionalString(config.workflowRunId),
        capabilityId: optionalString(config.capabilityId),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_decision_record_failed");
    }
  }

  if (command === "approval.request") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await requestApproval({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        kind: optionalString(config.kind) ?? "",
        title: optionalString(config.title) ?? "",
        summary: optionalString(config.summary),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        objectId: optionalString(config.objectId),
        capabilityId: optionalString(config.capabilityId),
        reviewerUserId: optionalString(config.reviewerUserId),
        priority: optionalString(config.priority),
        risk: optionalString(config.risk),
        dueAt: optionalString(config.dueAt),
        requestedAction: jsonObject(config.requestedAction),
        evidence: jsonObject(config.evidence),
        policy: jsonObject(config.policy),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_approval_request_failed");
    }
  }

  if (command === "adapter.intent.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordAdapterIntent({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        connectionId: optionalString(config.connectionId) ?? "",
        operation: optionalString(config.operation) ?? "",
        mode: optionalString(config.mode),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        capabilityId: optionalString(config.capabilityId),
        request: jsonObject(config.request),
        data: jsonObject(config.data),
        maxAttempts: config.maxAttempts,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_adapter_intent_record_failed");
    }
  }

  if (command === "rule.change.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordRuleChange({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        rulePackId: optionalString(config.rulePackId),
        ruleKey: optionalString(config.ruleKey) ?? "",
        changeType: optionalString(config.changeType) ?? "",
        title: optionalString(config.title) ?? "",
        summary: optionalString(config.summary),
        state: optionalString(config.state),
        decision: optionalString(config.decision),
        rationale: optionalString(config.rationale),
        taskId: optionalString(config.taskId),
        workflowRunId: optionalString(config.workflowRunId),
        capabilityId: optionalString(config.capabilityId),
        sourceRefs: jsonObject(config.sourceRefs),
        before: jsonObject(config.before),
        after: jsonObject(config.after),
        impact: jsonObject(config.impact),
        data: jsonObject(config.data),
        effectiveAt: optionalString(config.effectiveAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_rule_change_record_failed");
    }
  }

  if (command === "capability.grant") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await grantCapability({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        capabilityId: optionalString(config.capabilityId),
        capabilityKey: optionalString(config.capabilityKey),
        capabilityVersion: optionalString(config.capabilityVersion),
        actor: jsonObject(config.actor),
        scope: jsonObject(config.scope),
        policy: jsonObject(config.policy),
        active: optionalBoolean(config.active),
        startsAt: optionalString(config.startsAt),
        endsAt: optionalString(config.endsAt),
        approvalRequestId: optionalString(config.approvalRequestId),
        reason: optionalString(config.reason),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_capability_grant_failed");
    }
  }

  if (command === "budget.reserve") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await reserveBudget({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        budgetAccountId: optionalString(config.budgetAccountId) ?? "",
        units: config.units,
        taskId: optionalString(config.taskId),
        capabilityId: optionalString(config.capabilityId),
        expiresAt: optionalString(config.expiresAt),
        reason: optionalString(config.reason),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_budget_reserve_failed");
    }
  }

  if (command === "budget.charge") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await chargeBudget({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        reservationId: optionalString(config.reservationId) ?? "",
        units: config.units,
        costUsd: config.costUsd,
        actor: jsonObject(config.actor),
        taskId: optionalString(config.taskId),
        capabilityId: optionalString(config.capabilityId),
        inferenceId: optionalString(config.inferenceId),
        reason: optionalString(config.reason),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_budget_charge_failed");
    }
  }

  if (command === "budget.release") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await releaseBudget({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        reservationId: optionalString(config.reservationId) ?? "",
        reason: optionalString(config.reason),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_budget_release_failed");
    }
  }

  if (command === "worker.run.start") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await startCoreWorkerRun({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        worker: jsonObject(config.worker),
        command: optionalString(config.command),
        mode: optionalString(config.mode),
        taskId: optionalString(config.taskId),
        capabilityId: optionalString(config.capabilityId),
        capabilityKey: optionalString(config.capabilityKey),
        capabilityVersion: optionalString(config.capabilityVersion),
        connectionId: optionalString(config.connectionId),
        budgetAccountId: optionalString(config.budgetAccountId),
        units: config.units,
        expiresAt: optionalString(config.expiresAt),
        input: config.input,
        policy: config.policy,
        evidence: config.evidence,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_worker_run_start_failed");
    }
  }

  if (command === "worker.run.complete") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await completeCoreWorkerRun({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        worker: jsonObject(config.worker),
        workerRunId: optionalString(config.workerRunId),
        state: optionalString(config.state),
        output: config.output,
        reason: optionalString(config.reason),
        costUsd: config.costUsd,
        evidence: config.evidence,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_worker_run_complete_failed");
    }
  }

  if (command === "ai.infer") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await executeAiInference({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        routeKey: optionalString(config.routeKey),
        routePurpose: optionalString(config.routePurpose),
        budgetAccountId: optionalString(config.budgetAccountId) ?? "",
        maxUnits: config.maxUnits,
        costUsd: config.costUsd,
        actor: jsonObject(config.actor),
        taskId: optionalString(config.taskId),
        objectId: optionalString(config.objectId),
        capabilityId: optionalString(config.capabilityId),
        input: jsonObject(config.input),
        redaction: jsonObject(config.redaction),
        evaluation: jsonObject(config.evaluation),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_ai_infer_failed");
    }
  }

  if (command === "object.link") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await linkCoreObjects({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        fromObjectId: optionalString(config.fromObjectId) ?? optionalString(config.fromId) ?? "",
        toObjectId: optionalString(config.toObjectId) ?? optionalString(config.toId) ?? "",
        type: optionalString(config.type) ?? "",
        data: jsonObject(config.data),
        effectiveAt: optionalString(config.effectiveAt),
        endedAt: optionalString(config.endedAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_object_link_failed");
    }
  }

  if (command === "view.publish") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await publishCoreView({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        key: optionalString(config.key) ?? "",
        name: optionalString(config.name) ?? "",
        purpose: optionalString(config.purpose) ?? "",
        version: optionalString(config.version),
        surface: optionalString(config.surface),
        capabilityId: optionalString(config.capabilityId),
        objectType: optionalString(config.objectType),
        taskState: optionalString(config.taskState),
        contract: jsonObject(config.contract),
        actions: jsonObject(config.actions),
        data: jsonObject(config.data),
        mask: jsonObject(config.mask),
        active: optionalBoolean(config.active),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_view_publish_failed");
    }
  }

  if (command === "customer_signal.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordCustomerSignal({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        type: optionalString(config.type) ?? "",
        name: optionalString(config.name) ?? "",
        state: optionalString(config.state),
        source: optionalString(config.source),
        externalId: optionalString(config.externalId),
        customerObjectId: optionalString(config.customerObjectId),
        relatedObjectId: optionalString(config.relatedObjectId),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        data: jsonObject(config.data),
        occurredAt: optionalString(config.occurredAt),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_customer_signal_record_failed");
    }
  }

  if (command === "payroll.preview.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordPayrollPreview({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        payrollRunId: optionalString(config.payrollRunId) ?? "",
        statement: jsonObject(config.statement),
        lines: config.lines,
        liabilities: config.liabilities,
        trace: config.trace,
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_payroll_preview_record_failed");
    }
  }

  if (command === "payroll.preview.packet.prepare") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await preparePayrollPreviewPacket({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        payrollRunId: optionalString(config.payrollRunId) ?? "",
        objectId: optionalString(config.objectId),
        reviewerUserId: optionalString(config.reviewerUserId),
        dueAt: optionalString(config.dueAt),
        variance: jsonObject(config.variance),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_payroll_preview_packet_prepare_failed");
    }
  }

  if (command === "external_action.record") {
    const idempotency = normalizeIdempotencyKey(body.idempotencyKey);

    if (!idempotency.ok) {
      return errorResponse(
        {
          code: "invalid_idempotency_key",
          message: idempotency.message,
        },
        400,
      );
    }

    try {
      const result = await recordExternalAction({
        operatorEmail: auth.operatorEmail,
        idempotencyKey: idempotency.key,
        tenantSlug,
        targetType: optionalString(config.targetType) ?? "",
        targetId: optionalString(config.targetId) ?? "",
        kind: optionalString(config.kind) ?? "",
        state: optionalString(config.state) ?? "",
        connectionId: optionalString(config.connectionId),
        adapterActionId: optionalString(config.adapterActionId),
        taskId: optionalString(config.taskId),
        eventId: optionalString(config.eventId),
        capabilityId: optionalString(config.capabilityId),
        amountCents: config.amountCents,
        currency: optionalString(config.currency),
        occurredAt: optionalString(config.occurredAt),
        receipt: jsonObject(config.receipt),
        response: jsonObject(config.response),
        data: jsonObject(config.data),
      });

      return Response.json(
        {
          api: apiVersion,
          data: {
            command,
            core: {
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
      return coreErrorResponse(error, "core_external_action_record_failed");
    }
  }

  return errorResponse(
    {
      code: "core_command_unsupported",
      message:
        "Core command must be task.create, task.transition, object.upsert, adapter.upsert, connection.upsert, connection.health.record, entity.setup.record, worker.upsert, worker.transition, worker.run.start, worker.run.complete, object.link, event.ingest, evidence.attach, document.create, packet.prepare, document.packet.prepare, decision.record, approval.request, adapter.intent.record, rule.change.record, external_action.record, capability.grant, budget.reserve, budget.charge, budget.release, ai.infer, view.publish, customer_signal.record, payroll.preview.record, or payroll.preview.packet.prepare.",
    },
    400,
  );
}
