import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  controlPlaneAuthSessions,
  controlPlaneTokenRotationAttestations,
  events,
  tenants,
  users,
  type JsonObject,
} from "../db/schema";
import type {
  ControlPlaneAccess,
  ControlPlaneAccessResult,
  ControlPlaneRoute,
  ControlPlaneScopeResult,
} from "../worker/security";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const controlPlaneSource = "continuous.core.control_plane";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenFingerprintPattern = /^[a-f0-9]{8,64}$/i;

export type ControlPlaneAuthAttemptInput = {
  request: Request;
  route: ControlPlaneRoute;
  access: ControlPlaneAccess;
  command?: string | null;
  tenantSlug?: string | null;
  workerRole?: string | null;
  auth: ControlPlaneAccessResult;
  scope?: ControlPlaneScopeResult;
  db?: Database;
};

export type ControlPlaneTokenRotationAttestationInput = {
  operatorEmail: string;
  tenantSlug?: string;
  idempotencyKey: string;
  credentialId: string;
  previousCredentialId?: string;
  previousTokenFingerprint?: string;
  nextTokenFingerprint?: string;
  rotatedAt?: string;
  reason?: string;
  evidence?: JsonObject;
  authSessionId?: string | null;
  db?: Database;
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function hashFingerprint(value?: string | null) {
  if (!value) {
    return null;
  }

  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function headerFingerprint(request: Request, header: string) {
  return hashFingerprint(cleanString(request.headers.get(header)));
}

function bearerToken(authorization?: string | null) {
  const value = cleanString(authorization);

  if (!value) {
    return undefined;
  }

  const match = value.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || undefined;
}

function requestToken(request: Request) {
  return (
    bearerToken(request.headers.get("authorization")) ??
    cleanString(request.headers.get("x-worker-run-token"))
  );
}

export function controlPlaneTokenFingerprint(value?: string | null) {
  return hashFingerprint(cleanString(value));
}

export function controlPlaneRequestTokenFingerprint(request: Request) {
  return controlPlaneTokenFingerprint(requestToken(request));
}

export function controlPlaneSafeRequestMetadata(request: Request): JsonObject {
  const url = new URL(request.url);
  const requestId =
    cleanString(request.headers.get("x-request-id")) ??
    cleanString(request.headers.get("x-correlation-id")) ??
    cleanString(request.headers.get("cf-ray"));
  const forwardedFor = cleanString(request.headers.get("x-forwarded-for"));
  const remoteIp = forwardedFor?.split(",")[0]?.trim() ?? cleanString(request.headers.get("x-real-ip"));
  const metadata: JsonObject = {
    method: request.method,
    path: url.pathname,
    source: "http",
  };

  if (requestId) {
    metadata.requestId = requestId.slice(0, 160);
  }

  const userAgentFingerprint = headerFingerprint(request, "user-agent");

  if (userAgentFingerprint) {
    metadata.userAgentFingerprint = userAgentFingerprint;
  }

  const ipFingerprint = hashFingerprint(remoteIp);

  if (ipFingerprint) {
    metadata.ipFingerprint = ipFingerprint;
  }

  return metadata;
}

async function resolveAuthAnchors(input: {
  db: Database | Transaction;
  tenantSlug?: string | null;
  operatorEmail?: string | null;
}) {
  const tenantSlug = cleanString(input.tenantSlug);
  const operatorEmail = cleanString(input.operatorEmail)?.toLowerCase();
  let tenantId: string | null = null;
  let userId: string | null = null;

  if (tenantSlug) {
    const [tenant] = await input.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, tenantSlug))
      .limit(1);

    tenantId = tenant?.id ?? null;
  }

  if (operatorEmail && (!tenantSlug || tenantId)) {
    const conditions = [eq(users.email, operatorEmail), eq(users.state, "active")];

    if (tenantId) {
      conditions.push(eq(users.tenantId, tenantId));
    }

    const rows = await input.db
      .select({
        id: users.id,
        tenantId: users.tenantId,
      })
      .from(users)
      .where(and(...conditions))
      .orderBy(users.createdAt)
      .limit(2);

    if (rows.length === 1) {
      userId = rows[0].id;
      tenantId ??= rows[0].tenantId;
    }
  }

  return {
    tenantId,
    userId,
  };
}

export async function recordControlPlaneAuthAttempt(input: ControlPlaneAuthAttemptInput) {
  const db = input.db ?? defaultDb;

  try {
    const scopeFailure = input.scope && !input.scope.ok ? input.scope : null;
    const outcome = input.auth.ok && !scopeFailure ? "allowed" : "denied";
    const reasonCode = !input.auth.ok
      ? input.auth.code
      : scopeFailure
        ? scopeFailure.code
        : "allowed";
    const operatorEmail = input.auth.ok ? input.auth.operatorEmail : null;
    const credentialId = input.auth.ok ? input.auth.credentialId : null;
    const anchors = await resolveAuthAnchors({
      db,
      tenantSlug: input.tenantSlug,
      operatorEmail,
    });
    const [session] = await db
      .insert(controlPlaneAuthSessions)
      .values({
        tenantId: anchors.tenantId,
        userId: anchors.userId,
        operatorEmail,
        credentialId,
        tokenFingerprint: controlPlaneRequestTokenFingerprint(input.request),
        route: input.route,
        access: input.access,
        command: cleanString(input.command) ?? null,
        tenantSlug: cleanString(input.tenantSlug) ?? null,
        workerRole: cleanString(input.workerRole) ?? null,
        outcome,
        reasonCode,
        scope: input.auth.ok ? jsonObject(input.auth.scope) : {},
        request: controlPlaneSafeRequestMetadata(input.request),
      })
      .returning({ id: controlPlaneAuthSessions.id });

    return session ?? null;
  } catch (error) {
    console.error("control_plane_auth_session_record_failed", {
      route: input.route,
      access: input.access,
      command: cleanString(input.command) ?? null,
      error: error instanceof Error ? error.message : "Unknown auth audit error.",
    });

    return null;
  }
}

function requiredString(value: unknown, field: string) {
  const cleaned = cleanString(value);

  if (!cleaned) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_token_rotation",
      `${field} is required.`,
      400,
    );
  }

  return cleaned;
}

function normalizeTokenFingerprint(value: unknown, field: string, required: true): string;
function normalizeTokenFingerprint(value: unknown, field: string, required?: false): string | null;
function normalizeTokenFingerprint(value: unknown, field: string, required = false) {
  const cleaned = cleanString(value)?.replace(/^sha256:/i, "").toLowerCase();

  if (!cleaned) {
    if (required) {
      throw new PlatformUnavailableError(
        "invalid_control_plane_token_fingerprint",
        `${field} is required and must be a token fingerprint, not token material.`,
        400,
      );
    }

    return null;
  }

  if (!tokenFingerprintPattern.test(cleaned)) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_token_fingerprint",
      `${field} must be an 8 to 64 character hex token fingerprint, not token material.`,
      400,
    );
  }

  return cleaned.slice(0, 16);
}

function optionalUuid(value: unknown, field: string) {
  const cleaned = cleanString(value);

  if (!cleaned) {
    return null;
  }

  if (!uuidPattern.test(cleaned)) {
    throw new PlatformUnavailableError("invalid_uuid", `${field} must be a UUID.`, 400);
  }

  return cleaned;
}

function optionalDate(value: unknown, field: string) {
  const cleaned = cleanString(value);

  if (!cleaned) {
    return null;
  }

  const date = new Date(cleaned);

  if (!Number.isFinite(date.getTime())) {
    throw new PlatformUnavailableError("invalid_date", `${field} must be an ISO date.`, 400);
  }

  return date;
}

async function existingRotationResult(
  tx: Transaction,
  tenantId: string,
  idempotencyKey: string,
) {
  const [existing] = await tx
    .select({
      id: controlPlaneTokenRotationAttestations.id,
      eventId: controlPlaneTokenRotationAttestations.eventId,
      auditEventId: controlPlaneTokenRotationAttestations.auditEventId,
      credentialId: controlPlaneTokenRotationAttestations.credentialId,
      previousCredentialId: controlPlaneTokenRotationAttestations.previousCredentialId,
      previousTokenFingerprint:
        controlPlaneTokenRotationAttestations.previousTokenFingerprint,
      nextTokenFingerprint: controlPlaneTokenRotationAttestations.nextTokenFingerprint,
      state: controlPlaneTokenRotationAttestations.state,
      rotatedAt: controlPlaneTokenRotationAttestations.rotatedAt,
      attestedAt: controlPlaneTokenRotationAttestations.attestedAt,
    })
    .from(controlPlaneTokenRotationAttestations)
    .where(
      and(
        eq(controlPlaneTokenRotationAttestations.tenantId, tenantId),
        eq(controlPlaneTokenRotationAttestations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  return {
    created: false,
    tokenRotationAttestationId: existing.id,
    eventId: existing.eventId,
    auditEventId: existing.auditEventId,
    credentialId: existing.credentialId,
    previousCredentialId: existing.previousCredentialId,
    previousTokenFingerprint: existing.previousTokenFingerprint,
    nextTokenFingerprint: existing.nextTokenFingerprint,
    state: existing.state,
    rotatedAt: existing.rotatedAt.toISOString(),
    attestedAt: existing.attestedAt.toISOString(),
  };
}

export async function attestControlPlaneTokenRotation(
  input: ControlPlaneTokenRotationAttestationInput,
) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const credentialId = requiredString(input.credentialId, "config.credentialId");
  const previousCredentialId = cleanString(input.previousCredentialId) ?? null;
  const previousTokenFingerprint = normalizeTokenFingerprint(
    input.previousTokenFingerprint,
    "config.previousTokenFingerprint",
  );
  const nextTokenFingerprint = normalizeTokenFingerprint(
    input.nextTokenFingerprint,
    "config.nextTokenFingerprint",
    true,
  );
  const rotatedAt = optionalDate(input.rotatedAt, "config.rotatedAt") ?? new Date();
  const authSessionId = optionalUuid(input.authSessionId, "config.authSessionId");
  const reason = cleanString(input.reason) ?? "Operator attested control-plane token rotation.";
  const evidence = jsonObject(input.evidence);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${controlPlaneSource}:${input.idempotencyKey}`}))`,
    );

    const existing = await existingRotationResult(tx, operator.tenantId, input.idempotencyKey);

    if (existing) {
      return existing;
    }

    const now = new Date();
    const [rotation] = await tx
      .insert(controlPlaneTokenRotationAttestations)
      .values({
        tenantId: operator.tenantId,
        userId: operator.userId,
        authSessionId,
        operatorEmail: operator.email,
        credentialId,
        previousCredentialId,
        previousTokenFingerprint,
        nextTokenFingerprint,
        state: "attested",
        reason,
        idempotencyKey: input.idempotencyKey,
        evidence,
        rotatedAt,
        attestedAt: now,
        createdAt: now,
      })
      .returning({
        id: controlPlaneTokenRotationAttestations.id,
        attestedAt: controlPlaneTokenRotationAttestations.attestedAt,
      });
    const eventData: JsonObject = {
      tokenRotationAttestationId: rotation.id,
      credentialId,
      previousCredentialId,
      previousTokenFingerprint,
      nextTokenFingerprint,
      authSessionId,
      reason,
      evidence,
      rotatedAt: rotatedAt.toISOString(),
      attestedAt: rotation.attestedAt.toISOString(),
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.token_rotation.attested",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        idempotencyKey: `${input.idempotencyKey}:token_rotation_attested`,
        data: eventData,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.token_rotation.attested",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "control_plane_token_rotation",
        targetId: rotation.id,
        eventId: event.id,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:token_rotation_attested`,
        data: {
          ...eventData,
          eventId: event.id,
        },
      })
      .returning({ id: auditEvents.id });

    await tx
      .update(controlPlaneTokenRotationAttestations)
      .set({
        eventId: event.id,
        auditEventId: audit.id,
      })
      .where(eq(controlPlaneTokenRotationAttestations.id, rotation.id));

    return {
      created: true,
      tokenRotationAttestationId: rotation.id,
      eventId: event.id,
      auditEventId: audit.id,
      credentialId,
      previousCredentialId,
      previousTokenFingerprint,
      nextTokenFingerprint,
      state: "attested",
      rotatedAt: rotatedAt.toISOString(),
      attestedAt: rotation.attestedAt.toISOString(),
    };
  });
}
