import { describe, expect, it } from "vitest";

import { authorizeWorkerRead, authorizeWorkerRun, normalizeIdempotencyKey } from "./security";

const acceptedCredential = ["accepted", "worker", "credential"].join(".");
const operatorEmail = "owner@continuoushq.com";

describe("authorizeWorkerRun", () => {
  it("keeps worker runs disabled by default", () => {
    expect(
      authorizeWorkerRun({
        enabled: false,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Worker runs are disabled.",
    });
  });

  it("requires a token for enabled runs", () => {
    expect(
      authorizeWorkerRun({
        enabled: true,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_token_missing",
      message: "Enabled worker runs require WORKER_RUN_TOKEN.",
    });
  });

  it("accepts a matching bearer token", () => {
    expect(
      authorizeWorkerRun({
        enabled: true,
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({ ok: true, operatorEmail });
  });
});

describe("normalizeIdempotencyKey", () => {
  it("accepts stable operator-provided keys", () => {
    expect(normalizeIdempotencyKey("rev-worker:2026-05-19:001")).toEqual({
      ok: true,
      key: "rev-worker:2026-05-19:001",
    });
  });

  it("rejects unsafe key material", () => {
    expect(normalizeIdempotencyKey("not safe/key")).toEqual({
      ok: false,
      message: "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    });
  });
});

describe("authorizeWorkerRead", () => {
  it("requires a read token in development", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Worker reads require WORKER_RUN_TOKEN.",
    });
  });

  it("requires a read token in production", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Worker reads require WORKER_RUN_TOKEN.",
    });
  });

  it("rejects an invalid read token", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        headerToken: "wrong",
      }),
    ).toEqual({
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Worker read token is invalid.",
    });
  });

  it("accepts a matching read bearer token", () => {
    expect(
      authorizeWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({ ok: true, operatorEmail });
  });
});
