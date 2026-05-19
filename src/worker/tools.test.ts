import { describe, expect, it } from "vitest";

import { executeWorkerTool, workerToolSchema, workerTools } from "./tools";

describe("worker tool contract", () => {
  it("exposes the canonical repo-owned worker tools", () => {
    expect(workerTools.map((tool) => tool.name)).toEqual([
      "worker.snapshot",
      "worker.run",
      "worker.approvals.list",
      "worker.approvals.decide",
      "worker.adapters.reconcile",
    ]);
    expect(workerToolSchema.tools).toBe(workerTools);
    expect(workerToolSchema.$defs.workerTarget.properties.tenantSlug.type).toBe("string");
  });

  it("rejects unsupported worker roles before runtime work", async () => {
    await expect(
      executeWorkerTool("worker.snapshot", {
        worker: {
          role: "payroll_operations",
        },
      }),
    ).rejects.toThrow("Worker role payroll_operations is not available yet.");
  });

  it("validates worker run idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.run", {
        worker: {
          role: "revenue_operations",
        },
        idempotencyKey: "bad key!",
        config: {},
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("requires tenant scope for adapter reconciliation", async () => {
    await expect(
      executeWorkerTool("worker.adapters.reconcile", {
        worker: {
          role: "revenue_operations",
        },
        config: {
          limit: 25,
        },
      }),
    ).rejects.toThrow("worker.tenantSlug is required for adapter reconciliation.");
  });
});
