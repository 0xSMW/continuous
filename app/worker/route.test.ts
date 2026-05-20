import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeWorkerCommand: vi.fn(),
  executeWorkerView: vi.fn(),
  workerErrorStatus: vi.fn(),
  env: {
    APP_ENV: "test",
    WORKER_RUN_ENABLED: true,
    WORKER_RUN_TOKEN: "test-token",
    WORKER_OPERATOR_EMAIL: "operator@example.com",
    CONTROL_PLANE_ALLOWED_TENANTS: undefined as string | undefined,
    CONTROL_PLANE_ALLOWED_WORKER_ROLES: undefined as string | undefined,
    CONTROL_PLANE_TOKENS_JSON: undefined as string | undefined,
    CONTROL_PLANE_TOKEN_CATALOG_B64: undefined as string | undefined,
  },
}));

vi.mock("../../src/env", () => ({
  env: mocks.env,
}));

vi.mock("../../src/worker/registry", () => ({
  executeWorkerCommand: mocks.executeWorkerCommand,
  executeWorkerView: mocks.executeWorkerView,
  workerApiVersion: "continuous.worker.v1",
  workerErrorStatus: mocks.workerErrorStatus,
}));

describe("/worker route", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(mocks.env, {
      APP_ENV: "test",
      WORKER_RUN_ENABLED: true,
      WORKER_RUN_TOKEN: "test-token",
      WORKER_OPERATOR_EMAIL: "operator@example.com",
      CONTROL_PLANE_ALLOWED_TENANTS: undefined,
      CONTROL_PLANE_ALLOWED_WORKER_ROLES: undefined,
      CONTROL_PLANE_TOKENS_JSON: undefined,
      CONTROL_PLANE_TOKEN_CATALOG_B64: undefined,
    });
    mocks.workerErrorStatus.mockImplementation((error: unknown, fallbackCode: string) => ({
      status:
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status)
          : 500,
      code:
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : fallbackCode,
      message: error instanceof Error ? error.message : "Unknown worker error.",
    }));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("routes POST commands through the generic worker payload shape", async () => {
    const commandResult = {
      worker: {
        role: "owner_chief_of_staff",
        id: null,
        tenantSlug: "continuous-demo",
      },
      command: "brief.generate",
      result: {
        workerRunId: "run-1",
      },
    };
    mocks.executeWorkerCommand.mockResolvedValue(commandResult);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "header-key-001",
        },
        body: JSON.stringify({
          command: "brief.generate",
          worker: {
            role: "owner_chief_of_staff",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "body-key-001",
          config: {
            window: {
              from: "2026-05-19T00:00:00.000Z",
              to: "2026-05-20T00:00:00.000Z",
            },
            scopes: ["tasks"],
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      api: "continuous.worker.v1",
      data: commandResult,
      error: null,
    });
    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks"],
      },
      idempotencyKey: "body-key-001",
      operatorEmail: "operator@example.com",
    });
  });

  it("rejects POST commands outside the configured tenant scope", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.env.CONTROL_PLANE_ALLOWED_WORKER_ROLES = "revenue_operations";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          worker: {
            role: "revenue_operations",
            tenantSlug: "other-tenant",
          },
          idempotencyKey: "tenant-scope-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_tenant_forbidden",
      message: "This operator token is not allowed to access the requested tenant.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects POST commands outside the configured worker role scope", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.env.CONTROL_PLANE_ALLOWED_WORKER_ROLES = "revenue_operations";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "brief.generate",
          worker: {
            role: "owner_chief_of_staff",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "role-scope-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_worker_role_forbidden",
      message: "This operator token is not allowed to access the requested worker role.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects POST commands outside a scoped token command catalog", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = JSON.stringify([
      {
        id: "worker-runner",
        token: "test-token",
        operatorEmail: "operator@example.com",
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations", "owner_chief_of_staff"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "brief.generate",
          worker: {
            role: "owner_chief_of_staff",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "command-scope-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_command_forbidden",
      message: "This operator token is not allowed to execute the requested control-plane command.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("keeps idempotency-key as a fallback only when the payload omits idempotencyKey", async () => {
    mocks.executeWorkerCommand.mockResolvedValue({
      worker: {
        role: "revenue_operations",
        id: null,
        tenantSlug: "continuous-demo",
      },
      command: "run",
      result: {},
    });

    const { POST } = await import("./route");
    await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "header-key-001",
        },
        body: JSON.stringify({
          command: "run",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {
            intake: {
              source: "website_form",
              sourceEventId: "header-key-form-001",
            },
          },
        }),
      }),
    );

    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "header-key-001",
      }),
    );
  });

  it("rejects legacy top-level worker fields outside the command envelope", async () => {
    mocks.executeWorkerCommand.mockResolvedValue({
      worker: {
        role: "revenue_operations",
        id: null,
        tenantSlug: null,
      },
      command: "run",
      result: {},
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          leadPacket: {
            customerName: "Acme Roof Repair",
          },
          idempotencyKey: "legacy-top-level-001",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      api: "continuous.worker.v1",
      data: null,
      error: {
        code: "invalid_worker_command_envelope",
        message:
          "Worker command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: role, tenantSlug, leadPacket.",
      },
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects ad hoc top-level command fields even with a valid worker target", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "ad-hoc-top-level-001",
          approvalId: "approval-1",
          limit: 25,
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_command_envelope",
      message:
        "Worker command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: approvalId, limit.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects non-object command config before registry dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "invalid-config-001",
          config: ["leadPacket"],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_command_config",
      message: "config must be an object when provided.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("routes GET views through role-scoped worker selectors", async () => {
    const viewResult = {
      data: {
        worker: {
          role: "owner_chief_of_staff",
          id: "worker-1",
          tenantSlug: "continuous-demo",
        },
        view: "briefs",
        briefs: [],
      },
      error: null,
    };
    mocks.executeWorkerView.mockResolvedValue(viewResult);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/worker?view=briefs&role=owner_chief_of_staff&id=worker-1&tenantSlug=continuous-demo&state=review_ready",
        {
          headers: {
            authorization: "Bearer test-token",
          },
        },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      api: "continuous.worker.v1",
      data: viewResult.data,
      error: null,
    });
    expect(mocks.executeWorkerView).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      target: {
        role: "owner_chief_of_staff",
        id: "worker-1",
        tenantSlug: "continuous-demo",
      },
      view: "briefs",
      state: "review_ready",
    });
  });

  it("rejects GET views that omit tenant under scoped access", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.env.CONTROL_PLANE_ALLOWED_WORKER_ROLES = "revenue_operations";

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/worker?view=snapshot&role=revenue_operations", {
        headers: {
          authorization: "Bearer test-token",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_tenant_required",
      message: "tenantSlug is required for scoped control-plane access.",
    });
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });
});
