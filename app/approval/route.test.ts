import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeManagedControlPlaneCredential: vi.fn(),
  decideApproval: vi.fn(),
  listApprovals: vi.fn(),
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

vi.mock("../../src/core/approvals", () => ({
  decideApproval: mocks.decideApproval,
  listApprovals: mocks.listApprovals,
  normalizeApprovalDecision: (value: unknown) =>
    value === "approved" || value === "rejected" || value === "revision_requested"
      ? value
      : null,
}));

vi.mock("../../src/core/control-plane-auth", () => ({
  authorizeManagedControlPlaneCredential: mocks.authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt: mocks.recordControlPlaneAuthAttempt,
}));

describe("/approval route", () => {
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
          id: "approval-route-test",
          token: "test-token",
          operatorEmail: "operator@example.com",
          allowedRoutes: ["approval"],
          allowedAccess: ["read", "write"],
          allowedCommands: ["approval:*"],
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

  it("rejects scoped approval reads without a tenant before listing approvals", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/approval?view=inbox", {
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
    expect(mocks.listApprovals).not.toHaveBeenCalled();
  });

  it("lists shared approvals for an allowed tenant and subject", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listApprovals.mockResolvedValue({
      operator: {
        tenantSlug: "continuous-demo",
      },
      subject: "worker",
      approvals: [],
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/approval?tenantSlug=continuous-demo&state=pending&subject=worker", {
        headers: {
          authorization: "Bearer test-token",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.api).toBe("continuous.approval.v1");
    expect(body.data.view).toBe("inbox");
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      state: "pending",
      subject: "worker",
      priority: undefined,
      risk: undefined,
      kind: undefined,
    });
  });

  it("passes shared approval inbox filters without widening the route surface", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.listApprovals.mockResolvedValue({
      operator: {
        tenantSlug: "continuous-demo",
      },
      subject: "workflow",
      filters: {
        state: "all",
        priority: "urgent",
        risk: "high",
        kind: "payroll_preview_approval",
      },
      approvals: [],
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/approval?tenantSlug=continuous-demo&state=all&subject=workflow&priority=urgent&risk=high&kind=payroll_preview_approval",
        {
          headers: {
            authorization: "Bearer test-token",
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      state: undefined,
      subject: "workflow",
      priority: "urgent",
      risk: "high",
      kind: "payroll_preview_approval",
    });
  });

  it("rejects unsupported approval subjects instead of widening scope", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/approval?tenantSlug=continuous-demo&subject=everything", {
        headers: {
          authorization: "Bearer test-token",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_approval_subject",
      message: "Approval subject must be all, core, worker, workflow, or task.",
    });
    expect(mocks.listApprovals).not.toHaveBeenCalled();
  });

  it("dispatches platform approval decisions through the shared envelope", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.decideApproval.mockResolvedValue({
      decided: true,
      approvalRequestId: "77777777-7777-4777-8777-000000000001",
      state: "approved",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
            subject: "core",
          },
          config: {
            action: "approved",
            note: "Looks correct.",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("approval.decide");
    expect(body.data.approval).toEqual({
      id: "77777777-7777-4777-8777-000000000001",
      tenantSlug: "continuous-demo",
      subject: "core",
    });
    expect(mocks.decideApproval).toHaveBeenCalledWith({
      approvalId: "77777777-7777-4777-8777-000000000001",
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Looks correct.",
      subject: "core",
    });
  });

  it("rejects invalid approval command bodies before dispatch", async () => {
    const { POST } = await import("./route");

    const missingContentType = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          command: "approval.decide",
        }),
      }),
    );
    const invalidContentType = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          command: "approval.decide",
        }),
      }),
    );
    const jsonpContentType = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/jsonp",
        },
        body: JSON.stringify({
          command: "approval.decide",
        }),
      }),
    );
    const malformedJson = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    const arrayBody = await POST(
      new Request("http://localhost/approval", {
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
        code: "invalid_approval_command_body",
        message: "POST /approval requires an application/json request body.",
      },
    });
    await expect(invalidContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_approval_command_body",
        message: "POST /approval requires an application/json request body.",
      },
    });
    await expect(jsonpContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_approval_command_body",
        message: "POST /approval requires an application/json request body.",
      },
    });
    await expect(malformedJson.json()).resolves.toMatchObject({
      error: {
        code: "invalid_approval_command_body",
        message: "Approval command body must be valid JSON.",
      },
    });
    await expect(arrayBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_approval_command_body",
        message: "Approval command body must be a JSON object.",
      },
    });
    expect(missingContentType.status).toBe(415);
    expect(invalidContentType.status).toBe(415);
    expect(jsonpContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(arrayBody.status).toBe(400);
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects broad approval decision subjects before dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
            subject: "all",
          },
          config: {
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "approval_subject_too_broad",
      message: "approval.subject must be core, worker, workflow, or task for approval.decide.",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects ad hoc top-level approval command fields", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approvalId: "77777777-7777-4777-8777-000000000001",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
          },
          config: {
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_approval_command_envelope");
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects malformed approval command config before dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
          },
          config: "approved",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_approval_command_config",
      message: "config must be an object when provided.",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects invalid approval decisions before dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
            subject: "worker",
          },
          config: {
            action: "send_it",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_approval_decision");
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects approval decisions without an explicit subject", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
          },
          config: {
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "approval_subject_required",
      message: "approval.subject is required for approval.decide.",
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects unsupported decision subjects before dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/approval", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "approval.decide",
          approval: {
            id: "77777777-7777-4777-8777-000000000001",
            tenantSlug: "continuous-demo",
            subject: "everything",
          },
          config: {
            action: "approved",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_approval_subject");
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });
});
