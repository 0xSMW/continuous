import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

export type RunAuthInput = {
  enabled: boolean;
  appEnv: string;
  expectedToken?: string;
  operatorEmail?: string | null;
  authorization?: string | null;
};

export type RunAuthResult =
  | { ok: true; operatorEmail: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ControlPlaneScope = {
  tenantSlugs: string[];
  workerRoles: string[];
};

export type ControlPlaneRoute = "core" | "worker" | "workflow" | "approval";
export type ControlPlaneAccess = "read" | "write";

type ControlPlaneTokenDefinition = {
  id?: unknown;
  name?: unknown;
  token?: unknown;
  tokenSha256?: unknown;
  operatorEmail?: unknown;
  tenants?: unknown;
  tenantSlugs?: unknown;
  allowedTenants?: unknown;
  workerRoles?: unknown;
  allowedWorkerRoles?: unknown;
  routes?: unknown;
  allowedRoutes?: unknown;
  access?: unknown;
  allowedAccess?: unknown;
  commands?: unknown;
  allowedCommands?: unknown;
  expiresAt?: unknown;
};

type ControlPlaneCredential = {
  id: string;
  token?: string;
  tokenSha256?: string;
  operatorEmail: string;
  scope: ControlPlaneScope;
  routes: string[];
  access: string[];
  commands: string[];
  expiresAt?: string;
};

export type ControlPlaneScopeResult =
  | { ok: true }
  | { ok: false; status: 403; code: string; message: string };

export type ControlPlaneAccessResult =
  | {
      ok: true;
      operatorEmail: string;
      credentialId: string;
      scope: ControlPlaneScope;
    }
  | { ok: false; status: 401 | 403; code: string; message: string };

function scopeList(value?: string | null) {
  return Array.from(
    new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function allows(list: string[], value: string) {
  return list.includes("*") || list.includes(value);
}

function optionalScopeValue(value?: string | null) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceList(value: unknown) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean),
      ),
    );
  }

  return scopeList(stringValue(value));
}

function valueOrDefault(value: unknown, fallback: string[]) {
  const list = coerceList(value);
  return list.length > 0 ? list : fallback;
}

function suppliedToken(input: { authorization?: string | null }) {
  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? "";
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function allowsPattern(patterns: string[], value: string) {
  return patterns.some((pattern) => {
    if (pattern === "*" || pattern === value) {
      return true;
    }

    if (pattern.endsWith(":*")) {
      return value.startsWith(pattern.slice(0, -1));
    }

    return false;
  });
}

function allowsCommand(credential: ControlPlaneCredential, route: ControlPlaneRoute, command: string) {
  const commandKey = `${route}:${command}`;

  if (credential.commands.includes(commandKey)) {
    return true;
  }

  return (
    credential.id === "legacy-worker-run-token" &&
    route === "worker" &&
    credential.commands.includes("worker:*")
  );
}

function parseTokenCatalog(input: {
  tokenCatalogJson?: string | null;
  tokenCatalogB64?: string | null;
}) {
  const catalogJson =
    stringValue(input.tokenCatalogJson) ??
    (stringValue(input.tokenCatalogB64)
      ? Buffer.from(stringValue(input.tokenCatalogB64)!, "base64").toString("utf8")
      : undefined);

  if (!catalogJson) {
    return [];
  }

  const parsed = JSON.parse(catalogJson) as unknown;
  const definitions =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { tokens?: unknown }).tokens)
        ? (parsed as { tokens: unknown[] }).tokens
        : null;

  if (!definitions) {
    throw new Error("Control-plane token catalog must be a JSON array or an object with a tokens array.");
  }

  return definitions as ControlPlaneTokenDefinition[];
}

function normalizeTokenCatalog(input: {
  tokenCatalogJson?: string | null;
  tokenCatalogB64?: string | null;
  allowedTenants?: string | null;
  allowedWorkerRoles?: string | null;
}) {
  const fallbackScope = controlPlaneScopeFromEnv({
    allowedTenants: input.allowedTenants,
    allowedWorkerRoles: input.allowedWorkerRoles,
  });

  return parseTokenCatalog(input).map((definition, index): ControlPlaneCredential => {
    const token = stringValue(definition.token);
    const tokenSha256 = stringValue(definition.tokenSha256);
    const operatorEmail = stringValue(definition.operatorEmail);

    if (!token && !tokenSha256) {
      throw new Error(`Control-plane token catalog entry ${index + 1} is missing token or tokenSha256.`);
    }

    if (!operatorEmail) {
      throw new Error(`Control-plane token catalog entry ${index + 1} is missing operatorEmail.`);
    }

    const tenantSlugs = valueOrDefault(
      definition.allowedTenants ?? definition.tenantSlugs ?? definition.tenants,
      fallbackScope.tenantSlugs,
    );
    const workerRoles = valueOrDefault(
      definition.allowedWorkerRoles ?? definition.workerRoles,
      fallbackScope.workerRoles,
    );
    const routes = coerceList(definition.allowedRoutes ?? definition.routes);
    const access = coerceList(definition.allowedAccess ?? definition.access);
    const commands = coerceList(definition.allowedCommands ?? definition.commands);
    const id =
      stringValue(definition.id) ??
      stringValue(definition.name) ??
      `control-plane-token-${index + 1}`;

    return {
      id,
      token,
      tokenSha256,
      operatorEmail,
      scope: {
        tenantSlugs,
        workerRoles,
      },
      routes,
      access,
      commands,
      expiresAt: stringValue(definition.expiresAt),
    };
  });
}

function legacyCredential(input: {
  expectedToken: string;
  operatorEmail: string;
  allowedTenants?: string | null;
  allowedWorkerRoles?: string | null;
}): ControlPlaneCredential {
  return {
    id: "legacy-worker-run-token",
    token: input.expectedToken,
    operatorEmail: input.operatorEmail,
    scope: controlPlaneScopeFromEnv({
      allowedTenants: input.allowedTenants,
      allowedWorkerRoles: input.allowedWorkerRoles,
    }),
    routes: ["worker"],
    access: ["read", "write"],
    commands: ["worker:*"],
  };
}

function credentialMatches(credential: ControlPlaneCredential, token: string) {
  if (credential.token && safeEqual(credential.token, token)) {
    return true;
  }

  if (credential.tokenSha256 && safeEqual(credential.tokenSha256, hashToken(token))) {
    return true;
  }

  return false;
}

function tokenExpired(expiresAt?: string) {
  if (!expiresAt) {
    return false;
  }

  const expiry = Date.parse(expiresAt);

  return !Number.isFinite(expiry) || Date.now() > expiry;
}

export function controlPlaneScopeFromEnv(input: {
  allowedTenants?: string | null;
  allowedWorkerRoles?: string | null;
}): ControlPlaneScope {
  return {
    tenantSlugs: scopeList(input.allowedTenants),
    workerRoles: scopeList(input.allowedWorkerRoles),
  };
}

export function authorizeControlPlaneScope(input: {
  scope: ControlPlaneScope;
  tenantSlug?: string | null;
  workerRole?: string | null;
  requireTenant?: boolean;
  requireWorkerRole?: boolean;
}): ControlPlaneScopeResult {
  const tenantSlug = optionalScopeValue(input.tenantSlug);
  const workerRole = optionalScopeValue(input.workerRole);

  if (!tenantSlug && input.requireTenant) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_tenant_required",
      message: "tenantSlug is required for scoped control-plane access.",
    };
  }

  if (input.scope.tenantSlugs.length > 0) {
    if (tenantSlug && !allows(input.scope.tenantSlugs, tenantSlug)) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_tenant_forbidden",
        message: "This operator token is not allowed to access the requested tenant.",
      };
    }
  }

  if (!workerRole && input.requireWorkerRole) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_worker_role_required",
      message: "worker.role is required for scoped worker access.",
    };
  }

  if (input.scope.workerRoles.length > 0) {
    if (workerRole && !allows(input.scope.workerRoles, workerRole)) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_worker_role_forbidden",
        message: "This operator token is not allowed to access the requested worker role.",
      };
    }
  }

  return { ok: true };
}

export function authorizeControlPlaneAccess(input: {
  enabled?: boolean;
  appEnv: string;
  expectedToken?: string;
  operatorEmail?: string | null;
  authorization?: string | null;
  allowedTenants?: string | null;
  allowedWorkerRoles?: string | null;
  tokenCatalogJson?: string | null;
  tokenCatalogB64?: string | null;
  route: ControlPlaneRoute;
  access: ControlPlaneAccess;
  command?: string | null;
}): ControlPlaneAccessResult {
  if (input.access === "write" && input.enabled === false) {
    return {
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Worker runs are disabled.",
    };
  }

  const hasCatalog =
    Boolean(optionalScopeValue(input.tokenCatalogJson)) ||
    Boolean(optionalScopeValue(input.tokenCatalogB64));

  if (input.appEnv === "production" && !hasCatalog) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_required",
      message: "Production control-plane access requires a route-scoped token catalog.",
    };
  }

  if (!hasCatalog && !input.expectedToken) {
    return {
      ok: false,
      status: 403,
      code: input.access === "write" ? "worker_run_token_missing" : "worker_read_token_missing",
      message:
        input.access === "write"
          ? "Enabled worker runs require WORKER_RUN_TOKEN."
          : "Worker reads require WORKER_RUN_TOKEN.",
    };
  }

  const token = suppliedToken(input);

  if (!token) {
    return {
      ok: false,
      status: 401,
      code: hasCatalog
        ? "control_plane_unauthorized"
        : input.access === "write"
          ? "worker_run_unauthorized"
          : "worker_read_unauthorized",
      message: hasCatalog
        ? "Control-plane token is invalid."
        : input.access === "write"
          ? "Worker run token is invalid."
          : "Worker read token is invalid.",
    };
  }

  let credentials: ControlPlaneCredential[];

  try {
    if (hasCatalog) {
      credentials = normalizeTokenCatalog(input);
    } else {
      const legacyOperatorEmail = stringValue(input.operatorEmail);

      if (!legacyOperatorEmail) {
        return {
          ok: false,
          status: 403,
          code: "control_plane_operator_missing",
          message: "Legacy WORKER_RUN_TOKEN access requires WORKER_OPERATOR_EMAIL.",
        };
      }

      credentials = [
        legacyCredential({
          expectedToken: input.expectedToken!,
          operatorEmail: legacyOperatorEmail,
          allowedTenants: input.allowedTenants,
          allowedWorkerRoles: input.allowedWorkerRoles,
        }),
      ];
    }
  } catch (error) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_invalid",
      message: error instanceof Error ? error.message : "Control-plane token catalog is invalid.",
    };
  }

  const credential = credentials.find((item) => credentialMatches(item, token));

  if (!credential) {
    return {
      ok: false,
      status: 401,
      code: hasCatalog
        ? "control_plane_unauthorized"
        : input.access === "write"
          ? "worker_run_unauthorized"
          : "worker_read_unauthorized",
      message: hasCatalog
        ? "Control-plane token is invalid."
        : input.access === "write"
          ? "Worker run token is invalid."
          : "Worker read token is invalid.",
    };
  }

  if (tokenExpired(credential.expiresAt)) {
    return {
      ok: false,
      status: 401,
      code: "control_plane_token_expired",
      message: "Control-plane token has expired.",
    };
  }

  if (!allowsPattern(credential.routes, input.route)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_route_forbidden",
      message: "This operator token is not allowed to access the requested control-plane route.",
    };
  }

  if (!allowsPattern(credential.access, input.access)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_access_forbidden",
      message: "This operator token is not allowed to perform the requested control-plane access.",
    };
  }

  const command = optionalScopeValue(input.command);

  if ("command" in input && !command && credential.commands.length > 0) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_command_forbidden",
      message: "This operator token is not allowed to execute the requested control-plane command.",
    };
  }

  if (command && !allowsCommand(credential, input.route, command)) {
    return {
      ok: false,
      status: 403,
      code: "control_plane_command_forbidden",
      message: "This operator token is not allowed to execute the requested control-plane command.",
    };
  }

  return {
    ok: true,
    operatorEmail: credential.operatorEmail,
    credentialId: credential.id,
    scope: credential.scope,
  };
}

export function authorizeWorkerRun(input: RunAuthInput): RunAuthResult {
  if (!input.enabled) {
    return {
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Worker runs are disabled.",
    };
  }

  if (!input.expectedToken) {
    return {
      ok: false,
      status: 403,
      code: "worker_run_token_missing",
      message: "Enabled worker runs require WORKER_RUN_TOKEN.",
    };
  }

  const supplied = suppliedToken(input);

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_run_unauthorized",
      message: "Worker run token is invalid.",
    };
  }

  const operatorEmail = stringValue(input.operatorEmail);

  if (!operatorEmail) {
    return {
      ok: false,
      status: 403,
      code: "worker_operator_missing",
      message: "Worker runs require WORKER_OPERATOR_EMAIL.",
    };
  }

  return { ok: true, operatorEmail };
}

export function authorizeWorkerRead(input: Omit<RunAuthInput, "enabled">): RunAuthResult {
  if (!input.expectedToken) {
    return {
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Worker reads require WORKER_RUN_TOKEN.",
    };
  }

  const supplied = suppliedToken(input);

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Worker read token is invalid.",
    };
  }

  const operatorEmail = stringValue(input.operatorEmail);

  if (!operatorEmail) {
    return {
      ok: false,
      status: 403,
      code: "worker_operator_missing",
      message: "Worker reads require WORKER_OPERATOR_EMAIL.",
    };
  }

  return { ok: true, operatorEmail };
}

export type IdempotencyResult =
  | { ok: true; key: string }
  | { ok: false; message: string };

export function normalizeIdempotencyKey(value: unknown): IdempotencyResult {
  if (typeof value !== "string") {
    return { ok: false, message: "A string idempotency key is required." };
  }

  const key = value.trim();

  if (key.length < 8 || key.length > 160) {
    return {
      ok: false,
      message: "Idempotency key must be between 8 and 160 characters.",
    };
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    return {
      ok: false,
      message: "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    };
  }

  return { ok: true, key };
}
