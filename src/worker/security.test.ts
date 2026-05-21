import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  authorizeControlPlaneAccess,
  authorizeControlPlaneScope,
  authorizeWorkerRead,
  authorizeWorkerRun,
  controlPlaneScopeFromEnv,
  normalizeIdempotencyKey,
} from "./security";

const acceptedCredential = ["accepted", "worker", "credential"].join(".");
const operatorEmail = "owner@continuoushq.com";

function tokenSha256(token = acceptedCredential) {
  return createHash("sha256").update(token).digest("hex");
}

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

  it("requires an explicit operator for matching run tokens", () => {
    expect(
      authorizeWorkerRun({
        enabled: true,
        appEnv: "production",
        expectedToken: acceptedCredential,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_operator_missing",
      message: "Worker runs require WORKER_OPERATOR_EMAIL.",
    });
  });
});

describe("normalizeIdempotencyKey", () => {
  it("accepts stable operator-provided keys", () => {
    expect(normalizeIdempotencyKey("worker:2026-05-19:001")).toEqual({
      ok: true,
      key: "worker:2026-05-19:001",
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

  it("rejects an invalid read bearer token", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: "Bearer wrong",
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

  it("requires an explicit operator for matching read tokens", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_operator_missing",
      message: "Worker reads require WORKER_OPERATOR_EMAIL.",
    });
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

  it("requires tenant and worker role even when allowlists are empty", () => {
    const scope = controlPlaneScopeFromEnv({});

    expect(
      authorizeControlPlaneScope({
        scope,
        requireTenant: true,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_required",
      message: "tenantSlug is required for scoped control-plane access.",
    });

    expect(
      authorizeControlPlaneScope({
        scope,
        tenantSlug: "continuous-demo",
        requireTenant: true,
        requireWorkerRole: true,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_worker_role_required",
      message: "worker.role is required for scoped worker access.",
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

describe("authorizeControlPlaneAccess", () => {
  it("accepts a scoped token catalog entry for an allowed route command", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "worker-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail: "fallback@example.com",
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: true,
      operatorEmail,
      credentialId: "worker-runner",
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
      routes: ["worker"],
      access: ["write"],
      commands: ["worker:run"],
    });
  });

  it("accepts a base64 catalog with a token hash", () => {
    const tokenCatalogB64 = Buffer.from(
      JSON.stringify([
        {
          id: "hashed-worker-runner",
          tokenSha256: tokenSha256(),
          operatorEmail,
          allowedTenants: ["*"],
          allowedWorkerRoles: ["*"],
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands: ["worker:lead.read"],
        },
      ]),
    ).toString("base64");

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogB64,
        route: "worker",
        access: "write",
        command: "lead.read",
      }),
    ).toEqual({
      ok: true,
      operatorEmail,
      credentialId: "hashed-worker-runner",
      scope: {
        tenantSlugs: ["*"],
        workerRoles: ["*"],
      },
      routes: ["worker"],
      access: ["write"],
      commands: ["worker:lead.read"],
    });
  });

  it("rejects raw catalog tokens in production", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "raw-worker-runner",
        token: acceptedCredential,
        operatorEmail,
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:lead.read"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "lead.read",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_invalid",
      message: "Control-plane token catalog entry 1 must use tokenSha256 in production.",
    });
  });

  it("requires exact route-qualified catalog command scopes", () => {
    for (const allowedCommands of [["run"], ["worker:*"], ["*"]]) {
      const tokenCatalogJson = JSON.stringify([
        {
          id: "weak-worker-runner",
          tokenSha256: tokenSha256(),
          operatorEmail,
          allowedTenants: ["*"],
          allowedWorkerRoles: ["*"],
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands,
        },
      ]);

      expect(
        authorizeControlPlaneAccess({
          enabled: true,
          appEnv: "production",
          operatorEmail,
          authorization: `Bearer ${acceptedCredential}`,
          tokenCatalogJson,
          route: "worker",
          access: "write",
          command: "run",
        }),
      ).toEqual({
        ok: false,
        status: 403,
        code: "control_plane_command_forbidden",
        message: "This operator token is not allowed to execute the requested control-plane command.",
      });
    }
  });

  it("rejects catalog entries that spoof the legacy bootstrap credential id", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "local-bootstrap-control-plane-token",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:*"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_invalid",
      message: "Control-plane token catalog entry 1 uses a reserved bootstrap credential id.",
    });
  });

  it("rejects catalog tokens outside their command scope", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "worker-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "adapters.retry",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_command_forbidden",
      message: "This operator token is not allowed to execute the requested control-plane command.",
    });
  });

  it("rejects blank commands for command-scoped catalog tokens", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "worker-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    for (const command of ["", " "]) {
      expect(
        authorizeControlPlaneAccess({
          enabled: true,
          appEnv: "production",
          operatorEmail,
          authorization: `Bearer ${acceptedCredential}`,
          tokenCatalogJson,
          route: "worker",
          access: "write",
          command,
        }),
      ).toEqual({
        ok: false,
        status: 403,
        code: "control_plane_command_forbidden",
        message: "This operator token is not allowed to execute the requested control-plane command.",
      });
    }
  });

  it("rejects malformed control-plane token catalogs", () => {
    const cases = [
      {
        tokenCatalogJson: "{",
      },
      {
        tokenCatalogJson: JSON.stringify({ tokens: {} }),
      },
      {
        tokenCatalogJson: JSON.stringify([{ id: "missing-token", operatorEmail }]),
      },
      {
        tokenCatalogB64: Buffer.from(
          JSON.stringify([{ id: "missing-operator", tokenSha256: tokenSha256() }]),
        ).toString("base64"),
      },
    ];

    for (const testCase of cases) {
      expect(
        authorizeControlPlaneAccess({
          enabled: true,
          appEnv: "production",
          operatorEmail,
          authorization: `Bearer ${acceptedCredential}`,
          tokenCatalogJson: testCase.tokenCatalogJson,
          tokenCatalogB64: testCase.tokenCatalogB64,
          route: "worker",
          access: "write",
          command: "run",
        }),
      ).toMatchObject({
        ok: false,
        status: 403,
        code: "control_plane_token_catalog_invalid",
      });
    }
  });

  it("does not use the legacy operator env as a catalog credential fallback", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "missing-operator",
        tokenSha256: tokenSha256(),
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail: "fallback@example.com",
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_invalid",
      message: "Control-plane token catalog entry 1 is missing operatorEmail.",
    });
  });

  it("fails closed when catalog route, access, or command scopes are omitted", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "unscoped-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_route_forbidden",
      message: "This operator token is not allowed to access the requested control-plane route.",
    });
  });

  it("rejects catalog tokens outside their route scope", () => {
    const tokenCatalogJson = JSON.stringify([
      {
        id: "worker-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "core",
        access: "write",
        command: "task.create",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_route_forbidden",
      message: "This operator token is not allowed to access the requested control-plane route.",
    });
  });

  it("rejects expired catalog credentials while accepting active rotated credentials", () => {
    const rotatedCredential = ["rotated", "worker", "credential"].join(".");
    const tokenCatalogJson = JSON.stringify([
      {
        id: "expired-worker-runner",
        tokenSha256: tokenSha256(),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
      {
        id: "active-worker-runner",
        tokenSha256: tokenSha256(rotatedCredential),
        operatorEmail,
        allowedTenants: ["*"],
        allowedWorkerRoles: ["*"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    ]);

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 401,
      code: "control_plane_token_expired",
      message: "Control-plane token has expired.",
    });

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        operatorEmail,
        authorization: `Bearer ${rotatedCredential}`,
        tokenCatalogJson,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: true,
      operatorEmail,
      credentialId: "active-worker-runner",
      scope: {
        tenantSlugs: ["*"],
        workerRoles: ["*"],
      },
      routes: ["worker"],
      access: ["write"],
      commands: ["worker:run"],
    });
  });

  it("requires explicit production tenant and worker-role scopes or wildcard", () => {
    const cases = [
      {
        definition: {
          id: "missing-tenant-scope",
          tokenSha256: tokenSha256(),
          operatorEmail,
          allowedWorkerRoles: ["revenue_operations"],
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands: ["worker:run"],
        },
        message:
          'Control-plane token catalog entry 1 is missing allowedTenants; use "*" for all tenants.',
      },
      {
        definition: {
          id: "missing-worker-role-scope",
          tokenSha256: tokenSha256(),
          operatorEmail,
          allowedTenants: ["continuous-demo"],
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands: ["worker:run"],
        },
        message:
          'Control-plane token catalog entry 1 is missing allowedWorkerRoles; use "*" for all worker roles.',
      },
    ];

    for (const testCase of cases) {
      expect(
        authorizeControlPlaneAccess({
          enabled: true,
          appEnv: "production",
          operatorEmail,
          authorization: `Bearer ${acceptedCredential}`,
          tokenCatalogJson: JSON.stringify([testCase.definition]),
          route: "worker",
          access: "write",
          command: "run",
        }),
      ).toEqual({
        ok: false,
        status: 403,
        code: "control_plane_token_catalog_invalid",
        message: testCase.message,
      });
    }
  });

  it("requires catalog-backed credentials in production", () => {
    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        allowedTenants: "continuous-demo",
        allowedWorkerRoles: "revenue_operations",
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_token_catalog_required",
      message: "Production control-plane access requires a route-scoped token catalog.",
    });
  });

  it("limits the non-production legacy bootstrap token to the worker route", () => {
    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "test",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        allowedTenants: "continuous-demo",
        allowedWorkerRoles: "revenue_operations",
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: true,
      operatorEmail,
      credentialId: "local-bootstrap-control-plane-token",
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
      routes: ["worker"],
      access: ["read", "write"],
      commands: ["worker:*"],
    });

    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "test",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
        allowedTenants: "continuous-demo",
        allowedWorkerRoles: "revenue_operations",
        route: "worker",
        access: "write",
        command: "adapters.retry",
      }),
    ).toEqual({
      ok: true,
      operatorEmail,
      credentialId: "local-bootstrap-control-plane-token",
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
      routes: ["worker"],
      access: ["read", "write"],
      commands: ["worker:*"],
    });

    for (const [route, command] of [
      ["core", "task.create"],
      ["workflow", "start"],
      ["approval", "approval.decide"],
    ] as const) {
      expect(
        authorizeControlPlaneAccess({
          enabled: true,
          appEnv: "test",
          expectedToken: acceptedCredential,
          operatorEmail,
          authorization: `Bearer ${acceptedCredential}`,
          allowedTenants: "continuous-demo",
          allowedWorkerRoles: "revenue_operations",
          route,
          access: "write",
          command,
        }),
      ).toEqual({
        ok: false,
        status: 403,
        code: "control_plane_route_forbidden",
        message: "This operator token is not allowed to access the requested control-plane route.",
      });
    }
  });

  it("requires explicit operator identity for the legacy bootstrap token", () => {
    expect(
      authorizeControlPlaneAccess({
        enabled: true,
        appEnv: "test",
        expectedToken: acceptedCredential,
        authorization: `Bearer ${acceptedCredential}`,
        route: "worker",
        access: "write",
        command: "run",
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_operator_missing",
      message: "Legacy WORKER_RUN_TOKEN access requires WORKER_OPERATOR_EMAIL.",
    });
  });
});
