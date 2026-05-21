import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appServerWorkerToolManifest,
  executeAppServerWorkerDynamicToolCall,
  executeAppServerWorkerTool,
} from "./app-server-tools";

const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

beforeEach(() => {
  process.env.WORKER_OPERATOR_EMAIL = "owner@continuoushq.com";
});

afterEach(() => {
  if (originalAppEnv === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = originalAppEnv;
  }

  if (originalTrustedLocalWorkerTools === undefined) {
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
  } else {
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = originalTrustedLocalWorkerTools;
  }

  if (originalWorkerOperatorEmail === undefined) {
    delete process.env.WORKER_OPERATOR_EMAIL;
  } else {
    process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail;
  }
});

describe("app-server worker tools", () => {
  it("exposes schema discovery and registry-backed worker command control", async () => {
    const schema = await executeAppServerWorkerTool("continuous.worker.schema");

    expect(appServerWorkerToolManifest.mode).toBe("registry_backed_worker_control");
    expect(appServerWorkerToolManifest.tools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
      "continuous.worker.command",
      "continuous.worker.view",
    ]);
    expect(
      Object.keys(
        appServerWorkerToolManifest.tools.find((tool) => tool.name === "continuous.worker.command")
          ?.inputSchema.properties ?? {},
      ),
    ).not.toContain("operatorEmail");
    if (!("registry" in schema) || !schema.registry) {
      throw new Error("Expected schema result.");
    }
    const registry = schema.registry;
    const runtimeRoles = registry.runtimeContracts.map((contract) => contract.role);
    const plannedRoles = registry.plannedContracts.map((contract) => contract.role);
    const revenueFollowUpCommands = registry.followUpCommands.filter(
      (command) => command.role === "revenue_operations",
    );
    const registeredSystemsCommands = registry.commands.filter(
      (command) => command.role === "systems_operations",
    );
    const systemsCommandMetadata =
      registeredSystemsCommands.length > 0
        ? registeredSystemsCommands
        : registry.followUpCommands.filter((command) => command.role === "systems_operations");
    const registeredSystemsViews = registry.views.filter(
      (view) => view.role === "systems_operations",
    );
    const systemsViewMetadata =
      registeredSystemsViews.length > 0
        ? registeredSystemsViews
        : registry.followUpViews.filter((view) => view.role === "systems_operations");

    expect(registry.contracts.map((contract) => contract.role)).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "compliance_operations",
      "systems_operations",
    ]);
    expect(registry.contracts.every((contract) => contract.apiRoute === "/worker")).toBe(true);
    expect(registry.commands.every((command) => command.apiRoute === "/worker")).toBe(true);
    expect(registry.views.every((view) => view.apiRoute === "/worker")).toBe(true);
    expect(runtimeRoles).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "systems_operations",
    ]);
    expect(plannedRoles).toEqual(["compliance_operations"]);
    expect(registry.plannedCommands).toEqual(registry.followUpCommands);
    expect(registry.plannedViews).toEqual(registry.followUpViews);
    expect(revenueFollowUpCommands.map((command) => command.name)).toEqual(["payment_link.prepare"]);
    expect(
      registry.plannedFutureWorkerCommands.some(
        (command) => command.role === "systems_operations",
      ),
    ).toBe(false);
    expect(
      registry.plannedFutureWorkerViews.some((view) => view.role === "systems_operations"),
    ).toBe(false);
    expect(
      revenueFollowUpCommands.find((command) => command.name === "payment_link.prepare")?.configSchema.properties
        ?.sourceRefs?.type,
    ).toBe("object");
    expect(registry.commands.some((command) => command.name === "run")).toBe(true);
    expect(registry.commands.some((command) => command.name === "approval.decide")).toBe(true);
    expect(registry.commands.some((command) => command.name === "lead.classify")).toBe(true);
    expect(registry.commands.some((command) => command.name === "response.draft")).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "revenue_operations" &&
          command.name === "quote.prepare" &&
          command.apiRoute === "/worker" &&
          command.idempotency === "required" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "brief.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "decision_queue.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "anomaly.triage" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "schedule.propose",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "customer_update.draft",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "closeout.prepare",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "dispatch_operations" &&
          command.name === "exception.route" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "invoice.prepare" &&
          command.externalExecution === "dry_run",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "ar_followup.draft" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "cash_forecast.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "payment_draft.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "workforce_operations" &&
          command.name === "hire.packet.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "workforce_operations" &&
          command.name === "payroll_input.prepare" &&
          command.externalExecution === "dry_run",
      ),
    ).toBe(true);
    expect(registry.views.some((view) => view.role === "workforce_operations" && view.name === "readiness")).toBe(true);
    expect(systemsCommandMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "systems_operations",
          name: "connector.health.scan",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["checks"],
            properties: expect.objectContaining({
              checks: expect.objectContaining({ type: "array", minItems: 1 }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "systems_operations",
          name: "sync.repair.plan",
          apiRoute: "/worker",
          sideEffects: "dry_run",
          externalExecution: "dry_run",
          configSchema: expect.objectContaining({
            required: ["connectionId", "issueId"],
          }),
        }),
        expect.objectContaining({
          role: "systems_operations",
          name: "permission.review",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            oneRequired: ["connectionId", "grantId"],
          }),
        }),
        expect.objectContaining({
          role: "systems_operations",
          name: "automation.plan",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["workflowKey", "trigger"],
            properties: expect.objectContaining({
              trigger: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
      ]),
    );
    expect(systemsViewMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "systems_operations", name: "snapshot", apiRoute: "/worker" }),
        expect.objectContaining({ role: "systems_operations", name: "health", apiRoute: "/worker" }),
        expect.objectContaining({ role: "systems_operations", name: "repairs", apiRoute: "/worker" }),
      ]),
    );
  });

  it("requires a clean canonical command envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        idempotencyKey: "app-server-missing-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker must be an object with role, id, and tenantSlug selectors.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {},
        idempotencyKey: "app-server-empty-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker.role is required.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-missing-config-test-001",
      }),
    ).rejects.toThrow("config is required and must be an object.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-envelope-test-001",
        approvalId: "approval-1",
        limit: 25,
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: approvalId, limit.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("continuous.worker.command requires command.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: operatorEmail.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          approvalId: "approval-1",
        },
        idempotencyKey: "app-server-nested-worker-envelope-test-001",
        config: {
          intake: {
            source: "website_form",
            sourceEventId: "app-server-nested-worker-envelope-form-001",
          },
        },
      }),
    ).rejects.toThrow(
      "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: approvalId.",
    );
  });

  it("requires a clean canonical view envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("continuous.worker.view requires view.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        config: {},
      }),
    ).rejects.toThrow("worker must be an object with role, id, and tenantSlug selectors.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {},
        config: {},
      }),
    ).rejects.toThrow("worker.role is required.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
      }),
    ).rejects.toThrow("config is required and must be an object.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        state: "active",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.view payload fields must be view, worker, and config. Move operation inputs into config. Unexpected fields: state.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          approvalId: "approval-1",
        },
        config: {
          state: "active",
        },
      }),
    ).rejects.toThrow(
      "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: approvalId.",
    );
  });

  it("rejects malformed optional worker selectors on app-server tools", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          id: 42,
        },
        idempotencyKey: "app-server-malformed-worker-id",
        config: {},
      }),
    ).rejects.toThrow("worker.id must be a non-empty string when supplied.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: null,
        },
        config: {},
      }),
    ).rejects.toThrow("worker.tenantSlug must be a non-empty string when supplied.");
  });

  it("requires operator identity from the app-server transport environment", async () => {
    delete process.env.WORKER_OPERATOR_EMAIL;

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "missing.command",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-missing-operator-command",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.view requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.",
    );
  });

  it("accepts operator identity from authenticated app-server transport context", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
    delete process.env.WORKER_OPERATOR_EMAIL;

    await expect(
      executeAppServerWorkerTool(
        "continuous.worker.command",
        {
          command: "missing.command",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "app-server-authenticated-transport-command",
          config: {},
        },
        {
          source: "control_plane",
          operatorEmail: "owner@continuoushq.com",
          allowedAccess: ["write"],
          allowedCommands: ["worker:missing.command"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["revenue_operations"],
        },
      ),
    ).rejects.toThrow("Worker command must be run");

    await expect(
      executeAppServerWorkerTool(
        "continuous.worker.view",
        {
          view: "snapshot",
          worker: {
            role: "payroll_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        },
        {
          source: "control_plane",
          operatorEmail: "owner@continuoushq.com",
          allowedAccess: ["read"],
          allowedCommands: ["worker:view.snapshot"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["payroll_operations"],
        },
      ),
    ).rejects.toThrow("Worker role payroll_operations is not available yet.");
  });

  it("requires scoped app-server transport context for control-plane calls", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
    delete process.env.WORKER_OPERATOR_EMAIL;

    const commandPayload = {
      command: "missing.command",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: "app-server-scoped-transport-command",
      config: {},
    };

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: [],
        allowedCommands: ["worker:missing.command"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow("continuous.worker.command requires scoped authenticated transport context.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:missing.command"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow("continuous.worker.command transport context is not allowed to write.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow(
      "continuous.worker.command transport context is not allowed for worker:missing.command.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write"],
        allowedCommands: ["worker:missing.command"],
        allowedTenants: ["other-tenant"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow("continuous.worker.command transport context is not allowed for this tenant.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write"],
        allowedCommands: ["worker:missing.command"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["finance_operations"],
      }),
    ).rejects.toThrow(
      "continuous.worker.command transport context is not allowed for this worker role.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", commandPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write", "write"],
        allowedCommands: [" worker:missing.command ", "worker:missing.command"],
        allowedTenants: [" continuous-demo "],
        allowedWorkerRoles: [" revenue_operations "],
      }),
    ).rejects.toThrow("Worker command must be run");
  });

  it("requires scoped app-server transport context for view calls", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
    delete process.env.WORKER_OPERATOR_EMAIL;

    const viewPayload = {
      view: "snapshot",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      config: {},
    };

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", viewPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow("continuous.worker.view transport context is not allowed to read.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", viewPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.approvals"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow(
      "continuous.worker.view transport context is not allowed for worker:view.snapshot.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", viewPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["other-tenant"],
        allowedWorkerRoles: ["revenue_operations"],
      }),
    ).rejects.toThrow("continuous.worker.view transport context is not allowed for this tenant.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", viewPayload, {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["finance_operations"],
      }),
    ).rejects.toThrow(
      "continuous.worker.view transport context is not allowed for this worker role.",
    );
  });

  it("adapts Codex app-server dynamic tool calls to worker tool responses", async () => {
    const schemaResponse = await executeAppServerWorkerDynamicToolCall({
      tool: "continuous.worker.schema",
      arguments: {},
      callId: "dynamic-schema-call",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const schemaPayload = JSON.parse(schemaResponse.contentItems[0]?.text ?? "{}") as {
      ok?: boolean;
      tool?: string;
      data?: {
        manifest?: typeof appServerWorkerToolManifest;
      };
    };

    expect(schemaResponse.success).toBe(true);
    expect(schemaPayload.ok).toBe(true);
    expect(schemaPayload.tool).toBe("continuous.worker.schema");
    expect(schemaPayload.data?.manifest?.tools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
      "continuous.worker.command",
      "continuous.worker.view",
    ]);

    const errorResponse = await executeAppServerWorkerDynamicToolCall({
      tool: "continuous.worker.command",
      arguments: {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        config: {},
      },
      callId: "dynamic-error-call",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    const errorPayload = JSON.parse(errorResponse.contentItems[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
    };

    expect(errorResponse.success).toBe(false);
    expect(errorPayload.ok).toBe(false);
    expect(errorPayload.error).toContain("Unexpected fields: operatorEmail.");

    const deniedAccessResponse = await executeAppServerWorkerDynamicToolCall(
      {
        tool: "continuous.worker.view",
        arguments: {
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        },
        callId: "dynamic-denied-access-call",
        threadId: "thread-1",
        turnId: "turn-3",
      },
      {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["write"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );
    const deniedAccessPayload = JSON.parse(deniedAccessResponse.contentItems[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
    };

    expect(deniedAccessResponse.success).toBe(false);
    expect(deniedAccessPayload.ok).toBe(false);
    expect(deniedAccessPayload.error).toContain("transport context is not allowed to read");

    const deniedTenantResponse = await executeAppServerWorkerDynamicToolCall(
      {
        tool: "continuous.worker.view",
        arguments: {
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        },
        callId: "dynamic-denied-tenant-call",
        threadId: "thread-1",
        turnId: "turn-4",
      },
      {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["other-tenant"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );
    const deniedTenantPayload = JSON.parse(deniedTenantResponse.contentItems[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
    };

    expect(deniedTenantResponse.success).toBe(false);
    expect(deniedTenantPayload.ok).toBe(false);
    expect(deniedTenantPayload.error).toContain("transport context is not allowed for this tenant");

    const deniedRoleResponse = await executeAppServerWorkerDynamicToolCall(
      {
        tool: "continuous.worker.view",
        arguments: {
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        },
        callId: "dynamic-denied-role-call",
        threadId: "thread-1",
        turnId: "turn-5",
      },
      {
        source: "control_plane",
        operatorEmail: "owner@continuoushq.com",
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["finance_operations"],
      },
    );
    const deniedRolePayload = JSON.parse(deniedRoleResponse.contentItems[0]?.text ?? "{}") as {
      ok?: boolean;
      error?: string;
    };

    expect(deniedRoleResponse.success).toBe(false);
    expect(deniedRolePayload.ok).toBe(false);
    expect(deniedRolePayload.error).toContain(
      "transport context is not allowed for this worker role",
    );
  });

  it("applies registry schemas to workforce commands through the app-server envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "hire.packet.prepare",
        worker: {
          role: "workforce_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-planned-worker-test",
        config: {},
      }),
    ).rejects.toThrow("config.personId is required for hire.packet.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "payroll_input.prepare",
        worker: {
          role: "workforce_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-workforce-payroll-schema",
        config: {
          employmentId: "employment_uuid",
        },
      }),
    ).rejects.toThrow("config.period is required for payroll_input.prepare.");
  });

  it("disables app-server worker mutations in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-app-server-mutation-guard-001",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command is a trusted local mutation surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );

    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "missing.command",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-app-server-mutation-guard-002",
        config: {},
      }),
    ).rejects.toThrow("Worker command must be run");
  });

  it("disables app-server worker reads in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.view is a trusted local read surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );
  });

  it("forwards nested lead reader config through the registry-backed command envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-inbox-reader-test",
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
          },
          records: [
            {
              messageId: "message-001",
              from: "Buyer One <buyer@example.com>",
              subject: "Need roof leak inspection",
            },
          ],
        },
      }),
    ).rejects.toThrow("config.reader.credentialRef is required for inbox and CRM lead readers.");
  });

  it("applies registry schemas to dispatch commands through the app-server envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "customer_update.draft",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-update-schema",
        config: {
          jobId: "job_object_uuid",
        },
      }),
    ).rejects.toThrow("config.updateKind is required for customer_update.draft.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "closeout.prepare",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-closeout-schema",
        config: {
          sourceRefs: {
            jobObjectId: "job_object_uuid",
          },
        },
      }),
    ).rejects.toThrow("config.workOrderId is required for closeout.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "exception.route",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-exception-schema",
        config: {
          jobId: "job_object_uuid",
          reason: "missing_photos",
        },
      }),
    ).rejects.toThrow("config.severity is required for exception.route.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "invoice.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-invoice-schema",
        config: {},
      }),
    ).rejects.toThrow("config.jobId, closeoutId or sourceRefs is required for invoice.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "ar_followup.draft",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-ar-followup-schema",
        config: {
          invoiceId: "invoice_uuid",
        },
      }),
    ).rejects.toThrow("config.tonePolicy is required for ar_followup.draft.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "cash_forecast.generate",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-cash-forecast-schema",
        config: {
          window: {
            from: "2026-05-01T00:00:00.000Z",
            to: "2026-06-01T00:00:00.000Z",
          },
        },
      }),
    ).rejects.toThrow("config.accounts is required for cash_forecast.generate.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "payment_draft.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-payment-draft-schema",
        config: {},
      }),
    ).rejects.toThrow("config.billId, paymentId or sourceRefs is required for payment_draft.prepare.");
  });
});
