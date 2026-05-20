import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeWorkerCommand: vi.fn(),
  executeWorkerView: vi.fn(),
  registeredWorkerCommands: vi.fn(() => []),
  registeredWorkerViews: vi.fn(() => []),
}));

vi.mock("./registry", () => ({
  executeWorkerCommand: mocks.executeWorkerCommand,
  executeWorkerView: mocks.executeWorkerView,
  registeredWorkerCommands: mocks.registeredWorkerCommands,
  registeredWorkerViews: mocks.registeredWorkerViews,
}));

describe("worker tool envelope forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps worker view filters under config", async () => {
    mocks.executeWorkerView.mockResolvedValue({
      data: {
        worker: {
          role: "revenue_operations",
          id: null,
          tenantSlug: "continuous-demo",
        },
        view: "approvals",
        approvals: [],
      },
      error: null,
    });

    const { executeWorkerTool } = await import("./tools");
    const result = await executeWorkerTool("worker.view", {
      view: "approvals",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      config: {
        state: "pending",
      },
    });

    expect(mocks.executeWorkerView).toHaveBeenCalledWith({
      view: "approvals",
      target: {
        role: "revenue_operations",
        id: undefined,
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      state: "pending",
    });
    expect(result).toMatchObject({
      view: "approvals",
      error: null,
    });
  });

  it("rejects top-level worker view filters", async () => {
    const { executeWorkerTool } = await import("./tools");

    await expect(
      executeWorkerTool("worker.view", {
        view: "approvals",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        state: "pending",
      }),
    ).rejects.toThrow(
      "Worker tool payload fields must be view, worker, and config. Move operation inputs into config. Unexpected fields: state.",
    );
    expect(mocks.executeWorkerView).not.toHaveBeenCalled();
  });
});
