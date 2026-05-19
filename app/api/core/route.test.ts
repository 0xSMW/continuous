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
});
