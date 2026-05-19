import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeWorkerCommand: vi.fn(),
  executeWorkerView: vi.fn(),
  workerErrorStatus: vi.fn(),
}));

vi.mock("../../src/env", () => ({
  env: {
    APP_ENV: "test",
    WORKER_RUN_ENABLED: true,
    WORKER_RUN_TOKEN: "test-token",
    WORKER_OPERATOR_EMAIL: "operator@example.com",
  },
}));

vi.mock("../../src/worker/registry", () => ({
  executeWorkerCommand: mocks.executeWorkerCommand,
  executeWorkerView: mocks.executeWorkerView,
  workerApiVersion: "continuous.worker.v1",
  workerErrorStatus: mocks.workerErrorStatus,
}));

describe("/worker route", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.workerErrorStatus.mockImplementation((error: unknown, fallbackCode: string) => ({
      status:
        error && typeof error === "object" && "status" in error
          ? Number((error as { status: unknown }).status)
          : 500,
      code:
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : fallbackCode,
      message: error instanceof Error ? error.message : "Unknown worker error.",
    }));
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
  });

  it("keeps idempotency-key as a fallback only when the payload omits idempotencyKey", async () => {
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
          },
          config: {},
        }),
      }),
    );

    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "header-key-001",
      }),
    );
  });

  it("does not lift legacy top-level worker fields into the command envelope", async () => {
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
    await POST(
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

    expect(mocks.executeWorkerCommand).toHaveBeenCalledWith({
      command: "run",
      target: {
        role: undefined,
        id: undefined,
        tenantSlug: undefined,
      },
      config: undefined,
      idempotencyKey: "legacy-top-level-001",
      operatorEmail: "operator@example.com",
    });
  });

  it("routes GET views through role-scoped worker selectors", async () => {
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

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/worker?view=briefs&role=owner_chief_of_staff&id=worker-1&tenantSlug=continuous-demo&state=review_ready",
        {
          headers: {
            authorization: "Bearer test-token",
          },
        },
      ),
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
      state: "review_ready",
    });
  });
});
