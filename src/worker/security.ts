export type RunAuthInput = {
  enabled: boolean;
  appEnv: string;
  expectedToken?: string;
  operatorEmail: string;
  authorization?: string | null;
  headerToken?: string | null;
};

export type RunAuthResult =
  | { ok: true; operatorEmail: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ControlPlaneScope = {
  tenantSlugs: string[];
  workerRoles: string[];
};

export type ControlPlaneScopeResult =
  | { ok: true }
  | { ok: false; status: 403; code: string; message: string };

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

  if (input.scope.tenantSlugs.length > 0) {
    if (!tenantSlug && input.requireTenant) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_tenant_required",
        message: "tenantSlug is required for scoped control-plane access.",
      };
    }

    if (tenantSlug && !allows(input.scope.tenantSlugs, tenantSlug)) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_tenant_forbidden",
        message: "This operator token is not allowed to access the requested tenant.",
      };
    }
  }

  if (input.scope.workerRoles.length > 0) {
    if (!workerRole && input.requireWorkerRole) {
      return {
        ok: false,
        status: 403,
        code: "control_plane_worker_role_required",
        message: "worker.role is required for scoped worker access.",
      };
    }

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

  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? input.headerToken ?? "";

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_run_unauthorized",
      message: "Worker run token is invalid.",
    };
  }

  return { ok: true, operatorEmail: input.operatorEmail };
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

  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? input.headerToken ?? "";

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Worker read token is invalid.",
    };
  }

  return { ok: true, operatorEmail: input.operatorEmail };
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
