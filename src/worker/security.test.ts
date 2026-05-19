import { describe, expect, it } from "vitest";

import {
  authorizeControlPlaneScope,
  authorizeWorkerRead,
  authorizeWorkerRun,
  controlPlaneScopeFromEnv,
  normalizeIdempotencyKey,
} from "./security";

const acceptedCredential = ["accepted", "worker", "credential"].join(".");
const operatorEmail = "owner@continuoushq.com";

describe("authorizeWorkerRun", () => {
  it("keeps worker runs disabled by default", () => {
    expect(
      authorizeWorkerRun({
        enabled: false,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Worker runs are disabled.",
    });
  });

  it("requires a token for enabled runs", () => {
    expect(
      authorizeWorkerRun({
        enabled: true,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_token_missing",
      message: "Enabled worker runs require WORKER_RUN_TOKEN.",
    });
  });

  it("accepts a matching bearer token", () => {
    expect(
      authorizeWorkerRun({
        enabled: true,
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({ ok: true, operatorEmail });
  });
});

describe("normalizeIdempotencyKey", () => {
  it("accepts stable operator-provided keys", () => {
    expect(normalizeIdempotencyKey("rev-worker:2026-05-19:001")).toEqual({
      ok: true,
      key: "rev-worker:2026-05-19:001",
    });
  });

  it("rejects unsafe key material", () => {
    expect(normalizeIdempotencyKey("not safe/key")).toEqual({
      ok: false,
      message: "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    });
  });
});

describe("authorizeWorkerRead", () => {
  it("requires a read token in development", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Worker reads require WORKER_RUN_TOKEN.",
    });
  });

  it("requires a read token in production", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Worker reads require WORKER_RUN_TOKEN.",
    });
  });

  it("rejects an invalid read token", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        headerToken: "wrong",
      }),
    ).toEqual({
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Worker read token is invalid.",
    });
  });

  it("accepts a matching read bearer token", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({ ok: true, operatorEmail });
  });
});

describe("control-plane scope", () => {
  it("parses comma-delimited tenant and worker role allowlists", () => {
    expect(
      controlPlaneScopeFromEnv({
        allowedTenants: "continuous-demo, second-tenant, continuous-demo",
        allowedWorkerRoles: "revenue_operations, owner_chief_of_staff",
      }),
    ).toEqual({
      tenantSlugs: ["continuous-demo", "second-tenant"],
      workerRoles: ["revenue_operations", "owner_chief_of_staff"],
    });
  });

  it("requires tenant and worker role when scoped access is configured", () => {
    const scope = controlPlaneScopeFromEnv({
      allowedTenants: "continuous-demo",
      allowedWorkerRoles: "revenue_operations",
    });

    expect(
      authorizeControlPlaneScope({
        scope,
        requireTenant: true,
        requireWorkerRole: true,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_required",
      message: "tenantSlug is required for scoped control-plane access.",
    });
  });

  it("rejects out-of-scope tenants and worker roles", () => {
    const scope = controlPlaneScopeFromEnv({
      allowedTenants: "continuous-demo",
      allowedWorkerRoles: "revenue_operations",
    });

    expect(
      authorizeControlPlaneScope({
        scope,
        tenantSlug: "other-tenant",
        workerRole: "revenue_operations",
        requireTenant: true,
        requireWorkerRole: true,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_forbidden",
      message: "This operator token is not allowed to access the requested tenant.",
    });

    expect(
      authorizeControlPlaneScope({
        scope,
        tenantSlug: "continuous-demo",
        workerRole: "finance_operations",
        requireTenant: true,
        requireWorkerRole: true,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_worker_role_forbidden",
      message: "This operator token is not allowed to access the requested worker role.",
    });
  });

  it("allows explicitly scoped tenants and roles", () => {
    const scope = controlPlaneScopeFromEnv({
      allowedTenants: "continuous-demo",
      allowedWorkerRoles: "revenue_operations",
    });

    expect(
      authorizeControlPlaneScope({
        scope,
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireTenant: true,
        requireWorkerRole: true,
      }),
    ).toEqual({ ok: true });
  });
});
