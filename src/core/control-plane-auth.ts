import { createHash } from "node:crypto";

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  controlPlaneAuthSessions,
  controlPlaneCredentials,
  controlPlaneTokenRotationAttestations,
  events,
  tenants,
  uiContracts,
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
import {
  assertCoreIdempotencyReplay,
  coreIdempotencyFingerprint,
  type CoreIdempotencyFingerprint,
} from "./idempotency";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const controlPlaneSource = "continuous.core.control_plane";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenFingerprintPattern = /^[a-f0-9]{8,64}$/i;
const controlPlaneCredentialStates = new Set(["active", "paused", "revoked", "expired"]);

export type ControlPlaneAuthAttemptInput = {
  request: Request;
  route: ControlPlaneRoute;
  access: ControlPlaneAccess;
  command?: string | null;
  tenantSlug?: string | null;
  workerRole?: string | null;
  auth: ControlPlaneAccessResult;
  guard?: ManagedControlPlaneCredentialResult;
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

export type ManagedControlPlaneCredentialInput = {
  auth: ControlPlaneAccessResult;
  request: Request;
  tenantSlug?: string | null;
  workerRole?: string | null;
  route: ControlPlaneRoute;
  access: ControlPlaneAccess;
  command?: string | null;
  requireManagedCredential?: boolean;
  db?: Database;
};

export type ManagedControlPlaneCredentialResult =
  | { ok: true; managedCredentialId?: string | null }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ControlPlaneCredentialUpsertInput = {
  operatorEmail: string;
  tenantSlug?: string;
  idempotencyKey: string;
  credentialId: string;
  displayName?: string;
  credentialOperatorEmail?: string;
  state?: string;
  tokenFingerprint?: string;
  allowedTenants?: unknown;
  allowedWorkerRoles?: unknown;
  allowedRoutes?: unknown;
  allowedAccess?: unknown;
  allowedCommands?: unknown;
  expiresAt?: string;
  evidence?: JsonObject;
  db?: Database;
};

export type ControlPlaneCredentialRevokeInput = {
  operatorEmail: string;
  tenantSlug?: string;
  idempotencyKey: string;
  credentialId: string;
  reason?: string;
  evidence?: JsonObject;
  db?: Database;
};

export type ControlPlaneSessionReviewInput = {
  operatorEmail: string;
  tenantSlug?: string;
  idempotencyKey: string;
  credentialId?: string;
  outcome?: string;
  since?: string;
  limit?: unknown;
  db?: Database;
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown): string[] {
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

function listObject(value: unknown): JsonObject {
  return {
    items: stringList(value),
  };
}

function commandListObject(value: unknown): JsonObject {
  const items = stringList(value);
  const invalid = items.find(
    (item) => item === "*" || item.endsWith(":*") || !item.includes(":"),
  );

  if (invalid) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_credential",
      "config.allowedCommands must use exact route-qualified command keys.",
      400,
    );
  }

  return { items };
}

function listItems(value: JsonObject | null | undefined, key = "items") {
  return stringList(value?.[key]);
}

function scopedListAllows(items: string[], value?: string | null) {
  const cleaned = cleanString(value);

  if (items.length === 0) {
    return true;
  }

  if (!cleaned) {
    return false;
  }

  return items.includes("*") || items.includes(cleaned);
}

function patternListAllows(items: string[], value?: string | null) {
  const cleaned = cleanString(value);

  if (items.length === 0) {
    return true;
  }

  if (!cleaned) {
    return false;
  }

  return items.some((item) => {
    if (item === "*" || item === cleaned) {
      return true;
    }

    if (item.endsWith(":*")) {
      return cleaned.startsWith(item.slice(0, -1));
    }

    return false;
  });
}

function commandListAllows(items: string[], route: string, command?: string | null) {
  const cleanedCommand = cleanString(command);
  const cleanedRoute = cleanString(route);

  if (!cleanedCommand || !cleanedRoute) {
    return true;
  }

  return items.includes(`${cleanedRoute}:${cleanedCommand}`);
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
    const guardFailure = input.guard && !input.guard.ok ? input.guard : null;
    const scopeFailure = input.scope && !input.scope.ok ? input.scope : null;
    const outcome = input.auth.ok && !guardFailure && !scopeFailure ? "allowed" : "denied";
    const reasonCode = !input.auth.ok
      ? input.auth.code
      : guardFailure
        ? guardFailure.code
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

    if (session && outcome === "allowed" && anchors.tenantId && credentialId) {
      await db
        .update(controlPlaneCredentials)
        .set({
          lastAuthSessionId: session.id,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(controlPlaneCredentials.tenantId, anchors.tenantId),
            eq(controlPlaneCredentials.credentialId, credentialId),
          ),
        );
    }

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

function requiredString(
  value: unknown,
  field: string,
  code = "invalid_control_plane_token_rotation",
) {
  const cleaned = cleanString(value);

  if (!cleaned) {
    throw new PlatformUnavailableError(code, `${field} is required.`, 400);
  }

  return cleaned;
}

function requiredStringMax(value: unknown, field: string, max: number) {
  const cleaned = requiredString(value, field, "invalid_control_plane_credential");

  if (cleaned.length > max) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_credential",
      `${field} must be ${max} characters or fewer.`,
      400,
    );
  }

  return cleaned;
}

function parseCredentialState(value: unknown) {
  const state = cleanString(value) ?? "active";

  if (!controlPlaneCredentialStates.has(state)) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_credential_state",
      "config.state must be active, paused, revoked, or expired.",
      400,
    );
  }

  return state;
}

function parseSessionReviewLimit(value: unknown) {
  if (value === undefined || value === null) {
    return 50;
  }

  const limit = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new PlatformUnavailableError(
      "invalid_control_plane_session_review_limit",
      "config.limit must be an integer between 1 and 200.",
      400,
    );
  }

  return limit;
}

function credentialScopeObject(input: {
  allowedTenants?: unknown;
  allowedWorkerRoles?: unknown;
}): JsonObject {
  return {
    tenantSlugs: stringList(input.allowedTenants),
    workerRoles: stringList(input.allowedWorkerRoles),
  };
}

function credentialView(row: typeof controlPlaneCredentials.$inferSelect) {
  return {
    id: row.id,
    credentialId: row.credentialId,
    displayName: row.displayName,
    operatorEmail: row.operatorEmail,
    state: row.state,
    tokenFingerprint: row.tokenFingerprint,
    scope: row.scope,
    routes: row.routes,
    access: row.access,
    commands: row.commands,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastAuthSessionId: row.lastAuthSessionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sessionView(row: typeof controlPlaneAuthSessions.$inferSelect) {
  return {
    id: row.id,
    credentialId: row.credentialId,
    operatorEmail: row.operatorEmail,
    route: row.route,
    access: row.access,
    command: row.command,
    tenantSlug: row.tenantSlug,
    workerRole: row.workerRole,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    request: row.request,
    createdAt: row.createdAt.toISOString(),
  };
}

async function existingCredentialAuditResult(
  tx: Transaction,
  tenantId: string,
  idempotencyKey: string,
  suffix: string,
  replay?: {
    command: string;
    fingerprint: CoreIdempotencyFingerprint;
  },
) {
  const [existingAudit] = await tx
    .select({
      auditEventId: auditEvents.id,
      eventId: auditEvents.eventId,
      targetId: auditEvents.targetId,
      data: auditEvents.data,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.source, controlPlaneSource),
        eq(auditEvents.idempotencyKey, `${idempotencyKey}:${suffix}`),
        eq(auditEvents.targetType, "control_plane_credential"),
      ),
    )
    .limit(1);

  if (!existingAudit?.targetId) {
    return null;
  }

  if (replay) {
    assertCoreIdempotencyReplay({
      command: replay.command,
      fingerprint: replay.fingerprint,
      storedData: existingAudit.data,
    });
  }

  const [credential] = await tx
    .select()
    .from(controlPlaneCredentials)
    .where(eq(controlPlaneCredentials.id, existingAudit.targetId))
    .limit(1);

  if (!credential) {
    return null;
  }

  return {
    eventId: existingAudit.eventId,
    auditEventId: existingAudit.auditEventId,
    credential,
  };
}

async function upsertSessionReviewView(
  tx: Transaction,
  input: {
    tenantId: string;
    contract: JsonObject;
    actions: JsonObject;
    data: JsonObject;
    now: Date;
  },
) {
  const key = "control_plane.session_review";
  const version = "1.0.0";
  const [existing] = await tx
    .select({ id: uiContracts.id })
    .from(uiContracts)
    .where(
      and(
        eq(uiContracts.tenantId, input.tenantId),
        eq(uiContracts.key, key),
        eq(uiContracts.version, version),
      ),
    )
    .limit(1);

  if (existing) {
    const [view] = await tx
      .update(uiContracts)
      .set({
        name: "Control-plane session review",
        purpose: "Review operator control-plane credential use and denied attempts.",
        surface: "web",
        objectType: "control_plane_session",
        contract: input.contract,
        actions: input.actions,
        data: input.data,
        mask: {
          rawTokens: "never",
          request: "fingerprints_only",
        },
        active: true,
        updatedAt: input.now,
      })
      .where(eq(uiContracts.id, existing.id))
      .returning();

    return view;
  }

  const [view] = await tx
    .insert(uiContracts)
    .values({
      tenantId: input.tenantId,
      key,
      version,
      name: "Control-plane session review",
      purpose: "Review operator control-plane credential use and denied attempts.",
      surface: "web",
      objectType: "control_plane_session",
      contract: input.contract,
      actions: input.actions,
      data: input.data,
      mask: {
        rawTokens: "never",
        request: "fingerprints_only",
      },
      active: true,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();

  return view;
}

export async function authorizeManagedControlPlaneCredential(
  input: ManagedControlPlaneCredentialInput,
): Promise<ManagedControlPlaneCredentialResult> {
  if (!input.auth.ok) {
    return { ok: true };
  }

  const db = input.db ?? defaultDb;
  const tenantSlug = cleanString(input.tenantSlug);
  const requireManagedCredential = input.requireManagedCredential === true;

  if (!tenantSlug) {
    if (requireManagedCredential) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_tenant_required",
        message: "tenantSlug is required for managed control-plane credential checks.",
      };
    }

    return { ok: true };
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);

  if (!tenant) {
    if (requireManagedCredential) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_tenant_forbidden",
        message: "Managed control-plane credential checks require a known tenant.",
      };
    }

    return { ok: true };
  }

  const [credential] = await db
    .select()
    .from(controlPlaneCredentials)
    .where(
      and(
        eq(controlPlaneCredentials.tenantId, tenant.id),
        eq(controlPlaneCredentials.credentialId, input.auth.credentialId),
      ),
    )
    .limit(1);

  if (!credential) {
    if (requireManagedCredential) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_credential_required",
        message: "Managed control-plane credential inventory is required for this control-plane route.",
      };
    }

    return { ok: true };
  }

  const requestFingerprint = controlPlaneRequestTokenFingerprint(input.request);

  if (requireManagedCredential && !credential.tokenFingerprint) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_credential_fingerprint_required",
      message: "Managed control-plane credential inventory requires a token fingerprint.",
    };
  }

  if (credential.tokenFingerprint && credential.tokenFingerprint !== requestFingerprint) {
    const [rotationBridge] = requestFingerprint
      ? await db
          .select({ id: controlPlaneTokenRotationAttestations.id })
          .from(controlPlaneTokenRotationAttestations)
          .where(
            and(
              eq(controlPlaneTokenRotationAttestations.tenantId, tenant.id),
              eq(controlPlaneTokenRotationAttestations.credentialId, input.auth.credentialId),
              eq(
                controlPlaneTokenRotationAttestations.previousTokenFingerprint,
                credential.tokenFingerprint,
              ),
              eq(controlPlaneTokenRotationAttestations.nextTokenFingerprint, requestFingerprint),
              eq(controlPlaneTokenRotationAttestations.state, "attested"),
            ),
          )
          .orderBy(desc(controlPlaneTokenRotationAttestations.attestedAt))
          .limit(1)
      : [];

    if (!rotationBridge) {
      return {
        ok: false,
        status: 401,
        code: "control_plane_credential_fingerprint_mismatch",
        message: "Control-plane credential fingerprint does not match managed credential inventory.",
      };
    }
  }

  if (credential.state === "revoked" || credential.revokedAt) {
    return {
      ok: false,
      status: 401,
      code: "control_plane_credential_revoked",
      message: "Control-plane credential has been revoked.",
    };
  }

  if (credential.state === "paused") {
    return {
      ok: false,
      status: 403,
      code: "control_plane_credential_paused",
      message: "Control-plane credential is paused.",
    };
  }

  if (credential.state === "expired" || (credential.expiresAt && Date.now() > credential.expiresAt.getTime())) {
    return {
      ok: false,
      status: 401,
      code: "control_plane_credential_expired",
      message: "Control-plane credential has expired.",
    };
  }

  if (!scopedListAllows(listItems(credential.scope, "tenantSlugs"), tenantSlug)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_tenant_forbidden",
      message: "This managed control-plane credential is not allowed to access the requested tenant.",
    };
  }

  if (
    cleanString(input.workerRole) &&
    !scopedListAllows(listItems(credential.scope, "workerRoles"), input.workerRole)
  ) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_worker_role_forbidden",
      message: "This managed control-plane credential is not allowed to access the requested worker role.",
    };
  }

  if (!patternListAllows(listItems(credential.routes), input.route)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_route_forbidden",
      message: "This managed control-plane credential is not allowed to access the requested route.",
    };
  }

  if (!patternListAllows(listItems(credential.access), input.access)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_access_forbidden",
      message: "This managed control-plane credential is not allowed to perform the requested access.",
    };
  }

  const command = cleanString(input.command);

  if (!commandListAllows(listItems(credential.commands), input.route, command)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_command_forbidden",
      message: "This managed control-plane credential is not allowed to execute the requested command.",
    };
  }

  return {
    ok: true,
    managedCredentialId: credential.id,
  };
}

export async function upsertControlPlaneCredential(input: ControlPlaneCredentialUpsertInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const credentialId = requiredStringMax(input.credentialId, "config.credentialId", 140);
  const displayName = cleanString(input.displayName) ?? credentialId;
  const credentialOperatorEmail = (
    cleanString(input.credentialOperatorEmail) ?? operator.email
  ).toLowerCase();
  const state = parseCredentialState(input.state);
  const tokenFingerprint = normalizeTokenFingerprint(
    input.tokenFingerprint,
    "config.tokenFingerprint",
  );
  const scope = credentialScopeObject({
    allowedTenants: input.allowedTenants,
    allowedWorkerRoles: input.allowedWorkerRoles,
  });
  const routes = listObject(input.allowedRoutes);
  const access = listObject(input.allowedAccess);
  const commands = commandListObject(input.allowedCommands);
  const expiresAt = optionalDate(input.expiresAt, "config.expiresAt");
  const evidence = jsonObject(input.evidence);
  const idempotency = coreIdempotencyFingerprint("control_plane.credential.upsert", {
    credentialId,
    displayName,
    credentialOperatorEmail,
    state,
    tokenFingerprint,
    scope,
    routes,
    access,
    commands,
    expiresAt: expiresAt?.toISOString() ?? null,
    evidence,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${controlPlaneSource}:${input.idempotencyKey}:credential`}))`,
    );

    const existingReplay = await existingCredentialAuditResult(
      tx,
      operator.tenantId,
      input.idempotencyKey,
      "credential_upserted",
      {
        command: "control_plane.credential.upsert",
        fingerprint: idempotency,
      },
    );

    if (existingReplay) {
      return {
        created: false,
        updated: false,
        controlPlaneCredentialId: existingReplay.credential.id,
        credentialId: existingReplay.credential.credentialId,
        eventId: existingReplay.eventId,
        auditEventId: existingReplay.auditEventId,
        credential: credentialView(existingReplay.credential),
      };
    }

    const [existingCredential] = await tx
      .select()
      .from(controlPlaneCredentials)
      .where(
        and(
          eq(controlPlaneCredentials.tenantId, operator.tenantId),
          eq(controlPlaneCredentials.credentialId, credentialId),
        ),
      )
      .limit(1);
    const credentialAnchors = await resolveAuthAnchors({
      db: tx,
      tenantSlug: operator.tenantSlug,
      operatorEmail: credentialOperatorEmail,
    });
    const now = new Date();
    const [credential] = existingCredential
      ? await tx
          .update(controlPlaneCredentials)
          .set({
            userId: credentialAnchors.userId,
            displayName,
            operatorEmail: credentialOperatorEmail,
            state,
            tokenFingerprint,
            scope,
            routes,
            access,
            commands,
            evidence,
            expiresAt,
            revokedAt: state === "revoked" ? (existingCredential.revokedAt ?? now) : null,
            updatedAt: now,
          })
          .where(eq(controlPlaneCredentials.id, existingCredential.id))
          .returning()
      : await tx
          .insert(controlPlaneCredentials)
          .values({
            tenantId: operator.tenantId,
            userId: credentialAnchors.userId,
            credentialId,
            displayName,
            operatorEmail: credentialOperatorEmail,
            state,
            tokenFingerprint,
            scope,
            routes,
            access,
            commands,
            evidence,
            expiresAt,
            revokedAt: state === "revoked" ? now : null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const eventType = existingCredential
      ? "control_plane.credential.updated"
      : "control_plane.credential.created";
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        idempotencyKey: `${input.idempotencyKey}:credential_upserted`,
        data: {
          controlPlaneCredentialId: credential.id,
          credentialId,
          state,
          scope,
          routes,
          access,
          commands,
          hasTokenFingerprint: Boolean(tokenFingerprint),
          idempotency,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "control_plane_credential",
        targetId: credential.id,
        eventId: event.id,
        risk: state === "active" ? "medium" : "high",
        idempotencyKey: `${input.idempotencyKey}:credential_upserted`,
        data: {
          controlPlaneCredentialId: credential.id,
          credentialId,
          state,
          evidence,
          idempotency,
          rawTokenStored: false,
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingCredential,
      updated: Boolean(existingCredential),
      controlPlaneCredentialId: credential.id,
      credentialId,
      eventId: event.id,
      auditEventId: audit.id,
      credential: credentialView(credential),
    };
  });
}

export async function revokeControlPlaneCredential(input: ControlPlaneCredentialRevokeInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const credentialId = requiredStringMax(input.credentialId, "config.credentialId", 140);
  const reason = cleanString(input.reason) ?? "Control-plane credential revoked.";
  const evidence = jsonObject(input.evidence);
  const idempotency = coreIdempotencyFingerprint("control_plane.credential.revoke", {
    credentialId,
    reason,
    evidence,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${controlPlaneSource}:${input.idempotencyKey}:credential_revoke`}))`,
    );

    const existingReplay = await existingCredentialAuditResult(
      tx,
      operator.tenantId,
      input.idempotencyKey,
      "credential_revoked",
      {
        command: "control_plane.credential.revoke",
        fingerprint: idempotency,
      },
    );

    if (existingReplay) {
      return {
        revoked: false,
        controlPlaneCredentialId: existingReplay.credential.id,
        credentialId: existingReplay.credential.credentialId,
        eventId: existingReplay.eventId,
        auditEventId: existingReplay.auditEventId,
        credential: credentialView(existingReplay.credential),
      };
    }

    const [existingCredential] = await tx
      .select()
      .from(controlPlaneCredentials)
      .where(
        and(
          eq(controlPlaneCredentials.tenantId, operator.tenantId),
          eq(controlPlaneCredentials.credentialId, credentialId),
        ),
      )
      .limit(1);

    if (!existingCredential) {
      throw new PlatformUnavailableError(
        "control_plane_credential_not_found",
        "config.credentialId does not match a managed control-plane credential.",
        404,
      );
    }

    const now = new Date();
    const alreadyRevoked = existingCredential.state === "revoked" || Boolean(existingCredential.revokedAt);
    const [credential] = await tx
      .update(controlPlaneCredentials)
      .set({
        state: "revoked",
        evidence: {
          ...existingCredential.evidence,
          revocation: {
            reason,
            evidence,
            revokedBy: operator.actorRef,
            revokedAt: now.toISOString(),
          },
        },
        revokedAt: existingCredential.revokedAt ?? now,
        updatedAt: now,
      })
      .where(eq(controlPlaneCredentials.id, existingCredential.id))
      .returning();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.credential.revoked",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        idempotencyKey: `${input.idempotencyKey}:credential_revoked`,
        data: {
          controlPlaneCredentialId: credential.id,
          credentialId,
          reason,
          alreadyRevoked,
          idempotency,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.credential.revoked",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "control_plane_credential",
        targetId: credential.id,
        eventId: event.id,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:credential_revoked`,
        data: {
          controlPlaneCredentialId: credential.id,
          credentialId,
          reason,
          evidence,
          alreadyRevoked,
          idempotency,
        },
      })
      .returning({ id: auditEvents.id });

    return {
      revoked: !alreadyRevoked,
      controlPlaneCredentialId: credential.id,
      credentialId,
      eventId: event.id,
      auditEventId: audit.id,
      credential: credentialView(credential),
    };
  });
}

export async function reviewControlPlaneSessions(input: ControlPlaneSessionReviewInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const credentialId = cleanString(input.credentialId);
  const outcome = cleanString(input.outcome);
  const limit = parseSessionReviewLimit(input.limit);
  const requestedSince = optionalDate(input.since, "config.since");
  const since = requestedSince ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const idempotency = coreIdempotencyFingerprint("control_plane.session.review", {
    credentialId: credentialId ?? null,
    outcome: outcome ?? null,
    since: requestedSince?.toISOString() ?? null,
    limit,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${controlPlaneSource}:${input.idempotencyKey}:session_review`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        eventId: auditEvents.eventId,
        targetId: auditEvents.targetId,
        data: auditEvents.data,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, controlPlaneSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:session_reviewed`),
          eq(auditEvents.targetType, "control_plane_session_review"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "control_plane.session.review",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [view] = await tx
        .select()
        .from(uiContracts)
        .where(eq(uiContracts.id, existingAudit.targetId))
        .limit(1);

      if (view) {
        return {
          reviewed: false,
          reviewViewId: view.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          filters: jsonObject(view.data.filters),
          counts: jsonObject(view.data.counts),
          sessions: Array.isArray(view.data.sessions) ? view.data.sessions : [],
        };
      }
    }

    const conditions = [
      eq(controlPlaneAuthSessions.tenantId, operator.tenantId),
      gte(controlPlaneAuthSessions.createdAt, since),
    ];

    if (credentialId) {
      conditions.push(eq(controlPlaneAuthSessions.credentialId, credentialId));
    }

    if (outcome) {
      conditions.push(eq(controlPlaneAuthSessions.outcome, outcome));
    }

    const rows = await tx
      .select()
      .from(controlPlaneAuthSessions)
      .where(and(...conditions))
      .orderBy(desc(controlPlaneAuthSessions.createdAt))
      .limit(limit);
    const sessions = rows.map(sessionView);
    const counts: JsonObject = {
      total: rows.length,
      allowed: rows.filter((row) => row.outcome === "allowed").length,
      denied: rows.filter((row) => row.outcome === "denied").length,
    };
    const filters: JsonObject = {
      credentialId: credentialId ?? null,
      outcome: outcome ?? null,
      since: since.toISOString(),
      limit,
    };
    const now = new Date();
    const view = await upsertSessionReviewView(tx, {
      tenantId: operator.tenantId,
      now,
      contract: {
        kind: "control_plane_session_review",
        columns: ["createdAt", "credentialId", "route", "access", "command", "outcome", "reasonCode"],
      },
      actions: {
        revokeCredential: {
          command: "control_plane.credential.revoke",
          requiresApproval: true,
        },
      },
      data: {
        filters,
        counts,
        sessions,
      },
    });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.session_reviewed",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        idempotencyKey: `${input.idempotencyKey}:session_reviewed`,
        data: {
          reviewViewId: view.id,
          filters,
          counts,
          authSessionIds: sessions.map((session) => session.id),
          idempotency,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "control_plane.session_reviewed",
        source: controlPlaneSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "control_plane_session_review",
        targetId: view.id,
        eventId: event.id,
        risk: counts.denied ? "high" : "medium",
        idempotencyKey: `${input.idempotencyKey}:session_reviewed`,
        data: {
          reviewViewId: view.id,
          filters,
          counts,
          idempotency,
        },
      })
      .returning({ id: auditEvents.id });

    return {
      reviewed: true,
      reviewViewId: view.id,
      eventId: event.id,
      auditEventId: audit.id,
      filters,
      counts,
      sessions,
    };
  });
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
  replay?: {
    command: string;
    fingerprint: CoreIdempotencyFingerprint;
  },
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

  if (replay) {
    const [audit] = await tx
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(eq(auditEvents.id, existing.auditEventId ?? ""))
      .limit(1);

    assertCoreIdempotencyReplay({
      command: replay.command,
      fingerprint: replay.fingerprint,
      storedData: audit?.data,
    });
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
  const requestedRotatedAt = optionalDate(input.rotatedAt, "config.rotatedAt");
  const rotatedAt = requestedRotatedAt ?? new Date();
  const authSessionId = optionalUuid(input.authSessionId, "config.authSessionId");
  const reason = cleanString(input.reason) ?? "Operator attested control-plane token rotation.";
  const evidence = jsonObject(input.evidence);
  const idempotency = coreIdempotencyFingerprint("control_plane.token_rotation.attest", {
    credentialId,
    previousCredentialId,
    previousTokenFingerprint,
    nextTokenFingerprint,
    rotatedAt: requestedRotatedAt?.toISOString() ?? null,
    authSessionId,
    reason,
    evidence,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${controlPlaneSource}:${input.idempotencyKey}`}))`,
    );

    const existing = await existingRotationResult(tx, operator.tenantId, input.idempotencyKey, {
      command: "control_plane.token_rotation.attest",
      fingerprint: idempotency,
    });

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
      idempotency,
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
