import { describe, expect, it } from "vitest";

import { authorizeRevenueWorkerRead, authorizeRevenueWorkerRun, normalizeIdempotencyKey } from "./security";

const acceptedCredential = ["accepted", "worker", "credential"].join(".");
const operatorEmail = "owner@continuoushq.com";

describe("authorizeRevenueWorkerRun", () => {
  it("keeps worker runs disabled by default", () => {
    expect(
      authorizeRevenueWorkerRun({
        enabled: false,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Revenue Worker runs are disabled.",
    });
  });

  it("requires a token for enabled runs", () => {
    expect(
      authorizeRevenueWorkerRun({
        enabled: true,
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_run_token_missing",
      message: "Enabled worker runs require REVENUE_WORKER_RUN_TOKEN.",
    });
  });

  it("accepts a matching bearer token", () => {
    expect(
      authorizeRevenueWorkerRun({
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

describe("authorizeRevenueWorkerRead", () => {
  it("requires a read token in development", () => {
    expect(
      authorizeRevenueWorkerRead({
        appEnv: "development",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Revenue Worker reads require REVENUE_WORKER_RUN_TOKEN.",
    });
  });

  it("requires a read token in production", () => {
    expect(
      authorizeRevenueWorkerRead({
        appEnv: "production",
        operatorEmail,
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Revenue Worker reads require REVENUE_WORKER_RUN_TOKEN.",
    });
  });

  it("rejects an invalid read token", () => {
    expect(
      authorizeRevenueWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        headerToken: "wrong",
      }),
    ).toEqual({
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Revenue Worker read token is invalid.",
    });
  });

  it("accepts a matching read bearer token", () => {
    expect(
      authorizeRevenueWorkerRead({
        appEnv: "production",
        expectedToken: acceptedCredential,
        operatorEmail,
        authorization: `Bearer ${acceptedCredential}`,
      }),
    ).toEqual({ ok: true, operatorEmail });
  });
});
