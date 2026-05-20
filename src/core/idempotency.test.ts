import { describe, expect, it } from "vitest";

import {
  assertCoreIdempotencyReplay,
  coreIdempotencyFingerprint,
} from "./idempotency";

describe("Core command idempotency fingerprints", () => {
  it("hashes equivalent command input independent of object key order", () => {
    const left = coreIdempotencyFingerprint("task.create", {
      title: "Review packet",
      owner: {
        ref: "worker:owner",
        type: "worker",
      },
      evidence: {
        required: ["packet"],
        source: "workflow",
      },
    });
    const right = coreIdempotencyFingerprint("task.create", {
      evidence: {
        source: "workflow",
        required: ["packet"],
      },
      owner: {
        type: "worker",
        ref: "worker:owner",
      },
      title: "Review packet",
    });

    expect(right).toEqual(left);
  });

  it("treats command name as part of the replay fingerprint", () => {
    const create = coreIdempotencyFingerprint("task.create", {
      title: "Review packet",
    });
    const transition = coreIdempotencyFingerprint("task.transition", {
      title: "Review packet",
    });

    expect(transition.inputHash).not.toBe(create.inputHash);
  });

  it("rejects replay when the stored input fingerprint differs", () => {
    const original = coreIdempotencyFingerprint("task.create", {
      title: "Review packet",
    });
    const changed = coreIdempotencyFingerprint("task.create", {
      title: "Review changed packet",
    });

    expect(() =>
      assertCoreIdempotencyReplay({
        command: "task.create",
        fingerprint: changed,
        storedData: {
          idempotency: original,
        },
      }),
    ).toThrow("A task.create command already exists for this idempotency key with different input.");
  });

  it("allows legacy replay rows that predate stored fingerprints", () => {
    const fingerprint = coreIdempotencyFingerprint("task.create", {
      title: "Review packet",
    });

    expect(() =>
      assertCoreIdempotencyReplay({
        command: "task.create",
        fingerprint,
        storedData: {
          title: "Review packet",
        },
      }),
    ).not.toThrow();
  });
});
