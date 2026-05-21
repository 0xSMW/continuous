import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeManagedControlPlaneCredential: vi.fn(),
  executeWorkerCommand: vi.fn(),
  executeWorkerView: vi.fn(),
  recordControlPlaneAuthAttempt: vi.fn(),
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

vi.mock("../../src/core/control-plane-auth", () => ({
  authorizeManagedControlPlaneCredential: mocks.authorizeManagedControlPlaneCredential,
  recordControlPlaneAuthAttempt: mocks.recordControlPlaneAuthAttempt,
}));

function mockedWorkerErrorStatus(error: unknown, fallbackCode: string) {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : fallbackCode;
  const fallbackMessage =
    fallbackCode === "worker_view_failed" ? "Worker view failed." : "Worker command failed.";

  return {
    status,
    code,
    message: status >= 500 ? fallbackMessage : error instanceof Error ? error.message : fallbackMessage,
  };
}

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
    mocks.workerErrorStatus.mockImplementation(mockedWorkerErrorStatus);
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({ ok: true });
    mocks.recordControlPlaneAuthAttempt.mockResolvedValue({ id: "auth-session-1" });
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
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "worker",
        access: "write",
        command: "brief.generate",
        tenantSlug: "continuous-demo",
        workerRole: "owner_chief_of_staff",
        requireManagedCredential: true,
      }),
    );
  });

  it("routes Compliance commands without a family-specific API path", async () => {
    const commandResult = {
      worker: {
        role: "compliance_operations",
        id: null,
        tenantSlug: "continuous-demo",
      },
      command: "filing.prepare",
      result: {
        filingDraftId: "filing-draft-1",
        externalExecution: "blocked",
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
        },
        body: JSON.stringify({
          command: "filing.prepare",
          worker: {
            role: "compliance_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "compliance-filing-001",
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
      command: "filing.prepare",
      target: {
        role: "compliance_operations",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
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
      idempotencyKey: "compliance-filing-001",
      operatorEmail: "operator@example.com",
    });
  });

  it("routes Customer Experience commands without a family-specific API path", async () => {
    const commandResult = {
      worker: {
        role: "customer_experience_operations",
        id: null,
        tenantSlug: "continuous-demo",
      },
      command: "recovery.draft",
      result: {
        recoveryObjectId: "recovery-object-1",
        externalExecution: "blocked",
        externalSend: false,
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
        },
        body: JSON.stringify({
          command: "recovery.draft",
          worker: {
            role: "customer_experience_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "customer-recovery-001",
          config: {
            sourceRefs: {
              customerObjectId: "customer-object-1",
              customerSignalObjectId: "signal-object-1",
              evidencePacketId: "packet-1",
            },
            policy: {
              tone: "calm",
              requiresOwnerApproval: true,
              allowExternalSend: false,
            },
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
      command: "recovery.draft",
      target: {
        role: "customer_experience_operations",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
      config: {
        sourceRefs: {
          customerObjectId: "customer-object-1",
          customerSignalObjectId: "signal-object-1",
          evidencePacketId: "packet-1",
        },
        policy: {
          tone: "calm",
          requiresOwnerApproval: true,
          allowExternalSend: false,
        },
      },
      idempotencyKey: "customer-recovery-001",
      operatorEmail: "operator@example.com",
    });
  });

  it("routes payment-link preparation through the canonical worker envelope", async () => {
    const commandResult = {
      worker: {
        role: "revenue_operations",
        id: null,
        tenantSlug: "continuous-demo",
      },
      command: "payment_link.prepare",
      result: {
        paymentObjectId: "payment-object-1",
        providerPaymentLinkCreation: "blocked",
        moneyMovement: "blocked",
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
        },
        body: JSON.stringify({
          command: "payment_link.prepare",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "payment-link-route-001",
          config: {
            invoiceObjectId: "33333333-3333-4333-8333-000000000006",
            sourceRefs: {
              quoteObjectId: "33333333-3333-4333-8333-000000000004",
            },
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
      command: "payment_link.prepare",
      target: {
        role: "revenue_operations",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
      config: {
        invoiceObjectId: "33333333-3333-4333-8333-000000000006",
        sourceRefs: {
          quoteObjectId: "33333333-3333-4333-8333-000000000004",
        },
      },
      idempotencyKey: "payment-link-route-001",
      operatorEmail: "operator@example.com",
    });
  });

  it("rejects unauthorized POST commands before reading the request body", async () => {
    const getReader = vi.fn(() => {
      throw new Error("Body should not be read before auth succeeds.");
    });
    const { POST } = await import("./route");
    const response = await POST({
      url: "http://localhost/worker",
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
      code: "worker_run_unauthorized",
      message: "Worker run token is invalid.",
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid worker payload bodies before registry dispatch", async () => {
    const { POST } = await import("./route");

    const missingContentType = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          command: "run",
        }),
      }),
    );
    const invalidContentType = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          command: "run",
        }),
      }),
    );
    const jsonpContentType = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/jsonp",
        },
        body: JSON.stringify({
          command: "run",
        }),
      }),
    );
    const malformedJson = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    const arrayBody = await POST(
      new Request("http://localhost/worker", {
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
        code: "invalid_worker_payload_body",
        message: "POST /worker requires an application/json request body.",
      },
    });
    await expect(invalidContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_payload_body",
        message: "POST /worker requires an application/json request body.",
      },
    });
    await expect(jsonpContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_payload_body",
        message: "POST /worker requires an application/json request body.",
      },
    });
    await expect(malformedJson.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_payload_body",
        message: "Worker payload body must be valid JSON.",
      },
    });
    await expect(arrayBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_payload_body",
        message: "Worker payload body must be a JSON object.",
      },
    });
    expect(missingContentType.status).toBe(415);
    expect(invalidContentType.status).toBe(415);
    expect(jsonpContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(arrayBody.status).toBe(400);
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects oversized worker payload bodies before JSON parsing", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "content-length": "1048577",
        },
        body: JSON.stringify({
          command: "run",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "oversized-body-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toEqual({
      code: "worker_payload_body_too_large",
      message: "Worker payload body must be at most 1048576 bytes.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects oversized streamed worker payload bodies without trusting content-length", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "x".repeat(1_048_577),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toEqual({
      code: "worker_payload_body_too_large",
      message: "Worker payload body must be at most 1048576 bytes.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("denies worker commands when the managed credential inventory revokes the token", async () => {
    mocks.env.CONTROL_PLANE_ALLOWED_TENANTS = "continuous-demo";
    mocks.env.CONTROL_PLANE_ALLOWED_WORKER_ROLES = "revenue_operations";
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({
      ok: false,
      status: 401,
      code: "control_plane_credential_revoked",
      message: "Control-plane credential has been revoked.",
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
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "revoked-managed-credential-001",
          config: {
            leadPacket: {
              customerName: "Acme",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toEqual({
      code: "control_plane_credential_revoked",
      message: "Control-plane credential has been revoked.",
    });
    expect(mocks.recordControlPlaneAuthAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        guard: expect.objectContaining({
          code: "control_plane_credential_revoked",
        }),
      }),
    );
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
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
    expect(JSON.stringify(body)).not.toContain("test-token");
    expect(JSON.stringify(body)).not.toContain("x-worker-run-token");
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("allows read-scoped worker payloads without granting command access", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = JSON.stringify([
      {
        id: "worker-reader",
        token: "test-token",
        operatorEmail: "operator@example.com",
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
        allowedRoutes: ["worker"],
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
      },
    ]);
    mocks.executeWorkerView.mockResolvedValue({
      data: {
        worker: {
          role: "revenue_operations",
          id: null,
          tenantSlug: "continuous-demo",
        },
        view: "snapshot",
      },
      error: null,
    });

    const { POST } = await import("./route");
    const viewResponse = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const commandResponse = await POST(
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
          idempotencyKey: "read-token-command-denied-001",
          config: {},
        }),
      }),
    );

    expect(viewResponse.status).toBe(200);
    await expect(viewResponse.json()).resolves.toMatchObject({
      data: {
        view: "snapshot",
      },
      error: null,
    });
    expect(commandResponse.status).toBe(403);
    await expect(commandResponse.json()).resolves.toMatchObject({
      error: {
        code: "control_plane_access_forbidden",
        message: "This operator token is not allowed to perform the requested control-plane access.",
      },
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects missing or blank worker commands before managed credential dispatch", async () => {
    mocks.env.CONTROL_PLANE_TOKENS_JSON = JSON.stringify([
      {
        id: "worker-runner",
        token: "test-token",
        operatorEmail: "operator@example.com",
        allowedTenants: ["continuous-demo"],
        allowedWorkerRoles: ["revenue_operations"],
        allowedRoutes: ["worker"],
        allowedAccess: ["write"],
        allowedCommands: ["worker:run"],
      },
    ]);

    const { POST } = await import("./route");
    const missingCommand = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "missing-command-001",
          config: {},
        }),
      }),
    );
    const blankCommand = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: " ",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "blank-command-001",
          config: {},
        }),
      }),
    );

    expect(missingCommand.status).toBe(400);
    await expect(missingCommand.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_payload_envelope",
        message: "Worker payload requires a non-empty command or view string.",
      },
    });
    expect(blankCommand.status).toBe(400);
    await expect(blankCommand.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_command_envelope",
        message: "Worker command payload requires a non-empty command string.",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("does not treat idempotency-key as a worker payload fallback", async () => {
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

    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith({
      command: "run",
      target: {
        role: "revenue_operations",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
      config: {
        intake: {
          source: "website_form",
          sourceEventId: "header-key-form-001",
        },
      },
      idempotencyKey: undefined,
      operatorEmail: "operator@example.com",
    });
  });

  it("keeps payload idempotencyKey authoritative when the header is also present", async () => {
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
          idempotencyKey: "",
          config: {
            intake: {
              source: "website_form",
              sourceEventId: "body-key-form-001",
            },
          },
        }),
      }),
    );

    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "",
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

  it("rejects Compliance operation fields outside config", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "filing.prepare",
          worker: {
            role: "compliance_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "bad-compliance-envelope-001",
          filingRequirementId: "filing-requirement-1",
          period: {
            label: "2026-Q2",
            from: "2026-04-01T00:00:00.000Z",
            to: "2026-07-01T00:00:00.000Z",
          },
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_command_envelope",
      message:
        "Worker command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: filingRequirementId, period.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects operation fields nested under the worker selector", async () => {
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
            leadPacket: {
              customerName: "Acme Roof Repair",
            },
          },
          idempotencyKey: "nested-worker-operation-field-001",
          config: {
            intake: {
              source: "website_form",
              sourceEventId: "nested-worker-operation-field-form-001",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_target",
      message:
        "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: leadPacket.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects missing or empty worker selectors before registry dispatch", async () => {
    const { POST } = await import("./route");
    const missingWorker = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          idempotencyKey: "missing-worker-selector-001",
          config: {},
        }),
      }),
    );
    const emptyWorker = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "run",
          worker: {},
          idempotencyKey: "empty-worker-selector-001",
          config: {},
        }),
      }),
    );

    await expect(missingWorker.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_target",
        message: "worker must be an object with role, id, and tenantSlug selectors.",
      },
    });
    await expect(emptyWorker.json()).resolves.toMatchObject({
      error: {
        code: "invalid_worker_target",
        message: "worker.role is required.",
      },
    });
    expect(missingWorker.status).toBe(400);
    expect(emptyWorker.status).toBe(400);
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects route-like or family-worker role names before registry dispatch", async () => {
    const { POST } = await import("./route");
    const apiFamilyRole = ["api", "domain-worker"].join("/");

    for (const role of ["domain-worker", "domain_worker", apiFamilyRole, "worker/domain"]) {
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
              role,
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: `bad-worker-role-${role.replaceAll(/[^a-z0-9]+/g, "-")}`,
            config: {
              intake: {
                source: "website_form",
                sourceEventId: "bad-worker-role-form-001",
              },
            },
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toEqual({
        code: "invalid_worker_target",
        message:
          "worker.role must be a lower_snake_case role identifier such as revenue_operations; do not use route names, family-worker names, or URL fragments.",
      });
    }
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects route-like or family-worker operation names before registry dispatch", async () => {
    const { POST } = await import("./route");
    const badOperations = [
      ["", "api", "revenue-worker", "run"].join("/"),
      ["", "revenue-worker"].join("/"),
      "revenue-worker",
      ["revenue_worker", "run"].join("."),
      "worker.run",
      "worker?view=snapshot",
      "api.worker.run",
    ];

    for (const operation of badOperations) {
      const response = await POST(
        new Request("http://localhost/worker", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            command: operation,
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            idempotencyKey: `bad-worker-operation-${operation.replaceAll(/[^a-z0-9]+/g, "-")}`,
            config: {},
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toEqual({
        code: "invalid_worker_command_envelope",
        message:
          "Worker command and view names must be registered lower_snake_case or dotted operation identifiers such as lead.read or quote.prepare; do not use URL paths, route names, family-worker names, or query strings.",
      });
    }
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed optional worker selectors before registry dispatch", async () => {
    const { POST } = await import("./route");

    for (const [field, value, message] of [
      ["id", 42, "worker.id must be a non-empty string when supplied."],
      ["tenantSlug", null, "worker.tenantSlug must be a non-empty string when supplied."],
      ["tenantSlug", "", "worker.tenantSlug must be a non-empty string when supplied."],
    ] as const) {
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
              [field]: value,
            },
            idempotencyKey: `malformed-worker-selector-${field}`,
            config: {},
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toEqual({
        code: "invalid_worker_target",
        message,
      });
    }

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
      message: "config is required and must be an object.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("requires command config before registry dispatch", async () => {
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
          idempotencyKey: "missing-config-001",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_command_config",
      message: "config is required and must be an object.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects missing or non-object view config before registry dispatch", async () => {
    const { POST } = await import("./route");

    for (const [name, payload] of [
      [
        "missing",
        {
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
        },
      ],
      [
        "array",
        {
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: ["state"],
        },
      ],
    ] as const) {
      const response = await POST(
        new Request("http://localhost/worker", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      const body = await response.json();

      expect(response.status, name).toBe(400);
      expect(body.error).toEqual({
        code: "invalid_worker_view_config",
        message: "config is required and must be an object.",
      });
    }

    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });

  it("preserves mapped worker command errors", async () => {
    mocks.executeWorkerCommand.mockRejectedValue(
      Object.assign(new Error("Worker command config is invalid."), {
        status: 422,
        code: "worker_config_invalid",
      }),
    );

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
          idempotencyKey: "mapped-worker-error-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toEqual({
      code: "worker_config_invalid",
      message: "Worker command config is invalid.",
    });
  });

  it("sanitizes unexpected worker command failures", async () => {
    mocks.executeWorkerCommand.mockRejectedValue(
      new Error("worker command leaked api key postgres://internal"),
    );

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
          idempotencyKey: "unexpected-worker-error-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toEqual({
      code: "worker_command_failed",
      message: "Worker command failed.",
    });
    expect(JSON.stringify(body)).not.toContain("api key");
    expect(JSON.stringify(body)).not.toContain("postgres://internal");
  });

  it("routes read views through the generic worker payload shape", async () => {
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

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "briefs",
          worker: {
            role: "owner_chief_of_staff",
            id: "worker-1",
            tenantSlug: "continuous-demo",
          },
          config: {
            state: "review_ready",
          },
        }),
      }),
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
      config: {
        state: "review_ready",
      },
    });
    expect(mocks.authorizeManagedControlPlaneCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "worker",
        access: "read",
        command: "view.briefs",
        tenantSlug: "continuous-demo",
        workerRole: "owner_chief_of_staff",
        requireManagedCredential: true,
      }),
    );
  });

  it("preserves mapped worker view validation errors", async () => {
    mocks.executeWorkerView.mockRejectedValue(
      Object.assign(new Error("Worker view config is invalid."), {
        status: 422,
        code: "worker_view_config_invalid",
      }),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/worker", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          view: "briefs",
          worker: {
            role: "owner_chief_of_staff",
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toEqual({
      code: "worker_view_config_invalid",
      message: "Worker view config is invalid.",
    });
  });

  it("sanitizes unexpected worker view failures", async () => {
    mocks.executeWorkerView.mockResolvedValue({
      status: 500,
      data: {
        internal: "postgres://worker-view-secret",
      },
      error: "worker view leaked api key",
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
          view: "briefs",
          worker: {
            role: "owner_chief_of_staff",
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      api: "continuous.worker.v1",
      data: null,
      error: "Worker view failed.",
    });
    expect(JSON.stringify(body)).not.toContain("postgres://worker-view-secret");
    expect(JSON.stringify(body)).not.toContain("api key");
  });

  it("rejects GET worker reads because reads require a payload envelope", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(405);
    expect(body.error).toEqual({
      code: "worker_view_payload_required",
      message:
        "Worker reads use POST /worker with a JSON payload containing view, worker, and config. Put read filters under config.",
    });
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });

  it("rejects top-level worker view filters outside the view envelope", async () => {
    const { POST } = await import("./route");
    const forbiddenFields = ["role", "tenantSlug", "state", "workerRole", "leadSource"];

    for (const field of forbiddenFields) {
      const response = await POST(
        new Request("http://localhost/worker", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            view: "snapshot",
            worker: {
              role: "revenue_operations",
              tenantSlug: "continuous-demo",
            },
            config: {},
            [field]: true,
          }),
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toEqual({
        code: "invalid_worker_view_envelope",
        message:
          `Worker view payload fields must be view, worker, and config. Move operation inputs into config. Unexpected fields: ${field}.`,
      });
    }
    expect(mocks.authorizeManagedControlPlaneCredential).not.toHaveBeenCalled();
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });

  it("rejects view payloads that omit tenant under scoped access", async () => {
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
          view: "snapshot",
          worker: {
            role: "revenue_operations",
          },
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
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });

  it("rejects ambiguous worker payloads that mix command and view", async () => {
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
          view: "snapshot",
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "ambiguous-worker-payload-001",
          config: {},
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_worker_payload_envelope",
      message: "Worker payload must contain either command or view, not both.",
    });
    expect(mocks.executeWorkerCommand).not.toHaveBeenCalled();
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });
});
