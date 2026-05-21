import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeManagedControlPlaneCredential: vi.fn(),
  executeAppServerCoreDynamicToolCall: vi.fn(),
  executeAppServerWorkerDynamicToolCall: vi.fn(),
  recordControlPlaneAuthAttempt: vi.fn(),
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

vi.mock("../../src/worker/app-server-tools", () => ({
  executeAppServerWorkerDynamicToolCall: mocks.executeAppServerWorkerDynamicToolCall,
}));

vi.mock("../../src/core/app-server-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/app-server-tools")>();

  return {
    ...actual,
    executeAppServerCoreDynamicToolCall: mocks.executeAppServerCoreDynamicToolCall,
  };
});

vi.mock("../../src/core/control-plane-auth", () => ({
  authorizeManagedControlPlaneCredential: mocks.authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt: mocks.recordControlPlaneAuthAttempt,
}));

function tokenCatalog(allowedCommands: string[], extras: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      id: "app-server-operator",
      token: "test-token",
      operatorEmail: "operator@example.com",
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations", "dispatch_operations"],
      allowedRoutes: ["app_server"],
      allowedAccess: ["read", "write"],
      allowedCommands,
      ...extras,
    },
  ]);
}

describe("/app-server route", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(mocks.env, {
      APP_ENV: "test",
      WORKER_RUN_ENABLED: true,
      WORKER_RUN_TOKEN: "test-token",
      WORKER_OPERATOR_EMAIL: "operator@example.com",
      CONTROL_PLANE_ALLOWED_TENANTS: undefined,
      CONTROL_PLANE_ALLOWED_WORKER_ROLES: undefined,
      CONTROL_PLANE_TOKENS_JSON: tokenCatalog([
        "app_server:worker.schema",
        "app_server:worker.view.snapshot",
        "app_server:worker.command.lead.read",
      ]),
      CONTROL_PLANE_TOKEN_CATALOG_B64: undefined,
    });
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({ ok: true });
    mocks.recordControlPlaneAuthAttempt.mockResolvedValue({ id: "auth-session-1" });
    mocks.executeAppServerWorkerDynamicToolCall.mockResolvedValue({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "{}",
        },
      ],
    });
    mocks.executeAppServerCoreDynamicToolCall.mockResolvedValue({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "{}",
        },
      ],
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("rejects GET because dynamic app-server calls are POST-only", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.error).toEqual({
      code: "app_server_post_required",
      message: "App-server dynamic tool calls use POST /app-server.",
    });
  });

  it("rejects unauthorized calls before reading the request body", async () => {
    const getReader = vi.fn(() => {
      throw new Error("Body should not be read before auth succeeds.");
    });
    const { POST } = await import("./route");
    const response = await POST({
      url: "http://localhost/app-server",
      headers: new Headers({
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      }),
      body: {
        getReader,
      },
    } as unknown as Request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toEqual({
      code: "control_plane_unauthorized",
      message: "Control-plane token is invalid.",
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("bridges authenticated worker commands into control-plane app-server context", async () => {
    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.worker.command",
      arguments: {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-route-lead-read-001",
        config: {
          source: "website_form",
          records: [
            {
              sourceEventId: "form-001",
              customerName: "Acme Roof Repair",
              customerIntent: "roof leak inspection",
              serviceArea: "roofing",
              urgency: "high",
            },
          ],
        },
      },
      callId: "call-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      api: "continuous.app_server.v1",
      data: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: "{}",
          },
        ],
      },
      error: null,
    });
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "worker.command.lead.read",
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerWorkerDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["worker:lead.read"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
    expect(mocks.executeAppServerCoreDynamicToolCall).not.toHaveBeenCalled();
  });

  it("bridges authenticated worker views into read-scoped app-server context", async () => {
    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.worker.view",
      arguments: {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      },
      callId: "call-002",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.executeAppServerWorkerDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["read"],
      allowedCommands: ["worker:view.snapshot"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
  });

  it("bridges authenticated Core commands into control-plane app-server context", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.task.create"],
      {
        allowedWorkerRoles: [],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "task.create",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-task-create-001",
        config: {
          title: "Review Core app-server primitive",
          priority: "high",
        },
      },
      callId: "call-core-command-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "core.command.task.create",
        tenantSlug: "continuous-demo",
        workerRole: undefined,
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:task.create"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["*"],
    });
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("bridges authenticated Core views into read-scoped app-server context", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.view.summary"],
      {
        allowedWorkerRoles: [],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.view",
      arguments: {
        view: "summary",
        core: {
          tenantSlug: "continuous-demo",
        },
        config: {},
      },
      callId: "call-core-view-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["read"],
      allowedCommands: ["core:view.summary"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["*"],
    });
  });

  it("authorizes Core schema discovery through an explicit app-server schema command", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:core.schema"]);

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.schema",
      arguments: {},
      callId: "call-core-schema-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "read",
        command: "core.schema",
        requireManagedCredential: false,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, undefined);
  });

  it("rejects Core bridge calls outside token command or tenant scope", async () => {
    const { POST } = await import("./route");
    const basePayload = {
      tool: "continuous.core.command",
      arguments: {
        command: "task.create",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-denied-001",
        config: {
          title: "Denied Core bridge command",
        },
      },
      callId: "call-core-denied-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };

    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:core.view.summary"], {
      allowedWorkerRoles: [],
    });
    const deniedCommand = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(basePayload),
      }),
    );

    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:core.command.task.create"], {
      allowedWorkerRoles: [],
    });
    const deniedTenant = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...basePayload,
          arguments: {
            ...basePayload.arguments,
            core: {
              tenantSlug: "other-tenant",
            },
          },
        }),
      }),
    );

    expect(deniedCommand.status).toBe(403);
    await expect(deniedCommand.json()).resolves.toMatchObject({
      error: { code: "control_plane_command_forbidden" },
    });
    expect(deniedTenant.status).toBe(403);
    await expect(deniedTenant.json()).resolves.toMatchObject({
      error: { code: "control_plane_tenant_forbidden" },
    });
    expect(mocks.executeAppServerCoreDynamicToolCall).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("keeps Core bridge auth tenant-scoped instead of worker-role scoped", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.task.create"],
      {
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "task.create",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-worker-role-scope-001",
        config: {
          title: "Core auth is tenant scoped",
        },
      },
      callId: "call-core-worker-role-scope-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:task.create"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["*"],
    });
  });

  it("role-scopes Core worker upsert app-server commands before dynamic tool dispatch", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.upsert"],
      {
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "worker.upsert",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-worker-upsert-001",
        config: {
          role: "revenue_operations",
          kind: "synthetic",
          state: "training",
          name: "Revenue Operations Worker",
          mission: "Prepare quote-to-cash packets with blocked external execution.",
          autonomyLevel: 1,
          policy: {
            externalExecution: "blocked",
          },
        },
      },
      callId: "call-core-worker-upsert-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "core.command.worker.upsert",
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:worker.upsert"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
  });

  it("role-scopes Core worker transition app-server commands before dynamic tool dispatch", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.transition"],
      {
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "worker.transition",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-worker-transition-001",
        config: {
          worker: {
            role: "revenue_operations",
          },
          workerId: "22222222-2222-4222-8222-222222222222",
          toState: "active",
          reason: "Lifecycle smoke promoted the worker.",
        },
      },
      callId: "call-core-worker-transition-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "core.command.worker.transition",
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:worker.transition"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
  });

  it("role-scopes Core worker-run app-server commands before dynamic tool dispatch", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.run.start"],
      {
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "worker.run.start",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-worker-run-start-001",
        config: {
          worker: {
            role: "revenue_operations",
          },
          command: "quote.prepare",
          capabilityKey: "quote.prepare",
          budgetAccountId: "budget-1",
          units: 1200,
        },
      },
      callId: "call-core-worker-run-start-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "core.command.worker.run.start",
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:worker.run.start"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
  });

  it("role-scopes Core worker-run completion app-server commands before dynamic tool dispatch", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.run.complete"],
      {
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.core.command",
      arguments: {
        command: "worker.run.complete",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-core-worker-run-complete-001",
        config: {
          worker: {
            role: "revenue_operations",
          },
          workerRunId: "run-1",
          state: "done",
          reason: "Quote packet prepared with blocked external execution.",
        },
      },
      callId: "call-core-worker-run-complete-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "core.command.worker.run.complete",
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerCoreDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["core:worker.run.complete"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
    });
  });

  it("rejects Core worker-run app-server commands outside worker-role scope", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.run.start"],
      {
        allowedWorkerRoles: ["finance_operations"],
      },
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.core.command",
          arguments: {
            command: "worker.run.start",
            core: {
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-core-worker-run-forbidden-001",
            config: {
              worker: {
                role: "revenue_operations",
              },
              command: "quote.prepare",
              capabilityKey: "quote.prepare",
              budgetAccountId: "budget-1",
              units: 1200,
            },
          },
          callId: "call-core-worker-run-forbidden-001",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "control_plane_worker_role_forbidden",
      },
    });
    expect(mocks.executeAppServerCoreDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects Core worker transition app-server commands outside worker-role scope", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.transition"],
      {
        allowedWorkerRoles: ["finance_operations"],
      },
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.core.command",
          arguments: {
            command: "worker.transition",
            core: {
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-core-worker-transition-forbidden-001",
            config: {
              role: "revenue_operations",
              workerId: "22222222-2222-4222-8222-222222222222",
              toState: "active",
              reason: "Forbidden worker role should fail before dispatch.",
            },
          },
          callId: "call-core-worker-transition-forbidden-001",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "control_plane_worker_role_forbidden",
      },
    });
    expect(mocks.executeAppServerCoreDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects Core worker-run completion app-server commands outside worker-role scope", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:core.command.worker.run.complete"],
      {
        allowedWorkerRoles: ["finance_operations"],
      },
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.core.command",
          arguments: {
            command: "worker.run.complete",
            core: {
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-core-worker-run-complete-forbidden-001",
            config: {
              worker: {
                role: "revenue_operations",
              },
              workerRunId: "run-1",
              state: "done",
              reason: "Quote packet prepared with blocked external execution.",
            },
          },
          callId: "call-core-worker-run-complete-forbidden-001",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "control_plane_worker_role_forbidden",
      },
    });
    expect(mocks.executeAppServerCoreDynamicToolCall).not.toHaveBeenCalled();
  });

  it("bridges authenticated Compliance commands through the same app-server worker envelope", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:worker.command.filing.prepare"],
      {
        allowedWorkerRoles: ["compliance_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.worker.command",
      arguments: {
        command: "filing.prepare",
        worker: {
          role: "compliance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-route-compliance-filing-001",
        config: {
          filingRequirementId: "filing-requirement-1",
          period: {
            label: "2026-Q2",
            from: "2026-04-01T00:00:00.000Z",
            to: "2026-07-01T00:00:00.000Z",
          },
          sourceRefs: {
            payrollRunId: "payroll-run-1",
          },
        },
      },
      callId: "call-compliance-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "worker.command.filing.prepare",
        tenantSlug: "continuous-demo",
        workerRole: "compliance_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerWorkerDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["worker:filing.prepare"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["compliance_operations"],
    });
  });

  it("bridges authenticated Growth commands through the same app-server worker envelope", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(
      ["app_server:worker.command.campaign.draft"],
      {
        allowedWorkerRoles: ["growth_operations"],
      },
    );

    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.worker.command",
      arguments: {
        command: "campaign.draft",
        worker: {
          role: "growth_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-route-growth-campaign-001",
        config: {
          sourceRefs: {
            customerSignalObjectId: "signal-object-1",
            evidencePacketId: "packet-1",
            budgetReservationId: "budget-reservation-1",
          },
          policy: {
            channel: "email",
            audience: "recent_customers",
            requiresOwnerApproval: true,
            allowPublish: false,
          },
        },
      },
      callId: "call-growth-001",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "write",
        command: "worker.command.campaign.draft",
        tenantSlug: "continuous-demo",
        workerRole: "growth_operations",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.executeAppServerWorkerDynamicToolCall).toHaveBeenCalledWith(payload, {
      operatorEmail: "operator@example.com",
      source: "control_plane",
      allowedAccess: ["write"],
      allowedCommands: ["worker:campaign.draft"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["growth_operations"],
    });
  });

  it("authorizes schema discovery through an explicit app-server schema command", async () => {
    const { POST } = await import("./route");
    const payload = {
      tool: "continuous.worker.schema",
      arguments: {},
      callId: "call-003",
      threadId: "thread-001",
      turnId: "turn-001",
    };
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "app_server",
        access: "read",
        command: "worker.schema",
        requireManagedCredential: false,
      }),
    );
    expect(mocks.executeAppServerWorkerDynamicToolCall).toHaveBeenCalledWith(payload, undefined);
  });

  it("rejects schema discovery arguments before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.schema",
          arguments: {
            view: "snapshot",
          },
          callId: "call-schema-extra",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message: "continuous.worker.schema does not accept arguments.",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects bridge calls outside token command, tenant, and worker-role scope", async () => {
    const { POST } = await import("./route");
    const basePayload = {
      tool: "continuous.worker.command",
      arguments: {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-route-denied-001",
        config: {},
      },
      callId: "call-004",
      threadId: "thread-001",
      turnId: "turn-001",
    };

    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:worker.view.snapshot"]);
    const deniedCommand = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(basePayload),
      }),
    );

    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:worker.command.lead.read"]);
    const deniedTenant = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...basePayload,
          arguments: {
            ...basePayload.arguments,
            worker: {
              role: "revenue_operations",
              tenantSlug: "other-tenant",
            },
          },
        }),
      }),
    );

    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog(["app_server:worker.command.lead.read"], {
      allowedWorkerRoles: ["dispatch_operations"],
    });
    const deniedRole = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(basePayload),
      }),
    );

    expect(deniedCommand.status).toBe(403);
    await expect(deniedCommand.json()).resolves.toMatchObject({
      error: { code: "control_plane_command_forbidden" },
    });
    expect(deniedTenant.status).toBe(403);
    await expect(deniedTenant.json()).resolves.toMatchObject({
      error: { code: "control_plane_tenant_forbidden" },
    });
    expect(deniedRole.status).toBe(403);
    await expect(deniedRole.json()).resolves.toMatchObject({
      error: { code: "control_plane_worker_role_forbidden" },
    });
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects Compliance bridge calls when token role scope omits Compliance", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = tokenCatalog([
      "app_server:worker.command.filing.prepare",
    ]);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.command",
          arguments: {
            command: "filing.prepare",
            worker: {
              role: "compliance_operations",
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-route-compliance-role-denied-001",
            config: {
              filingRequirementId: "filing-requirement-1",
              period: {
                from: "2026-04-01T00:00:00.000Z",
                to: "2026-07-01T00:00:00.000Z",
              },
            },
          },
          callId: "call-compliance-002",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "control_plane_worker_role_forbidden" },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects malformed app-server tool-call payloads before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const missingTool = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          arguments: {},
          callId: "call-005",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );
    const unknownTool = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.invalid",
          arguments: {},
          callId: "call-006",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(missingTool.status).toBe(400);
    await expect(missingTool.json()).resolves.toMatchObject({
      error: { code: "invalid_app_server_tool_call" },
    });
    expect(unknownTool.status).toBe(400);
    await expect(unknownTool.json()).resolves.toMatchObject({
      error: { code: "unknown_app_server_tool" },
    });
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects non-object app-server arguments before dynamic dispatch", async () => {
    const { POST } = await import("./route");

    for (const [index, args] of [null, "not-object", []].entries()) {
      const response = await POST(
        new Request("http://localhost/app-server", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool: index % 2 === 0 ? "continuous.worker.command" : "continuous.worker.view",
            arguments: args,
            callId: `call-non-object-arguments-${index}`,
            threadId: "thread-001",
            turnId: "turn-001",
          }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_app_server_tool_call",
          message: "App-server dynamic calls require arguments to be an object.",
        },
      });
    }

    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects route-like worker roles inside app-server worker arguments", async () => {
    const { POST } = await import("./route");
    const apiFamilyRole = ["api", "domain-worker"].join("/");
    const routeNouns = ["api", "app_server", "approval", "core", "worker", "workers", "workflow"];

    for (const role of [
      "domain-worker",
      "domain_worker",
      "legacy-worker",
      "legacy_worker",
      apiFamilyRole,
      "api/legacy-worker",
      "worker/domain",
      "worker/revenue_operations",
      ...routeNouns,
    ]) {
      const response = await POST(
        new Request("http://localhost/app-server", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool: "continuous.worker.command",
            arguments: {
              command: "lead.read",
              worker: {
                role,
                tenantSlug: "continuous-demo",
              },
              idempotencyKey: `app-server-bad-role-${role.replaceAll(/[^a-z0-9]+/g, "-")}`,
              config: {
                source: "website_form",
                records: [
                  {
                    sourceEventId: "app-server-bad-role-form-001",
                    customerName: "Acme Roof Repair",
                  },
                ],
              },
            },
            callId: "call-bad-worker-role",
            threadId: "thread-001",
            turnId: "turn-001",
          }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_app_server_tool_call",
          message:
            "worker.role must be a lower_snake_case role identifier such as revenue_operations; do not use route names, family-worker names, or URL fragments.",
        },
      });
    }
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects route-like worker operation names inside app-server worker arguments", async () => {
    const { POST } = await import("./route");
    const badOperations = [
      ["", "api", "legacy-worker", "run"].join("/"),
      ["", "legacy-worker"].join("/"),
      "legacy-worker",
      ["legacy_worker", "run"].join("."),
      "worker.run",
      "worker?view=snapshot",
      "api.worker.run",
    ];

    for (const operation of badOperations) {
      const response = await POST(
        new Request("http://localhost/app-server", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool: "continuous.worker.command",
            arguments: {
              command: operation,
              worker: {
                role: "revenue_operations",
                tenantSlug: "continuous-demo",
              },
              idempotencyKey: `app-server-bad-operation-${operation.replaceAll(/[^a-z0-9]+/g, "-")}`,
              config: {},
            },
            callId: "call-bad-worker-operation",
            threadId: "thread-001",
            turnId: "turn-001",
          }),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_app_server_tool_call",
          message:
            "Worker command and view names must be registered lower_snake_case or dotted operation identifiers such as lead.read or quote.prepare; do not use URL paths, route names, family-worker names, or query strings.",
        },
      });
    }
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects top-level context and operation fields before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.command",
          arguments: {
            command: "lead.read",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-route-top-level-context-001",
            config: {},
          },
          callId: "call-007",
          threadId: "thread-001",
          turnId: "turn-001",
          operatorEmail: "forged@example.com",
          context: {
            source: "control_plane",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message: expect.stringContaining("Put worker operation inputs under arguments.config."),
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects worker operation fields beside arguments.config before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.command",
          arguments: {
            command: "lead.read",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-route-arguments-envelope-001",
            source: "website_form",
            records: [
              {
                sourceEventId: "form-001",
                customerName: "Acme Roof Repair",
              },
            ],
            config: {},
          },
          callId: "call-008",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message:
          "continuous.worker.command arguments fields must be command, worker, idempotencyKey, and config. Put worker operation inputs under arguments.config. Unexpected fields: source, records.",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects command and view argument cross-contamination before dynamic dispatch", async () => {
    const { POST } = await import("./route");

    for (const payload of [
      {
        tool: "continuous.worker.command",
        arguments: {
          command: "lead.read",
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "app-server-route-command-view-contamination-001",
          config: {},
        },
        callId: "call-command-view-contamination",
        threadId: "thread-001",
        turnId: "turn-001",
      },
      {
        tool: "continuous.worker.view",
        arguments: {
          view: "snapshot",
          command: "lead.read",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        },
        callId: "call-view-command-contamination",
        threadId: "thread-001",
        turnId: "turn-001",
      },
    ]) {
      const response = await POST(
        new Request("http://localhost/app-server", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_app_server_tool_call",
          message: expect.stringContaining("Unexpected fields:"),
        },
      });
    }

    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects worker view filters beside arguments.config before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.view",
          arguments: {
            view: "approvals",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            state: "pending",
            config: {},
          },
          callId: "call-view-filter-outside-config",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message:
          "continuous.worker.view arguments fields must be view, worker, and config. Put worker operation inputs under arguments.config. Unexpected fields: state.",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });

  it("rejects missing or non-object worker config before dynamic dispatch", async () => {
    const { POST } = await import("./route");
    const commandResponse = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.command",
          arguments: {
            command: "lead.read",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: "app-server-route-missing-config-001",
          },
          callId: "call-command-missing-config",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );
    const viewResponse = await POST(
      new Request("http://localhost/app-server", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tool: "continuous.worker.view",
          arguments: {
            view: "snapshot",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            config: [],
          },
          callId: "call-view-array-config",
          threadId: "thread-001",
          turnId: "turn-001",
        }),
      }),
    );

    expect(commandResponse.status).toBe(400);
    await expect(commandResponse.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message: "config is required and must be an object.",
      },
    });
    expect(viewResponse.status).toBe(400);
    await expect(viewResponse.json()).resolves.toMatchObject({
      error: {
        code: "invalid_app_server_tool_call",
        message: "config is required and must be an object.",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeAppServerWorkerDynamicToolCall).not.toHaveBeenCalled();
  });
});
