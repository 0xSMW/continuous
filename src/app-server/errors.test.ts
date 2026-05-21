import { describe, expect, it } from "vitest";

import { appServerToolErrorMessage } from "./errors";

describe("app-server error sanitization", () => {
  it("passes through public app-server contract errors", () => {
    expect(
      appServerToolErrorMessage(
        new Error("continuous.core.schema does not accept arguments."),
        "fallback",
      ),
    ).toBe("continuous.core.schema does not accept arguments.");
    expect(
      appServerToolErrorMessage(
        new Error("Unsupported Core ledger collection. Supported collections: objects, tasks."),
        "fallback",
      ),
    ).toBe("Unsupported Core ledger collection. Supported collections: objects, tasks.");
  });

  it("redacts backend, credential, and oversized errors", () => {
    expect(
      appServerToolErrorMessage(
        new Error("postgres://core-db.internal/continuous redaction-sentinel"),
        "fallback",
      ),
    ).toBe("fallback");
    expect(
      appServerToolErrorMessage(
        new Error("Unexpected provider credential metadata"),
        "fallback",
      ),
    ).toBe("fallback");
    expect(appServerToolErrorMessage(new Error("x".repeat(501)), "fallback")).toBe(
      "fallback",
    );
  });

  it("falls back for non-error and unknown messages", () => {
    expect(appServerToolErrorMessage("plain string", "fallback")).toBe("fallback");
    expect(appServerToolErrorMessage(new Error("an implementation detail leaked"), "fallback")).toBe(
      "fallback",
    );
  });
});
