import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeManagedControlPlaneCredential: vi.fn(),
  decideApproval: vi.fn(),
  executeWorkflowSteps: vi.fn(),
  listApprovals: vi.fn(),
  listWorkflows: vi.fn(),
  recordControlPlaneAuthAttempt: vi.fn(),
  startWorkflowRun: vi.fn(),
  transitionWorkflowRun: vi.fn(),
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

vi.mock("../../src/core/approvals", () => ({
  decideApproval: mocks.decideApproval,
  listApprovals: mocks.listApprovals,
  normalizeApprovalDecision: (value: unknown) =>
    value === "approved" || value === "rejected" || value === "revision_requested"
      ? value
      : undefined,
}));

vi.mock("../../src/core/workflows", () => ({
  executeWorkflowSteps: mocks.executeWorkflowSteps,
  listWorkflows: mocks.listWorkflows,
  startWorkflowRun: mocks.startWorkflowRun,
  transitionWorkflowRun: mocks.transitionWorkflowRun,
}));

vi.mock("../../src/core/control-plane-auth", () => ({
  authorizeManagedControlPlaneCredential: mocks.authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt: mocks.recordControlPlaneAuthAttempt,
}));

vi.mock("../../src/worker/revenue", () => ({
  RevenueWorkerUnavailableError: class RevenueWorkerUnavailableError extends Error {
    status = 503;
    code = "worker_unavailable";
  },
}));

describe("/workflow route scope", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(mocks.env, {
      APP_ENV: "test",
      WORKER_RUN_ENABLED: true,
      WORKER_RUN_TOKEN: "test-token",
      WORKER_OPERATOR_EMAIL: "operator@example.com",
      CONTROL_PLANE_ALLOWED_TENANTS: undefined,
      CONTROL_PLANE_ALLOWED_WORKER_ROLES: undefined,
      CONTROL_PLANE_TOKENS_JSON: JSON.stringify([
        {
          id: "workflow-route-test",
          token: "test-token",
          operatorEmail: "operator@example.com",
          allowedRoutes: ["workflow"],
          allowedAccess: ["read", "write"],
          allowedCommands: ["workflow:*"],
        },
      ]),
      CONTROL_PLANE_TOKEN_CATALOG_B64: undefined,
    });
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({ ok: true });
    mocks.recordControlPlaneAuthAttempt.mockResolvedValue({ id: "auth-session-1" });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("rejects scoped reads without a tenant before listing workflows", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/workflow?view=overview", {
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
    expect(mocks.listWorkflows).not.toHaveBeenCalled();
  });

  it("rejects scoped writes outside the tenant allowlist before starting workflows", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "start",
          workflow: {
            key: "lead_to_cash",
            tenantSlug: "other-tenant",
          },
          idempotencyKey: "workflow-scope-test-001",
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
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("allows scoped workflow reads for an allowed tenant", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listWorkflows.mockResolvedValue({
      view: "overview",
      workflows: [],
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/workflow?tenantSlug=continuous-demo", {
        headers: {
          authorization: "Bearer test-token",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.listWorkflows).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      state: undefined,
    });
  });

  it("transitions workflows through the canonical command envelope", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.transitionWorkflowRun.mockResolvedValue({
      created: true,
      replayed: false,
      stepId: "step-1",
      eventId: "event-1",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "transition",
          workflow: {
            runId: "workflow-run-1",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "workflow-transition-001",
          config: {
            toState: "awaiting_approval",
            reason: "Preview packet is ready",
            data: {
              packetId: "packet-1",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("transition");
    expect(mocks.transitionWorkflowRun).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      runId: "workflow-run-1",
      toState: "awaiting_approval",
      idempotencyKey: "workflow-transition-001",
      reason: "Preview packet is ready",
      data: {
        packetId: "packet-1",
      },
      blockers: {},
      metrics: {},
    });
  });

  it("rejects invalid workflow command bodies before dispatch", async () => {
    const { POST } = await import("./route");

    const missingContentType = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          command: "steps.execute",
        }),
      }),
    );
    const invalidContentType = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          command: "steps.execute",
        }),
      }),
    );
    const jsonpContentType = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/jsonp",
        },
        body: JSON.stringify({
          command: "steps.execute",
        }),
      }),
    );
    const malformedJson = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    const arrayBody = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify([]),
      }),
    );

    await expect(missingContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_workflow_command_body",
        message: "POST /workflow requires an application/json request body.",
      },
    });
    await expect(invalidContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_workflow_command_body",
        message: "POST /workflow requires an application/json request body.",
      },
    });
    await expect(jsonpContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_workflow_command_body",
        message: "POST /workflow requires an application/json request body.",
      },
    });
    await expect(malformedJson.json()).resolves.toMatchObject({
      error: {
        code: "invalid_workflow_command_body",
        message: "Workflow command body must be valid JSON.",
      },
    });
    await expect(arrayBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_workflow_command_body",
        message: "Workflow command body must be a JSON object.",
      },
    });
    expect(missingContentType.status).toBe(415);
    expect(invalidContentType.status).toBe(415);
    expect(jsonpContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(arrayBody.status).toBe(400);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.transitionWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.executeWorkflowSteps).not.toHaveBeenCalled();
  });

  it("rejects workflow transitions without an idempotency key before dispatch", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "transition",
          workflow: {
            runId: "workflow-run-1",
            tenantSlug: "continuous-demo",
          },
          config: {
            toState: "awaiting_approval",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_transition",
      message: "A string idempotency key is required.",
    });
    expect(mocks.transitionWorkflowRun).not.toHaveBeenCalled();
  });

  it("executes workflow steps through the canonical command envelope", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.executeWorkflowSteps.mockResolvedValue({
      processed: 1,
      completed: 1,
      failed: 0,
      results: [{ stepId: "step-1", state: "done" }],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "steps.execute",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {
            limit: 2,
            leaseOwner: "route-test",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("steps.execute");
    expect(mocks.executeWorkflowSteps).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      limit: 2,
      leaseOwner: "route-test",
      leaseMs: undefined,
    });
  });

  it("rejects ad hoc top-level workflow command fields", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "steps.execute",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          limit: 99,
          approvalId: "approval-1",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_command_envelope",
      message:
        "Workflow command payload fields must be command, workflow, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: limit, approvalId.",
    });
    expect(mocks.executeWorkflowSteps).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow command config before dispatch", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "steps.execute",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: "run steps",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_command_config",
      message: "config must be an object when provided.",
    });
    expect(mocks.executeWorkflowSteps).not.toHaveBeenCalled();
  });
});
