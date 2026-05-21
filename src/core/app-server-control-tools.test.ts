import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decideApproval: vi.fn(),
  executeWorkflowSteps: vi.fn(),
  listApprovals: vi.fn(),
  listWorkflows: vi.fn(),
  startWorkflowRun: vi.fn(),
  transitionWorkflowRun: vi.fn(),
}));

vi.mock("./approvals", () => ({
  decideApproval: mocks.decideApproval,
  listApprovals: mocks.listApprovals,
  normalizeApprovalDecision: (value: unknown) =>
    value === "approved" || value === "rejected" || value === "revision_requested"
      ? value
      : null,
}));

vi.mock("./workflows", () => ({
  executeWorkflowSteps: mocks.executeWorkflowSteps,
  listWorkflows: mocks.listWorkflows,
  startWorkflowRun: mocks.startWorkflowRun,
  transitionWorkflowRun: mocks.transitionWorkflowRun,
}));

import {
  appServerControlToolManifest,
  executeAppServerControlDynamicToolCall,
  executeAppServerControlTool,
} from "./app-server-control-tools";

const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

beforeEach(() => {
  process.env.WORKER_OPERATOR_EMAIL = "owner@continuoushq.com";
  mocks.listWorkflows.mockResolvedValue({
    operator: { tenantSlug: "continuous-demo" },
    definitions: [],
    runs: [],
    steps: [],
  });
  mocks.startWorkflowRun.mockResolvedValue({
    started: true,
    workflowRunId: "workflow-run-1",
  });
  mocks.transitionWorkflowRun.mockResolvedValue({
    transitioned: true,
    workflowRunId: "workflow-run-1",
  });
  mocks.executeWorkflowSteps.mockResolvedValue({
    executed: true,
    results: [],
  });
  mocks.listApprovals.mockResolvedValue({
    operator: { tenantSlug: "continuous-demo" },
    subject: "worker",
    approvals: [],
  });
  mocks.decideApproval.mockResolvedValue({
    approvalId: "approval-1",
    action: "approved",
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

describe("app-server workflow and approval tools", () => {
  it("exposes shared control schemas with canonical route metadata", async () => {
    const workflowSchema = (await executeAppServerControlTool("continuous.workflow.schema")) as {
      registry: {
        commands: Array<{ name: string; apiRoute: string; tool: string; idempotency: string }>;
        views: Array<{ name: string; apiRoute: string; tool: string }>;
      };
    };
    const approvalSchema = (await executeAppServerControlTool("continuous.approval.schema")) as {
      registry: {
        commands: Array<{ name: string; apiRoute: string; tool: string; idempotency: string }>;
        views: Array<{ name: string; apiRoute: string; tool: string }>;
      };
    };

    expect(appServerControlToolManifest.mode).toBe("registry_backed_control_plane");
    expect(appServerControlToolManifest.tools.map((tool) => tool.name)).toEqual([
      "continuous.workflow.schema",
      "continuous.workflow.command",
      "continuous.workflow.view",
      "continuous.approval.schema",
      "continuous.approval.command",
      "continuous.approval.view",
    ]);
    const approvalCommandTool = appServerControlToolManifest.tools.find(
      (tool) => tool.name === "continuous.approval.command",
    );
    const approvalCommandTarget = (
      approvalCommandTool?.inputSchema as {
        $defs: {
          approvalTarget: {
            required: string[];
            properties: {
              subject: {
                enum: string[];
              };
            };
          };
        };
      }
    ).$defs.approvalTarget;

    expect(approvalCommandTarget.required).toEqual(["tenantSlug", "id", "subject"]);
    expect(approvalCommandTarget.properties.subject.enum).toEqual([
      "core",
      "worker",
      "workflow",
      "task",
    ]);
    expect(workflowSchema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "start",
          apiRoute: "/workflow",
          tool: "continuous.workflow.command",
          idempotency: "required",
        }),
        expect.objectContaining({
          name: "steps.execute",
          apiRoute: "/workflow",
          idempotency: "not_required",
        }),
      ]),
    );
    expect(workflowSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "overview",
          apiRoute: "/workflow",
          tool: "continuous.workflow.view",
        }),
      ]),
    );
    expect(approvalSchema.registry.commands).toEqual([
      expect.objectContaining({
        name: "approval.decide",
        apiRoute: "/approval",
        tool: "continuous.approval.command",
        idempotency: "required",
      }),
    ]);
    expect(approvalSchema.registry.views).toEqual([
      expect.objectContaining({
        name: "inbox",
        apiRoute: "/approval",
        tool: "continuous.approval.view",
      }),
    ]);
  });

  it("dispatches workflow views through scoped app-server transport context", async () => {
    const result = await executeAppServerControlTool(
      "continuous.workflow.view",
      {
        view: "overview",
        workflow: {
          tenantSlug: "continuous-demo",
        },
        config: {
          state: "active",
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["read"],
        allowedCommands: ["workflow:view.overview"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toMatchObject({
      view: "overview",
      workflow: {
        tenantSlug: "continuous-demo",
      },
    });
    expect(mocks.listWorkflows).toHaveBeenCalledWith({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      state: "active",
    });
  });

  it("dispatches workflow starts through the canonical app-server command envelope", async () => {
    const result = await executeAppServerControlTool(
      "continuous.workflow.command",
      {
        command: "start",
        workflow: {
          key: "lead_to_cash",
          tenantSlug: "continuous-demo",
          objectId: "33333333-3333-4333-8333-000000000001",
        },
        idempotencyKey: "workflow-app-server-start-001",
        config: {
          initialState: "started",
          data: {
            source: "app_server_control_test",
          },
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["workflow:start"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(result).toEqual({
      command: "start",
      workflow: {
        key: "lead_to_cash",
        runId: null,
        tenantSlug: "continuous-demo",
      },
      result: {
        started: true,
        workflowRunId: "workflow-run-1",
      },
    });
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorEmail: "owner@continuoushq.com",
        workflowKey: "lead_to_cash",
        idempotencyKey: "workflow-app-server-start-001",
        tenantSlug: "continuous-demo",
        objectId: "33333333-3333-4333-8333-000000000001",
      }),
    );
  });

  it("keeps workflow step execution idempotency-free while preserving config boundaries", async () => {
    await executeAppServerControlTool(
      "continuous.workflow.command",
      {
        command: "steps.execute",
        workflow: {
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 3,
          leaseOwner: "app-server-control-test",
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["workflow:steps.execute"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(mocks.executeWorkflowSteps).toHaveBeenCalledWith({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 3,
      leaseOwner: "app-server-control-test",
      leaseMs: undefined,
    });
  });

  it("dispatches approval inbox reads and decisions through shared approval tools", async () => {
    const inbox = await executeAppServerControlTool(
      "continuous.approval.view",
      {
        view: "inbox",
        approval: {
          tenantSlug: "continuous-demo",
          subject: "worker",
        },
        config: {
          state: "pending",
          risk: "high",
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["read"],
        allowedCommands: ["approval:view.inbox"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    const decision = await executeAppServerControlTool(
      "continuous.approval.command",
      {
        command: "approval.decide",
        approval: {
          id: "77777777-7777-4777-8777-000000000001",
          tenantSlug: "continuous-demo",
          subject: "core",
        },
        idempotencyKey: "approval-app-server-decision-001",
        config: {
          action: "approved",
          note: "Approved through shared app-server control plane.",
        },
      },
      {
        operatorEmail: "owner@continuoushq.com",
        source: "control_plane",
        allowedAccess: ["write"],
        allowedCommands: ["approval:approval.decide"],
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["*"],
      },
    );

    expect(inbox).toMatchObject({
      view: "inbox",
      approval: {
        tenantSlug: "continuous-demo",
        subject: "worker",
      },
    });
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      state: "pending",
      subject: "worker",
      priority: undefined,
      risk: "high",
      kind: undefined,
    });
    expect(decision).toEqual({
      command: "approval.decide",
      approval: {
        id: "77777777-7777-4777-8777-000000000001",
        tenantSlug: "continuous-demo",
        subject: "core",
      },
      result: {
        approvalId: "approval-1",
        action: "approved",
      },
    });
    expect(mocks.decideApproval).toHaveBeenCalledWith({
      approvalId: "77777777-7777-4777-8777-000000000001",
      idempotencyKey: "approval-app-server-decision-001",
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Approved through shared app-server control plane.",
      subject: "core",
    });
  });

  it("rejects top-level operation inputs outside arguments.config", async () => {
    await expect(
      executeAppServerControlTool(
        "continuous.workflow.command",
        {
          command: "transition",
          workflow: {
            runId: "workflow-run-1",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "workflow-app-server-bad-envelope-001",
          toState: "approved",
          config: {},
        },
        {
          operatorEmail: "owner@continuoushq.com",
          source: "control_plane",
          allowedAccess: ["write"],
          allowedCommands: ["workflow:transition"],
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["*"],
        },
      ),
    ).rejects.toThrow(
      "continuous.workflow.command arguments fields must be command, workflow, idempotencyKey, and config. Put operation inputs under arguments.config. Unexpected fields: toState.",
    );
  });

  it("rejects approval commands without a concrete approval subject selector", async () => {
    const context = {
      operatorEmail: "owner@continuoushq.com",
      source: "control_plane" as const,
      allowedAccess: ["write" as const],
      allowedCommands: ["approval:approval.decide"],
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["*"],
    };

    await expect(
      executeAppServerControlTool(
        "continuous.approval.command",
        {
          command: "approval.decide",
          approval: {
            tenantSlug: "continuous-demo",
            subject: "core",
          },
          idempotencyKey: "approval-missing-id-001",
          config: {
            action: "approved",
          },
        },
        context,
      ),
    ).rejects.toThrow("approval.id is required for approval commands.");

    await expect(
      executeAppServerControlTool(
        "continuous.approval.command",
        {
          command: "approval.decide",
          approval: {
            tenantSlug: "continuous-demo",
            id: "77777777-7777-4777-8777-000000000001",
          },
          idempotencyKey: "approval-missing-subject-001",
          config: {
            action: "approved",
          },
        },
        context,
      ),
    ).rejects.toThrow("approval.subject is required for approval commands.");

    await expect(
      executeAppServerControlTool(
        "continuous.approval.command",
        {
          command: "approval.decide",
          approval: {
            tenantSlug: "continuous-demo",
            id: "77777777-7777-4777-8777-000000000001",
            subject: "all",
          },
          idempotencyKey: "approval-all-subject-001",
          config: {
            action: "approved",
          },
        },
        context,
      ),
    ).rejects.toThrow("approval.subject must be core, worker, workflow, or task for approval commands.");
  });

  it("wraps dynamic control tool errors in Codex-compatible content items", async () => {
    const result = await executeAppServerControlDynamicToolCall({
      tool: "continuous.approval.command",
      arguments: null,
      callId: "bad-control-call",
      threadId: "thread-001",
      turnId: "turn-001",
    });
    const payload = JSON.parse(result.contentItems[0]?.text ?? "{}") as {
      ok: boolean;
      tool: string;
      error: string;
    };

    expect(result.success).toBe(false);
    expect(payload).toEqual({
      ok: false,
      tool: "continuous.approval.command",
      callId: "bad-control-call",
      data: null,
      error: "Dynamic app-server control tool arguments must be an object.",
    });
  });
});
