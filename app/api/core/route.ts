import { env } from "../../../src/env";
import { getHealth } from "../../../src/core/health";
import { getCoreSummarySafe } from "../../../src/core/summary";
import {
  attachCoreEvidence,
  createCoreDocument,
  ingestCoreEvent,
  recordCoreDecision,
  upsertCoreObject,
} from "../../../src/core/primitives";
import { createCoreTask } from "../../../src/core/tasks";
import { PlatformUnavailableError } from "../../../src/core/errors";
import {
  authorizeWorkerRead,
  authorizeWorkerRun,
  normalizeIdempotencyKey,
} from "../../../src/worker/security";
import type { JsonObject } from "../../../src/db/schema";

export const dynamic = "force-dynamic";

const apiVersion = "continuous.core.v1";

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

export async function GET(request: Request) {
  const auth = authorizeWorkerRead({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
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
  const auth = authorizeWorkerRun({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
  }

  const body = await readBody(request);
  const command = optionalString(body.command);
  const core = bodyObject(body.core);
  const config = bodyObject(body.config);
  const tenantSlug = optionalString(core.tenantSlug);

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

  return errorResponse(
    {
      code: "core_command_unsupported",
      message:
        "Core command must be task.create, object.upsert, event.ingest, evidence.attach, document.create, or decision.record.",
    },
    400,
  );
}
