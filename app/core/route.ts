import { env } from "../../src/env";
import { requestApproval } from "../../src/core/approvals";
import { reserveBudget, chargeBudget, releaseBudget } from "../../src/core/budgets";
import { grantCapability } from "../../src/core/capabilities";
import { getHealth } from "../../src/core/health";
import { preparePayrollPreviewPacket, recordPayrollPreview } from "../../src/core/payroll";
import { getCoreSummarySafe } from "../../src/core/summary";
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
  recordRuleChange,
  upsertCoreObject,
} from "../../src/core/primitives";
import { createCoreTask, transitionCoreTask } from "../../src/core/tasks";
import { PlatformUnavailableError } from "../../src/core/errors";
import {
  authorizeControlPlaneAccess,
  authorizeControlPlaneScope,
  normalizeIdempotencyKey,
} from "../../src/worker/security";
import type { JsonObject } from "../../src/db/schema";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.core.v1";
const coreCommandEnvelopeFields = new Set(["command", "core", "idempotencyKey", "config"]);
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
      code: "invalid_core_command_config",
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

function actorFrom(value: unknown) {
  const actor = bodyObject(value);
  return {
    type: optionalString(actor.type),
    id: optionalString(actor.id),
    ref: optionalString(actor.ref),
  };
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

function coreErrorResponse(error: unknown, fallbackCode: string) {
  const coreError =
    error instanceof PlatformUnavailableError
      ? {
          status: error.status,
          code: error.code,
          message: error.message,
        }
      : {
          status: 500,
          code: fallbackCode,
          message: error instanceof Error ? error.message : "Unknown core error.",
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

function unexpectedCorePayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !coreCommandEnvelopeFields.has(field));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
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
    route: "core",
    access: "read",
    command: "view.summary",
  });

  if (!auth.ok) {
    return guardErrorResponse(auth);
  }

  const scope = authorizeControlPlaneScope({
    scope: auth.scope,
    tenantSlug,
    requireTenant: true,
  });

  if (!scope.ok) {
    return guardErrorResponse(scope);
  }

  const result = await getCoreSummarySafe();
  const health = getHealth({
    dbOk: result.ok,
    dbError: result.error,
    counts: result.summary.counts,
  });

  return Response.json(
    {
      api: apiVersion,
      health,
      data: result.summary,
      error: result.error,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function POST(request: Request) {
  const body = await readBody(request);
  const unexpectedFields = unexpectedCorePayloadFields(body);
  const command = optionalString(body.command);
  const core = bodyObject(body.core);
  const configResult = configObject(body.config);
  const config = configResult.ok ? configResult.value : {};
  const tenantSlug = optionalString(core.tenantSlug);
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
    route: "core",
    access: "write",
    command,
  });

  if (!auth.ok) {
    return guardErrorResponse(auth);
  }

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_core_command_envelope",
        message: `Core command payload fields must be command, core, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
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
    return guardErrorResponse(scope);
  }

  if (command === "task.create") {
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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

  if (command === "event.ingest") {
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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

  if (command === "object.link") {
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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
    const idempotency = normalizeIdempotencyKey(
      request.headers.get("idempotency-key") ?? body.idempotencyKey,
    );

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

  return errorResponse(
    {
      code: "core_command_unsupported",
      message:
        "Core command must be task.create, task.transition, object.upsert, adapter.upsert, connection.upsert, connection.health.record, object.link, event.ingest, evidence.attach, document.create, packet.prepare, document.packet.prepare, decision.record, approval.request, adapter.intent.record, rule.change.record, capability.grant, budget.reserve, budget.charge, budget.release, view.publish, customer_signal.record, payroll.preview.record, or payroll.preview.packet.prepare.",
    },
    400,
  );
}
