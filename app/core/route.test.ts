import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeAiInference: vi.fn(),
  attachCoreEvidence: vi.fn(),
  authorizeManagedControlPlaneCredential: vi.fn(),
  attestControlPlaneTokenRotation: vi.fn(),
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
  recordAdapterIntent: vi.fn(),
  prepareCorePacket: vi.fn(),
  publishCoreView: vi.fn(),
  recordCoreConnectionHealth: vi.fn(),
  recordCoreDecision: vi.fn(),
  recordCustomerSignal: vi.fn(),
  recordRuleChange: vi.fn(),
  reviewControlPlaneSessions: vi.fn(),
  revokeControlPlaneCredential: vi.fn(),
  releaseBudget: vi.fn(),
  requestApproval: vi.fn(),
  reserveBudget: vi.fn(),
  transitionCoreTask: vi.fn(),
  upsertControlPlaneCredential: vi.fn(),
  upsertCoreAdapter: vi.fn(),
  upsertCoreConnection: vi.fn(),
  upsertCoreObject: vi.fn(),
  recordControlPlaneAuthAttempt: vi.fn(),
}));

vi.mock("../../src/core/ai-gateway", () => ({
  executeAiInference: mocks.executeAiInference,
}));

vi.mock("../../src/core/approvals", () => ({
  requestApproval: mocks.requestApproval,
}));

vi.mock("../../src/core/budgets", () => ({
  chargeBudget: mocks.chargeBudget,
  releaseBudget: mocks.releaseBudget,
  reserveBudget: mocks.reserveBudget,
}));

vi.mock("../../src/core/capabilities", () => ({
  grantCapability: mocks.grantCapability,
}));

vi.mock("../../src/core/health", () => ({
  getHealth: mocks.getHealth,
}));

vi.mock("../../src/core/payroll", () => ({
  preparePayrollPreviewPacket: mocks.preparePayrollPreviewPacket,
  recordPayrollPreview: mocks.recordPayrollPreview,
}));

vi.mock("../../src/core/summary", () => ({
  getCoreSummarySafe: mocks.getCoreSummarySafe,
}));

vi.mock("../../src/core/control-plane-auth", () => ({
  authorizeManagedControlPlaneCredential: mocks.authorizeManagedControlPlaneCredential,
  attestControlPlaneTokenRotation: mocks.attestControlPlaneTokenRotation,
  recordControlPlaneAuthAttempt: mocks.recordControlPlaneAuthAttempt,
  reviewControlPlaneSessions: mocks.reviewControlPlaneSessions,
  revokeControlPlaneCredential: mocks.revokeControlPlaneCredential,
  upsertControlPlaneCredential: mocks.upsertControlPlaneCredential,
}));

vi.mock("../../src/core/primitives", () => ({
  attachCoreEvidence: mocks.attachCoreEvidence,
  createCoreDocument: mocks.createCoreDocument,
  ingestCoreEvent: mocks.ingestCoreEvent,
  linkCoreObjects: mocks.linkCoreObjects,
  prepareCorePacket: mocks.prepareCorePacket,
  publishCoreView: mocks.publishCoreView,
  recordAdapterIntent: mocks.recordAdapterIntent,
  recordCoreConnectionHealth: mocks.recordCoreConnectionHealth,
  recordCoreDecision: mocks.recordCoreDecision,
  recordCustomerSignal: mocks.recordCustomerSignal,
  recordRuleChange: mocks.recordRuleChange,
  upsertCoreAdapter: mocks.upsertCoreAdapter,
  upsertCoreConnection: mocks.upsertCoreConnection,
  upsertCoreObject: mocks.upsertCoreObject,
}));

vi.mock("../../src/core/tasks", () => ({
  createCoreTask: mocks.createCoreTask,
  transitionCoreTask: mocks.transitionCoreTask,
}));

describe("POST /core", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("WORKER_RUN_ENABLED", "true");
    vi.stubEnv("WORKER_RUN_TOKEN", "test-token");
    vi.stubEnv("WORKER_OPERATOR_EMAIL", "operator@example.com");
    vi.stubEnv(
      "CONTROL_PLANE_TOKENS_JSON",
      JSON.stringify([
        {
          id: "core-route-test",
          token: "test-token",
          operatorEmail: "operator@example.com",
          allowedRoutes: ["core"],
          allowedAccess: ["read", "write"],
          allowedCommands: ["core:*"],
        },
      ]),
    );
    vi.stubEnv("CONTROL_PLANE_TOKEN_CATALOG_B64", "");
    mocks.authorizeManagedControlPlaneCredential.mockResolvedValue({ ok: true });
    mocks.recordControlPlaneAuthAttempt.mockResolvedValue({ id: "auth-session-1" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("rejects worker-only catalog tokens before Core dispatch", async () => {
    vi.stubEnv(
      "CONTROL_PLANE_TOKENS_JSON",
      JSON.stringify([
        {
          id: "worker-only-route-test",
          token: "test-token",
          operatorEmail: "operator@example.com",
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands: ["worker:run"],
        },
      ]),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "task.create",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "worker-only-core-route-test-001",
          config: {
            title: "This should not dispatch",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toEqual({
      code: "control_plane_route_forbidden",
      message: "This operator token is not allowed to access the requested control-plane route.",
    });
    expect(mocks.createCoreTask).not.toHaveBeenCalled();
  });

  it("attests control-plane token rotation through the Core command envelope", async () => {
    const previousFingerprint = ["1111", "2222", "3333", "4444"].join("");
    const nextFingerprint = ["5555", "6666", "7777", "8888"].join("");

    mocks.attestControlPlaneTokenRotation.mockResolvedValue({
      created: true,
      tokenRotationAttestationId: "rotation-1",
      eventId: "event-1",
      auditEventId: "audit-1",
      credentialId: "ops-credential",
      previousCredentialId: "ops-credential-old",
      previousTokenFingerprint: previousFingerprint,
      nextTokenFingerprint: nextFingerprint,
      state: "attested",
      rotatedAt: "2026-05-20T00:00:00.000Z",
      attestedAt: "2026-05-20T00:01:00.000Z",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.token_rotation.attest",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "rotation-attest-001",
          config: {
            credentialId: "ops-credential",
            previousCredentialId: "ops-credential-old",
            previousTokenFingerprint: previousFingerprint,
            nextTokenFingerprint: nextFingerprint,
            rotatedAt: "2026-05-20T00:00:00.000Z",
            reason: "scheduled operator rotation",
            evidence: {
              report: "ops/rotation/2026-05-20",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("control_plane.token_rotation.attest");
    expect(body.data.result.tokenRotationAttestationId).toBe("rotation-1");
    expect(mocks.attestControlPlaneTokenRotation).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      idempotencyKey: "rotation-attest-001",
      tenantSlug: "continuous-demo",
      credentialId: "ops-credential",
      previousCredentialId: "ops-credential-old",
      previousTokenFingerprint: previousFingerprint,
      nextTokenFingerprint: nextFingerprint,
      rotatedAt: "2026-05-20T00:00:00.000Z",
      reason: "scheduled operator rotation",
      evidence: {
        report: "ops/rotation/2026-05-20",
      },
      authSessionId: "auth-session-1",
    });
  });

  it("rejects raw token material in token rotation attestations", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.token_rotation.attest",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "rotation-attest-forbidden-field-001",
          config: {
            credentialId: "ops-credential",
            token: null,
            nextToken: null,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_control_plane_token_rotation",
      message:
        "Token rotation attestations accept credential ids and token fingerprints only. Remove raw token fields: token, nextToken.",
    });
    expect(mocks.attestControlPlaneTokenRotation).not.toHaveBeenCalled();
  });

  it("upserts managed control-plane credentials through the Core command envelope", async () => {
    mocks.upsertControlPlaneCredential.mockResolvedValue({
      created: true,
      updated: false,
      controlPlaneCredentialId: "credential-row-1",
      credentialId: "bootstrap-operator",
      eventId: "event-1",
      auditEventId: "audit-1",
      credential: {
        credentialId: "bootstrap-operator",
        state: "active",
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.credential.upsert",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "credential-upsert-001",
          config: {
            credentialId: "bootstrap-operator",
            displayName: "Bootstrap operator",
            tokenFingerprint: "aabbccddeeff0011",
            allowedTenants: ["continuous-demo"],
            allowedWorkerRoles: ["revenue_operations"],
            allowedRoutes: ["core", "worker"],
            allowedAccess: ["read", "write"],
            allowedCommands: ["core:*", "worker:run"],
            evidence: {
              owner: "ops",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("control_plane.credential.upsert");
    expect(body.data.result.controlPlaneCredentialId).toBe("credential-row-1");
    expect(mocks.upsertControlPlaneCredential).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      idempotencyKey: "credential-upsert-001",
      tenantSlug: "continuous-demo",
      credentialId: "bootstrap-operator",
      displayName: "Bootstrap operator",
      credentialOperatorEmail: undefined,
      state: undefined,
      tokenFingerprint: "aabbccddeeff0011",
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["core", "worker"],
      allowedAccess: ["read", "write"],
      allowedCommands: ["core:*", "worker:run"],
      expiresAt: undefined,
      evidence: {
        owner: "ops",
      },
    });
  });

  it("runs deterministic AI inference through the Core command envelope", async () => {
    mocks.executeAiInference.mockResolvedValue({
      created: true,
      idempotencyKey: "ai-infer-001",
      inferenceId: "inference-1",
      providerId: "provider-1",
      routeId: "route-1",
      budgetAccountId: "budget-1",
      reservationId: "reservation-1",
      usageEventId: "usage-1",
      eventId: "event-1",
      auditEventId: "audit-1",
      evidenceId: "evidence-1",
      promptHash: "hash-1",
      units: 500,
      costUsd: "0.000000",
      request: {
        input: {
          prompt: "Classify lead",
          token: "[redacted]",
        },
      },
      result: {
        mode: "deterministic",
      },
      safety: {
        externalExecution: "blocked",
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "ai.infer",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "ai-infer-001",
          config: {
            routeKey: "low_cost_fast",
            budgetAccountId: "budget-1",
            maxUnits: 500,
            actor: {
              type: "worker",
              id: "worker-1",
              ref: "worker:worker-1",
            },
            capabilityId: "capability-1",
            input: {
              prompt: "Classify lead",
              token: null,
            },
            redaction: {
              fields: ["token"],
            },
            evaluation: {
              caseId: "lead-classification",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("ai.infer");
    expect(body.data.result.inferenceId).toBe("inference-1");
    expect(mocks.executeAiInference).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      idempotencyKey: "ai-infer-001",
      tenantSlug: "continuous-demo",
      routeKey: "low_cost_fast",
      routePurpose: undefined,
      budgetAccountId: "budget-1",
      maxUnits: 500,
      costUsd: undefined,
      actor: {
        type: "worker",
        id: "worker-1",
        ref: "worker:worker-1",
      },
      taskId: undefined,
      objectId: undefined,
      capabilityId: "capability-1",
      input: {
        prompt: "Classify lead",
        token: null,
      },
      redaction: {
        fields: ["token"],
      },
      evaluation: {
        caseId: "lead-classification",
      },
    });
  });

  it("preserves structured AI gateway errors", async () => {
    mocks.executeAiInference.mockRejectedValue({
      status: 422,
      code: "ai_gateway_route_not_found",
      message: "config.routeKey does not match an active model route in this tenant.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "ai.infer",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "ai-infer-error-001",
          config: {
            routeKey: "missing_route",
            budgetAccountId: "budget-1",
            maxUnits: 500,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toEqual({
      code: "ai_gateway_route_not_found",
      message: "config.routeKey does not match an active model route in this tenant.",
    });
  });

  it("rejects invalid Core command bodies before command dispatch", async () => {
    const { POST } = await import("./route");

    const missingContentType = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          command: "task.create",
        }),
      }),
    );
    const invalidContentType = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          command: "task.create",
        }),
      }),
    );
    const jsonpContentType = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/jsonp",
        },
        body: JSON.stringify({
          command: "task.create",
        }),
      }),
    );
    const malformedJson = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    const arrayBody = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify([]),
      }),
    );

    await expect(missingContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_core_command_body",
        message: "POST /core requires an application/json request body.",
      },
    });
    await expect(invalidContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_core_command_body",
        message: "POST /core requires an application/json request body.",
      },
    });
    await expect(jsonpContentType.json()).resolves.toMatchObject({
      error: {
        code: "invalid_core_command_body",
        message: "POST /core requires an application/json request body.",
      },
    });
    await expect(malformedJson.json()).resolves.toMatchObject({
      error: {
        code: "invalid_core_command_body",
        message: "Core command body must be valid JSON.",
      },
    });
    await expect(arrayBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_core_command_body",
        message: "Core command body must be a JSON object.",
      },
    });
    expect(missingContentType.status).toBe(415);
    expect(invalidContentType.status).toBe(415);
    expect(jsonpContentType.status).toBe(415);
    expect(malformedJson.status).toBe(400);
    expect(arrayBody.status).toBe(400);
    expect(mocks.createCoreTask).not.toHaveBeenCalled();
    expect(mocks.executeAiInference).not.toHaveBeenCalled();
  });

  it("rejects raw token material in managed control-plane credential payloads", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.credential.upsert",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "credential-upsert-forbidden-field-001",
          config: {
            credentialId: "bootstrap-operator",
            token: null,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_control_plane_credential");
    expect(mocks.upsertControlPlaneCredential).not.toHaveBeenCalled();
  });

  it("revokes managed control-plane credentials through the Core command envelope", async () => {
    mocks.revokeControlPlaneCredential.mockResolvedValue({
      revoked: true,
      controlPlaneCredentialId: "credential-row-1",
      credentialId: "bootstrap-operator",
      eventId: "event-1",
      auditEventId: "audit-1",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.credential.revoke",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "credential-revoke-001",
          config: {
            credentialId: "bootstrap-operator",
            reason: "operator offboarding",
            evidence: {
              ticket: "SEC-100",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("control_plane.credential.revoke");
    expect(mocks.revokeControlPlaneCredential).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      idempotencyKey: "credential-revoke-001",
      tenantSlug: "continuous-demo",
      credentialId: "bootstrap-operator",
      reason: "operator offboarding",
      evidence: {
        ticket: "SEC-100",
      },
    });
  });

  it("reviews control-plane auth sessions through the Core command envelope", async () => {
    mocks.reviewControlPlaneSessions.mockResolvedValue({
      reviewed: true,
      reviewViewId: "view-1",
      eventId: "event-1",
      auditEventId: "audit-1",
      counts: {
        total: 1,
        denied: 0,
      },
      sessions: [],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "control_plane.session.review",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "session-review-001",
          config: {
            credentialId: "bootstrap-operator",
            since: "2026-05-20T00:00:00.000Z",
            limit: 25,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("control_plane.session.review");
    expect(mocks.reviewControlPlaneSessions).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      idempotencyKey: "session-review-001",
      tenantSlug: "continuous-demo",
      credentialId: "bootstrap-operator",
      outcome: undefined,
      since: "2026-05-20T00:00:00.000Z",
      limit: 25,
    });
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
      new Request("http://localhost/core", {
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
      new Request("http://localhost/core", {
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
      new Request("http://localhost/core", {
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

  it("dispatches adapter.upsert with catalog config payload", async () => {
    mocks.upsertCoreAdapter.mockResolvedValue({
      created: true,
      adapterId: "99999999-9999-4999-8999-000000000021",
      eventId: "event-1",
      auditEventId: "audit-1",
      adapter: {
        key: "google_workspace",
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "adapter.upsert",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "adapter-upsert-route-test-001",
          config: {
            key: "google_workspace",
            name: "Google Workspace",
            kind: "inbox",
            auth: "oauth",
            capabilities: {
              read: ["lead.read"],
              sources: ["google_workspace_inbox"],
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("adapter.upsert");
    expect(body.data.result.adapterId).toBe("99999999-9999-4999-8999-000000000021");
    expect(mocks.upsertCoreAdapter).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "adapter-upsert-route-test-001",
      adapterId: undefined,
      key: "google_workspace",
      name: "Google Workspace",
      kind: "inbox",
      auth: "oauth",
      configSchema: {},
      eventSchema: {},
      capabilities: {
        read: ["lead.read"],
        sources: ["google_workspace_inbox"],
      },
      active: undefined,
    });
  });

  it("dispatches connection.upsert with read-only polling config payload", async () => {
    mocks.upsertCoreConnection.mockResolvedValue({
      created: true,
      connectionId: "99999999-9999-4999-8999-000000000022",
      adapterId: "99999999-9999-4999-8999-000000000021",
      eventId: "event-1",
      auditEventId: "audit-1",
      externalExecution: "blocked",
      pollingEnabled: true,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "connection.upsert",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "connection-upsert-route-test-001",
          config: {
            adapterKey: "google_workspace",
            name: "Google Workspace Leads",
            state: "active",
            externalAccountId: "leads@continuoushq.com",
            scopes: {
              reads: ["lead.read"],
            },
            config: {
              sources: ["google_workspace_inbox"],
              providers: ["google_workspace"],
              readerKinds: ["inbox"],
              polling: {
                enabled: true,
                source: "google_workspace_inbox",
                provider: "google_workspace",
                credentialRef: "env:GOOGLE_WORKSPACE_TOKEN",
              },
              externalExecution: "blocked",
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("connection.upsert");
    expect(body.data.result.connectionId).toBe("99999999-9999-4999-8999-000000000022");
    expect(mocks.upsertCoreConnection).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "connection-upsert-route-test-001",
      connectionId: undefined,
      adapterId: undefined,
      adapterKey: "google_workspace",
      name: "Google Workspace Leads",
      state: "active",
      externalAccountId: "leads@continuoushq.com",
      scopes: {
        reads: ["lead.read"],
      },
      config: {
        sources: ["google_workspace_inbox"],
        providers: ["google_workspace"],
        readerKinds: ["inbox"],
        polling: {
          enabled: true,
          source: "google_workspace_inbox",
          provider: "google_workspace",
          credentialRef: "env:GOOGLE_WORKSPACE_TOKEN",
        },
        externalExecution: "blocked",
      },
      lastSyncAt: undefined,
    });
  });

  it("dispatches connection.health.record with readiness checks in config", async () => {
    mocks.recordCoreConnectionHealth.mockResolvedValue({
      created: true,
      connectionId: "99999999-9999-4999-8999-000000000022",
      adapterId: "99999999-9999-4999-8999-000000000021",
      eventId: "event-1",
      evidenceId: "evidence-1",
      auditEventId: "audit-1",
      status: "needs_configuration",
      externalExecution: "blocked",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "connection.health.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "connection-health-route-test-001",
          config: {
            connectionId: "99999999-9999-4999-8999-000000000022",
            checks: ["state", "credential_ref", "scheduler"],
            observedAt: "2026-05-20T08:00:00.000Z",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("connection.health.record");
    expect(body.data.result.status).toBe("needs_configuration");
    expect(mocks.recordCoreConnectionHealth).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "connection-health-route-test-001",
      connectionId: "99999999-9999-4999-8999-000000000022",
      checks: ["state", "credential_ref", "scheduler"],
      observedAt: "2026-05-20T08:00:00.000Z",
    });
  });

  it("dispatches adapter.intent.record with adapter config payload", async () => {
    mocks.recordAdapterIntent.mockResolvedValue({
      created: true,
      adapterRunId: "88888888-8888-4888-8888-000000000001",
      adapterActionId: "88888888-8888-4888-8888-000000000002",
      eventId: "event-1",
      auditEventId: "audit-1",
      evidenceId: "evidence-1",
      externalExecution: "blocked",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "adapter.intent.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "adapter-intent-route-test-001",
          config: {
            connectionId: "99999999-9999-4999-8999-000000000001",
            operation: "draft_customer_response",
            mode: "dry_run",
            maxAttempts: 3,
            request: {
              externalSend: false,
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
    expect(body.data.command).toBe("adapter.intent.record");
    expect(body.data.result.adapterActionId).toBe("88888888-8888-4888-8888-000000000002");
    expect(mocks.recordAdapterIntent).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "adapter-intent-route-test-001",
      connectionId: "99999999-9999-4999-8999-000000000001",
      operation: "draft_customer_response",
      mode: "dry_run",
      taskId: undefined,
      eventId: undefined,
      capabilityId: undefined,
      request: {
        externalSend: false,
      },
      data: {
        source: "route-test",
      },
      maxAttempts: 3,
    });
  });

  it("dispatches rule.change.record with rule config payload", async () => {
    mocks.recordRuleChange.mockResolvedValue({
      created: true,
      objectId: "88888888-8888-4888-8888-000000000003",
      objectVersionId: "88888888-8888-4888-8888-000000000004",
      decisionId: "88888888-8888-4888-8888-000000000005",
      eventId: "event-1",
      auditEventId: "audit-1",
      evidenceId: "evidence-1",
      externalExecution: "blocked",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "rule.change.record",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "rule-change-route-test-001",
          config: {
            rulePackId: "99999999-9999-4999-8999-000000000002",
            ruleKey: "payroll.federal.941.deposit_schedule",
            changeType: "threshold_update",
            title: "Update deposit schedule threshold",
            state: "proposed",
            decision: "owner_review_required",
            sourceRefs: {
              irs: "publication-15",
            },
            before: {
              threshold: "old",
            },
            after: {
              threshold: "new",
            },
            impact: {
              filings: ["941"],
            },
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.command).toBe("rule.change.record");
    expect(body.data.result.objectId).toBe("88888888-8888-4888-8888-000000000003");
    expect(mocks.recordRuleChange).toHaveBeenCalledWith({
      operatorEmail: "operator@example.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: "rule-change-route-test-001",
      rulePackId: "99999999-9999-4999-8999-000000000002",
      ruleKey: "payroll.federal.941.deposit_schedule",
      changeType: "threshold_update",
      title: "Update deposit schedule threshold",
      summary: undefined,
      state: "proposed",
      decision: "owner_review_required",
      rationale: undefined,
      taskId: undefined,
      workflowRunId: undefined,
      capabilityId: undefined,
      sourceRefs: {
        irs: "publication-15",
      },
      before: {
        threshold: "old",
      },
      after: {
        threshold: "new",
      },
      impact: {
        filings: ["941"],
      },
      data: {},
      effectiveAt: undefined,
    });
  });

  it("rejects commands outside the configured tenant scope before dispatch", async () => {
    vi.stubEnv("CONTROL_PLANE_ALLOWED_TENANTS", "continuous-demo");

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
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
      new Request("http://localhost/core", {
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

  it("rejects ad hoc top-level command fields", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "task.create",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-envelope-test-001",
          title: "Mis-shaped task",
          objectId: "33333333-3333-4333-8333-000000000001",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_core_command_envelope",
      message:
        "Core command payload fields must be command, core, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: title, objectId.",
    });
    expect(mocks.createCoreTask).not.toHaveBeenCalled();
  });

  it("rejects malformed command config before dispatch", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/core", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "task.create",
          core: {
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: "core-config-test-001",
          config: "task title",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: "invalid_core_command_config",
      message: "config must be an object when provided.",
    });
    expect(mocks.createCoreTask).not.toHaveBeenCalled();
  });

  it("requires a tenant for scoped Core summary reads", async () => {
    vi.stubEnv("CONTROL_PLANE_ALLOWED_TENANTS", "continuous-demo");

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/core", {
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
