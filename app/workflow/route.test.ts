import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformUnavailableError } from "../../src/core/errors";
import { WorkerUnavailableError } from "../../src/worker/errors";

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

vi.mock("../../src/worker/errors", () => ({
  WorkerUnavailableError: class WorkerUnavailableError extends Error {
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
          allowedCommands: [
            "workflow:view.overview",
            "workflow:view.approvals",
            "workflow:start",
            "workflow:transition",
            "workflow:steps.execute",
            "workflow:approval.decide",
          ],
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

  it("rejects query-shaped workflow reads", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.error).toEqual({
      code: "workflow_view_payload_required",
      message:
        "Workflow reads use POST /workflow with a JSON payload containing view, workflow, and config. Put read filters under config.",
    });
  });

  it("rejects scoped reads without a tenant before listing workflows", async () => {
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
          view: "overview",
          workflow: {},
          config: {},
        }),
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

  it("requires managed credential inventory before workflow dispatch", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({
      ok: false,
      status: 403,
      code: "control_plane_credential_required",
      message: "Managed control-plane credential inventory is required for this control-plane route.",
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
          command: "start",
          workflow: {
            key: "lead_to_cash",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "workflow-managed-required-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_credential_required",
      message: "Managed control-plane credential inventory is required for this control-plane route.",
    });
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "workflow",
        access: "write",
        command: "start",
        tenantSlug: "continuous-demo",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects unauthorized workflow commands before reading the request body", async () => {
    const getReader = vi.fn(() => {
      throw new Error("Body should not be read before auth succeeds.");
    });
    const { POST } = await import("./route");
    const response = await POST({
      url: "http://localhost/workflow",
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
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.transitionWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.executeWorkflowSteps).not.toHaveBeenCalled();
  });

  it("allows scoped workflow reads for an allowed tenant", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listWorkflows.mockResolvedValue({
      view: "overview",
      workflows: [],
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
          view: "overview",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "workflow",
        access: "read",
        command: "view.overview",
        tenantSlug: "continuous-demo",
        requireManagedCredential: true,
      }),
    );
    expect(mocks.listWorkflows).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      state: undefined,
    });
  });

  it("rejects top-level workflow read filters outside the view envelope", async () => {
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
          view: "overview",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          state: "active",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_view_envelope",
      message:
        "Workflow view payload fields must be view, workflow, and config. Move read filters into config. Unexpected fields: state.",
    });
    expect(mocks.listWorkflows).not.toHaveBeenCalled();
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
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "workflow",
        access: "write",
        command: "transition",
        tenantSlug: "continuous-demo",
        requireManagedCredential: true,
      }),
    );
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

  it("rejects oversized workflow command bodies before JSON parsing", async () => {
    const { POST } = await import("./route");
    const byContentLength = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "content-length": "1048577",
        },
        body: JSON.stringify({
          command: "steps.execute",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "oversized-workflow-body-001",
          config: {},
        }),
      }),
    );
    const byStream = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "x".repeat(1_048_577),
      }),
    );

    for (const response of [byContentLength, byStream]) {
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toEqual({
        code: "workflow_command_body_too_large",
        message: "Workflow command body must be at most 1048576 bytes.",
      });
    }
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

  it("does not treat idempotency-key as a workflow payload fallback", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "header-workflow-key-001",
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

  it("rejects workflow approval decisions without an idempotency key before dispatch", async () => {
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
          command: "approval.decide",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {
            approvalId: "approval-1",
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_approval_decision",
      message: "A string idempotency key is required.",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("does not treat idempotency-key as a workflow approval payload fallback", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "header-workflow-approval-key-001",
        },
        body: JSON.stringify({
          command: "approval.decide",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {
            approvalId: "approval-1",
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_workflow_approval_decision",
      message: "A string idempotency key is required.",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
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

  it("sanitizes workflow step execution errors in command responses", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.executeWorkflowSteps.mockResolvedValue({
      processed: 1,
      completed: 0,
      failed: 1,
      skipped: 0,
      results: [
        {
          stepId: "step-1",
          state: "failed",
          attempt: 1,
          handler: "worker_command",
          error: {
            code: "workflow_step_execution_failed",
            message: "postgres://workflow-secret/provider-token",
            retryable: false,
          },
        },
      ],
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
            limit: 1,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.result.results[0].error).toEqual(
      expect.objectContaining({
        code: "workflow_step_execution_failed",
        message: "Workflow step execution failed.",
        retryable: false,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("workflow-secret");
    expect(JSON.stringify(body)).not.toContain("provider-token");
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

  it("preserves mapped workflow service failures", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listWorkflows.mockRejectedValueOnce(
      new PlatformUnavailableError(
        "workflow_overview_unavailable",
        "Workflow overview is unavailable.",
        503,
      ),
    );
    mocks.listApprovals.mockRejectedValueOnce(
      new WorkerUnavailableError(
        "Workflow approvals are unavailable.",
        "Workflow approvals are unavailable.",
        503,
      ),
    );
    mocks.startWorkflowRun.mockRejectedValueOnce(
      new PlatformUnavailableError(
        "workflow_definition_missing",
        "Workflow definition is missing.",
        404,
      ),
    );
    mocks.transitionWorkflowRun.mockRejectedValueOnce(
      new PlatformUnavailableError(
        "workflow_transition_invalid",
        "Workflow transition is not allowed.",
        409,
      ),
    );
    mocks.executeWorkflowSteps.mockRejectedValueOnce(
      new PlatformUnavailableError(
        "workflow_step_execution_blocked",
        "Workflow step execution is blocked.",
        423,
      ),
    );
    mocks.decideApproval.mockRejectedValueOnce(
      new PlatformUnavailableError(
        "workflow_approval_decision_invalid",
        "Workflow approval decision is invalid.",
        422,
      ),
    );

    const { POST } = await import("./route");
    const overview = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "overview",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const approvals = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "approvals",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const start = await POST(
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
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "workflow-start-failure-map",
          config: {},
        }),
      }),
    );
    const transition = await POST(
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
          idempotencyKey: "workflow-transition-failure-map",
          config: {
            toState: "blocked",
          },
        }),
      }),
    );
    const steps = await POST(
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
            limit: 1,
          },
        }),
      }),
    );
    const approval = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "workflow-approval-failure-map",
          config: {
            approvalId: "approval-1",
            action: "approved",
          },
        }),
      }),
    );

    await expect(overview.json()).resolves.toMatchObject({
      error: {
        code: "workflow_overview_unavailable",
        message: "Workflow command failed.",
      },
    });
    await expect(approvals.json()).resolves.toMatchObject({
      error: {
        code: "worker_unavailable",
        message: "Workflow command failed.",
      },
    });
    await expect(start.json()).resolves.toMatchObject({
      error: {
        code: "workflow_definition_missing",
        message: "Workflow definition is missing.",
      },
    });
    await expect(transition.json()).resolves.toMatchObject({
      error: {
        code: "workflow_transition_invalid",
        message: "Workflow transition is not allowed.",
      },
    });
    await expect(steps.json()).resolves.toMatchObject({
      error: {
        code: "workflow_step_execution_blocked",
        message: "Workflow step execution is blocked.",
      },
    });
    await expect(approval.json()).resolves.toMatchObject({
      error: {
        code: "workflow_approval_decision_invalid",
        message: "Workflow approval decision is invalid.",
      },
    });
    expect(overview.status).toBe(503);
    expect(approvals.status).toBe(503);
    expect(start.status).toBe(404);
    expect(transition.status).toBe(409);
    expect(steps.status).toBe(423);
    expect(approval.status).toBe(422);
    expect(mocks.decideApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      idempotencyKey: "workflow-approval-failure-map",
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: undefined,
      subject: "workflow",
    });
  });

  it("sanitizes unexpected workflow failures", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listWorkflows.mockRejectedValue(new Error("workflow secret dsn postgres://internal"));

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/workflow", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "overview",
          workflow: {
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toEqual({
      code: "workflow_list_failed",
      message: "Workflow command failed.",
    });
    expect(JSON.stringify(body)).not.toContain("postgres://internal");
  });
});
