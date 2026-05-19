import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachCoreEvidence: vi.fn(),
  chargeBudget: vi.fn(),
  createCoreDocument: vi.fn(),
  createCoreTask: vi.fn(),
  getCoreSummarySafe: vi.fn(),
  getHealth: vi.fn(),
  grantCapability: vi.fn(),
  ingestCoreEvent: vi.fn(),
  linkCoreObjects: vi.fn(),
  preparePayrollPreviewPacket: vi.fn(),
  recordPayrollPreview: vi.fn(),
  prepareCorePacket: vi.fn(),
  publishCoreView: vi.fn(),
  recordCoreDecision: vi.fn(),
  recordCustomerSignal: vi.fn(),
  releaseBudget: vi.fn(),
  requestApproval: vi.fn(),
  reserveBudget: vi.fn(),
  transitionCoreTask: vi.fn(),
  upsertCoreObject: vi.fn(),
}));

vi.mock("../../../src/core/approvals", () => ({
  requestApproval: mocks.requestApproval,
}));

vi.mock("../../../src/core/budgets", () => ({
  chargeBudget: mocks.chargeBudget,
  releaseBudget: mocks.releaseBudget,
  reserveBudget: mocks.reserveBudget,
}));

vi.mock("../../../src/core/capabilities", () => ({
  grantCapability: mocks.grantCapability,
}));

vi.mock("../../../src/core/health", () => ({
  getHealth: mocks.getHealth,
}));

vi.mock("../../../src/core/payroll", () => ({
  preparePayrollPreviewPacket: mocks.preparePayrollPreviewPacket,
  recordPayrollPreview: mocks.recordPayrollPreview,
}));

vi.mock("../../../src/core/summary", () => ({
  getCoreSummarySafe: mocks.getCoreSummarySafe,
}));

vi.mock("../../../src/core/primitives", () => ({
  attachCoreEvidence: mocks.attachCoreEvidence,
  createCoreDocument: mocks.createCoreDocument,
  ingestCoreEvent: mocks.ingestCoreEvent,
  linkCoreObjects: mocks.linkCoreObjects,
  prepareCorePacket: mocks.prepareCorePacket,
  publishCoreView: mocks.publishCoreView,
  recordCoreDecision: mocks.recordCoreDecision,
  recordCustomerSignal: mocks.recordCustomerSignal,
  upsertCoreObject: mocks.upsertCoreObject,
}));

vi.mock("../../../src/core/tasks", () => ({
  createCoreTask: mocks.createCoreTask,
  transitionCoreTask: mocks.transitionCoreTask,
}));

describe("POST /api/core", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("WORKER_RUN_ENABLED", "true");
    vi.stubEnv("WORKER_RUN_TOKEN", "test-token");
    vi.stubEnv("WORKER_OPERATOR_EMAIL", "operator@example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("dispatches customer_signal.record with command config payload", async () => {
    mocks.recordCustomerSignal.mockResolvedValue({
      created: true,
      signalId: "signal-1",
      objectId: "object-1",
      eventId: "event-1",
      evidenceId: "evidence-1",
      auditEventId: "audit-1",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "customer_signal.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "signal-route-test-001",
          config: {
            type: "review",
            name: "Google review request",
            state: "requested",
            source: "ci.route",
            externalId: "review-001",
            customerObjectId: "33333333-3333-4333-8333-000000000001",
            relatedObjectId: "33333333-3333-4333-8333-000000000005",
            data: {
              platform: "google",
              requestStatus: "prepared",
            },
            occurredAt: "2026-05-19T18:00:00.000Z",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("customer_signal.record");
    expect(body.data.core.tenantSlug).toBe("continuous-demo");
    expect(body.data.result.signalId).toBe("signal-1");
    expect(mocks.recordCustomerSignal).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "signal-route-test-001",
      type: "review",
      name: "Google review request",
      state: "requested",
      source: "ci.route",
      externalId: "review-001",
      customerObjectId: "33333333-3333-4333-8333-000000000001",
      relatedObjectId: "33333333-3333-4333-8333-000000000005",
      taskId: undefined,
      eventId: undefined,
      data: {
        platform: "google",
        requestStatus: "prepared",
      },
      occurredAt: "2026-05-19T18:00:00.000Z",
    });
  });

  it("dispatches payroll.preview.record with statement, lines, liabilities, and trace config", async () => {
    mocks.recordPayrollPreview.mockResolvedValue({
      recorded: true,
      payrollRunId: "55555555-5555-4555-8555-000000000007",
      statementId: "77777777-7777-4777-8777-000000000001",
      lineIds: ["77777777-7777-4777-8777-000000000002"],
      liabilityIds: ["77777777-7777-4777-8777-000000000003"],
      traceId: "77777777-7777-4777-8777-000000000004",
      eventId: "event-1",
      auditEventId: "audit-1",
      evidenceId: "evidence-1",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "payroll.preview.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "payroll-route-test-001",
          config: {
            payrollRunId: "55555555-5555-4555-8555-000000000007",
            statement: {
              employmentId: "44444444-4444-4444-8444-000000000001",
              grossCents: 336000,
              netCents: 248640,
              taxCents: 87360,
              deductionCents: 0,
            },
            lines: [
              {
                kind: "earning",
                code: "regular_hours",
                amountCents: 336000,
              },
            ],
            liabilities: [
              {
                kind: "federal_withholding",
                payee: "IRS",
                amountCents: 87360,
              },
            ],
            trace: {
              hash: "route-payroll-trace",
              inputs: {
                regularHours: 80,
              },
              outputs: {
                grossCents: 336000,
              },
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("payroll.preview.record");
    expect(body.data.core.tenantSlug).toBe("continuous-demo");
    expect(body.data.result.statementId).toBe("77777777-7777-4777-8777-000000000001");
    expect(mocks.recordPayrollPreview).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "payroll-route-test-001",
      payrollRunId: "55555555-5555-4555-8555-000000000007",
      statement: {
        employmentId: "44444444-4444-4444-8444-000000000001",
        grossCents: 336000,
        netCents: 248640,
        taxCents: 87360,
        deductionCents: 0,
      },
      lines: [
        {
          kind: "earning",
          code: "regular_hours",
          amountCents: 336000,
        },
      ],
      liabilities: [
        {
          kind: "federal_withholding",
          payee: "IRS",
          amountCents: 87360,
        },
      ],
      trace: {
        hash: "route-payroll-trace",
        inputs: {
          regularHours: 80,
        },
        outputs: {
          grossCents: 336000,
        },
      },
    });
  });

  it("dispatches payroll.preview.packet.prepare with payroll run and packet config", async () => {
    mocks.preparePayrollPreviewPacket.mockResolvedValue({
      prepared: true,
      payrollRunId: "55555555-5555-4555-8555-000000000007",
      packetId: "77777777-7777-4777-8777-000000000005",
      packetDocumentId: "77777777-7777-4777-8777-000000000006",
      varianceDocumentId: "77777777-7777-4777-8777-000000000007",
      payStatementDocumentIds: ["77777777-7777-4777-8777-000000000008"],
      paymentInstructionIds: ["77777777-7777-4777-8777-000000000009"],
      filingDraftId: "77777777-7777-4777-8777-000000000010",
      approvalRequestId: "77777777-7777-4777-8777-000000000011",
      eventId: "event-1",
      auditEventId: "audit-1",
      evidenceId: "evidence-1",
      totals: {
        statementCount: 1,
      },
      externalExecution: "blocked",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "payroll.preview.packet.prepare",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "payroll-packet-route-test-001",
          config: {
            payrollRunId: "55555555-5555-4555-8555-000000000007",
            objectId: "33333333-3333-4333-8333-000000000105",
            reviewerUserId: "22222222-2222-4222-8222-222222222222",
            dueAt: "2026-05-20T00:00:00.000Z",
            variance: {
              notes: "seeded route test",
            },
            data: {
              source: "route-test",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("payroll.preview.packet.prepare");
    expect(body.data.core.tenantSlug).toBe("continuous-demo");
    expect(body.data.result.packetId).toBe("77777777-7777-4777-8777-000000000005");
    expect(mocks.preparePayrollPreviewPacket).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "payroll-packet-route-test-001",
      payrollRunId: "55555555-5555-4555-8555-000000000007",
      objectId: "33333333-3333-4333-8333-000000000105",
      reviewerUserId: "22222222-2222-4222-8222-222222222222",
      dueAt: "2026-05-20T00:00:00.000Z",
      variance: {
        notes: "seeded route test",
      },
      data: {
        source: "route-test",
      },
    });
  });

  it("rejects commands outside the configured tenant scope before dispatch", async () => {
    vi.stubEnv("CONTROL_PLANE_ALLOWED_TENANTS", "continuous-demo");

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "task.create",
          core: {
            tenantSlug: "other-tenant",
          },
          idempotencyKey: "core-scope-test-001",
          config: {
            title: "Out-of-scope task",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_tenant_forbidden",
      message: "This operator token is not allowed to access the requested tenant.",
    });
    expect(mocks.createCoreTask).not.toHaveBeenCalled();
  });

  it("rejects payroll.preview.record before dispatch when idempotency is invalid", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "payroll.preview.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "",
          config: {
            payrollRunId: "55555555-5555-4555-8555-000000000007",
            lines: [],
            trace: {},
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_idempotency_key");
    expect(mocks.recordPayrollPreview).not.toHaveBeenCalled();
  });

  it("requires a tenant for scoped Core summary reads", async () => {
    vi.stubEnv("CONTROL_PLANE_ALLOWED_TENANTS", "continuous-demo");

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/core", {
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
    expect(mocks.getCoreSummarySafe).not.toHaveBeenCalled();
  });
});
