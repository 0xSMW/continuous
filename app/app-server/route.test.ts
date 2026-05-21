import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeManagedControlPlaneCredential: vi.fn(),
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

    for (const role of ["domain-worker", "domain_worker", apiFamilyRole, "worker/domain"]) {
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
