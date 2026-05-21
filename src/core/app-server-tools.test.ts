import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCoreTask: vi.fn(),
  transitionCoreTask: vi.fn(),
  completeCoreWorkerRun: vi.fn(),
  startCoreWorkerRun: vi.fn(),
  transitionCoreWorker: vi.fn(),
  upsertCoreWorker: vi.fn(),
  getCoreSummarySafe: vi.fn(),
  getHealth: vi.fn(),
  scanObligations: vi.fn(),
}));

vi.mock("./tasks", () => ({
  createCoreTask: mocks.createCoreTask,
  transitionCoreTask: mocks.transitionCoreTask,
}));

vi.mock("./summary", () => ({
  getCoreSummarySafe: mocks.getCoreSummarySafe,
}));

vi.mock("./health", () => ({
  getHealth: mocks.getHealth,
}));

vi.mock("./obligations", () => ({
  scanObligations: mocks.scanObligations,
}));

vi.mock("./worker-runs", () => ({
  completeCoreWorkerRun: mocks.completeCoreWorkerRun,
  startCoreWorkerRun: mocks.startCoreWorkerRun,
}));

vi.mock("./workers", () => ({
  transitionCoreWorker: mocks.transitionCoreWorker,
  upsertCoreWorker: mocks.upsertCoreWorker,
}));

import {
  appServerCoreToolManifest,
  executeAppServerCoreDynamicToolCall,
  executeAppServerCoreTool,
} from "./app-server-tools";

const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

beforeEach(() => {
  process.env.WORKER_OPERATOR_EMAIL = "owner@continuoushq.com";
  mocks.createCoreTask.mockResolvedValue({
    created: true,
    taskId: "task-1",
  });
  mocks.startCoreWorkerRun.mockResolvedValue({
    started: true,
    workerRunId: "run-1",
  });
  mocks.completeCoreWorkerRun.mockResolvedValue({
    completed: true,
    workerRunId: "run-1",
  });
  mocks.upsertCoreWorker.mockResolvedValue({
    recorded: true,
    workerId: "worker-1",
  });
  mocks.transitionCoreWorker.mockResolvedValue({
    transitioned: true,
    workerId: "worker-1",
  });
  mocks.getCoreSummarySafe.mockResolvedValue({
    ok: true,
    error: null,
    summary: {
      counts: {
        tasks: 1,
      },
    },
  });
  mocks.getHealth.mockReturnValue({
    status: "ok",
  });
  mocks.scanObligations.mockResolvedValue({
    created: true,
    obligationIds: ["obligation-1"],
    externalExecution: "blocked",
  });
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

  vi.resetAllMocks();
});

describe("app-server Core tools", () => {
  it("exposes Core schema discovery with command and view registry metadata", async () => {
    const schema = (await executeAppServerCoreTool("continuous.core.schema")) as unknown as {
      registry: {
        commands: unknown[];
        views: unknown[];
        excludedCommands: string[];
      };
    };

    expect(appServerCoreToolManifest.mode).toBe("registry_backed_core_control");
    expect(appServerCoreToolManifest.tools.map((tool) => tool.name)).toEqual([
      "continuous.core.schema",
      "continuous.core.command",
      "continuous.core.view",
    ]);
    expect(schema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "task.create",
          apiRoute: "/core",
          tool: "continuous.core.command",
          idempotency: "required",
        }),
        expect.objectContaining({
          name: "worker.upsert",
          apiRoute: "/core",
        }),
        expect.objectContaining({
          name: "worker.transition",
          apiRoute: "/core",
        }),
        expect.objectContaining({
          name: "worker.run.start",
          apiRoute: "/core",
        }),
        expect.objectContaining({
          name: "worker.run.complete",
          apiRoute: "/core",
        }),
        expect.objectContaining({
          name: "obligation.scan",
          apiRoute: "/core",
          tool: "continuous.core.command",
        }),
      ]),
    );
    expect(schema.registry.views).toEqual([
      expect.objectContaining({
        name: "summary",
        apiRoute: "/core",
        tool: "continuous.core.view",
      }),
    ]);
    expect(schema.registry.excludedCommands).toEqual(
      expect.arrayContaining(["control_plane.credential.upsert"]),
    );
  });

  it("dispatches Core commands through the canonical app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "task.create",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-task-001",
        config: {
          title: "Review Core app-server task",
          priority: "high",
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:task.create"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toEqual({
      command: "task.create",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        created: true,
        taskId: "task-1",
      },
    });
    expect(mocks.createCoreTask).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "core-app-server-task-001",
        tenantSlug: "continuous-demo",
        title: "Review Core app-server task",
        priority: "high",
      }),
    );
  });

  it("dispatches Core obligation scans through the app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "obligation.scan",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-obligation-scan-001",
        config: {
          jurisdiction: "US",
          rulePackId: "55555555-5555-4555-8555-000000000008",
          filingRequirementId: "55555555-5555-4555-8555-000000000010",
          scope: {
            domain: "payroll",
          },
          facts: {
            period: "2026-Q2",
          },
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:obligation.scan"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toEqual({
      command: "obligation.scan",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        created: true,
        obligationIds: ["obligation-1"],
        externalExecution: "blocked",
      },
    });
    expect(mocks.scanObligations).toHaveBeenCalledWith({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "core-app-server-obligation-scan-001",
      scope: {
        domain: "payroll",
      },
      jurisdiction: "US",
      asOf: undefined,
      dueAt: undefined,
      rulePackId: "55555555-5555-4555-8555-000000000008",
      filingRequirementId: "55555555-5555-4555-8555-000000000010",
      facts: {
        period: "2026-Q2",
      },
      data: {},
    });
  });

  it("rejects caller-owned Core obligation scan lineage fields through app-server tools", async () => {
    await expect(
      executeAppServerCoreTool(
        "continuous.core.command",
        {
          command: "obligation.scan",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-app-server-obligation-scan-002",
          config: {
            jurisdiction: "US",
            taskId: "task-1",
          },
        },
        {
          operatorEmail: "owner@continuoushq.com",
          source: "control_plane",
          allowedAccess: ["write"],
          allowedCommands: ["core:obligation.scan"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["*"],
        },
      ),
    ).rejects.toThrow("workflow linkage is owned by workflow execution");
    expect(mocks.scanObligations).not.toHaveBeenCalled();
  });

  it("dispatches Core worker identity lifecycle through the app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "worker.upsert",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-worker-upsert-001",
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
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:worker.upsert"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    expect(result).toEqual({
      command: "worker.upsert",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        recorded: true,
        workerId: "worker-1",
      },
    });
    expect(mocks.upsertCoreWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "core-app-server-worker-upsert-001",
        tenantSlug: "continuous-demo",
        role: "revenue_operations",
        kind: "synthetic",
        state: "training",
        name: "Revenue Operations Worker",
        mission: "Prepare quote-to-cash packets with blocked external execution.",
        autonomyLevel: 1,
        policy: {
          externalExecution: "blocked",
        },
      }),
    );
  });

  it("dispatches Core worker transition lifecycle through the app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "worker.transition",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-worker-transition-001",
        config: {
          role: "revenue_operations",
          workerId: "22222222-2222-4222-8222-222222222222",
          toState: "active",
          reason: "Lifecycle smoke promoted the worker.",
          evidence: {
            source: "app_server_core_lifecycle_test",
          },
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:worker.transition"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    expect(result).toEqual({
      command: "worker.transition",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        transitioned: true,
        workerId: "worker-1",
      },
    });
    expect(mocks.transitionCoreWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "core-app-server-worker-transition-001",
        tenantSlug: "continuous-demo",
        workerId: "22222222-2222-4222-8222-222222222222",
        toState: "active",
        reason: "Lifecycle smoke promoted the worker.",
        evidence: {
          source: "app_server_core_lifecycle_test",
        },
      }),
    );
  });

  it("requires worker-role-scoped transport for Core worker lifecycle commands", async () => {
    mocks.transitionCoreWorker.mockClear();

    await expect(
      executeAppServerCoreTool(
        "continuous.core.command",
        {
          command: "worker.transition",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-app-server-worker-transition-missing-role-001",
          config: {
            workerId: "22222222-2222-4222-8222-222222222222",
            toState: "active",
            reason: "Missing role should fail before dispatch.",
          },
        },
        {
          operatorEmail: "owner@continuoushq.com",
          source: "control_plane",
          allowedAccess: ["write"],
          allowedCommands: ["core:worker.transition"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["revenue_operations"],
        },
      ),
    ).rejects.toThrow("continuous.core.command requires worker.role for scoped worker lifecycle access.");

    await expect(
      executeAppServerCoreTool(
        "continuous.core.command",
        {
          command: "worker.transition",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-app-server-worker-transition-forbidden-role-001",
          config: {
            role: "revenue_operations",
            workerId: "22222222-2222-4222-8222-222222222222",
            toState: "active",
            reason: "Wrong role scope should fail before dispatch.",
          },
        },
        {
          operatorEmail: "owner@continuoushq.com",
          source: "control_plane",
          allowedAccess: ["write"],
          allowedCommands: ["core:worker.transition"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["finance_operations"],
        },
      ),
    ).rejects.toThrow("continuous.core.command transport context is not allowed for this worker role.");

    await expect(
      executeAppServerCoreTool(
        "continuous.core.command",
        {
          command: "worker.transition",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-app-server-worker-transition-unscoped-role-001",
          config: {
            role: "revenue_operations",
            workerId: "22222222-2222-4222-8222-222222222222",
            toState: "active",
            reason: "Empty role scope should fail before dispatch.",
          },
        },
        {
          operatorEmail: "owner@continuoushq.com",
          source: "control_plane",
          allowedAccess: ["write"],
          allowedCommands: ["core:worker.transition"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: [],
        },
      ),
    ).rejects.toThrow("continuous.core.command requires scoped worker-role transport context.");

    expect(mocks.transitionCoreWorker).not.toHaveBeenCalled();
  });

  it("dispatches Core worker-run lifecycle commands through the app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "worker.run.start",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-worker-run-start-001",
        config: {
          worker: {
            role: "revenue_operations",
            id: "22222222-2222-4222-8222-222222222222",
          },
          command: "quote.prepare",
          mode: "dry_run",
          capabilityKey: "quote.prepare",
          budgetAccountId: "44444444-4444-4444-8444-444444444444",
          units: 1200,
          input: {
            leadObjectId: "lead-1",
          },
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:worker.run.start"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    expect(result).toEqual({
      command: "worker.run.start",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        started: true,
        workerRunId: "run-1",
      },
    });
    expect(mocks.startCoreWorkerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "core-app-server-worker-run-start-001",
        tenantSlug: "continuous-demo",
        worker: {
          role: "revenue_operations",
          id: "22222222-2222-4222-8222-222222222222",
        },
        command: "quote.prepare",
        mode: "dry_run",
        capabilityKey: "quote.prepare",
        budgetAccountId: "44444444-4444-4444-8444-444444444444",
        units: 1200,
      }),
    );
  });

  it("dispatches Core worker-run completion through the app-server command envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.command",
      {
        command: "worker.run.complete",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-worker-run-complete-001",
        config: {
          worker: {
            role: "revenue_operations",
            id: "22222222-2222-4222-8222-222222222222",
          },
          workerRunId: "run-1",
          state: "done",
          reason: "Quote packet prepared with blocked external execution.",
          output: {
            packetId: "packet-1",
          },
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["core:worker.run.complete"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
      },
    );

    expect(result).toEqual({
      command: "worker.run.complete",
      core: {
        tenantSlug: "continuous-demo",
      },
      result: {
        completed: true,
        workerRunId: "run-1",
      },
    });
    expect(mocks.completeCoreWorkerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "core-app-server-worker-run-complete-001",
        tenantSlug: "continuous-demo",
        worker: {
          role: "revenue_operations",
          id: "22222222-2222-4222-8222-222222222222",
        },
        workerRunId: "run-1",
        state: "done",
        reason: "Quote packet prepared with blocked external execution.",
        output: {
          packetId: "packet-1",
        },
      }),
    );
  });

  it("dispatches Core summary views through the canonical app-server view envelope", async () => {
    const result = await executeAppServerCoreTool(
      "continuous.core.view",
      {
        view: "summary",
        core: {
          tenantSlug: "continuous-demo",
        },
        config: {},
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["read"],
        allowedCommands: ["core:view.summary"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toEqual({
      core: {
        tenantSlug: "continuous-demo",
      },
      view: "summary",
      health: {
        status: "ok",
      },
      summary: {
        counts: {
          tasks: 1,
        },
      },
      error: null,
    });
    expect(mocks.getCoreSummarySafe).toHaveBeenCalledWith({
      tenantSlug: "continuous-demo",
    });
  });

  it("sanitizes Core summary view errors", async () => {
    mocks.getCoreSummarySafe.mockResolvedValue({
      ok: false,
      error: "redaction-sentinel-alpha redaction-sentinel-beta",
      summary: {
        counts: {
          tasks: 0,
        },
        activeTasks: [],
        recentEvents: [],
      },
    });
    mocks.getHealth.mockReturnValue({
      status: "degraded",
      dbError: "Core summary is unavailable.",
    });

    const result = await executeAppServerCoreTool(
      "continuous.core.view",
      {
        view: "summary",
        core: {
          tenantSlug: "continuous-demo",
        },
        config: {},
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["read"],
        allowedCommands: ["core:view.summary"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: "Core summary is unavailable.",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("redaction-sentinel-alpha");
    expect(JSON.stringify(result)).not.toContain("redaction-sentinel-beta");
    expect(mocks.getHealth).toHaveBeenCalledWith({
      dbOk: false,
      dbError: "Core summary is unavailable.",
      counts: {
        tasks: 0,
      },
    });
  });

  it("keeps operation-specific Core command fields under config", async () => {
    await expect(
      executeAppServerCoreTool("continuous.core.command", {
        command: "task.create",
        core: {
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "core-app-server-bad-envelope-001",
        title: "Bad top-level field",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.core.command payload fields must be command, core, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: title.",
    );
  });

  it("wraps dynamic Core tool errors in Codex-compatible content items", async () => {
    const response = await executeAppServerCoreDynamicToolCall({
      tool: "continuous.core.command",
      arguments: null,
      callId: "core-call-001",
      threadId: "thread-001",
      turnId: "turn-001",
    });
    const item = response.contentItems[0];
    const payload = JSON.parse(item?.type === "inputText" ? item.text : "{}");

    expect(response.success).toBe(false);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: false,
        tool: "continuous.core.command",
        callId: "core-call-001",
        data: null,
        error: "Dynamic app-server Core tool arguments must be an object.",
      }),
    );
  });
});
