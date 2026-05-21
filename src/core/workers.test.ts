import { describe, expect, it } from "vitest";

import { canTransitionCoreWorkerState, upsertCoreWorker } from "./workers";

describe("Core worker primitives", () => {
  it("rejects invalid worker kinds before touching persistence", async () => {
    await expect(
      upsertCoreWorker({
        operatorEmail: "operator@example.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: "worker-invalid-kind-test-001",
        kind: "assistant",
        name: "Compliance Operations Worker",
        role: "compliance_operations",
        mission: "Prepare compliance filings.",
      }),
    ).rejects.toMatchObject({
      code: "worker_kind_invalid",
      status: 400,
    });
  });

  it("rejects invalid autonomy levels before touching persistence", async () => {
    await expect(
      upsertCoreWorker({
        operatorEmail: "operator@example.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: "worker-invalid-autonomy-test-001",
        kind: "synthetic",
        autonomyLevel: 8,
        name: "Compliance Operations Worker",
        role: "compliance_operations",
        mission: "Prepare compliance filings.",
      }),
    ).rejects.toMatchObject({
      code: "worker_autonomy_level_invalid",
      status: 400,
    });
  });

  it("keeps worker state transitions narrow and lifecycle-owned", () => {
    expect(canTransitionCoreWorkerState("draft", "training")).toBe(true);
    expect(canTransitionCoreWorkerState("training", "active")).toBe(true);
    expect(canTransitionCoreWorkerState("active", "paused")).toBe(true);
    expect(canTransitionCoreWorkerState("paused", "active")).toBe(true);
    expect(canTransitionCoreWorkerState("draft", "active")).toBe(false);
    expect(canTransitionCoreWorkerState("retired", "active")).toBe(false);
  });
});
