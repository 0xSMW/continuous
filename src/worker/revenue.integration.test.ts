import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileAdapterLedger } from "../core/adapters";
import { executeAiInference } from "../core/ai-gateway";
import { decideApproval, requestApproval } from "../core/approvals";
import { reserveBudget, chargeBudget, releaseBudget } from "../core/budgets";
import { grantCapability } from "../core/capabilities";
import {
  attestControlPlaneTokenRotation,
  authorizeManagedControlPlaneCredential,
  controlPlaneTokenFingerprint,
  recordControlPlaneAuthAttempt,
  reviewControlPlaneSessions,
  revokeControlPlaneCredential,
  upsertControlPlaneCredential,
} from "../core/control-plane-auth";
import {
  attachCoreEvidence,
  createCoreDocument,
  ingestCoreEvent,
  linkCoreObjects,
  prepareCorePacket,
  publishCoreView,
  recordAdapterIntent,
  recordCoreConnectionHealth,
  recordCustomerSignal,
  recordCoreDecision,
  recordExternalAction,
  recordRuleChange,
  upsertCoreAdapter,
  upsertCoreConnection,
  upsertCoreObject,
} from "../core/primitives";
import { preparePayrollPreviewPacket, recordPayrollPreview } from "../core/payroll";
import { createCoreTask, transitionCoreTask } from "../core/tasks";
import { transitionCoreWorker, upsertCoreWorker } from "../core/workers";
import { completeCoreWorkerRun, startCoreWorkerRun } from "../core/worker-runs";
import { executeWorkflowSteps, startWorkflowRun, transitionWorkflowRun } from "../core/workflows";
import { db, pool } from "../db/client";
import {
  adapters,
  adapterActions,
  adapterRuns,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  controlPlaneCredentials,
  customerSignals,
  decisions,
  documents,
  events,
  evaluations,
  evidence,
  evidencePackets,
  filingDrafts,
  jobs,
  objects,
  objectLinks,
  objectVersions,
  payments,
  paymentInstructions,
  payrollLiabilities,
  payrollLines,
  payrollRuns,
  payrollStatements,
  payrollTraces,
  rulePacks,
  tasks,
  generatedViews,
  invoices,
  usageEvents,
  users,
  workflowRuns,
  workflowSteps,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";
import {
  ownerBriefEvalCases,
  revenueWorkerActionEvalCases,
  revenueWorkerBlockedEvalCases,
  revenueWorkerEvalCases,
  scoreOwnerBriefRun,
  scoreRevenueWorkerAction,
  scoreRevenueWorkerRun,
} from "./evals";
import { executeAppServerWorkerTool } from "./app-server-tools";
import { executeWorkerCommand, executeWorkerView } from "./registry";
import {
  classifyRevenueLead,
  continueRevenueWorker,
  draftRevenueResponse,
  runRevenueWorker,
} from "./revenue";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;
const bunExecutable = process.env.BUN_EXECUTABLE ?? "bun";

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

maybeDescribe("Revenue Worker integration eval", () => {
  beforeAll(() => {
    process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail ?? "owner@continuoushq.com";

    execFileSync(bunExecutable, ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    execFileSync(bunExecutable, ["run", "db:seed"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }, 120_000);

  afterAll(async () => {
    if (originalWorkerOperatorEmail === undefined) {
      delete process.env.WORKER_OPERATOR_EMAIL;
    } else {
      process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail;
    }

    await pool.end();
  });

  it("fails closed when required managed worker credential inventory is absent or incomplete", async () => {
    const token = `ci-managed-token-${randomUUID()}`;
    const request = new Request("http://localhost/worker", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const missingCredentialAuth = {
      ok: true as const,
      operatorEmail: "owner@continuoushq.com",
      credentialId: `ci-managed-missing-${randomUUID()}`,
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
    };

    const missingTenantSlug = await authorizeManagedControlPlaneCredential({
      request,
      auth: missingCredentialAuth,
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(missingTenantSlug).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_required",
      message: "tenantSlug is required for managed control-plane credential checks.",
    });

    const unknownTenant = await authorizeManagedControlPlaneCredential({
      request,
      auth: missingCredentialAuth,
      tenantSlug: `missing-tenant-${randomUUID()}`,
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(unknownTenant).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_forbidden",
      message: "Managed control-plane credential checks require a known tenant.",
    });

    const missingRow = await authorizeManagedControlPlaneCredential({
      request,
      auth: missingCredentialAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(missingRow).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_credential_required",
      message: "Managed control-plane credential inventory is required for this control-plane route.",
    });

    const noFingerprintCredentialId = `ci-managed-no-fingerprint-${randomUUID()}`;
    await upsertControlPlaneCredential({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-credential-upsert-no-fingerprint-${randomUUID()}`,
      credentialId: noFingerprintCredentialId,
      displayName: "CI managed operator without fingerprint",
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["worker"],
      allowedAccess: ["write"],
      allowedCommands: ["worker:run"],
      evidence: {
        source: "ci",
      },
      db,
    });

    const noFingerprint = await authorizeManagedControlPlaneCredential({
      request,
      auth: {
        ...missingCredentialAuth,
        credentialId: noFingerprintCredentialId,
      },
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(noFingerprint).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_credential_fingerprint_required",
      message: "Managed control-plane credential inventory requires a token fingerprint.",
    });

    const emptyScopeToken = `ci-managed-empty-scope-token-${randomUUID()}`;
    const emptyScopeCredentialId = `ci-managed-empty-scope-${randomUUID()}`;
    await upsertControlPlaneCredential({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-credential-upsert-empty-scope-${randomUUID()}`,
      credentialId: emptyScopeCredentialId,
      displayName: "CI managed operator with empty scopes",
      tokenFingerprint: controlPlaneTokenFingerprint(emptyScopeToken) ?? undefined,
      allowedTenants: [],
      allowedWorkerRoles: [],
      allowedRoutes: [],
      allowedAccess: [],
      allowedCommands: [],
      evidence: {
        source: "ci",
      },
      db,
    });

    const emptyScopeDenied = await authorizeManagedControlPlaneCredential({
      request: new Request("http://localhost/worker", {
        headers: {
          authorization: `Bearer ${emptyScopeToken}`,
        },
      }),
      auth: {
        ok: true,
        operatorEmail: "owner@continuoushq.com",
        credentialId: emptyScopeCredentialId,
        scope: {
          tenantSlugs: ["continuous-demo"],
          workerRoles: ["revenue_operations"],
        },
      },
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(emptyScopeDenied).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_tenant_forbidden",
      message: "This managed control-plane credential is not allowed to access the requested tenant.",
    });
  });

  it("requires exact route-qualified commands in managed credential inventory", async () => {
    for (const allowedCommands of [["run"], ["worker:*"], ["*"]]) {
      await expect(
        upsertControlPlaneCredential({
          operatorEmail: "owner@continuoushq.com",
          tenantSlug: "continuous-demo",
          idempotencyKey: `ci-managed-weak-command-${randomUUID()}`,
          credentialId: `ci-managed-weak-command-${randomUUID()}`,
          displayName: "CI weak command scope",
          tokenFingerprint: controlPlaneTokenFingerprint(`ci-managed-token-${randomUUID()}`) ?? undefined,
          allowedTenants: ["continuous-demo"],
          allowedWorkerRoles: ["revenue_operations"],
          allowedRoutes: ["worker"],
          allowedAccess: ["write"],
          allowedCommands,
          evidence: {
            source: "ci",
          },
          db,
        }),
      ).rejects.toMatchObject({
        code: "invalid_control_plane_credential",
        status: 400,
      });
    }

    const token = `ci-managed-exact-token-${randomUUID()}`;
    const credentialId = `ci-managed-exact-command-${randomUUID()}`;
    const tokenFingerprint = controlPlaneTokenFingerprint(token);

    await upsertControlPlaneCredential({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-managed-exact-command-${randomUUID()}`,
      credentialId,
      displayName: "CI exact command scope",
      tokenFingerprint: tokenFingerprint ?? undefined,
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["worker"],
      allowedAccess: ["write"],
      allowedCommands: ["worker:run"],
      evidence: {
        source: "ci",
      },
      db,
    });

    const allowed = await authorizeManagedControlPlaneCredential({
      request: new Request("http://localhost/worker", {
        headers: {
          authorization: `Bearer ${token}`,
        },
      }),
      auth: {
        ok: true,
        operatorEmail: "owner@continuoushq.com",
        credentialId,
        scope: {
          tenantSlugs: ["continuous-demo"],
          workerRoles: ["revenue_operations"],
        },
      },
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(allowed.ok).toBe(true);

    for (const command of [undefined, " "]) {
      const denied = await authorizeManagedControlPlaneCredential({
        request: new Request("http://localhost/worker", {
          headers: {
            authorization: `Bearer ${token}`,
          },
        }),
        auth: {
          ok: true,
          operatorEmail: "owner@continuoushq.com",
          credentialId,
          scope: {
            tenantSlugs: ["continuous-demo"],
            workerRoles: ["revenue_operations"],
          },
        },
        tenantSlug: "continuous-demo",
        workerRole: "revenue_operations",
        route: "worker",
        access: "write",
        command,
        requireManagedCredential: true,
        db,
      });

      expect(denied).toEqual({
        ok: false,
        status: 403,
        code: "control_plane_command_forbidden",
        message: "This managed control-plane credential is not allowed to execute the requested command.",
      });
    }
  });

  it("lets recovery commands reconcile stale managed credential fingerprints without opening normal commands", async () => {
    const credentialId = `ci-managed-recovery-${randomUUID()}`;
    const staleToken = `ci-managed-stale-token-${randomUUID()}`;
    const nextToken = `ci-managed-next-token-${randomUUID()}`;

    await upsertControlPlaneCredential({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-managed-recovery-upsert-${randomUUID()}`,
      credentialId,
      displayName: "CI stale recovery credential",
      tokenFingerprint: controlPlaneTokenFingerprint(staleToken) ?? undefined,
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["core", "worker"],
      allowedAccess: ["write"],
      allowedCommands: ["core:control_plane.credential.upsert", "worker:run"],
      evidence: {
        source: "ci",
      },
      db,
    });

    const nextRequest = new Request("http://localhost/core", {
      headers: {
        authorization: `Bearer ${nextToken}`,
      },
    });
    const catalogAuth = {
      ok: true as const,
      operatorEmail: "owner@continuoushq.com",
      credentialId,
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
    };
    const normalCommandDenied = await authorizeManagedControlPlaneCredential({
      request: nextRequest,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(normalCommandDenied).toEqual({
      ok: false,
      status: 401,
      code: "control_plane_credential_fingerprint_mismatch",
      message: "Control-plane credential fingerprint does not match managed credential inventory.",
    });

    const recoveryCommandAllowed = await authorizeManagedControlPlaneCredential({
      request: nextRequest,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      route: "core",
      access: "write",
      command: "control_plane.credential.upsert",
      requireManagedCredential: false,
      db,
    });

    expect(recoveryCommandAllowed.ok).toBe(true);

    const unlistedRecoveryCommandDenied = await authorizeManagedControlPlaneCredential({
      request: nextRequest,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      route: "core",
      access: "write",
      command: "control_plane.session.review",
      requireManagedCredential: false,
      db,
    });

    expect(unlistedRecoveryCommandDenied).toEqual({
      ok: false,
      status: 403,
      code: "control_plane_command_forbidden",
      message: "This managed control-plane credential is not allowed to execute the requested command.",
    });
  });

  it("enforces managed control-plane credential revocation after catalog auth succeeds", async () => {
    const credentialId = `ci-managed-${randomUUID()}`;
    const token = `ci-managed-token-${randomUUID()}`;
    const tokenFingerprint = controlPlaneTokenFingerprint(token);
    const upsertIdempotencyKey = `ci-credential-upsert-${randomUUID()}`;
    const upsertInput = {
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: upsertIdempotencyKey,
      credentialId,
      displayName: "CI managed operator",
      tokenFingerprint: tokenFingerprint ?? undefined,
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["worker"],
      allowedAccess: ["write"],
      allowedCommands: ["worker:run"],
      evidence: {
        source: "ci",
      },
      db,
    };
    const upsert = await upsertControlPlaneCredential(upsertInput);

    expect(upsert.created).toBe(true);

    const [storedCredential] = await db
      .select()
      .from(controlPlaneCredentials)
      .where(eq(controlPlaneCredentials.id, upsert.controlPlaneCredentialId))
      .limit(1);

    expect(storedCredential.tokenFingerprint).toBe(tokenFingerprint);
    expect(JSON.stringify(storedCredential.evidence)).not.toContain(token);
    const upsertReplay = await upsertControlPlaneCredential(upsertInput);

    expect(upsertReplay.created).toBe(false);
    expect(upsertReplay.updated).toBe(false);
    expect(upsertReplay.controlPlaneCredentialId).toBe(upsert.controlPlaneCredentialId);
    expect(upsertReplay.eventId).toBe(upsert.eventId);
    expect(upsertReplay.auditEventId).toBe(upsert.auditEventId);
    await expect(
      upsertControlPlaneCredential({
        ...upsertInput,
        displayName: "Changed CI managed operator",
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    const request = new Request("http://localhost/worker", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const catalogAuth = {
      ok: true as const,
      operatorEmail: "owner@continuoushq.com",
      credentialId,
      scope: {
        tenantSlugs: ["continuous-demo"],
        workerRoles: ["revenue_operations"],
      },
    };
    const allowed = await authorizeManagedControlPlaneCredential({
      request,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(allowed.ok).toBe(true);

    const rotatedToken = `ci-managed-rotated-token-${randomUUID()}`;
    const rotatedTokenFingerprint = controlPlaneTokenFingerprint(rotatedToken);
    const rotatedRequest = new Request("http://localhost/worker", {
      headers: {
        authorization: `Bearer ${rotatedToken}`,
      },
    });
    const rotationIdempotencyKey = `ci-credential-rotation-${randomUUID()}`;
    const rotationInput = {
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: rotationIdempotencyKey,
      credentialId,
      previousCredentialId: credentialId,
      previousTokenFingerprint: tokenFingerprint ?? undefined,
      nextTokenFingerprint: rotatedTokenFingerprint ?? undefined,
      reason: "CI rotation bridge proof",
      evidence: {
        source: "ci",
      },
      db,
    };
    const rotation = await attestControlPlaneTokenRotation(rotationInput);

    expect(rotation.tokenRotationAttestationId).toBeTruthy();
    const rotationReplay = await attestControlPlaneTokenRotation(rotationInput);

    expect(rotationReplay.created).toBe(false);
    expect(rotationReplay.tokenRotationAttestationId).toBe(rotation.tokenRotationAttestationId);
    expect(rotationReplay.eventId).toBe(rotation.eventId);
    expect(rotationReplay.auditEventId).toBe(rotation.auditEventId);
    await expect(
      attestControlPlaneTokenRotation({
        ...rotationInput,
        reason: "Changed CI rotation bridge proof",
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    await db
      .update(controlPlaneCredentials)
      .set({
        lastUsedAt: sql`now() + interval '1 second'`,
        updatedAt: sql`now() + interval '1 second'`,
      })
      .where(eq(controlPlaneCredentials.id, upsert.controlPlaneCredentialId));

    const rotatedBridgeAllowed = await authorizeManagedControlPlaneCredential({
      request: rotatedRequest,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(rotatedBridgeAllowed.ok).toBe(true);

    await upsertControlPlaneCredential({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-credential-upsert-rotated-${randomUUID()}`,
      credentialId,
      displayName: "CI managed operator",
      tokenFingerprint: rotatedTokenFingerprint ?? undefined,
      allowedTenants: ["continuous-demo"],
      allowedWorkerRoles: ["revenue_operations"],
      allowedRoutes: ["worker"],
      allowedAccess: ["write"],
      allowedCommands: ["worker:run"],
      evidence: {
        source: "ci",
        rotation: rotation.tokenRotationAttestationId,
      },
      db,
    });

    const previousTokenDenied = await authorizeManagedControlPlaneCredential({
      request,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(previousTokenDenied).toEqual({
      ok: false,
      status: 401,
      code: "control_plane_credential_fingerprint_mismatch",
      message: "Control-plane credential fingerprint does not match managed credential inventory.",
    });

    const revokeIdempotencyKey = `ci-credential-revoke-${randomUUID()}`;
    const revokeInput = {
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: revokeIdempotencyKey,
      credentialId,
      reason: "CI revocation proof",
      evidence: {
        source: "ci",
      },
      db,
    };
    const revoke = await revokeControlPlaneCredential(revokeInput);

    expect(revoke.revoked).toBe(true);
    const revokeReplay = await revokeControlPlaneCredential(revokeInput);

    expect(revokeReplay.revoked).toBe(false);
    expect(revokeReplay.controlPlaneCredentialId).toBe(revoke.controlPlaneCredentialId);
    expect(revokeReplay.eventId).toBe(revoke.eventId);
    expect(revokeReplay.auditEventId).toBe(revoke.auditEventId);
    await expect(
      revokeControlPlaneCredential({
        ...revokeInput,
        reason: "Changed CI revocation proof",
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    const denied = await authorizeManagedControlPlaneCredential({
      request: rotatedRequest,
      auth: catalogAuth,
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      route: "worker",
      access: "write",
      command: "run",
      requireManagedCredential: true,
      db,
    });

    expect(denied).toEqual({
      ok: false,
      status: 401,
      code: "control_plane_credential_revoked",
      message: "Control-plane credential has been revoked.",
    });

    const authSession = await recordControlPlaneAuthAttempt({
      request: rotatedRequest,
      route: "worker",
      access: "write",
      command: "run",
      tenantSlug: "continuous-demo",
      workerRole: "revenue_operations",
      auth: catalogAuth,
      guard: denied,
      scope: { ok: true },
      db,
    });

    expect(authSession?.id).toBeTruthy();

    const reviewIdempotencyKey = `ci-session-review-${randomUUID()}`;
    const reviewInput = {
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: reviewIdempotencyKey,
      credentialId,
      outcome: "denied",
      limit: 10,
      db,
    };
    const review = await reviewControlPlaneSessions(reviewInput);

    expect(review.reviewed).toBe(true);
    expect(review.counts.denied).toBeGreaterThanOrEqual(1);
    expect(review.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId,
          reasonCode: "control_plane_credential_revoked",
        }),
      ]),
    );
    const reviewReplay = await reviewControlPlaneSessions(reviewInput);

    expect(reviewReplay.reviewed).toBe(false);
    expect(reviewReplay.reviewViewId).toBe(review.reviewViewId);
    expect(reviewReplay.eventId).toBe(review.eventId);
    expect(reviewReplay.auditEventId).toBe(review.auditEventId);
    await expect(
      reviewControlPlaneSessions({
        ...reviewInput,
        outcome: "allowed",
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  });

  it("creates headless core tasks with event and audit proof", async () => {
    const idempotencyKey = `ci-core-task-${randomUUID()}`;
    const first = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      title: "Review agency notice packet",
      priority: "high",
      owner: {
        type: "user",
      },
      evidence: {
        required: ["notice_packet"],
      },
      cost: {
        humanMinutes: 15,
      },
      kpi: {
        riskAvoided: "filing_penalty",
      },
      db,
    });

    expect(first.created).toBe(true);
    expect(first.task.title).toBe("Review agency notice packet");
    expect(first.task.state).toBe("active");
    expect(first.task.priority).toBe("high");
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();

    const [task] = await db.select().from(tasks).where(eq(tasks.id, first.taskId)).limit(1);
    const [event] = await db.select().from(events).where(eq(events.id, first.eventId ?? "")).limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);

    expect(task?.title).toBe("Review agency notice packet");
    expect(task?.ownerRef).toMatch(/^user:/);
    expect(objectValue(task?.evidence).required).toEqual(["notice_packet"]);
    expect(event?.type).toBe("task.created");
    expect(event?.taskId).toBe(first.taskId);
    expect(audit?.type).toBe("task.created");
    expect(audit?.targetType).toBe("task");
    expect(audit?.targetId).toBe(first.taskId);
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");
    expect(objectValue(objectValue(audit?.data).idempotency)).toMatchObject({
      command: "task.create",
      hashVersion: 1,
    });
    expect(stringValue(objectValue(objectValue(audit?.data).idempotency).inputHash)).toHaveLength(64);

    const replay = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      title: "Review agency notice packet",
      priority: "high",
      owner: {
        type: "user",
      },
      evidence: {
        required: ["notice_packet"],
      },
      cost: {
        humanMinutes: 15,
      },
      kpi: {
        riskAvoided: "filing_penalty",
      },
      db,
    });
    await expect(
      createCoreTask({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey,
        title: "Different title should conflict",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
    const [taskCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.tasks"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:task_created`),
        ),
      );

    expect(replay.created).toBe(false);
    expect(replay.taskId).toBe(first.taskId);
    expect(taskCount.value).toBe(1);
  }, 120_000);

  it("records Core workers as lifecycle-owned objects with event, evidence, and audit proof", async () => {
    const runId = randomUUID();
    const upsertKey = `ci-core-worker-upsert-${runId}`;
    const transitionKey = `ci-core-worker-transition-${runId}`;
    const first = await upsertCoreWorker({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: upsertKey,
      kind: "synthetic",
      state: "draft",
      name: "Compliance Operations Worker CI",
      role: `compliance_operations_ci_${runId}`,
      mission: "Prepare source-backed compliance filing packets while external execution stays blocked.",
      autonomyLevel: 1,
      scope: {
        flows: ["filing_prepare"],
      },
      policy: {
        externalExecution: "blocked",
      },
      lifecycle: {
        workflowKey: "synthetic_worker_lifecycle",
      },
      evidence: {
        packet: "synthetic_worker_packet",
      },
      db,
    });

    expect(first.created).toBe(true);
    expect(first.worker.kind).toBe("synthetic");
    expect(first.worker.state).toBe("draft");
    expect(first.objectId).toBeTruthy();
    expect(first.objectVersionId).toBeTruthy();
    expect(first.eventId).toBeTruthy();
    expect(first.evidenceId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();

    const [worker] = await db.select().from(workers).where(eq(workers.id, first.workerId)).limit(1);
    const [object] = await db.select().from(objects).where(eq(objects.id, first.objectId ?? "")).limit(1);
    const [event] = await db.select().from(events).where(eq(events.id, first.eventId ?? "")).limit(1);
    const [trace] = await db.select().from(evidence).where(eq(evidence.id, first.evidenceId ?? "")).limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);

    expect(worker?.role).toBe(`compliance_operations_ci_${runId}`);
    expect(object?.type).toBe("worker");
    expect(object?.source).toBe("continuous.core.workers");
    expect(object?.externalId).toBe(`worker:${first.workerId}`);
    expect(event?.type).toBe("worker.created");
    expect(event?.objectId).toBe(first.objectId);
    expect(trace?.kind).toBe("trace");
    expect(trace?.objectId).toBe(first.objectId);
    expect(audit?.type).toBe("worker.created");
    expect(audit?.targetType).toBe("worker");
    expect(audit?.targetId).toBe(first.workerId);
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");

    const replay = await upsertCoreWorker({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: upsertKey,
      kind: "synthetic",
      state: "draft",
      name: "Compliance Operations Worker CI",
      role: `compliance_operations_ci_${runId}`,
      mission: "Prepare source-backed compliance filing packets while external execution stays blocked.",
      autonomyLevel: 1,
      scope: {
        flows: ["filing_prepare"],
      },
      policy: {
        externalExecution: "blocked",
      },
      lifecycle: {
        workflowKey: "synthetic_worker_lifecycle",
      },
      evidence: {
        packet: "synthetic_worker_packet",
      },
      db,
    });

    expect(replay.recorded).toBe(false);
    expect(replay.workerId).toBe(first.workerId);
    await expect(
      upsertCoreWorker({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: upsertKey,
        kind: "synthetic",
        state: "draft",
        name: "Changed Worker",
        role: `compliance_operations_ci_${runId}`,
        mission: "Prepare source-backed compliance filing packets while external execution stays blocked.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    await expect(
      transitionCoreWorker({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-worker-invalid-transition-${runId}`,
        workerId: first.workerId,
        toState: "active",
        reason: "Skip simulation",
        db,
      }),
    ).rejects.toMatchObject({
      code: "worker_transition_invalid",
      status: 409,
    });

    const transitioned = await transitionCoreWorker({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: transitionKey,
      workerId: first.workerId,
      toState: "training",
      reason: "Start simulation",
      lifecycle: {
        workflowKey: "synthetic_worker_lifecycle",
      },
      evidence: {
        checklist: ["scope", "budget", "eval"],
      },
      db,
    });
    const [updatedWorker] = await db
      .select()
      .from(workers)
      .where(eq(workers.id, first.workerId))
      .limit(1);
    const [transitionEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, transitioned.eventId ?? ""))
      .limit(1);

    expect(transitioned.transitioned).toBe(true);
    expect(transitioned.worker.state).toBe("training");
    expect(updatedWorker?.state).toBe("training");
    expect(transitionEvent?.type).toBe("worker.transitioned");
    expect(transitionEvent?.objectId).toBe(first.objectId);
  }, 120_000);

  it("runs Core AI gateway inference with route policy, redaction, budget, and replay proof", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-core-ai-gateway-${runId}`;
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const [capability] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(eq(capabilities.key, "lead.classify"))
      .limit(1);
    const [budgetAccount] = await db
      .select({ id: budgetAccounts.id })
      .from(budgetAccounts)
      .where(eq(budgetAccounts.targetId, worker?.id ?? ""))
      .limit(1);

    if (!worker || !capability || !budgetAccount) {
      throw new Error("Missing seeded AI gateway worker, capability, or budget account.");
    }

    const result = await executeAiInference({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      routeKey: "low_cost_fast",
      budgetAccountId: budgetAccount.id,
      maxUnits: 750,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
        ref: `worker:${worker.id}`,
      },
      input: {
        prompt: "Classify this lead for quote readiness.",
        customerName: "Acme Roof Repair",
        token: null,
        inputRefs: {
          sourceObjectId: "33333333-3333-4333-8333-000000000001",
          token: null,
        },
      },
      redaction: {
        fields: ["token"],
      },
      evaluation: {
        caseId: "ci.lead_classification",
      },
      db,
    });

    expect(result.created).toBe(true);
    expect(result.inferenceId).toBeTruthy();
    expect(result.reservationId).toBeTruthy();
    expect(result.usageEventId).toBeTruthy();
    expect(result.eventId).toBeTruthy();
    expect(result.auditEventId).toBeTruthy();
    expect(result.evidenceId).toBeTruthy();
    expect(result.units).toBe(750);
    expect(objectValue(result.request).input).toMatchObject({
      prompt: "Classify this lead for quote readiness.",
      customerName: "Acme Roof Repair",
      token: "[redacted]",
      inputRefs: {
        sourceObjectId: "33333333-3333-4333-8333-000000000001",
        token: "[redacted]",
      },
    });
    expect(objectValue(result.request).inputRefs).toMatchObject({
      sourceObjectId: "33333333-3333-4333-8333-000000000001",
      token: "[redacted]",
    });
    expect(objectValue(result.result).mode).toBe("deterministic");
    expect(objectValue(result.safety).externalExecution).toBe("blocked");

    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, result.usageEventId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, result.auditEventId ?? ""))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, result.evidenceId ?? ""))
      .limit(1);

    expect(usage?.inferenceId).toBe(result.inferenceId);
    expect(usage?.units).toBe(750);
    expect(audit?.source).toBe("continuous.core.ai_gateway");
    expect(audit?.targetType).toBe("inference");
    expect(audit?.targetId).toBe(result.inferenceId);
    expect(objectValue(audit?.data).providerExecution).toBe("disabled");
    expect(proof?.kind).toBe("trace");
    expect(objectValue(objectValue(proof?.data).redactedRequest).input).toMatchObject({
      token: "[redacted]",
      inputRefs: {
        token: "[redacted]",
      },
    });
    expect(objectValue(objectValue(proof?.data).redactedRequest).inputRefs).toMatchObject({
      token: "[redacted]",
    });

    const replay = await executeAiInference({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      routeKey: "low_cost_fast",
      budgetAccountId: budgetAccount.id,
      maxUnits: 750,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
        ref: `worker:${worker.id}`,
      },
      input: {
        prompt: "Classify this lead for quote readiness.",
        customerName: "Acme Roof Repair",
        token: null,
        inputRefs: {
          sourceObjectId: "33333333-3333-4333-8333-000000000001",
          token: null,
        },
      },
      redaction: {
        fields: ["token"],
      },
      evaluation: {
        caseId: "ci.lead_classification",
      },
      db,
    });
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.ai_gateway"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:ai_infer`),
        ),
      );

    expect(replay.created).toBe(false);
    expect(replay.inferenceId).toBe(result.inferenceId);
    expect(replay.usageEventId).toBe(result.usageEventId);
    expect(auditCount.value).toBe(1);
    await expect(
      executeAiInference({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey,
        routeKey: "low_cost_fast",
        budgetAccountId: budgetAccount.id,
        maxUnits: 750,
        capabilityId: capability.id,
        actor: {
          type: "worker",
          id: worker.id,
          ref: `worker:${worker.id}`,
        },
        input: {
          prompt: "Changed input must conflict with the original inference.",
          customerName: "Acme Roof Repair",
          token: null,
          inputRefs: {
            sourceObjectId: "33333333-3333-4333-8333-000000000001",
            token: null,
          },
        },
        redaction: {
          fields: ["token"],
        },
        evaluation: {
          caseId: "ci.lead_classification",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("records payroll preview statements, lines, liabilities, traces, and proof", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-payroll-preview-${runId}`;
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const employmentId = "55555555-5555-4555-8555-000000000004";
    const payrollObjectId = "33333333-3333-4333-8333-000000000105";
    const first = await recordPayrollPreview({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      statement: {
        employmentId,
        objectId: payrollObjectId,
        externalId: `ci-payroll-statement-${runId}`,
        state: "draft",
        grossCents: 336000,
        netCents: 248640,
        taxCents: 87360,
        deductionCents: 0,
        data: {
          source: "ci",
        },
      },
      lines: [
        {
          kind: "earning",
          code: "regular_hours",
          description: "Regular wages",
          amountCents: 336000,
          taxable: true,
          data: {
            hours: 80,
            rateCents: 4200,
          },
        },
        {
          kind: "tax",
          code: "federal_withholding",
          amountCents: 87360,
          data: {
            authority: "IRS",
          },
        },
      ],
      liabilities: [
        {
          kind: "tax_withholding",
          payee: "IRS",
          jurisdiction: "US",
          amountCents: 87360,
          state: "draft",
        },
      ],
      trace: {
        hash: `ci-payroll-trace-${runId}`,
        sourceRefs: {
          payrollRunId,
          employmentId,
        },
        inputs: {
          hours: 80,
          rateCents: 4200,
        },
        outputs: {
          grossCents: 336000,
          netCents: 248640,
          taxCents: 87360,
        },
        rules: {
          execution: "preview_only",
        },
      },
      db,
    });

    expect(first.recorded).toBe(true);
    expect(first.statementId).toBeTruthy();
    expect(first.lineIds).toHaveLength(2);
    expect(first.liabilityIds).toHaveLength(1);
    expect(first.traceId).toBeTruthy();
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();
    expect(first.evidenceId).toBeTruthy();

    const [statement] = await db
      .select()
      .from(payrollStatements)
      .where(eq(payrollStatements.id, first.statementId))
      .limit(1);
    const lines = await db
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.statementId, first.statementId));
    const liabilities = await db
      .select()
      .from(payrollLiabilities)
      .where(eq(payrollLiabilities.statementId, first.statementId));
    const [trace] = await db
      .select()
      .from(payrollTraces)
      .where(eq(payrollTraces.id, first.traceId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.evidenceId ?? ""))
      .limit(1);
    const [payrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);

    expect(statement?.payrollRunId).toBe(payrollRunId);
    expect(statement?.employmentId).toBe(employmentId);
    expect(statement?.grossCents).toBe(336000);
    expect(lines.map((line) => line.kind).sort()).toEqual(["earning", "tax"]);
    expect(liabilities[0]?.payee).toBe("IRS");
    expect(trace?.hash).toBe(`ci-payroll-trace-${runId}`);
    expect(audit?.type).toBe("payroll.preview.recorded");
    expect(audit?.source).toBe("continuous.core.payroll");
    expect(audit?.targetType).toBe("payroll_statement");
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");
    expect(proof?.kind).toBe("trace");
    expect(objectValue(proof?.data).traceId).toBe(first.traceId);
    expect(objectValue(payrollRun?.data).preview).toMatchObject({
      lastStatementId: first.statementId,
      traceId: first.traceId,
      externalExecution: "blocked",
    });

    const replay = await recordPayrollPreview({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      statement: {
        employmentId,
        objectId: payrollObjectId,
        externalId: `ci-payroll-statement-${runId}`,
        state: "draft",
        grossCents: 336000,
        netCents: 248640,
        taxCents: 87360,
        deductionCents: 0,
        data: {
          source: "ci",
        },
      },
      lines: [
        {
          kind: "earning",
          code: "regular_hours",
          description: "Regular wages",
          amountCents: 336000,
          taxable: true,
          data: {
            hours: 80,
            rateCents: 4200,
          },
        },
        {
          kind: "tax",
          code: "federal_withholding",
          amountCents: 87360,
          data: {
            authority: "IRS",
          },
        },
      ],
      liabilities: [
        {
          kind: "tax_withholding",
          payee: "IRS",
          jurisdiction: "US",
          amountCents: 87360,
          state: "draft",
        },
      ],
      trace: {
        hash: `ci-payroll-trace-${runId}`,
        sourceRefs: {
          payrollRunId,
          employmentId,
        },
        inputs: {
          hours: 80,
          rateCents: 4200,
        },
        outputs: {
          grossCents: 336000,
          netCents: 248640,
          taxCents: 87360,
        },
        rules: {
          execution: "preview_only",
        },
      },
      db,
    });
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.payroll"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:payroll_preview_recorded`),
        ),
      );

    expect(replay.recorded).toBe(false);
    expect(replay.statementId).toBe(first.statementId);
    expect(auditCount.value).toBe(1);
    await expect(
      recordPayrollPreview({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey,
        payrollRunId,
        statement: {
          employmentId,
          grossCents: 1,
          netCents: 1,
          taxCents: 0,
        },
        lines: [
          {
            kind: "earning",
            amountCents: 1,
          },
        ],
        trace: {
          hash: "should-conflict",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("prepares payroll preview packets with approval and blocked funding handoffs", async () => {
    const runId = randomUUID();
    const idempotencyKey = `ci-payroll-packet-${runId}`;
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const payrollObjectId = "33333333-3333-4333-8333-000000000105";
    const first = await preparePayrollPreviewPacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      objectId: payrollObjectId,
      variance: {
        source: "ci",
      },
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(first.prepared).toBe(true);
    expect(first.packetId).toBeTruthy();
    expect(first.packetDocumentId).toBeTruthy();
    expect(first.varianceDocumentId).toBeTruthy();
    expect(first.payStatementDocumentIds.length).toBeGreaterThanOrEqual(1);
    expect(first.paymentInstructionIds).toHaveLength(2);
    expect(first.filingDraftId).toBeTruthy();
    expect(first.approvalRequestId).toBeTruthy();
    expect(first.eventId).toBeTruthy();
    expect(first.auditEventId).toBeTruthy();
    expect(first.evidenceId).toBeTruthy();
    expect(first.externalExecution).toBe("blocked");

    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, first.packetId))
      .limit(1);
    const [packetDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.packetDocumentId ?? ""))
      .limit(1);
    const [varianceDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.varianceDocumentId ?? ""))
      .limit(1);
    const paymentDrafts = await db
      .select()
      .from(paymentInstructions)
      .where(inArray(paymentInstructions.id, first.paymentInstructionIds));
    const [filingDraft] = await db
      .select()
      .from(filingDrafts)
      .where(eq(filingDrafts.id, first.filingDraftId ?? ""))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, first.auditEventId))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.evidenceId ?? ""))
      .limit(1);

    expect(packet?.kind).toBe("payroll_packet");
    expect(packet?.state).toBe("approval_required");
    expect(objectValue(packet?.data).externalExecution).toBe("blocked");
    expect(objectValue(packet?.data).approvalRequestId).toBe(first.approvalRequestId);
    expect(packetDocument?.kind).toBe("payroll_packet");
    expect(varianceDocument?.kind).toBe("payroll_variance_report");
    expect(paymentDrafts.map((draft) => draft.kind).sort()).toEqual([
      "payroll_net_pay_funding",
      "payroll_tax_deposit",
    ]);
    expect(paymentDrafts.every((draft) => draft.state === "approval_required")).toBe(true);
    expect(paymentDrafts.every((draft) => objectValue(draft.data).moneyMovement === "blocked")).toBe(true);
    expect(filingDraft?.state).toBe("source_review");
    expect(objectValue(filingDraft?.data).externalExecution).toBe("blocked");
    expect(approval?.kind).toBe("payroll_preview_approval");
    expect(approval?.state).toBe("pending");
    expect(objectValue(approval?.requestedAction).moneyMovement).toBe("blocked");
    expect(audit?.type).toBe("payroll.preview.packet.prepared");
    expect(audit?.targetType).toBe("evidence_packet");
    expect(proof?.kind).toBe("trace");
    expect(objectValue(proof?.data).packetId).toBe(first.packetId);

    const replay = await preparePayrollPreviewPacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey,
      payrollRunId,
      objectId: payrollObjectId,
      variance: {
        source: "ci",
      },
      data: {
        source: "ci.core",
      },
      db,
    });
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.core.payroll"),
          eq(auditEvents.idempotencyKey, `${idempotencyKey}:payroll_preview_packet_prepared`),
        ),
      );

    expect(replay.prepared).toBe(false);
    expect(replay.packetId).toBe(first.packetId);
    expect(replay.approvalRequestId).toBe(first.approvalRequestId);
    expect(auditCount.value).toBe(1);
    await expect(
      preparePayrollPreviewPacket({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey,
        payrollRunId,
        objectId: payrollObjectId,
        variance: {
          source: "changed",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    const approvalDecisionIdempotencyKey = `ci-payroll-approval-decision-${runId}`;
    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: approvalDecisionIdempotencyKey,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI payroll preview approval; execution remains blocked.",
      subject: "core",
      db,
    });

    expect(decision.approval.state).toBe("approved");
    expect(objectValue(decision.payrollHandoff).externalExecution).toBe("blocked");

    const [approvedPayrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);
    const approvedPaymentDrafts = await db
      .select()
      .from(paymentInstructions)
      .where(inArray(paymentInstructions.id, first.paymentInstructionIds));
    const [approvedFilingDraft] = await db
      .select()
      .from(filingDrafts)
      .where(eq(filingDrafts.id, first.filingDraftId ?? ""))
      .limit(1);
    const [approvedPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, first.packetId))
      .limit(1);
    const [approvedPacketDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, first.packetDocumentId ?? ""))
      .limit(1);
    const [handoffEvent] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, "payroll.preview.approval.applied"),
          sql`${events.data}->>'approvalRequestId' = ${first.approvalRequestId}`,
        ),
      )
      .limit(1);
    const [handoffAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.type, "payroll.preview.approval.applied"),
          eq(auditEvents.targetType, "payroll_run"),
          eq(auditEvents.targetId, payrollRunId),
        ),
      )
      .limit(1);

    const payrollHandoff = objectValue(approvedPayrollRun?.data).handoff;
    expect(approvedPayrollRun?.state).toBe("approved");
    expect(objectValue(payrollHandoff).approvalRequestId).toBe(first.approvalRequestId);
    expect(objectValue(payrollHandoff).externalExecution).toBe("blocked");
    expect(objectValue(payrollHandoff).moneyMovement).toBe("blocked");
    expect(approvedPaymentDrafts.every((draft) => draft.state === "approved_blocked")).toBe(true);
    expect(
      approvedPaymentDrafts.every((draft) => objectValue(objectValue(draft.data).approvalDecision).action === "approved"),
    ).toBe(true);
    expect(
      approvedPaymentDrafts.every((draft) => objectValue(objectValue(draft.data).handoff).moneyMovement === "blocked"),
    ).toBe(true);
    expect(approvedFilingDraft?.state).toBe("approved_blocked");
    expect(objectValue(objectValue(approvedFilingDraft?.data).handoff).submission).toBe("blocked");
    expect(approvedPacket?.state).toBe("approved");
    expect(objectValue(objectValue(approvedPacket?.data).handoff).approvalRequestId).toBe(first.approvalRequestId);
    expect(approvedPacketDocument?.state).toBe("approved");
    expect(objectValue(objectValue(approvedPacketDocument?.data).handoff).approvalRequestId).toBe(
      first.approvalRequestId,
    );
    expect(handoffEvent?.source).toBe("continuous.approvals");
    expect(handoffAudit?.risk).toBe("high");

    const replayedDecision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: approvalDecisionIdempotencyKey,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI payroll preview approval; execution remains blocked.",
      subject: "core",
      db,
    });
    const [decisionAuditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.approvals"),
          eq(auditEvents.idempotencyKey, `${approvalDecisionIdempotencyKey}:approval_decided`),
        ),
      );

    expect(replayedDecision.auditEventId).toBe(decision.auditEventId);
    expect(replayedDecision.evidenceId).toBe(decision.evidenceId);
    expect(objectValue(replayedDecision.payrollHandoff).approvalRequestId).toBe(first.approvalRequestId);
    expect(decisionAuditCount.value).toBe(1);
    await expect(
      decideApproval({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: approvalDecisionIdempotencyKey,
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        action: "approved",
        note: "Changed approval note must conflict.",
        subject: "core",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("fails closed when payroll approval artifacts are missing", async () => {
    const runId = randomUUID();
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const [beforePayrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);
    const approvalResult = await requestApproval({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-payroll-missing-artifacts-request-${runId}`,
      kind: "payroll_preview_approval",
      title: "Approve payroll packet with missing artifacts",
      summary: "This malformed approval should stay pending and leave payroll untouched.",
      priority: "high",
      risk: "high",
      evidence: {
        payrollRunId,
      },
      data: {
        payrollRunId,
        externalExecution: "blocked",
      },
      db,
    });

    await expect(
      decideApproval({
        approvalId: approvalResult.approvalRequestId,
        idempotencyKey: `ci-payroll-missing-artifacts-decision-${runId}`,
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        action: "approved",
        note: "This must fail closed before payroll handoff.",
        subject: "core",
        db,
      }),
    ).rejects.toMatchObject({
      code: "payroll_approval_packet_required",
      status: 409,
    });

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalResult.approvalRequestId))
      .limit(1);
    const [afterPayrollRun] = await db
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, payrollRunId))
      .limit(1);
    const [appliedEventCount] = await db
      .select({ value: count() })
      .from(events)
      .where(
        and(
          eq(events.type, "payroll.preview.approval.applied"),
          sql`${events.data}->>'approvalRequestId' = ${approvalResult.approvalRequestId}`,
        ),
      );

    expect(approval?.state).toBe("pending");
    expect(afterPayrollRun?.state).toBe(beforePayrollRun?.state);
    expect(objectValue(afterPayrollRun?.data).handoff).toEqual(objectValue(beforePayrollRun?.data).handoff);
    expect(appliedEventCount.value).toBe(0);
  }, 120_000);

  it("transitions headless core tasks and requests approval packets", async () => {
    const runId = randomUUID();
    const taskResult = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-${runId}`,
      title: "Review agency response packet",
      priority: "high",
      evidence: {
        required: ["response_packet"],
      },
      db,
    });
    const transitionResult = await transitionCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-transition-${runId}`,
      taskId: taskResult.taskId,
      toState: "waiting",
      reason: "Response packet is waiting for owner review.",
      evidence: {
        packetReady: true,
      },
      outcome: {
        status: "waiting_on_owner",
      },
      db,
    });

    expect(transitionResult.transitioned).toBe(true);
    expect(transitionResult.task.state).toBe("waiting");
    expect(transitionResult.eventId).toBeTruthy();
    expect(transitionResult.auditEventId).toBeTruthy();
    expect(transitionResult.evidenceId).toBeTruthy();

    const approvalResult = await requestApproval({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-approval-${runId}`,
      taskId: taskResult.taskId,
      eventId: transitionResult.eventId ?? undefined,
      kind: "agency_notice_response_approval",
      title: "Approve agency response packet",
      summary: "Prepared response packet is ready for review; external submission is blocked.",
      priority: "high",
      risk: "medium",
      requestedAction: {
        action: "approve_prepared_response",
        externalExecution: "blocked",
      },
      evidence: {
        transitionEvidenceId: transitionResult.evidenceId,
      },
      policy: {
        externalSubmission: "approval_required",
      },
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(approvalResult.created).toBe(true);
    expect(approvalResult.approvalRequestId).toBeTruthy();
    expect(approvalResult.eventId).toBe(transitionResult.eventId);
    expect(approvalResult.auditEventId).toBeTruthy();
    expect(approvalResult.evidenceId).toBeTruthy();
    expect(approvalResult.approval.state).toBe("pending");
    expect(approvalResult.approval.subject).toEqual({
      type: "task",
      id: taskResult.taskId,
    });

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskResult.taskId)).limit(1);
    const [transitionEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, transitionResult.eventId ?? ""))
      .limit(1);
    const [transitionEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, transitionResult.evidenceId ?? ""))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalResult.approvalRequestId))
      .limit(1);
    const [approvalEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, approvalResult.evidenceId ?? ""))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          taskResult.auditEventId,
          transitionResult.auditEventId,
          approvalResult.auditEventId,
        ]),
      );

    if (!approval) {
      throw new Error("Expected approval request row.");
    }

    expect(task?.state).toBe("approval_required");
    expect(objectValue(task?.outcome).approvalRequestId).toBe(approvalResult.approvalRequestId);
    expect(transitionEvent?.type).toBe("task.transitioned");
    expect(transitionEvidence?.kind).toBe("trace");
    expect(objectValue(transitionEvidence?.data).toState).toBe("waiting");
    expect(approval?.state).toBe("pending");
    expect(approval?.eventId).toBe(transitionResult.eventId);
    expect(objectValue(approval?.requestedAction).externalExecution).toBe("blocked");
    expect(approvalEvidence?.kind).toBe("approval");
    expect(objectValue(approvalEvidence?.data).approvalRequestId).toBe(approvalResult.approvalRequestId);
    expect(auditCount.value).toBe(3);

    const nonReviewerEmail = `approval-non-reviewer-${runId}@continuoushq.com`;
    await db
      .insert(users)
      .values({
        id: randomUUID(),
        tenantId: approval.tenantId,
        email: nonReviewerEmail,
        name: "Non Reviewer",
        role: "member",
        state: "active",
      })
      .onConflictDoNothing();

    await expect(
      decideApproval({
        approvalId: approvalResult.approvalRequestId,
        idempotencyKey: `ci-core-approval-forbidden-${runId}`,
        operatorEmail: nonReviewerEmail,
        tenantSlug: "continuous-demo",
        action: "approved",
        subject: "task",
        db,
      }),
    ).rejects.toMatchObject({
      code: "approval_reviewer_forbidden",
      status: 403,
    });

    const transitionReplay = await transitionCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-control-task-transition-${runId}`,
      taskId: taskResult.taskId,
      toState: "waiting",
      reason: "Response packet is waiting for owner review.",
      evidence: {
        packetReady: true,
      },
      outcome: {
        status: "waiting_on_owner",
      },
      db,
    });
    await expect(
      transitionCoreTask({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-control-task-transition-${runId}`,
        taskId: taskResult.taskId,
        toState: "done",
        reason: "Different state should conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
    const approvalReplay = await requestApproval({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-approval-${runId}`,
      taskId: taskResult.taskId,
      eventId: transitionResult.eventId ?? undefined,
      kind: "agency_notice_response_approval",
      title: "Approve agency response packet",
      summary: "Prepared response packet is ready for review; external submission is blocked.",
      priority: "high",
      risk: "medium",
      requestedAction: {
        action: "approve_prepared_response",
        externalExecution: "blocked",
      },
      evidence: {
        transitionEvidenceId: transitionResult.evidenceId,
      },
      policy: {
        externalSubmission: "approval_required",
      },
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(transitionReplay.transitioned).toBe(false);
    expect(transitionReplay.taskId).toBe(taskResult.taskId);
    expect(approvalReplay.created).toBe(false);
    expect(approvalReplay.approvalRequestId).toBe(approvalResult.approvalRequestId);
    await expect(
      requestApproval({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-approval-${runId}`,
        taskId: taskResult.taskId,
        kind: "different_kind",
        title: "Different title should conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("grants capabilities and moves budget through reserve charge and release", async () => {
    const runId = randomUUID();
    const [capability] = await db
      .select()
      .from(capabilities)
      .where(and(eq(capabilities.key, "worker.read"), eq(capabilities.active, true)))
      .limit(1);
    const [worker] = await db.select().from(workers).where(eq(workers.role, "revenue_operations")).limit(1);

    expect(capability).toBeDefined();
    expect(worker).toBeDefined();

    const [budgetAccount] = await db
      .select()
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.tenantId, worker.tenantId),
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, worker.id),
          eq(budgetAccounts.active, true),
        ),
      )
      .limit(1);

    expect(budgetAccount).toBeDefined();

    const grantResult = await grantCapability({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-capability-grant-${runId}`,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
      },
      scope: {
        flow: "ci_budget_control",
      },
      policy: {
        autonomyLevel: 1,
        externalExecution: "blocked",
      },
      reason: "CI grants a scoped worker capability through Core.",
      db,
    });

    expect(grantResult.granted).toBe(true);
    expect(grantResult.capabilityGrantId).toBeTruthy();
    expect(grantResult.eventId).toBeTruthy();
    expect(grantResult.auditEventId).toBeTruthy();
    expect(grantResult.evidenceId).toBeTruthy();
    expect(grantResult.grant.actor.type).toBe("worker");
    expect(grantResult.grant.capabilityKey).toBe("worker.read");

    const grantReplay = await grantCapability({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-capability-grant-${runId}`,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
      },
      scope: {
        flow: "ci_budget_control",
      },
      policy: {
        autonomyLevel: 1,
        externalExecution: "blocked",
      },
      reason: "CI grants a scoped worker capability through Core.",
      db,
    });

    expect(grantReplay.granted).toBe(false);
    expect(grantReplay.capabilityGrantId).toBe(grantResult.capabilityGrantId);
    await expect(
      grantCapability({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-capability-grant-${runId}`,
        capabilityId: capability.id,
        actor: {
          type: "worker",
          id: worker.id,
        },
        scope: {
          flow: "changed_scope",
        },
        policy: {
          autonomyLevel: 1,
          externalExecution: "blocked",
        },
        reason: "Changed capability input must conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    const taskResult = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-task-${runId}`,
      title: "Review budget control packet",
      capabilityId: capability.id,
      evidence: {
        required: ["budget_trace"],
      },
      db,
    });
    const reserveResult = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      units: 1200,
      reason: "Reserve budget before worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(reserveResult.reserved).toBe(true);
    expect(reserveResult.reservation.state).toBe("held");
    expect(reserveResult.reservation.units).toBe(1200);
    expect(reserveResult.eventId).toBeTruthy();
    expect(reserveResult.auditEventId).toBeTruthy();
    expect(reserveResult.evidenceId).toBeTruthy();

    const chargeResult = await chargeBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-charge-${runId}`,
      reservationId: reserveResult.reservationId,
      actor: {
        type: "worker",
        id: worker.id,
      },
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      costUsd: "0.000000",
      reason: "Charge the reserved budget after the worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(chargeResult.charged).toBe(true);
    expect(chargeResult.usage.units).toBe(1200);
    expect(chargeResult.usage.reservationId).toBe(reserveResult.reservationId);
    expect(chargeResult.eventId).toBeTruthy();
    expect(chargeResult.auditEventId).toBeTruthy();
    expect(chargeResult.evidenceId).toBeTruthy();

    const releaseReserve = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      units: 600,
      reason: "Reserve budget for a canceled worker action.",
      db,
    });
    const releaseResult = await releaseBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-${runId}`,
      reservationId: releaseReserve.reservationId,
      reason: "Release unused budget after canceling the action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(releaseResult.released).toBe(true);
    expect(releaseResult.reservation.state).toBe("released");
    expect(releaseResult.eventId).toBeTruthy();
    expect(releaseResult.auditEventId).toBeTruthy();
    expect(releaseResult.evidenceId).toBeTruthy();

    const [grant] = await db
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.id, grantResult.capabilityGrantId))
      .limit(1);
    const [chargedReservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, reserveResult.reservationId))
      .limit(1);
    const [releasedReservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, releaseReserve.reservationId))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, chargeResult.usageEventId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          grantResult.auditEventId,
          reserveResult.auditEventId,
          chargeResult.auditEventId,
          releaseResult.auditEventId,
        ]),
      );

    expect(grant?.active).toBe(true);
    expect(objectValue(grant?.policy).externalExecution).toBe("blocked");
    expect(chargedReservation?.state).toBe("used");
    expect(releasedReservation?.state).toBe("released");
    expect(usage?.reservationId).toBe(reserveResult.reservationId);
    expect(usage?.actorType).toBe("worker");
    expect(usage?.actorId).toBe(worker.id);
    expect(auditCount.value).toBe(4);

    const reserveReplay = await reserveBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-reserve-${runId}`,
      budgetAccountId: budgetAccount.id,
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      units: 1200,
      reason: "Reserve budget before worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });
    const chargeReplay = await chargeBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-charge-${runId}`,
      reservationId: reserveResult.reservationId,
      actor: {
        type: "worker",
        id: worker.id,
      },
      taskId: taskResult.taskId,
      capabilityId: capability.id,
      costUsd: "0.000000",
      reason: "Charge the reserved budget after the worker action.",
      data: {
        source: "ci.core",
      },
      db,
    });
    const releaseReplay = await releaseBudget({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-budget-release-${runId}`,
      reservationId: releaseReserve.reservationId,
      reason: "Release unused budget after canceling the action.",
      data: {
        source: "ci.core",
      },
      db,
    });

    expect(reserveReplay.reserved).toBe(false);
    expect(reserveReplay.reservationId).toBe(reserveResult.reservationId);
    expect(chargeReplay.charged).toBe(false);
    expect(chargeReplay.usageEventId).toBe(chargeResult.usageEventId);
    expect(releaseReplay.released).toBe(false);
    expect(releaseReplay.reservationId).toBe(releaseReserve.reservationId);

    await expect(
      reserveBudget({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-budget-reserve-${runId}`,
        budgetAccountId: budgetAccount.id,
        units: 999,
        reason: "Changed budget reserve input must conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
    await expect(
      chargeBudget({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-budget-charge-${runId}`,
        reservationId: reserveResult.reservationId,
        actor: {
          type: "worker",
          id: worker.id,
        },
        reason: "Changed budget charge input must conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
    await expect(
      releaseBudget({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-budget-release-${runId}`,
        reservationId: releaseReserve.reservationId,
        reason: "Changed budget release input must conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("starts and completes worker runs through the Core lifecycle gate", async () => {
    const runId = randomUUID();
    const [capability] = await db
      .select()
      .from(capabilities)
      .where(and(eq(capabilities.key, "worker.read"), eq(capabilities.active, true)))
      .limit(1);
    const [worker] = await db.select().from(workers).where(eq(workers.role, "revenue_operations")).limit(1);

    expect(capability).toBeDefined();
    expect(worker).toBeDefined();

    const [budgetAccount] = await db
      .select()
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.tenantId, worker.tenantId),
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, worker.id),
          eq(budgetAccounts.active, true),
        ),
      )
      .limit(1);

    expect(budgetAccount).toBeDefined();

    await grantCapability({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-run-capability-${runId}`,
      capabilityId: capability.id,
      actor: {
        type: "worker",
        id: worker.id,
      },
      scope: {
        flow: "core_worker_run_lifecycle",
      },
      policy: {
        externalExecution: "blocked",
      },
      reason: "CI grants a scoped worker capability before starting a Core worker run.",
      db,
    });

    const start = await startCoreWorkerRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-run-start-${runId}`,
      worker: {
        id: worker.id,
        role: "revenue_operations",
      },
      command: "lead.read",
      mode: "read_only",
      capabilityId: capability.id,
      budgetAccountId: budgetAccount.id,
      units: 10,
      input: {
        source: "ci.core.worker_run",
      },
      policy: {
        externalExecution: "blocked",
      },
      evidence: {
        required: ["capability_grant", "budget_reservation"],
      },
      db,
    });

    expect(start.started).toBe(true);
    expect(start.run.state).toBe("running");
    expect(start.run.worker.role).toBe("revenue_operations");
    expect(start.budget.reservationId).toBeTruthy();
    expect(start.capability.capabilityKey).toBe("worker.read");

    const startReplay = await startCoreWorkerRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-run-start-${runId}`,
      worker: {
        id: worker.id,
        role: "revenue_operations",
      },
      command: "lead.read",
      mode: "read_only",
      capabilityId: capability.id,
      budgetAccountId: budgetAccount.id,
      units: 10,
      input: {
        source: "ci.core.worker_run",
      },
      policy: {
        externalExecution: "blocked",
      },
      evidence: {
        required: ["capability_grant", "budget_reservation"],
      },
      db,
    });

    expect(startReplay.started).toBe(false);
    expect(startReplay.workerRunId).toBe(start.workerRunId);

    const complete = await completeCoreWorkerRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-run-complete-${runId}`,
      worker: {
        id: worker.id,
        role: "revenue_operations",
      },
      workerRunId: start.workerRunId,
      state: "done",
      reason: "Worker run finished with blocked external execution.",
      output: {
        sourceRecordsRead: 1,
      },
      evidence: {
        receipt: "ci_worker_run_complete",
      },
      db,
    });

    expect(complete.completed).toBe(true);
    expect(complete.run.state).toBe("done");
    expect(objectValue(complete.budget).state).toBe("used");
    const reservationId = stringValue(start.budget.reservationId);

    const [run] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, start.workerRunId))
      .limit(1);
    const [reservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, reservationId))
      .limit(1);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.reservationId, reservationId))
      .limit(1);

    expect(run?.state).toBe("done");
    expect(objectValue(run?.data).externalExecution).toBe("blocked");
    expect(objectValue(objectValue(run?.data).completion).externalExecution).toBe("blocked");
    expect(reservation?.state).toBe("used");
    expect(usage?.actorType).toBe("worker");
    expect(usage?.actorId).toBe(worker.id);

    await expect(
      completeCoreWorkerRun({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-worker-run-complete-${runId}`,
        worker: {
          id: worker.id,
          role: "revenue_operations",
        },
        workerRunId: start.workerRunId,
        state: "failed",
        reason: "Changed completion input must conflict.",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("upserts adapters and pollable read-only connections through headless core primitives", async () => {
    const runId = randomUUID();
    const adapterKey = `google_workspace_ci_${runId}`;
    const leadSourceCredentialEnv = "GOOGLE_WORKSPACE_CONNECTOR_REF";
    const leadSourceCredentialRef = `env:${leadSourceCredentialEnv}`;
    const fixtureCredentialValue = "configured-fixture";
    const adapterResult = await upsertCoreAdapter({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-adapter-upsert-${runId}`,
      key: adapterKey,
      name: "Google Workspace CI",
      kind: "inbox",
      auth: "oauth",
      capabilities: {
        read: ["lead.read"],
        sources: ["google_workspace_inbox"],
        providers: ["google_workspace"],
        readerKinds: ["inbox"],
      },
      db,
    });
    const connectionResult = await upsertCoreConnection({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-connection-upsert-${runId}`,
      adapterKey,
      name: "Google Workspace lead inbox CI",
      state: "active",
      externalAccountId: `leads-${runId}@continuoushq.com`,
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
          credentialRef: leadSourceCredentialRef,
        },
        externalExecution: "blocked",
      },
      db,
    });
    const [adapter] = await db.select().from(adapters).where(eq(adapters.id, adapterResult.adapterId)).limit(1);
    const adapterEventId = stringValue(adapterResult.eventId);
    const adapterAuditEventId = stringValue(adapterResult.auditEventId);

    if (!adapterEventId || !adapterAuditEventId) {
      throw new Error("Expected adapter upsert to record an event.");
    }
    const [adapterEvent] = await db.select().from(events).where(eq(events.id, adapterEventId)).limit(1);
    const [adapterAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, adapterAuditEventId))
      .limit(1);
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionResult.connectionId))
      .limit(1);
    const connectionConfig = objectValue(connection?.config);
    const polling = objectValue(connectionConfig.polling);
    const connectionReplay = await upsertCoreConnection({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-connection-upsert-${runId}`,
      adapterKey,
      name: "Google Workspace lead inbox CI",
      state: "active",
      externalAccountId: `leads-${runId}@continuoushq.com`,
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
          credentialRef: leadSourceCredentialRef,
        },
        externalExecution: "blocked",
      },
      db,
    });
    const healthResult = await recordCoreConnectionHealth({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-connection-health-${runId}`,
      connectionId: connectionResult.connectionId,
      checks: [
        "state",
        "adapter",
        "external_execution",
        "credential_ref",
        "source_metadata",
        "scopes",
        "polling",
      ],
      env: {
        [leadSourceCredentialEnv]: fixtureCredentialValue,
      },
      db,
    });
    const healthReplay = await recordCoreConnectionHealth({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-connection-health-${runId}`,
      connectionId: connectionResult.connectionId,
      checks: [
        "state",
        "adapter",
        "external_execution",
        "credential_ref",
        "source_metadata",
        "scopes",
        "polling",
      ],
      db,
    });
    const credentialCheck = healthResult.checks.find((check) => objectValue(check).key === "credential_ref");
    const healthReport = objectValue(healthResult.report);

    expect(adapterResult.created).toBe(true);
    expect(adapterResult.adapter.authMode).toBe("oauth");
    expect(objectValue(adapterResult.adapter).auth).toBeUndefined();
    expect(adapter?.key).toBe(adapterKey);
    expect(adapter?.auth).toBe("oauth");
    expect(objectValue(adapter?.capabilities).sources).toEqual(["google_workspace_inbox"]);
    expect(objectValue(adapterEvent?.data).authMode).toBe("oauth");
    expect(objectValue(adapterEvent?.data).auth).toBeUndefined();
    expect(objectValue(adapterAudit?.data).authMode).toBe("oauth");
    expect(objectValue(adapterAudit?.data).auth).toBeUndefined();
    expect(connectionResult.created).toBe(true);
    expect(connectionResult.externalExecution).toBe("blocked");
    expect(connectionResult.pollingEnabled).toBe(true);
    expect(connection?.state).toBe("active");
    expect(connection?.adapterId).toBe(adapterResult.adapterId);
    expect(objectValue(connection?.scopes).reads).toEqual(["lead.read"]);
    expect(polling.credentialRef).toBe(leadSourceCredentialRef);
    expect(connectionReplay.created).toBe(false);
    expect(connectionReplay.connectionId).toBe(connectionResult.connectionId);
    expect(healthResult.created).toBe(true);
    expect(healthResult.status).toBe("ready");
    expect(healthResult.externalExecution).toBe("blocked");
    expect(healthResult.evidenceId).toBeTruthy();
    expect(objectValue(credentialCheck).data).toMatchObject({
      credentialRefState: "managed_ref_present",
      credentialRefKind: "env",
      envConfigured: true,
    });
    expect(JSON.stringify(healthReport)).not.toContain(fixtureCredentialValue);
    expect(healthReplay.created).toBe(false);
    expect(healthReplay.status).toBe("ready");

    const bufferedConnectionResult = await upsertCoreConnection({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-buffered-connection-upsert-${runId}`,
      adapterKey,
      name: "Buffered scheduler inbox CI",
      state: "active",
      externalAccountId: `buffered-leads-${runId}`,
      scopes: {
        reads: ["lead.read"],
      },
      config: {
        sources: ["google_workspace_inbox"],
        providers: ["google_workspace"],
        readerKinds: ["inbox"],
        polling: {
          enabled: true,
          mode: "connection_buffer",
          source: "google_workspace_inbox",
          provider: "google_workspace",
        },
        inbox: {
          messages: [
            {
              messageId: `buffered-message-${runId}`,
              subject: "Need roof leak inspection",
            },
          ],
        },
        externalExecution: "blocked",
      },
      db,
    });
    const bufferedHealthResult = await recordCoreConnectionHealth({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-buffered-connection-health-${runId}`,
      connectionId: bufferedConnectionResult.connectionId,
      checks: [
        "state",
        "adapter",
        "external_execution",
        "credential_ref",
        "source_metadata",
        "scopes",
        "polling",
      ],
      env: {},
      db,
    });
    const bufferedCredentialCheck = bufferedHealthResult.checks.find(
      (check) => objectValue(check).key === "credential_ref",
    );

    expect(bufferedConnectionResult.created).toBe(true);
    expect(bufferedConnectionResult.pollingEnabled).toBe(true);
    expect(bufferedHealthResult.status).toBe("ready");
    expect(objectValue(bufferedCredentialCheck).status).toBe("not_applicable");
    expect(objectValue(bufferedCredentialCheck).data).toMatchObject({
      credentialRefState: "not_required",
      credentialRefKind: null,
      envConfigured: null,
      pollingMode: "connection_buffer",
    });

    await expect(
      upsertCoreAdapter({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-adapter-secret-block-${runId}`,
        key: `${adapterKey}_secret`,
        name: "Unsafe adapter",
        kind: "inbox",
        auth: leadSourceCredentialRef,
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_adapter_auth_mode_invalid",
      status: 400,
    });

    await expect(
      upsertCoreConnection({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-connection-sensitive-field-block-${runId}`,
        adapterKey,
        name: "Unsafe connection",
        state: "active",
        scopes: {
          reads: ["lead.read"],
        },
        config: {
          polling: {
            enabled: true,
            source: "google_workspace_inbox",
            provider: "google_workspace",
            accessToken: "placeholder",
          },
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_inline_secret_blocked",
    });
  }, 120_000);

  it("persists headless core objects, events, evidence, documents, and decisions", async () => {
    const runId = randomUUID();
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-object-${runId}`,
      type: "agency_notice",
      name: "Agency notice from the Department of Cheerful Paperwork",
      source: "ci.core",
      externalId: `notice-${runId}`,
      state: "received",
      data: {
        agency: "Department of Cheerful Paperwork",
        dueInDays: 14,
      },
      version: {
        data: {
          state: "received",
          factsLocked: true,
        },
        reason: "CI primitive smoke",
      },
      db,
    });

    expect(objectResult.created).toBe(true);
    expect(objectResult.objectId).toBeTruthy();
    expect(objectResult.objectVersionId).toBeTruthy();
    expect(objectResult.eventId).toBeTruthy();
    expect(objectResult.auditEventId).toBeTruthy();

    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-event-${runId}`,
      type: "agency_notice.received",
      source: "ci.core.intake",
      objectId: objectResult.objectId,
      data: {
        channel: "mailroom",
        mood: "stern but manageable",
      },
      db,
    });

    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-evidence-${runId}`,
      kind: "snapshot",
      name: "Agency notice source snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        receivedBy: "operator",
        documentState: "legible",
      },
      db,
    });

    const documentResult = await createCoreDocument({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-document-${runId}`,
      kind: "agency_notice_packet",
      name: "Agency notice packet",
      state: "review_ready",
      sensitivity: "high",
      objectId: objectResult.objectId,
      data: {
        evidenceIds: [evidenceResult.evidenceId],
      },
      db,
    });

    const decisionResult = await recordCoreDecision({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-decision-${runId}`,
      kind: "notice_routing",
      state: "proposed",
      decision: "owner_review_required",
      rationale: "Notice response should be reviewed before any agency contact.",
      eventId: eventResult.eventId,
      data: {
        objectId: objectResult.objectId,
        evidenceId: evidenceResult.evidenceId,
        documentId: documentResult.documentId,
      },
      db,
    });
    const packetResult = await prepareCorePacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-packet-${runId}`,
      kind: "agency_notice_packet",
      name: "Agency notice evidence packet",
      state: "review_ready",
      sensitivity: "high",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      evidenceIds: [evidenceResult.evidenceId],
      documentIds: [documentResult.documentId],
      sections: {
        order: ["summary", "source", "decision"],
      },
      data: {
        decisionId: decisionResult.decisionId,
      },
      db,
    });
    const [connection] = await db.select({ id: connections.id }).from(connections).limit(1);
    const [rulePack] = await db.select({ id: rulePacks.id }).from(rulePacks).limit(1);

    expect(connection?.id).toBeTruthy();
    expect(rulePack?.id).toBeTruthy();

    const adapterIntentResult = await recordAdapterIntent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-adapter-intent-${runId}`,
      connectionId: connection?.id ?? "",
      operation: "draft_agency_response",
      mode: "dry_run",
      eventId: eventResult.eventId,
      request: {
        objectId: objectResult.objectId,
        externalSend: false,
      },
      data: {
        source: "core_primitive_ci",
      },
      maxAttempts: 2,
      db,
    });
    const ruleChangeResult = await recordRuleChange({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-rule-change-${runId}`,
      rulePackId: rulePack?.id,
      ruleKey: "agency_notice.response_window",
      changeType: "operator_policy_update",
      title: "Agency notice response window update",
      state: "proposed",
      decision: "owner_review_required",
      rationale: "Rule changes need owner review before compliance automation changes.",
      sourceRefs: {
        source: "ci",
      },
      before: {
        responseWindowDays: 14,
      },
      after: {
        responseWindowDays: 10,
      },
      impact: {
        objects: [objectResult.objectId],
      },
      data: {
        externalExecution: "blocked",
      },
      db,
    });
    const paymentObjectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-external-action-payment-object-${runId}`,
      type: "payment",
      name: "External action payment target",
      source: "ci.core",
      externalId: `external-action-payment-${runId}`,
      state: "pending",
      db,
    });
    const [paymentObject] = await db
      .select({ tenantId: objects.tenantId })
      .from(objects)
      .where(eq(objects.id, paymentObjectResult.objectId))
      .limit(1);

    expect(paymentObject?.tenantId).toBeTruthy();

    const [payment] = await db
      .insert(payments)
      .values({
        tenantId: paymentObject?.tenantId ?? "",
        objectId: paymentObjectResult.objectId,
        state: "pending",
        externalId: `external-action-payment-${runId}`,
        data: {
          source: "core_primitive_ci",
        },
      })
      .returning({ id: payments.id });
    const externalActionResult = await recordExternalAction({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-external-action-${runId}`,
      targetType: "payment",
      targetId: payment.id,
      kind: "payment_receipt",
      state: "receipt_recorded",
      adapterActionId: adapterIntentResult.adapterActionId,
      amountCents: 24900,
      currency: "usd",
      occurredAt: "2026-05-20T08:00:00.000Z",
      receipt: {
        receiptId: `receipt-${runId}`,
        provider: "ci",
      },
      response: {
        status: "recorded",
      },
      data: {
        source: "core_primitive_ci",
      },
      db,
    });

    const [object] = await db.select().from(objects).where(eq(objects.id, objectResult.objectId)).limit(1);
    const [version] = await db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.id, objectResult.objectVersionId ?? ""))
      .limit(1);
    const [event] = await db.select().from(events).where(eq(events.id, eventResult.eventId)).limit(1);
    const [evidenceItem] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, evidenceResult.evidenceId))
      .limit(1);
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentResult.documentId))
      .limit(1);
    const [decision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, decisionResult.decisionId))
      .limit(1);
    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, packetResult.packetId))
      .limit(1);
    const [adapterRun] = await db
      .select()
      .from(adapterRuns)
      .where(eq(adapterRuns.id, adapterIntentResult.adapterRunId ?? ""))
      .limit(1);
    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, adapterIntentResult.adapterActionId))
      .limit(1);
    const [ruleChangeObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, ruleChangeResult.objectId))
      .limit(1);
    const [ruleChangeDecision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, ruleChangeResult.decisionId ?? ""))
      .limit(1);
    const [ruleChangeEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, ruleChangeResult.evidenceId ?? ""))
      .limit(1);
    const [externalActionEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, externalActionResult.eventId ?? ""))
      .limit(1);
    const [externalActionEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, externalActionResult.evidenceId ?? ""))
      .limit(1);
    const [paymentAfterExternalAction] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, payment.id))
      .limit(1);
    const [paymentObjectAfterExternalAction] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, paymentObjectResult.objectId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          objectResult.auditEventId,
          eventResult.auditEventId ?? "",
          evidenceResult.auditEventId,
          documentResult.auditEventId,
          decisionResult.auditEventId,
          packetResult.auditEventId,
          adapterIntentResult.auditEventId,
          ruleChangeResult.auditEventId,
        ]),
      );
    const replay = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-evidence-${runId}`,
      kind: "snapshot",
      name: "Agency notice source snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        receivedBy: "operator",
        documentState: "legible",
      },
      db,
    });

    expect(object?.externalId).toBe(`notice-${runId}`);
    expect(version?.version).toBe(objectResult.version);
    expect(event?.type).toBe("agency_notice.received");
    expect(evidenceItem?.kind).toBe("snapshot");
    expect(document?.kind).toBe("agency_notice_packet");
    expect(document?.sensitivity).toBe("high");
    expect(decision?.decision).toBe("owner_review_required");
    expect(packet?.documentId).toBe(packetResult.documentId);
    expect(packet?.state).toBe("review_ready");
    expect(objectValue(packet?.evidenceIds).ids).toEqual([evidenceResult.evidenceId]);
    expect(adapterRun?.operation).toBe("draft_agency_response");
    expect(adapterRun?.mode).toBe("dry_run");
    expect(adapterRun?.reconciliationState).toBe("pending");
    expect(adapterAction?.operation).toBe("draft_agency_response");
    expect(objectValue(adapterAction?.request).externalExecution).toBe("blocked");
    expect(ruleChangeObject?.type).toBe("rule_change");
    expect(ruleChangeObject?.state).toBe("proposed");
    expect(ruleChangeDecision?.decision).toBe("owner_review_required");
    expect(ruleChangeEvidence?.kind).toBe("trace");
    expect(objectValue(ruleChangeEvidence?.data).decisionId).toBe(ruleChangeResult.decisionId);
    expect(externalActionResult.created).toBe(true);
    expect(externalActionResult.connectionId).toBe(connection?.id);
    expect(externalActionResult.executionMode).toBe("record_only");
    expect(externalActionEvent?.type).toBe("external_action.recorded");
    expect(externalActionEvent?.source).toBe("continuous.core.external_actions");
    expect(externalActionEvidence?.kind).toBe("receipt");
    expect(paymentAfterExternalAction?.state).toBe("receipt_recorded");
    expect(paymentObjectAfterExternalAction?.state).toBe("receipt_recorded");
    expect(objectValue(paymentAfterExternalAction?.data).lastExternalAction).toMatchObject({
      targetType: "payment",
      targetId: payment.id,
      kind: "payment_receipt",
      state: "receipt_recorded",
      amountCents: 24900,
      currency: "USD",
      sourceEventId: adapterIntentResult.eventId,
      externalExecution: "blocked",
      executionMode: "record_only",
      continuousExecuted: false,
    });
    expect(objectValue(paymentObjectAfterExternalAction?.data).lastExternalAction).toMatchObject({
      targetType: "payment",
      targetId: payment.id,
      state: "receipt_recorded",
      sourceEventId: adapterIntentResult.eventId,
    });
    expect(auditCount.value).toBe(8);
    expect(replay.created).toBe(false);
    expect(replay.evidenceId).toBe(evidenceResult.evidenceId);

    const packetReplay = await prepareCorePacket({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-packet-${runId}`,
      kind: "agency_notice_packet",
      name: "Agency notice evidence packet",
      state: "review_ready",
      sensitivity: "high",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      evidenceIds: [evidenceResult.evidenceId],
      documentIds: [documentResult.documentId],
      sections: {
        order: ["summary", "source", "decision"],
      },
      data: {
        decisionId: decisionResult.decisionId,
      },
      db,
    });

    expect(packetReplay.prepared).toBe(false);
    expect(packetReplay.packetId).toBe(packetResult.packetId);

    const adapterIntentReplay = await recordAdapterIntent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-adapter-intent-${runId}`,
      connectionId: connection?.id ?? "",
      operation: "draft_agency_response",
      mode: "dry_run",
      eventId: eventResult.eventId,
      request: {
        objectId: objectResult.objectId,
        externalSend: false,
      },
      data: {
        source: "core_primitive_ci",
      },
      maxAttempts: 2,
      db,
    });
    const ruleChangeReplay = await recordRuleChange({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-rule-change-${runId}`,
      rulePackId: rulePack?.id,
      ruleKey: "agency_notice.response_window",
      changeType: "operator_policy_update",
      title: "Agency notice response window update",
      state: "proposed",
      decision: "owner_review_required",
      rationale: "Rule changes need owner review before compliance automation changes.",
      sourceRefs: {
        source: "ci",
      },
      before: {
        responseWindowDays: 14,
      },
      after: {
        responseWindowDays: 10,
      },
      impact: {
        objects: [objectResult.objectId],
      },
      data: {
        externalExecution: "blocked",
      },
      db,
    });

    expect(adapterIntentReplay.created).toBe(false);
    expect(adapterIntentReplay.adapterActionId).toBe(adapterIntentResult.adapterActionId);
    expect(ruleChangeReplay.created).toBe(false);
    expect(ruleChangeReplay.objectId).toBe(ruleChangeResult.objectId);

    const externalActionReplay = await recordExternalAction({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-external-action-${runId}`,
      targetType: "payment",
      targetId: payment.id,
      kind: "payment_receipt",
      state: "receipt_recorded",
      adapterActionId: adapterIntentResult.adapterActionId,
      amountCents: 24900,
      currency: "usd",
      occurredAt: "2026-05-20T08:00:00.000Z",
      receipt: {
        receiptId: `receipt-${runId}`,
        provider: "ci",
      },
      response: {
        status: "recorded",
      },
      data: {
        source: "core_primitive_ci",
      },
      db,
    });

    expect(externalActionReplay.created).toBe(false);
    expect(externalActionReplay.targetId).toBe(payment.id);
    expect(externalActionReplay.evidenceId).toBe(externalActionResult.evidenceId);

    await expect(
      recordExternalAction({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-external-action-${runId}`,
        targetType: "payment",
        targetId: payment.id,
        kind: "payment_receipt",
        state: "receipt_recorded",
        adapterActionId: adapterIntentResult.adapterActionId,
        amountCents: 25000,
        currency: "usd",
        occurredAt: "2026-05-20T08:00:00.000Z",
        receipt: {
          receiptId: `receipt-${runId}`,
          provider: "ci",
        },
        response: {
          status: "recorded",
        },
        data: {
          source: "core_primitive_ci",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    await expect(
      recordExternalAction({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-core-external-action-mismatch-${runId}`,
        targetType: "payment",
        targetId: payment.id,
        kind: "payment_receipt",
        state: "receipt_recorded",
        connectionId: randomUUID(),
        adapterActionId: adapterIntentResult.adapterActionId,
        amountCents: 24900,
        currency: "usd",
        occurredAt: "2026-05-20T08:00:00.000Z",
        receipt: {
          receiptId: `receipt-mismatch-${runId}`,
          provider: "ci",
        },
        response: {
          status: "recorded",
        },
        data: {
          source: "core_primitive_ci",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_external_action_adapter_mismatch",
      status: 400,
    });

    await db.delete(payments).where(eq(payments.id, payment.id));

    const externalActionDeletedTargetReplay = await recordExternalAction({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-core-external-action-${runId}`,
      targetType: "payment",
      targetId: payment.id,
      kind: "payment_receipt",
      state: "receipt_recorded",
      adapterActionId: adapterIntentResult.adapterActionId,
      amountCents: 24900,
      currency: "usd",
      occurredAt: "2026-05-20T08:00:00.000Z",
      receipt: {
        receiptId: `receipt-${runId}`,
        provider: "ci",
      },
      response: {
        status: "recorded",
      },
      data: {
        source: "core_primitive_ci",
      },
      db,
    });

    expect(externalActionDeletedTargetReplay.created).toBe(false);
    expect(externalActionDeletedTargetReplay.targetId).toBe(payment.id);
    expect(externalActionDeletedTargetReplay.evidenceId).toBe(externalActionResult.evidenceId);
  }, 120_000);

  it("persists headless core object links and generated views", async () => {
    const runId = randomUUID();
    const notice = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-link-notice-${runId}`,
      type: "agency_notice",
      name: "Linked agency notice",
      source: "ci.core",
      externalId: `linked-notice-${runId}`,
      db,
    });
    const customer = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-link-customer-${runId}`,
      type: "customer",
      name: "Linked customer",
      source: "ci.core",
      externalId: `linked-customer-${runId}`,
      db,
    });
    const link = await linkCoreObjects({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-object-link-${runId}`,
      fromObjectId: notice.objectId,
      toObjectId: customer.objectId,
      type: "about_customer",
      data: {
        confidence: "operator_confirmed",
      },
      db,
    });
    const view = await publishCoreView({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-view-publish-${runId}`,
      key: `ci.notice.review.${runId}`,
      name: "Notice review",
      purpose: "Render an operator review packet for an agency notice.",
      objectType: "agency_notice",
      taskState: "approval_required",
      contract: {
        sections: ["summary", "evidence", "actions"],
      },
      actions: {
        valid: ["approve", "request_revision"],
      },
      data: {
        objectId: notice.objectId,
      },
      mask: {
        pii: "redacted_by_default",
      },
      db,
    });

    expect(link.created).toBe(true);
    expect(link.updated).toBe(false);
    expect(link.link.fromObjectId).toBe(notice.objectId);
    expect(link.link.toObjectId).toBe(customer.objectId);
    expect(view.created).toBe(true);
    expect(view.updated).toBe(false);
    expect(view.view.key).toBe(`ci.notice.review.${runId}`);

    const [persistedLink] = await db
      .select()
      .from(objectLinks)
      .where(eq(objectLinks.id, link.objectLinkId))
      .limit(1);
    const [persistedView] = await db
      .select()
      .from(generatedViews)
      .where(eq(generatedViews.id, view.viewId))
      .limit(1);
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        inArray(auditEvents.id, [
          notice.auditEventId,
          customer.auditEventId,
          link.auditEventId,
          view.auditEventId,
        ]),
      );
    const linkReplay = await linkCoreObjects({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-object-link-${runId}`,
      fromObjectId: notice.objectId,
      toObjectId: customer.objectId,
      type: "about_customer",
      data: {
        confidence: "operator_confirmed",
      },
      db,
    });
    const viewReplay = await publishCoreView({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-view-publish-${runId}`,
      key: `ci.notice.review.${runId}`,
      name: "Notice review",
      purpose: "Render an operator review packet for an agency notice.",
      objectType: "agency_notice",
      taskState: "approval_required",
      contract: {
        sections: ["summary", "evidence", "actions"],
      },
      actions: {
        valid: ["approve", "request_revision"],
      },
      data: {
        objectId: notice.objectId,
      },
      mask: {
        pii: "redacted_by_default",
      },
      db,
    });

    expect(persistedLink?.type).toBe("about_customer");
    expect(objectValue(persistedLink?.data).confidence).toBe("operator_confirmed");
    expect(persistedView?.purpose).toBe("Render an operator review packet for an agency notice.");
    expect(persistedView?.taskState).toBe("approval_required");
    expect(objectValue(persistedView?.contract).sections).toEqual(["summary", "evidence", "actions"]);
    expect(auditCount.value).toBe(4);
    expect(linkReplay.created).toBe(false);
    expect(linkReplay.objectLinkId).toBe(link.objectLinkId);
    expect(viewReplay.created).toBe(false);
    expect(viewReplay.viewId).toBe(view.viewId);
  }, 120_000);

  it("records customer signals as headless core primitives", async () => {
    const runId = randomUUID();
    const [customerObject] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.type, "customer"), eq(objects.externalId, "seed-customer")))
      .limit(1);
    const [jobObject] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.type, "job"), eq(objects.externalId, "seed-job")))
      .limit(1);

    expect(customerObject?.id).toBeTruthy();
    expect(jobObject?.id).toBeTruthy();

    const result = await recordCustomerSignal({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-customer-signal-${runId}`,
      type: "review",
      name: "CI Google review request",
      state: "requested",
      source: "ci.core",
      externalId: `ci-review-${runId}`,
      customerObjectId: customerObject?.id,
      relatedObjectId: jobObject?.id,
      data: {
        platform: "google",
        requestStatus: "prepared",
      },
      db,
    });

    expect(result.created).toBe(true);
    expect(result.signalId).toBeTruthy();
    expect(result.objectId).toBeTruthy();
    expect(result.eventId).toBeTruthy();
    expect(result.evidenceId).toBeTruthy();
    expect(result.auditEventId).toBeTruthy();

    const [signal] = await db
      .select()
      .from(customerSignals)
      .where(eq(customerSignals.id, result.signalId))
      .limit(1);
    const [signalObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, result.objectId))
      .limit(1);
    const links = await db
      .select()
      .from(objectLinks)
      .where(eq(objectLinks.fromId, result.objectId));
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, result.eventId ?? ""))
      .limit(1);
    const [note] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, result.evidenceId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, result.auditEventId))
      .limit(1);

    expect(signal?.type).toBe("review");
    expect(signal?.state).toBe("requested");
    expect(signal?.source).toBe("ci.core");
    expect(objectValue(signal?.data).platform).toBe("google");
    expect(signalObject?.type).toBe("review");
    expect(signalObject?.externalId).toBe(`ci-review-${runId}`);
    expect(links.map((link) => link.type).sort()).toEqual(["about_customer", "about_work_item"]);
    expect(event?.type).toBe("customer_signal.recorded");
    expect(note?.kind).toBe("note");
    expect(audit?.targetType).toBe("customer_signal");
    expect(objectValue(audit?.data).externalExecution).toBe("blocked");

    const replay = await recordCustomerSignal({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-customer-signal-${runId}`,
      type: "review",
      name: "CI Google review request",
      state: "requested",
      source: "ci.core",
      externalId: `ci-review-${runId}`,
      customerObjectId: customerObject?.id,
      relatedObjectId: jobObject?.id,
      data: {
        platform: "google",
        requestStatus: "prepared",
      },
      db,
    });
    const [signalCount] = await db
      .select({ value: count() })
      .from(customerSignals)
      .where(eq(customerSignals.externalId, `ci-review-${runId}`));

    expect(replay.created).toBe(false);
    expect(replay.signalId).toBe(result.signalId);
    expect(signalCount.value).toBe(1);
  }, 120_000);

  it("persists the golden lead-to-quote output, eval row, and idempotent replay", async () => {
    const evalCase = revenueWorkerEvalCases[0];
    const first = await runRevenueWorker({
      idempotencyKey: evalCase.idempotencyKey,
      tenantSlug: evalCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: evalCase.config,
    });
    const scored = scoreRevenueWorkerRun(first, evalCase);

    expect(first.created).toBe(true);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const data = objectValue(workerRun?.data);
    const output = objectValue(data.output);
    const quote = objectValue(output.quote);

    expect(workerRun?.state).toBe(evalCase.expected.runState);
    expect(workerRun?.mode).toBe(evalCase.expected.runMode);
    expect(output.classification).toBe(evalCase.expected.classification);
    expect(output.sourceSnapshotEvidenceId).toBe(first.sourceSnapshotEvidenceId);
    expect(output.draftResponse).toContain(evalCase.expected.draftIncludes);
    expect(quote.totalCents).toBe(evalCase.expected.quoteTotalCents);
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.requiresApproval).toBe(true);
    expect(output.budgetUnits).toBe(evalCase.expected.maxBudgetUnits);
    expect(output.adapterRunId).toBe(first.adapterRunId);
    expect(output.adapterActionId).toBe(first.adapterActionId);
    expect(output.adapterReceiptEvidenceId).toBe(first.adapterReceiptEvidenceId);
    expect(output.approvalRequestId).toBe(first.approvalRequestId);
    expect(output.quoteApprovalViewId).toBe(first.quoteApprovalViewId);

    const [evaluation] = await db
      .select()
      .from(evaluations)
      .where(
        and(
          eq(evaluations.workerId, first.snapshot.worker?.id ?? ""),
          eq(evaluations.kind, "simulation_quality"),
          sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`,
        ),
      )
      .limit(1);
    const evalData = objectValue(evaluation?.data);
    const dimensions = objectValue(evalData.dimensions);

    expect(evaluation?.score).toBe("0.860");
    expect(dimensions.evidence_complete).toBe(true);
    expect(dimensions.source_snapshot_present).toBe(true);
    expect(dimensions.input_derived_output).toBe(true);
    expect(dimensions.within_budget).toBe(true);
    expect(dimensions.external_execution_blocked).toBe(true);
    expect(dimensions.owner_approval_required).toBe(true);
    expect(dimensions.external_send_blocked).toBe(true);
    expect(dimensions.quote_approval_view_present).toBe(true);

    const [quoteApprovalView] = await db
      .select()
      .from(generatedViews)
      .where(eq(generatedViews.id, first.quoteApprovalViewId ?? ""))
      .limit(1);
    const viewContract = objectValue(quoteApprovalView?.contract);
    const viewActions = objectValue(quoteApprovalView?.actions);
    const viewData = objectValue(quoteApprovalView?.data);
    const latestViewData = objectValue(viewData.latest);

    expect(quoteApprovalView?.key).toBe("quote.approval.review");
    expect(quoteApprovalView?.objectType).toBe("quote");
    expect(quoteApprovalView?.taskState).toBe("approval_required");
    expect(viewContract.schemaVersion).toBe("continuous.ui.quote_approval.v1");
    expect(viewActions.decisionSurface).toBe("/approval");
    expect(viewActions.postDecisionSurface).toBe("/worker");
    expect(latestViewData.approvalRequestId).toBe(first.approvalRequestId);
    expect(latestViewData.externalExecution).toBe("blocked");

    const [quoteApprovalRequest] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);
    expect(objectValue(quoteApprovalRequest?.data).quoteApprovalViewId).toBe(first.quoteApprovalViewId);
    expect(objectValue(quoteApprovalRequest?.evidence).quoteApprovalViewId).toBe(first.quoteApprovalViewId);

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);
    const sourceLead = objectValue(sourceData.leadPacket);

    expect(sourceSnapshot?.kind).toBe("snapshot");
    expect(sourceSnapshot?.name).toBe("Lead source snapshot");
    expect(sourceData.externalSend).toBe(false);
    expect(sourceLead.customerIntent).toBe("roof leak inspection");

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterRequest = objectValue(adapterAction?.request);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterRequest.externalSend).toBe(false);
    expect(objectValue(adapterRequest.quote).totalCents).toBe(evalCase.expected.quoteTotalCents);
    expect(adapterReceipt.externalMutation).toBe(false);

    const [runsBeforeReplay] = await db
      .select({ value: count() })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.worker"),
          eq(workerRuns.idempotencyKey, evalCase.idempotencyKey),
        ),
      );
    const [evalsBeforeReplay] = await db
      .select({ value: count() })
      .from(evaluations)
      .where(sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`);
    const replay = await runRevenueWorker({
      idempotencyKey: evalCase.idempotencyKey,
      tenantSlug: evalCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: evalCase.config,
    });
    const [runsAfterReplay] = await db
      .select({ value: count() })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.source, "continuous.worker"),
          eq(workerRuns.idempotencyKey, evalCase.idempotencyKey),
        ),
      );
    const [evalsAfterReplay] = await db
      .select({ value: count() })
      .from(evaluations)
      .where(sql`${evaluations.data}->>'idempotencyKey' = ${evalCase.idempotencyKey}`);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(first.workerRunId);
    expect(runsAfterReplay.value).toBe(runsBeforeReplay.value);
    expect(evalsAfterReplay.value).toBe(evalsBeforeReplay.value);

    const secondCase = revenueWorkerEvalCases[1];
    const second = await runRevenueWorker({
      idempotencyKey: secondCase.idempotencyKey,
      tenantSlug: secondCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: secondCase.config,
    });
    const secondScored = scoreRevenueWorkerRun(second, secondCase);

    expect(second.created).toBe(true);
    expect(secondScored.passed).toBe(true);

    const [secondWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, second.workerRunId ?? ""))
      .limit(1);
    const secondOutput = objectValue(objectValue(secondWorkerRun?.data).output);

    expect(secondOutput.classification).toBe(secondCase.expected.classification);
    expect(secondOutput.draftResponse).toContain(secondCase.expected.draftIncludes);
    expect(objectValue(secondOutput.quote).totalCents).toBe(secondCase.expected.quoteTotalCents);
    expect(secondOutput.externalSend).toBe(false);
    expect(secondOutput.classification).not.toBe(output.classification);
    expect(secondOutput.draftResponse).not.toEqual(output.draftResponse);
    expect(secondOutput.quote).not.toEqual(output.quote);
  }, 120_000);

  it("runs the missing-fact and pricing-override Revenue eval cases", async () => {
    const evalCases = [
      revenueWorkerEvalCases.find((item) => item.id === "revenue.missing_facts.owner_review"),
      revenueWorkerEvalCases.find((item) => item.id === "revenue.pricing_override.approval_blocked"),
    ];

    for (const evalCase of evalCases) {
      expect(evalCase).toBeDefined();
      if (!evalCase) {
        throw new Error("Missing Revenue Worker eval case.");
      }

      const result = await runRevenueWorker({
        idempotencyKey: evalCase.idempotencyKey,
        tenantSlug: evalCase.worker.tenantSlug,
        operatorEmail: "owner@continuoushq.com",
        config: evalCase.config,
      });
      const scored = scoreRevenueWorkerRun(result, evalCase);
      const output = objectValue(result.output);
      const quote = objectValue(output.quote);
      const quotePolicy = objectValue(quote.policy);

      expect(result.created).toBe(true);
      expect(scored.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
      expect(scored.passed).toBe(true);
      expect(output.classification).toBe(evalCase.expected.classification);
      expect(output.draftResponse).toContain(evalCase.expected.draftIncludes);
      expect(quote.totalCents).toBe(evalCase.expected.quoteTotalCents);
      expect(quotePolicy.approvalRequired).toBe(true);
      expect(quotePolicy.externalSend).toBe(false);
      expect(quotePolicy.moneyMovement).toBe("blocked");
      expect(output.externalSend).toBe(false);

      if (evalCase.id === "revenue.pricing_override.approval_blocked") {
        expect(quote.subtotalCents).toBe(50100);
        expect(objectValue(Array.isArray(quote.lines) ? quote.lines[0] : {}).amountCents).toBe(50100);
      }
    }
  }, 120_000);

  it("scores split Revenue classify and draft command eval cases", async () => {
    const classifyCase = revenueWorkerActionEvalCases.find(
      (item) => item.command === "lead.classify",
    );
    const draftCase = revenueWorkerActionEvalCases.find((item) => item.command === "response.draft");

    expect(classifyCase).toBeDefined();
    expect(draftCase).toBeDefined();
    if (!classifyCase || !draftCase) {
      throw new Error("Missing split Revenue command eval cases.");
    }

    const classify = await classifyRevenueLead({
      idempotencyKey: classifyCase.idempotencyKey,
      tenantSlug: classifyCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: classifyCase.config,
    });
    const classifyScore = scoreRevenueWorkerAction(classify, classifyCase);

    expect(classify.created).toBe(true);
    expect(classifyScore.passed).toBe(true);
    expect(classifyScore.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(objectValue(classify.output).command).toBe("lead.classify");

    const draft = await draftRevenueResponse({
      idempotencyKey: draftCase.idempotencyKey,
      tenantSlug: draftCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: draftCase.config,
    });
    const draftScore = scoreRevenueWorkerAction(draft, draftCase);

    expect(draft.created).toBe(true);
    expect(draftScore.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(draftScore.passed).toBe(true);
    expect(objectValue(draft.output).command).toBe("response.draft");

    const draftReplay = await draftRevenueResponse({
      idempotencyKey: draftCase.idempotencyKey,
      tenantSlug: draftCase.worker.tenantSlug,
      operatorEmail: "owner@continuoushq.com",
      config: draftCase.config,
    });

    expect(draftReplay.created).toBe(false);
    expect(draftReplay.workerRunId).toBe(draft.workerRunId);
  }, 120_000);

  it("rejects policy-risk Revenue eval cases before worker ledgers are written", async () => {
    const evalCase = revenueWorkerBlockedEvalCases.find(
      (item) => item.id === "revenue.policy_risk.external_send_blocked",
    );

    expect(evalCase).toBeDefined();
    if (!evalCase) {
      throw new Error("Missing Revenue Worker blocked eval case.");
    }

    await expect(
      runRevenueWorker({
        idempotencyKey: evalCase.idempotencyKey,
        tenantSlug: evalCase.worker.tenantSlug,
        operatorEmail: "owner@continuoushq.com",
        config: evalCase.config,
      }),
    ).rejects.toMatchObject({
      code: evalCase.expected.errorCode,
      status: evalCase.expected.status,
    });

    const [workerRunCount] = await db
      .select({ count: count() })
      .from(workerRuns)
      .where(eq(workerRuns.idempotencyKey, evalCase.idempotencyKey));

    expect(workerRunCount.count).toBe(0);
  }, 120_000);

  it("records a workflow spine and approval continuation for Revenue Worker runs", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-workflow-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "workflow_test",
          sourceEventId: `workflow-test:${runId}`,
          customerName: "Workflow Spine Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
    });

    expect(first.created).toBe(true);
    expect(first.workflowRunId).toBeTruthy();
    expect(first.workflowStepIds.length).toBe(4);
    expect(objectValue(first.output).workflowRunId).toBe(first.workflowRunId);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const workflowBlockers = objectValue(workflowRun?.blockers);

    expect(workflowRun?.state).toBe("approval_requested");
    expect(workflowRun?.workerId).toBe(first.snapshot.worker?.id);
    expect(workflowData.workerRunId).toBe(first.workerRunId);
    expect(workflowData.approvalRequestId).toBe(first.approvalRequestId);
    expect(workflowData.workflowStepIds).toEqual(first.workflowStepIds);
    expect(workflowBlockers.open).toContain("owner_approval_required");

    const steps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, first.workflowStepIds));
    const stepStates = steps.map((step) => step.toState).sort();

    expect(stepStates).toEqual([
      "adapter_dry_run_recorded",
      "approval_requested",
      "intake_resolved",
      "packet_prepared",
    ]);
    expect(steps.every((step) => step.workflowRunId === first.workflowRunId)).toBe(true);
    expect(steps.find((step) => step.toState === "approval_requested")?.approvalRequestId).toBe(
      first.approvalRequestId,
    );

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);

    expect(approval?.workflowRunId).toBe(first.workflowRunId);
    expect(approval?.workerRunId).toBe(first.workerRunId);

    const approvalDecisionIdempotencyKey = `ci-worker-approval-decision-${runId}`;
    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: approvalDecisionIdempotencyKey,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI approval continuation check",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("approved");
    expect(decision.workflowStepId).toBeTruthy();

    const [approvedWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const approvedWorkflowData = objectValue(approvedWorkflowRun?.data);
    const lastDecision = objectValue(approvedWorkflowData.lastApprovalDecision);
    const continuation = objectValue(lastDecision.continuation);

    expect(approvedWorkflowRun?.state).toBe("approved");
    expect(lastDecision.action).toBe("approved");
    expect(lastDecision.workflowStepId).toBe(decision.workflowStepId);
    expect(continuation.externalExecution).toBe("blocked");
    expect(continuation.externalSend).toBe(false);

    const [decisionStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, decision.workflowStepId ?? ""))
      .limit(1);
    const decisionStepOutput = objectValue(decisionStep?.output);

    expect(decisionStep?.kind).toBe("approval_decision");
    expect(decisionStep?.fromState).toBe("approval_requested");
    expect(decisionStep?.toState).toBe("approved");
    expect(decisionStep?.approvalRequestId).toBe(first.approvalRequestId);
    expect(objectValue(decisionStepOutput.continuation).externalExecution).toBe("blocked");

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const workerRunOutput = objectValue(objectValue(workerRun?.data).output);
    const approvalDecision = objectValue(workerRunOutput.approvalDecision);

    expect(objectValue(approvalDecision.continuation).externalExecution).toBe("blocked");
    expect(workerRunOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(objectValue(adapterReceipt.continuation).externalExecution).toBe("blocked");

    const decisionReplay = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: approvalDecisionIdempotencyKey,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "CI approval continuation check",
      subject: "worker",
      db,
    });
    const [approvalDecisionAuditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.source, "continuous.approvals"),
          eq(auditEvents.idempotencyKey, `${approvalDecisionIdempotencyKey}:approval_decided`),
        ),
      );
    const [approvalDecisionStepCount] = await db
      .select({ value: count() })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.kind, "approval_decision"),
          eq(workflowSteps.approvalRequestId, first.approvalRequestId ?? ""),
        ),
      );

    expect(decisionReplay.auditEventId).toBe(decision.auditEventId);
    expect(decisionReplay.evidenceId).toBe(decision.evidenceId);
    expect(decisionReplay.workflowStepId).toBe(decision.workflowStepId);
    expect(approvalDecisionAuditCount.value).toBe(1);
    expect(approvalDecisionStepCount.value).toBe(1);
    await expect(
      decideApproval({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: approvalDecisionIdempotencyKey,
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        action: "rejected",
        note: "Changed action must conflict.",
        subject: "worker",
        db,
      }),
    ).rejects.toMatchObject({
      code: "core_command_idempotency_conflict",
      status: 409,
    });

    const approvedContinuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-approved-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const approvedOutput = objectValue(approvedContinuation.output);
    const approvedExecutionPacket = objectValue(approvedOutput.approvedExecutionPacket);

    expect(approvedContinuation.created).toBe(true);
    expect(approvedContinuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(approvedContinuation.workflowRunId).toBe(first.workflowRunId);
    expect(approvedOutput.status).toBe("approved_execution_blocked");
    expect(approvedOutput.approvalRequestId).toBe(first.approvalRequestId);
    expect(approvedOutput.nextAction).toBe("enable_scoped_adapter_execution");
    expect(approvedOutput.externalExecution).toBe("blocked");
    expect(approvedOutput.externalSend).toBe(false);
    expect(approvedOutput.requiresApproval).toBe(false);
    expect(approvedOutput.approvedExecutionEvidenceId).toBeTruthy();
    expect(approvedOutput.approvedExecutionDocumentId).toBeTruthy();
    expect(approvedOutput.approvedEvidencePacketId).toBeTruthy();
    expect(approvedExecutionPacket.status).toBe("approved_execution_blocked");
    expect(approvedExecutionPacket.externalExecution).toBe("blocked");
    expect(approvedExecutionPacket.externalSend).toBe(false);

    const [executionWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const executionWorkflowData = objectValue(executionWorkflowRun?.data);
    const approvedExecutionContinuation = objectValue(
      executionWorkflowData.approvedExecutionContinuation,
    );

    expect(executionWorkflowRun?.state).toBe("execution_blocked");
    expect(approvedExecutionContinuation.workerRunId).toBe(approvedContinuation.workerRunId);
    expect(approvedExecutionContinuation.action).toBe("approved");
    expect(approvedExecutionContinuation.approvedExecutionEvidenceId).toBe(
      approvedOutput.approvedExecutionEvidenceId,
    );
    expect(executionWorkflowData.workflowStepIds).toContain(approvedContinuation.workflowStepId);

    const [approvedContinuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, approvedContinuation.workflowStepId ?? ""))
      .limit(1);
    const approvedStepOutput = objectValue(approvedContinuationStep?.output);

    expect(approvedContinuationStep?.kind).toBe("worker_continuation");
    expect(approvedContinuationStep?.fromState).toBe("approved");
    expect(approvedContinuationStep?.toState).toBe("execution_blocked");
    expect(approvedStepOutput.nextAction).toBe("enable_scoped_adapter_execution");
    expect(approvedStepOutput.externalExecution).toBe("blocked");
    expect(approvedStepOutput.externalSend).toBe(false);

    const [approvedExecutionEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(approvedOutput.approvedExecutionEvidenceId ?? "")))
      .limit(1);
    const approvedExecutionEvidenceData = objectValue(approvedExecutionEvidence?.data);
    const [approvedExecutionDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(approvedOutput.approvedExecutionDocumentId ?? "")))
      .limit(1);
    const [approvedEvidencePacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(approvedOutput.approvedEvidencePacketId ?? "")))
      .limit(1);

    expect(approvedExecutionEvidence?.kind).toBe("draft");
    expect(approvedExecutionEvidenceData.externalExecution).toBe("blocked");
    expect(approvedExecutionEvidenceData.externalSend).toBe(false);
    expect(approvedExecutionDocument?.state).toBe("blocked");
    expect(approvedEvidencePacket?.state).toBe("blocked");
    expect(approvedEvidencePacket?.documentId).toBe(approvedOutput.approvedExecutionDocumentId);

    const [continuedOriginalRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const continuedOriginalOutput = objectValue(objectValue(continuedOriginalRun?.data).output);

    expect(objectValue(continuedOriginalOutput.approvedExecutionContinuation).workerRunId).toBe(
      approvedContinuation.workerRunId,
    );
    expect(continuedOriginalOutput.externalSend).toBe(false);

    const [continuedAdapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const continuedAdapterReceipt = objectValue(continuedAdapterAction?.receipt);

    expect(objectValue(continuedAdapterReceipt.approvedExecutionContinuation).externalExecution).toBe(
      "blocked",
    );
    expect(continuedAdapterReceipt.externalMutation).toBe(false);
    expect(continuedAdapterReceipt.externalSend).toBe(false);

    const approvedReplay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-approved-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(approvedReplay.created).toBe(false);
    expect(approvedReplay.workerRunId).toBe(approvedContinuation.workerRunId);
    expect(objectValue(approvedReplay.output).status).toBe("approved_execution_blocked");
  }, 120_000);

  it("records approved controlled-send receipts through config.execution on the generic worker command", async () => {
    const runId = randomUUID();
    const [seedConnection] = await db.select({ tenantId: connections.tenantId }).from(connections).limit(1);

    expect(seedConnection?.tenantId).toBeTruthy();

    const [sendAdapter] = await db
      .insert(adapters)
      .values({
        key: `customer_message_${runId}`,
        name: `Customer message ${runId}`,
        kind: "customer_message",
        auth: "managed",
        capabilities: {
          write: ["customer_message.send"],
          receipts: ["delivery"],
        },
      })
      .returning();
    const [sendConnection] = await db
      .insert(connections)
      .values({
        tenantId: seedConnection.tenantId,
        adapterId: sendAdapter.id,
        name: `Customer message send ${runId}`,
        state: "active",
        externalAccountId: `customer-message-${runId}`,
        scopes: { writes: ["customer_message.send"] },
        config: {
          executable: false,
          credentialRef: "managed:customer-message-sender",
          writer: {
            provider: "postmark",
            channel: "email",
          },
        },
      })
      .returning();
    const [noCredentialConnection] = await db
      .insert(connections)
      .values({
        tenantId: seedConnection.tenantId,
        adapterId: sendAdapter.id,
        name: `Customer message no credential ${runId}`,
        state: "active",
        externalAccountId: `customer-message-no-credential-${runId}`,
        scopes: { writes: ["customer_message.send"] },
        config: {
          executable: false,
        },
      })
      .returning();

    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-controlled-send-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "controlled_send_test",
          sourceEventId: `controlled-send-test:${runId}`,
          customerName: "Controlled Send Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-controlled-send-approval-${runId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Approve controlled send receipt recording.",
      subject: "worker",
      db,
    });

    const baseExecution = {
      connectionId: sendConnection.id,
      credentialRef: "managed:customer-message-sender",
      requiredScopes: ["customer_message.send"],
      channel: "email",
      recipient: "buyer@example.com",
      debugValue: "inline-material-that-must-not-persist",
      receipt: {
        receiptId: `receipt:${runId}`,
        providerMessageId: `message:${runId}`,
        sentAt: "2026-05-19T09:30:00.000Z",
        rawProviderDump: "inline-receipt-material-that-must-not-persist",
      },
      rollback: {
        strategy: "send_followup_correction",
        escalationOwner: "owner@continuoushq.com",
        steps: ["send correction email", "open owner review task"],
        rawProviderDump: "inline-rollback-material-that-must-not-persist",
      },
    };
    const baseExecutionWithoutConnection = {
      credentialRef: baseExecution.credentialRef,
      requiredScopes: baseExecution.requiredScopes,
      channel: baseExecution.channel,
      recipient: baseExecution.recipient,
      receipt: baseExecution.receipt,
      rollback: baseExecution.rollback,
    };
    const baseExecutionWithoutCredential = {
      connectionId: baseExecution.connectionId,
      requiredScopes: baseExecution.requiredScopes,
      channel: baseExecution.channel,
      recipient: baseExecution.recipient,
      receipt: baseExecution.receipt,
      rollback: baseExecution.rollback,
    };

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-no-connection-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: baseExecutionWithoutConnection,
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_controlled_send_connection_required" });

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-no-credential-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: {
            ...baseExecutionWithoutCredential,
            connectionId: noCredentialConnection.id,
          },
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_controlled_send_credential_required" });

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-missing-scope-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: {
            ...baseExecution,
            requiredScopes: ["message.send"],
          },
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_controlled_send_scope_missing" });

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-missing-rollback-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: {
            ...baseExecution,
            rollback: {},
          },
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_controlled_send_rollback_required" });

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-alias-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          controlledSend: baseExecution,
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_controlled_send_config_alias" });

    const controlledContinuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-controlled-send-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        approvalId: first.approvalRequestId ?? "",
        execution: baseExecution,
      },
      db,
    });
    const output = objectValue(controlledContinuation.output);
    const controlledReceipt = objectValue(output.controlledSendReceipt);
    const credential = objectValue(controlledReceipt.credential);
    const receipt = objectValue(controlledReceipt.receipt);
    const rollback = objectValue(controlledReceipt.rollback);
    const outputJson = JSON.stringify(output);

    expect(controlledContinuation.created).toBe(true);
    expect(output.status).toBe("approved_execution_recorded");
    expect(output.nextAction).toBe("reconcile_controlled_send_receipt");
    expect(output.externalExecution).toBe("recorded");
    expect(output.externalSend).toBe(true);
    expect(controlledReceipt.connectionId).toBe(sendConnection.id);
    expect(controlledReceipt.operation).toBe("customer_message.send");
    expect(controlledReceipt.recipient).toBe("buyer@example.com");
    expect(credential.kind).toBe("managed");
    expect(credential.hash).toBeTruthy();
    expect(receipt.providerMessageId).toBe(`message:${runId}`);
    expect(rollback.strategy).toBe("send_followup_correction");
    expect(rollback.escalationOwner).toBe("owner@continuoushq.com");
    for (const forbidden of [
      "managed:customer-message-sender",
      "inline-material-that-must-not-persist",
      "inline-receipt-material-that-must-not-persist",
      "inline-rollback-material-that-must-not-persist",
    ]) {
      expect(outputJson).not.toContain(forbidden);
    }

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, controlledContinuation.taskId ?? ""))
      .limit(1);
    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const [adapterRun] = await db
      .select()
      .from(adapterRuns)
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""))
      .limit(1);
    const [continuationRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, controlledContinuation.workerRunId ?? ""))
      .limit(1);
    const continuationDataJson = JSON.stringify(continuationRun?.data);
    const storedConfig = objectValue(objectValue(continuationRun?.data).input).config;
    const storedExecutionConfig = objectValue(objectValue(storedConfig).execution);

    expect(workflowRun?.state).toBe("execution_recorded");
    expect(objectValue(workflowRun?.blockers).open).toEqual([]);
    expect(task?.state).toBe("done");
    expect(adapterAction?.connectionId).toBe(sendConnection.id);
    expect(adapterAction?.mode).toBe("controlled_record");
    expect(adapterAction?.operation).toBe("customer_message.send");
    expect(adapterAction?.reconciliationState).toBe("matched");
    expect(objectValue(adapterAction?.receipt).externalSend).toBe(true);
    expect(adapterRun?.connectionId).toBe(sendConnection.id);
    expect(adapterRun?.writeCount).toBe(1);
    expect(objectValue(adapterRun?.receipt).externalSend).toBe(true);
    expect(objectValue(storedConfig).approvalId).toBe(first.approvalRequestId);
    expect(storedExecutionConfig.provided).toBe(true);
    expect(storedExecutionConfig.inputHash).toBeTruthy();
    for (const forbidden of [
      "managed:customer-message-sender",
      "inline-material-that-must-not-persist",
      "inline-receipt-material-that-must-not-persist",
      "inline-rollback-material-that-must-not-persist",
    ]) {
      expect(continuationDataJson).not.toContain(forbidden);
    }

    const replay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-controlled-send-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        approvalId: first.approvalRequestId ?? "",
        execution: baseExecution,
      },
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(controlledContinuation.workerRunId);

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-continue-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: {
            ...baseExecution,
            receipt: {
              ...baseExecution.receipt,
              providerMessageId: `changed:${runId}`,
            },
          },
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_continuation_idempotency_conflict" });

    const storedContinuationData = objectValue(continuationRun?.data);
    const storedContinuationInput = objectValue(storedContinuationData.input);
    delete storedContinuationInput.inputHash;
    await db
      .update(workerRuns)
      .set({
        data: {
          ...storedContinuationData,
          input: storedContinuationInput,
        },
      })
      .where(eq(workerRuns.id, controlledContinuation.workerRunId ?? ""));

    await expect(
      continueRevenueWorker({
        approvalId: first.approvalRequestId ?? "",
        idempotencyKey: `ci-worker-controlled-send-continue-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: first.approvalRequestId ?? "",
          execution: baseExecution,
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "worker_continuation_idempotency_conflict" });
  }, 120_000);

  it("claims, executes, and retries queued workflow steps", async () => {
    const runId = randomUUID();
    const start = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-run-${runId}`,
      initialState: "draft",
      data: {
        source: "workflow_executor_ci",
      },
      db,
    });
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, start.run.id))
      .limit(1);

    expect(start.created).toBe(true);
    expect(run?.state).toBe("draft");

    const [queuedStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: run?.tenantId ?? "",
        definitionId: run?.definitionId ?? "",
        workflowRunId: start.run.id,
        kind: "transition",
        name: "CI execute payroll source lock",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-executor-step-${runId}`,
        input: {
          source: "workflow_executor_ci",
        },
      })
      .returning();

    const executed = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor:${runId}`,
      db,
    });
    const [executionResult] = executed.results;

    expect(executed.processed).toBe(1);
    expect(executed.completed).toBe(1);
    expect(executed.failed).toBe(0);
    expect(executionResult?.stepId).toBe(queuedStep.id);
    expect(executionResult?.state).toBe("done");
    expect(executionResult?.eventId).toBeTruthy();
    expect(executionResult?.auditEventId).toBeTruthy();
    expect(executionResult?.evidenceId).toBeTruthy();

    const [executedRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, start.run.id))
      .limit(1);
    const [executedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, queuedStep.id))
      .limit(1);
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, executionResult?.eventId ?? ""))
      .limit(1);
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, executionResult?.auditEventId ?? ""))
      .limit(1);
    const [proof] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, executionResult?.evidenceId ?? ""))
      .limit(1);
    const executedStepOutput = objectValue(executedStep?.output);

    expect(executedRun?.state).toBe("source_data_locked");
    expect(executedStep?.state).toBe("done");
    expect(executedStep?.leaseOwner).toBeNull();
    expect(executedStep?.leasedUntil).toBeNull();
    expect(executedStepOutput.externalExecution).toBe("blocked");
    expect(event?.type).toBe("workflow.step.executed");
    expect(audit?.targetId).toBe(queuedStep.id);
    expect(proof?.kind).toBe("trace");

    const expiredStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-expired-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [expiredRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, expiredStart.run.id))
      .limit(1);
    const [expiredStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: expiredRun?.tenantId ?? "",
        definitionId: expiredRun?.definitionId ?? "",
        workflowRunId: expiredStart.run.id,
        kind: "transition",
        name: "CI reclaim expired payroll transition",
        state: "running",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        leaseOwner: "expired-runner",
        leasedUntil: new Date("2026-05-19T00:00:00.000Z"),
        idempotencyKey: `ci-workflow-executor-expired-step-${runId}`,
        input: {
          source: "workflow_executor_expired_ci",
        },
        startedAt: new Date("2026-05-19T00:00:00.000Z"),
      })
      .returning();

    const reclaimed = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-expired:${runId}`,
      db,
    });
    const [reclaimedResult] = reclaimed.results;
    const [reclaimedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, expiredStep.id))
      .limit(1);

    expect(reclaimed.processed).toBe(1);
    expect(reclaimed.completed).toBe(1);
    expect(reclaimedResult?.stepId).toBe(expiredStep.id);
    expect(reclaimedResult?.attempt).toBe(2);
    expect(reclaimedStep?.state).toBe("done");
    expect(reclaimedStep?.attempt).toBe(2);
    expect(reclaimedStep?.leaseOwner).toBeNull();

    const [revenueWorker] = await db
      .select({ id: workers.id, tenantId: workers.tenantId })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const [quoteCapability] = await db
      .select({ id: capabilities.id, key: capabilities.key })
      .from(capabilities)
      .where(eq(capabilities.key, "quote.prepare"))
      .limit(1);

    expect(revenueWorker?.id).toBeTruthy();
    expect(quoteCapability?.id).toBeTruthy();

    const revenueWorkerId = revenueWorker?.id ?? "";
    const quoteCapabilityId = quoteCapability?.id ?? "";
    const quoteCapabilityKey = quoteCapability?.key ?? "";
    const capabilityTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-workflow-capability-task-${runId}`,
      title: "Execute capability workflow step",
      capabilityId: quoteCapabilityId,
      owner: {
        type: "worker",
        id: revenueWorkerId,
        ref: `worker:${revenueWorkerId}`,
      },
      db,
    });
    const capabilityStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-capability-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [capabilityRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, capabilityStart.run.id))
      .limit(1);
    const [capabilityStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: capabilityRun?.tenantId ?? "",
        definitionId: capabilityRun?.definitionId ?? "",
        workflowRunId: capabilityStart.run.id,
        taskId: capabilityTask.taskId,
        workerId: revenueWorkerId,
        capabilityId: quoteCapabilityId,
        kind: "capability_execution",
        name: "CI execute quote capability through workflow",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "source_data_locked",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-capability-step-${runId}`,
        input: {
          source: "workflow_capability_ci",
          capabilityKey: quoteCapabilityKey,
        },
      })
      .returning();

    const capabilityExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-capability:${runId}`,
      db,
    });
    const [capabilityResult] = capabilityExecution.results;
    const [executedCapabilityStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, capabilityStep.id))
      .limit(1);
    const [capabilityEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, capabilityResult?.eventId ?? ""))
      .limit(1);
    const [capabilityAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, capabilityResult?.auditEventId ?? ""))
      .limit(1);
    const [capabilityTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, capabilityTask.taskId))
      .limit(1);
    const capabilityOutput = objectValue(executedCapabilityStep?.output);
    const capabilityProof = objectValue(capabilityOutput.capabilityExecution);
    const taskCapabilityOutcome = objectValue(
      objectValue(capabilityTaskRow?.outcome).lastCapabilityExecution,
    );

    expect(capabilityExecution.processed).toBe(1);
    expect(capabilityExecution.completed).toBe(1);
    expect(capabilityResult?.stepId).toBe(capabilityStep.id);
    expect(executedCapabilityStep?.state).toBe("done");
    expect(capabilityProof.capabilityId).toBe(quoteCapabilityId);
    expect(capabilityProof.capabilityKey).toBe("quote.prepare");
    expect(capabilityProof.capabilityGrantId).toBeTruthy();
    expect(objectValue(capabilityProof.actor).id).toBe(revenueWorkerId);
    expect(capabilityOutput.externalExecution).toBe("blocked");
    expect(capabilityEvent?.actorType).toBe("worker");
    expect(capabilityEvent?.actorId).toBe(revenueWorkerId);
    expect(capabilityEvent?.capabilityId).toBe(quoteCapabilityId);
    expect(capabilityAudit?.capabilityId).toBe(quoteCapabilityId);
    expect(taskCapabilityOutcome.workflowStepId).toBe(capabilityStep.id);
    expect(taskCapabilityOutcome.evidenceId).toBe(capabilityResult?.evidenceId);

    const packetTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-workflow-packet-task-${runId}`,
      title: "Prepare workflow packet from queued step",
      state: "active",
      db,
    });
    const packetStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-packet-run-${runId}`,
      initialState: "calculating",
      data: {
        source: "workflow_packet_ci",
      },
      db,
    });
    const [packetRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const [packetStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        kind: "packet_prepare",
        name: "CI prepare payroll workflow packet",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "calculating",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-packet-step-${runId}`,
        input: {
          packet: {
            kind: "payroll_packet",
            name: "CI queued workflow payroll packet",
            state: "review_ready",
            evidenceIds: [String(capabilityResult?.evidenceId)],
            sections: {
              summary: "Workflow executor prepared this packet from a queued step.",
            },
            data: {
              source: "workflow_packet_ci",
            },
          },
        },
      })
      .returning();

    const packetExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-packet:${runId}`,
      db,
    });
    const [packetResult] = packetExecution.results;
    const [executedPacketStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, packetStep.id))
      .limit(1);
    const [executedPacketRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const packetStepOutput = objectValue(executedPacketStep?.output);
    const packetPreparation = objectValue(packetStepOutput.packetPreparation);
    const [workflowPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(packetPreparation.packetId ?? "")))
      .limit(1);
    const [workflowPacketDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(packetPreparation.documentId ?? "")))
      .limit(1);
    const [packetTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const packetEvidenceIds = objectValue(workflowPacket?.evidenceIds).ids;
    const packetTaskOutcome = objectValue(objectValue(packetTaskRow?.outcome).lastWorkflowPacket);

    expect(packetExecution.processed).toBe(1);
    expect(packetExecution.completed).toBe(1);
    expect(packetResult?.stepId).toBe(packetStep.id);
    expect(executedPacketStep?.state).toBe("done");
    expect(executedPacketRun?.state).toBe("awaiting_approval");
    expect(packetPreparation.packetId).toBeTruthy();
    expect(packetPreparation.documentId).toBeTruthy();
    expect(packetPreparation.externalExecution).toBe("blocked");
    expect(workflowPacket?.kind).toBe("payroll_packet");
    expect(workflowPacket?.workflowRunId).toBe(packetStart.run.id);
    expect(workflowPacket?.taskId).toBe(packetTask.taskId);
    expect(workflowPacket?.eventId).toBe(packetResult?.eventId);
    expect(workflowPacket?.state).toBe("review_ready");
    expect(workflowPacketDocument?.kind).toBe("payroll_packet");
    expect(stringList(packetEvidenceIds)).toEqual(
      expect.arrayContaining([String(capabilityResult?.evidenceId), String(packetResult?.evidenceId)]),
    );
    expect(objectValue(objectValue(workflowPacket?.data).sections).summary).toContain(
      "queued step",
    );
    expect(packetTaskOutcome.packetId).toBe(packetPreparation.packetId);
    expect(packetTaskOutcome.workflowStepId).toBe(packetStep.id);

    const [approvalStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        kind: "approval_request",
        name: "CI request payroll workflow approval",
        state: "queued",
        priority: "urgent",
        risk: "high",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-approval-step-${runId}`,
        input: {
          approval: {
            kind: "payroll_approval",
            title: "CI payroll workflow approval",
            summary: "Queued workflow execution requested payroll approval.",
            requestedAction: {
              action: "approve_payroll_packet",
              packetId: String(packetPreparation.packetId ?? ""),
            },
            evidence: {
              packetId: String(packetPreparation.packetId ?? ""),
              packetEvidenceId: String(packetResult?.evidenceId ?? ""),
            },
            data: {
              source: "workflow_approval_ci",
            },
          },
        },
      })
      .returning();

    const approvalExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-approval:${runId}`,
      db,
    });
    const [approvalResult] = approvalExecution.results;
    const [executedApprovalStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, approvalStep.id))
      .limit(1);
    const [approvalRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const approvalStepOutput = objectValue(executedApprovalStep?.output);
    const workflowApproval = objectValue(approvalStepOutput.approvalRequest);
    const [workflowApprovalRequest] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, String(workflowApproval.approvalRequestId ?? "")))
      .limit(1);
    const [workflowApprovalAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, String(workflowApproval.approvalAuditEventId ?? "")))
      .limit(1);
    const [workflowApprovalEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(workflowApproval.approvalEvidenceId ?? "")))
      .limit(1);
    const [approvalTaskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const approvalRunData = objectValue(approvalRun?.data);
    const lastWorkflowApproval = objectValue(approvalRunData.lastWorkflowApprovalRequest);
    const approvalTaskOutcome = objectValue(
      objectValue(approvalTaskRow?.outcome).lastWorkflowApprovalRequest,
    );

    expect(approvalExecution.processed).toBe(1);
    expect(approvalExecution.completed).toBe(1);
    expect(approvalResult?.stepId).toBe(approvalStep.id);
    expect(executedApprovalStep?.state).toBe("done");
    expect(executedApprovalStep?.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalRun?.state).toBe("awaiting_approval");
    expect(workflowApproval.approvalRequestId).toBeTruthy();
    expect(workflowApproval.externalExecution).toBe("blocked");
    expect(workflowApprovalRequest?.kind).toBe("payroll_approval");
    expect(workflowApprovalRequest?.state).toBe("pending");
    expect(workflowApprovalRequest?.workflowRunId).toBe(packetStart.run.id);
    expect(workflowApprovalRequest?.taskId).toBe(packetTask.taskId);
    expect(workflowApprovalRequest?.eventId).toBe(approvalResult?.eventId);
    expect(objectValue(workflowApprovalRequest?.requestedAction).packetId).toBe(packetPreparation.packetId);
    expect(workflowApprovalAudit?.targetId).toBe(workflowApproval.approvalRequestId);
    expect(workflowApprovalAudit?.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(workflowApprovalEvidence?.kind).toBe("approval");
    expect(objectValue(workflowApprovalEvidence?.data).workflowStepId).toBe(approvalStep.id);
    expect(lastWorkflowApproval.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalTaskRow?.state).toBe("approval_required");
    expect(approvalTaskOutcome.approvalRequestId).toBe(workflowApproval.approvalRequestId);
    expect(approvalTaskOutcome.workflowStepId).toBe(approvalStep.id);

    const [workflowConnection] = await db.select({ id: connections.id }).from(connections).limit(1);
    const [workflowRulePack] = await db.select({ id: rulePacks.id }).from(rulePacks).limit(1);

    expect(workflowConnection?.id).toBeTruthy();
    expect(workflowRulePack?.id).toBeTruthy();

    const [adapterIntentStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        capabilityId: quoteCapabilityId,
        kind: "adapter_intent_record",
        name: "CI record adapter intent from workflow",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-adapter-intent-step-${runId}`,
        input: {
          adapterIntent: {
            connectionId: workflowConnection?.id,
            operation: "draft_agency_response",
            mode: "dry_run",
            maxAttempts: 2,
            request: {
              packetId: String(packetPreparation.packetId ?? ""),
              externalSend: false,
            },
            data: {
              source: "workflow_adapter_intent_ci",
            },
          },
        },
      })
      .returning();

    const adapterIntentExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-adapter-intent:${runId}`,
      db,
    });
    const [adapterIntentResult] = adapterIntentExecution.results;
    const [executedAdapterIntentStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, adapterIntentStep.id))
      .limit(1);
    const adapterIntentOutput = objectValue(executedAdapterIntentStep?.output);
    const workflowAdapterIntent = objectValue(adapterIntentOutput.adapterIntentRecord);
    const [workflowAdapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, String(workflowAdapterIntent.adapterActionId ?? "")))
      .limit(1);
    const [adapterIntentTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const adapterIntentTaskOutcome = objectValue(
      objectValue(adapterIntentTask?.outcome).lastWorkflowAdapterIntent,
    );

    expect(adapterIntentExecution.processed).toBe(1);
    expect(adapterIntentExecution.completed).toBe(1);
    expect(adapterIntentResult?.stepId).toBe(adapterIntentStep.id);
    expect(executedAdapterIntentStep?.state).toBe("done");
    expect(workflowAdapterIntent.adapterActionId).toBeTruthy();
    expect(workflowAdapterIntent.externalExecution).toBe("blocked");
    expect(workflowAdapterAction?.mode).toBe("dry_run");
    expect(workflowAdapterAction?.operation).toBe("draft_agency_response");
    expect(objectValue(workflowAdapterAction?.request).workflowStepId).toBe(adapterIntentStep.id);
    expect(adapterIntentTaskOutcome.adapterActionId).toBe(workflowAdapterIntent.adapterActionId);

    const [ruleChangeStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        capabilityId: quoteCapabilityId,
        kind: "rule_change_record",
        name: "CI record rule change from workflow",
        state: "queued",
        priority: "urgent",
        risk: "high",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-rule-change-step-${runId}`,
        input: {
          ruleChange: {
            rulePackId: workflowRulePack?.id,
            ruleKey: "workflow.agency_notice.response_window",
            changeType: "operator_policy_update",
            title: "Workflow agency response window update",
            state: "proposed",
            decision: "owner_review_required",
            rationale: "Workflow-driven rule changes stay blocked until owner review.",
            before: {
              responseWindowDays: 14,
            },
            after: {
              responseWindowDays: 10,
            },
            impact: {
              packetId: String(packetPreparation.packetId ?? ""),
            },
            data: {
              source: "workflow_rule_change_ci",
            },
          },
        },
      })
      .returning();

    const ruleChangeExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-rule-change:${runId}`,
      db,
    });
    const [ruleChangeResult] = ruleChangeExecution.results;
    const [executedRuleChangeStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, ruleChangeStep.id))
      .limit(1);
    const ruleChangeOutput = objectValue(executedRuleChangeStep?.output);
    const workflowRuleChange = objectValue(ruleChangeOutput.ruleChangeRecord);
    const [workflowRuleChangeObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, String(workflowRuleChange.objectId ?? "")))
      .limit(1);
    const [workflowRuleChangeDecision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, String(workflowRuleChange.decisionId ?? "")))
      .limit(1);
    const [ruleChangeTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const ruleChangeTaskOutcome = objectValue(
      objectValue(ruleChangeTask?.outcome).lastWorkflowRuleChange,
    );

    expect(ruleChangeExecution.processed).toBe(1);
    expect(ruleChangeExecution.completed).toBe(1);
    expect(ruleChangeResult?.stepId).toBe(ruleChangeStep.id);
    expect(executedRuleChangeStep?.state).toBe("done");
    expect(workflowRuleChange.objectId).toBeTruthy();
    expect(workflowRuleChange.externalExecution).toBe("blocked");
    expect(workflowRuleChangeObject?.type).toBe("rule_change");
    expect(objectValue(workflowRuleChangeObject?.data).workflowStepId).toBe(ruleChangeStep.id);
    expect(workflowRuleChangeDecision?.decision).toBe("owner_review_required");
    expect(ruleChangeTaskOutcome.objectId).toBe(workflowRuleChange.objectId);

    const [workerCommandStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        taskId: packetTask.taskId,
        workerId: revenueWorkerId,
        kind: "worker_command",
        name: "CI classify a lead through workflow",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-worker-command-step-${runId}`,
        input: {
          command: "lead.classify",
          worker: {
            role: "revenue_operations",
            id: revenueWorkerId,
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: `ci-workflow-worker-command-${runId}`,
          config: {
            leadPacket: {
              source: "workflow_worker_command_ci",
              sourceEventId: `workflow-worker-command:${runId}`,
              customerName: "Workflow Command Roofing",
              customerIntent: "roof leak inspection",
              serviceArea: "roofing",
              urgency: "high",
              missingFacts: ["preferred_time_window"],
            },
          },
        },
      })
      .returning();

    const workerCommandExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-worker-command:${runId}`,
      db,
    });
    const [workerCommandResult] = workerCommandExecution.results;
    const [executedWorkerCommandStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, workerCommandStep.id))
      .limit(1);
    const [workerCommandRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, packetStart.run.id))
      .limit(1);
    const workerCommandOutput = objectValue(executedWorkerCommandStep?.output);
    const workflowWorkerCommand = objectValue(workerCommandOutput.workerCommand);
    const workflowWorkerCommandResult = objectValue(workflowWorkerCommand.result);
    const [workflowWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, String(workflowWorkerCommandResult.workerRunId ?? "")))
      .limit(1);
    const [workerCommandTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, packetTask.taskId))
      .limit(1);
    const workerCommandTaskOutcome = objectValue(
      objectValue(workerCommandTask?.outcome).lastWorkflowWorkerCommand,
    );
    const workerCommandRunData = objectValue(workerCommandRun?.data);
    const lastWorkflowWorkerCommand = objectValue(workerCommandRunData.lastWorkflowWorkerCommand);

    expect(workerCommandExecution.processed).toBe(1);
    expect(workerCommandExecution.completed).toBe(1);
    expect(workerCommandResult?.stepId).toBe(workerCommandStep.id);
    expect(executedWorkerCommandStep?.state).toBe("done");
    expect(workerCommandOutput.externalExecution).toBe("blocked");
    expect(workflowWorkerCommand.command).toBe("lead.classify");
    expect(objectValue(workflowWorkerCommand.worker).role).toBe("revenue_operations");
    expect(workflowWorkerCommand.externalExecution).toBe("registry_controlled");
    expect(workflowWorkerCommandResult.workerRunId).toBeTruthy();
    expect(workflowWorkerRun?.mode).toBe("classification");
    expect(workerCommandRun?.state).toBe("awaiting_approval");
    expect(lastWorkflowWorkerCommand.workflowStepId).toBe(workerCommandStep.id);
    expect(workerCommandTaskOutcome.workflowStepId).toBe(workerCommandStep.id);
    expect(objectValue(workerCommandTaskOutcome.result).workerRunId).toBe(workflowWorkerCommandResult.workerRunId);

    const [crossTenantWorkerCommandStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: packetRun?.tenantId ?? "",
        definitionId: packetRun?.definitionId ?? "",
        workflowRunId: packetStart.run.id,
        workerId: revenueWorkerId,
        kind: "worker_command",
        name: "CI reject cross-tenant worker command",
        state: "queued",
        priority: "urgent",
        risk: "high",
        fromState: "awaiting_approval",
        toState: "awaiting_approval",
        attempt: 1,
        maxAttempts: 1,
        idempotencyKey: `ci-workflow-worker-command-cross-tenant-step-${runId}`,
        input: {
          command: "lead.classify",
          worker: {
            role: "revenue_operations",
            id: revenueWorkerId,
            tenantSlug: "other-tenant",
          },
          idempotencyKey: `ci-workflow-worker-command-cross-tenant-${runId}`,
          config: {
            leadPacket: {
              source: "workflow_worker_command_cross_tenant_ci",
              sourceEventId: `workflow-worker-command-cross-tenant:${runId}`,
              customerName: "Wrong Tenant Roofing",
              customerIntent: "roof leak inspection",
              serviceArea: "roofing",
              urgency: "high",
            },
          },
        },
      })
      .returning();

    const crossTenantExecution = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-worker-command-cross-tenant:${runId}`,
      db,
    });
    const [crossTenantResult] = crossTenantExecution.results;
    const [failedCrossTenantStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, crossTenantWorkerCommandStep.id))
      .limit(1);
    const crossTenantError = objectValue(failedCrossTenantStep?.error);

    expect(crossTenantExecution.processed).toBe(1);
    expect(crossTenantExecution.completed).toBe(0);
    expect(crossTenantExecution.failed).toBe(1);
    expect(crossTenantResult?.stepId).toBe(crossTenantWorkerCommandStep.id);
    expect(crossTenantResult?.state).toBe("failed");
    expect(failedCrossTenantStep?.state).toBe("failed");
    expect(crossTenantError.code).toBe("workflow_worker_tenant_mismatch");
    expect(crossTenantError.retryable).toBe(false);

    const retryStart = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-executor-retry-run-${runId}`,
      initialState: "draft",
      db,
    });
    const [retryRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, retryStart.run.id))
      .limit(1);
    const [retryStep] = await db
      .insert(workflowSteps)
      .values({
        tenantId: retryRun?.tenantId ?? "",
        definitionId: retryRun?.definitionId ?? "",
        workflowRunId: retryStart.run.id,
        kind: "transition",
        name: "CI retry invalid payroll transition",
        state: "queued",
        priority: "urgent",
        risk: "medium",
        fromState: "draft",
        toState: "not_a_state",
        attempt: 1,
        maxAttempts: 2,
        idempotencyKey: `ci-workflow-executor-retry-step-${runId}`,
        input: {
          source: "workflow_executor_retry_ci",
        },
      })
      .returning();

    const firstFailure = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-retry:${runId}`,
      db,
    });
    const [firstFailureResult] = firstFailure.results;

    expect(firstFailure.processed).toBe(1);
    expect(firstFailure.completed).toBe(0);
    expect(firstFailure.failed).toBe(1);
    expect(firstFailureResult?.stepId).toBe(retryStep.id);
    expect(firstFailureResult?.state).toBe("failed");

    const [failedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, retryStep.id))
      .limit(1);
    const failedError = objectValue(failedStep?.error);

    expect(failedStep?.state).toBe("failed");
    expect(failedStep?.attempt).toBe(1);
    expect(failedStep?.nextAttemptAt).toBeTruthy();
    expect(failedError.retryable).toBe(true);

    await db
      .update(workflowSteps)
      .set({
        nextAttemptAt: new Date("2026-05-19T00:00:00.000Z"),
      })
      .where(eq(workflowSteps.id, retryStep.id));

    const finalFailure = await executeWorkflowSteps({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      limit: 1,
      leaseOwner: `ci-workflow-executor-retry:${runId}`,
      db,
    });
    const [finalFailureResult] = finalFailure.results;
    const [finalFailedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, retryStep.id))
      .limit(1);
    const finalError = objectValue(finalFailedStep?.error);

    expect(finalFailure.processed).toBe(1);
    expect(finalFailureResult?.stepId).toBe(retryStep.id);
    expect(finalFailureResult?.state).toBe("failed");
    expect(finalFailedStep?.attempt).toBe(2);
    expect(finalFailedStep?.nextAttemptAt).toBeNull();
    expect(finalError.retryable).toBe(false);
  }, 120_000);

  it("replays direct workflow transitions by idempotency key", async () => {
    const runId = randomUUID();
    const start = await startWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      workflowKey: "run_payroll",
      idempotencyKey: `ci-workflow-transition-run-${runId}`,
      initialState: "draft",
      data: {
        source: "workflow_transition_idempotency_ci",
      },
      db,
    });
    const idempotencyKey = `ci-workflow-transition-${runId}`;

    const first = await transitionWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      runId: start.run.id,
      toState: "source_data_locked",
      idempotencyKey,
      reason: "Source data locked for CI replay proof",
      data: {
        source: "workflow_transition_idempotency_ci",
      },
      db,
    });

    expect(first.created).toBe(true);
    expect(first.replayed).toBe(false);

    const replay = await transitionWorkflowRun({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      runId: start.run.id,
      toState: "source_data_locked",
      idempotencyKey,
      reason: "Source data locked for CI replay proof",
      data: {
        source: "workflow_transition_idempotency_ci",
      },
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.stepId).toBe(first.stepId);
    expect(replay.eventId).toBe(first.eventId);

    const [stepCount] = await db
      .select({ value: count() })
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.workflowRunId, start.run.id),
          eq(workflowSteps.idempotencyKey, `transition:${idempotencyKey}`),
        ),
      );

    expect(stepCount?.value).toBe(1);

    await expect(
      transitionWorkflowRun({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        runId: start.run.id,
        toState: "calculating",
        idempotencyKey,
        reason: "Different payload should conflict",
        db,
      }),
    ).rejects.toMatchObject({
      code: "workflow_transition_idempotency_conflict",
      status: 409,
    });
  }, 120_000);

  it("prepares workflow packets for workforce, payroll, filing, AI, and rule-change domains", async () => {
    const runId = randomUUID();
    const packetCases = [
      {
        id: "new-hire",
        workflowKey: "hire_employee",
        fromState: "classification_review",
        toState: "onboarding_packet_prepared",
        stepKind: "document_packet_prepare",
        packetKind: "new_hire_packet",
        packetName: "CI new-hire packet",
      },
      {
        id: "contractor",
        workflowKey: "engage_contractor",
        fromState: "classification_review",
        toState: "contract_prepared",
        stepKind: "document_packet_prepare",
        packetKind: "contractor_packet",
        packetName: "CI contractor packet",
      },
      {
        id: "payroll",
        workflowKey: "payroll_preview",
        fromState: "preview_ready",
        toState: "awaiting_approval",
        stepKind: "packet_prepare",
        packetKind: "payroll_packet",
        packetName: "CI payroll packet",
      },
      {
        id: "filing",
        workflowKey: "filing_draft",
        fromState: "validation",
        toState: "review_ready",
        stepKind: "evidence_packet_prepare",
        packetKind: "filing_draft_packet",
        packetName: "CI filing packet",
      },
      {
        id: "termination",
        workflowKey: "termination",
        fromState: "final_pay_calculation",
        toState: "approval_pending",
        stepKind: "evidence_packet_prepare",
        packetKind: "termination_packet",
        packetName: "CI termination packet",
      },
      {
        id: "ai-action",
        workflowKey: "ai_budget_cycle",
        fromState: "active",
        toState: "usage_review",
        stepKind: "packet_prepare",
        packetKind: "ai_action_packet",
        packetName: "CI AI action packet",
      },
      {
        id: "rule-change",
        workflowKey: "open_new_state",
        fromState: "rule_review",
        toState: "registration_ready",
        stepKind: "document_packet_prepare",
        packetKind: "rule_change_packet",
        packetName: "CI rule-change packet",
      },
    ];

    for (const packetCase of packetCases) {
      const task = await createCoreTask({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: `ci-domain-packet-task-${packetCase.id}-${runId}`,
        title: `Prepare ${packetCase.packetName}`,
        state: "active",
        db,
      });
      const start = await startWorkflowRun({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        workflowKey: packetCase.workflowKey,
        idempotencyKey: `ci-domain-packet-run-${packetCase.id}-${runId}`,
        initialState: packetCase.fromState,
        data: {
          source: "domain_packet_ci",
          packetCase: packetCase.id,
        },
        db,
      });
      const [run] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, start.run.id))
        .limit(1);
      const [step] = await db
        .insert(workflowSteps)
        .values({
          tenantId: run?.tenantId ?? "",
          definitionId: run?.definitionId ?? "",
          workflowRunId: start.run.id,
          taskId: task.taskId,
          kind: packetCase.stepKind,
          name: `CI prepare ${packetCase.packetName}`,
          state: "queued",
          priority: "urgent",
          risk: "medium",
          fromState: packetCase.fromState,
          toState: packetCase.toState,
          attempt: 1,
          maxAttempts: 2,
          idempotencyKey: `ci-domain-packet-step-${packetCase.id}-${runId}`,
          input: {
            packet: {
              kind: packetCase.packetKind,
              name: packetCase.packetName,
              state: "review_ready",
              taskId: task.taskId,
              sections: {
                summary: `${packetCase.packetName} prepared through the generic workflow packet executor.`,
                packetCase: packetCase.id,
              },
              data: {
                source: "domain_packet_ci",
                packetCase: packetCase.id,
                workflowKey: packetCase.workflowKey,
              },
            },
          },
        })
        .returning();

      const execution = await executeWorkflowSteps({
        operatorEmail: "owner@continuoushq.com",
        tenantSlug: "continuous-demo",
        limit: 1,
        leaseOwner: `ci-domain-packet:${packetCase.id}:${runId}`,
        db,
      });
      const [result] = execution.results;
      const [executedStep] = await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, step.id))
        .limit(1);
      const [executedRun] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, start.run.id))
        .limit(1);
      const packetPreparation = objectValue(objectValue(executedStep?.output).packetPreparation);
      const [packet] = await db
        .select()
        .from(evidencePackets)
        .where(eq(evidencePackets.id, String(packetPreparation.packetId ?? "")))
        .limit(1);
      const [document] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, String(packetPreparation.documentId ?? "")))
        .limit(1);
      const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.taskId)).limit(1);
      const taskPacket = objectValue(objectValue(taskRow?.outcome).lastWorkflowPacket);
      const packetData = objectValue(packet?.data);
      const packetSections = objectValue(packetData.sections);

      expect(execution.processed).toBe(1);
      expect(execution.completed).toBe(1);
      expect(result?.stepId).toBe(step.id);
      expect(executedStep?.state).toBe("done");
      expect(executedRun?.state).toBe(packetCase.toState);
      expect(packetPreparation.externalExecution).toBe("blocked");
      expect(packet?.kind).toBe(packetCase.packetKind);
      expect(packet?.name).toBe(packetCase.packetName);
      expect(packet?.workflowRunId).toBe(start.run.id);
      expect(packet?.taskId).toBe(task.taskId);
      expect(packet?.eventId).toBe(result?.eventId);
      expect(document?.kind).toBe(packetCase.packetKind);
      expect(document?.workflowRunId).toBe(start.run.id);
      expect(packetData.workflowKey).toBe(packetCase.workflowKey);
      expect(packetData.workflowStepKind).toBe(packetCase.stepKind);
      expect(packetData.externalExecution).toBe("blocked");
      expect(packetSections.packetCase).toBe(packetCase.id);
      expect(taskPacket.packetId).toBe(packetPreparation.packetId);
      expect(taskPacket.workflowStepId).toBe(step.id);
    }
  }, 120_000);

  it("continues revision-requested approval outcomes through the worker command spine", async () => {
    const runId = randomUUID();
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const workerId = worker?.id ?? "";

    expect(workerId).toBeTruthy();

    const createdTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-revision-task-${runId}`,
      title: "Revision continuation quote task",
      state: "active",
      priority: "urgent",
      owner: {
        type: "worker",
        id: workerId,
        ref: `worker:${workerId}`,
      },
      db,
    });
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-revision-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "revision_test",
          sourceEventId: `revision-test:${runId}`,
          customerName: "Revision Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    expect(first.taskId).toBe(createdTask.taskId);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-revision-approval-${runId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "revision_requested",
      note: "Revise the draft before owner approval.",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("revision_requested");

    const continuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const output = objectValue(continuation.output);

    expect(continuation.created).toBe(true);
    expect(continuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(continuation.workflowRunId).toBe(first.workflowRunId);
    expect(output.status).toBe("revised_packet_ready_for_owner_approval");
    expect(output.nextAction).toBe("owner_approval");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.revisionApprovalRequestId).toBeTruthy();
    expect(output.revisedPacketEvidenceId).toBeTruthy();
    expect(output.revisedPacketDocumentId).toBeTruthy();
    expect(output.revisedEvidencePacketId).toBeTruthy();

    const revisionApprovalRequestId = String(output.revisionApprovalRequestId ?? "");
    const revisedPacketEvidenceId = String(output.revisedPacketEvidenceId ?? "");
    const revisedPacketDocumentId = String(output.revisedPacketDocumentId ?? "");
    const revisedEvidencePacketId = String(output.revisedEvidencePacketId ?? "");
    const revisedPacket = objectValue(output.revisedPacket);

    expect(output.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(output.originalApprovalRequestId).toBe(first.approvalRequestId);
    expect(revisedPacket.status).toBe("revised_packet_ready_for_owner_approval");
    expect(revisedPacket.externalExecution).toBe("blocked");
    expect(revisedPacket.externalSend).toBe(false);
    expect(revisedPacket.requiresApproval).toBe(true);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, continuation.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const revisionContinuation = objectValue(workflowData.revisionContinuation);

    expect(workflowRun?.state).toBe("approval_requested");
    expect(revisionContinuation.workerRunId).toBe(continuation.workerRunId);
    expect(revisionContinuation.action).toBe("revision_requested");
    expect(revisionContinuation.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(revisionContinuation.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(workflowData.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(workflowData.workflowStepIds).toContain(continuation.workflowStepId);

    const [continuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, continuation.workflowStepId ?? ""))
      .limit(1);
    const stepOutput = objectValue(continuationStep?.output);

    expect(continuationStep?.kind).toBe("worker_continuation");
    expect(continuationStep?.fromState).toBe("revision_requested");
    expect(continuationStep?.toState).toBe("approval_requested");
    expect(stepOutput.nextAction).toBe("owner_approval");
    expect(stepOutput.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(stepOutput.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(stepOutput.externalExecution).toBe("blocked");
    expect(stepOutput.externalSend).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, continuation.taskId ?? ""))
      .limit(1);
    const taskOutcome = objectValue(task?.outcome);

    expect(task?.state).toBe("approval_required");
    expect(taskOutcome.status).toBe("revised_packet_ready_for_owner_approval");
    expect(taskOutcome.approvalRequestId).toBe(revisionApprovalRequestId);
    expect(taskOutcome.originalApprovalRequestId).toBe(first.approvalRequestId);
    expect(taskOutcome.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(objectValue(taskOutcome.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );

    const [revisionApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, revisionApprovalRequestId))
      .limit(1);
    const revisionRequestedAction = objectValue(revisionApproval?.requestedAction);
    const revisionPolicy = objectValue(revisionApproval?.policy);
    const revisionApprovalData = objectValue(revisionApproval?.data);

    expect(revisionApproval?.kind).toBe("quote_revision_approval");
    expect(revisionApproval?.state).toBe("pending");
    expect(revisionApproval?.workerRunId).toBe(continuation.workerRunId);
    expect(revisionRequestedAction.action).toBe("review_revised_packet");
    expect(revisionRequestedAction.externalSend).toBe(false);
    expect(revisionRequestedAction.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(revisionRequestedAction.revisedPacketDocumentId).toBe(revisedPacketDocumentId);
    expect(revisionRequestedAction.revisedEvidencePacketId).toBe(revisedEvidencePacketId);
    expect(revisionPolicy.revisionOfApprovalRequestId).toBe(first.approvalRequestId);
    expect(revisionApprovalData.originalApprovalRequestId).toBe(first.approvalRequestId);

    const [revisedEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, revisedPacketEvidenceId))
      .limit(1);
    const revisedEvidenceData = objectValue(revisedEvidence?.data);

    expect(revisedEvidence?.kind).toBe("draft");
    expect(revisedEvidenceData.externalExecution).toBe("blocked");
    expect(revisedEvidenceData.externalSend).toBe(false);
    expect(objectValue(revisedEvidenceData.revisedPacket).status).toBe(
      "revised_packet_ready_for_owner_approval",
    );

    const [revisedDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, revisedPacketDocumentId))
      .limit(1);
    const [revisedPacketRow] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, revisedEvidencePacketId))
      .limit(1);

    expect(revisedDocument?.state).toBe("prepared");
    expect(revisedPacketRow?.state).toBe("prepared");
    expect(revisedPacketRow?.documentId).toBe(revisedPacketDocumentId);

    const [originalWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const originalOutput = objectValue(objectValue(originalWorkerRun?.data).output);

    expect(objectValue(originalOutput.revisionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );
    expect(originalOutput.revisionApprovalRequestId).toBe(revisionApprovalRequestId);
    expect(originalOutput.revisedPacketEvidenceId).toBe(revisedPacketEvidenceId);
    expect(originalOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(adapterReceipt.externalSend).not.toBe(true);

    const replay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(continuation.workerRunId);
    expect(objectValue(replay.output).status).toBe("revised_packet_ready_for_owner_approval");
    expect(objectValue(replay.output).revisionApprovalRequestId).toBe(revisionApprovalRequestId);
  }, 120_000);

  it("continues rejected approval outcomes by closing the prepared action", async () => {
    const runId = randomUUID();
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const workerId = worker?.id ?? "";

    expect(workerId).toBeTruthy();

    const createdTask = await createCoreTask({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-rejected-task-${runId}`,
      title: "Rejected continuation quote task",
      state: "active",
      priority: "high",
      owner: {
        type: "worker",
        id: workerId,
        ref: `worker:${workerId}`,
      },
      db,
    });
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-rejected-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "rejection_test",
          sourceEventId: `rejection-test:${runId}`,
          customerName: "Rejected Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    expect(first.taskId).toBe(createdTask.taskId);

    const decision = await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-rejected-approval-${runId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "rejected",
      note: "Do not send this quote.",
      subject: "worker",
      db,
    });

    expect(decision.workflowRunState).toBe("rejected");
    expect(decision.taskState).toBe("blocked");

    const continuation = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-rejected-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });
    const output = objectValue(continuation.output);
    const rejectedPacket = objectValue(output.rejectedPacket);

    expect(continuation.created).toBe(true);
    expect(continuation.originalWorkerRunId).toBe(first.workerRunId);
    expect(continuation.workflowRunId).toBe(first.workflowRunId);
    expect(output.status).toBe("rejected_closed");
    expect(output.approvalRequestId).toBe(first.approvalRequestId);
    expect(output.nextAction).toBe("stop_prepared_action");
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);
    expect(output.requiresApproval).toBe(false);
    expect(output.rejectedPacketEvidenceId).toBeTruthy();
    expect(output.rejectedPacketDocumentId).toBeTruthy();
    expect(output.rejectedEvidencePacketId).toBeTruthy();
    expect(rejectedPacket.status).toBe("rejected_closed");
    expect(rejectedPacket.nextAction).toBe("stop_prepared_action");
    expect(rejectedPacket.externalExecution).toBe("blocked");
    expect(rejectedPacket.externalSend).toBe(false);

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, continuation.workflowRunId ?? ""))
      .limit(1);
    const workflowData = objectValue(workflowRun?.data);
    const workflowBlockers = objectValue(workflowRun?.blockers);
    const rejectionContinuation = objectValue(workflowData.rejectionContinuation);

    expect(workflowRun?.state).toBe("rejected");
    expect(workflowRun?.completedAt).toBeTruthy();
    expect(workflowBlockers.open).toEqual([]);
    expect(rejectionContinuation.workerRunId).toBe(continuation.workerRunId);
    expect(rejectionContinuation.action).toBe("rejected");
    expect(rejectionContinuation.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(workflowData.workflowStepIds).toContain(continuation.workflowStepId);

    const [continuationStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, continuation.workflowStepId ?? ""))
      .limit(1);
    const stepOutput = objectValue(continuationStep?.output);

    expect(continuationStep?.kind).toBe("worker_continuation");
    expect(continuationStep?.fromState).toBe("rejected");
    expect(continuationStep?.toState).toBe("rejected");
    expect(stepOutput.nextAction).toBe("stop_prepared_action");
    expect(stepOutput.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(stepOutput.externalExecution).toBe("blocked");
    expect(stepOutput.externalSend).toBe(false);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, continuation.taskId ?? ""))
      .limit(1);
    const taskOutcome = objectValue(task?.outcome);

    expect(task?.state).toBe("blocked");
    expect(taskOutcome.status).toBe("rejected_closed");
    expect(taskOutcome.approvalRequestId).toBe(first.approvalRequestId);
    expect(taskOutcome.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(objectValue(taskOutcome.rejectionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );

    const [rejectedEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, String(output.rejectedPacketEvidenceId ?? "")))
      .limit(1);
    const rejectedEvidenceData = objectValue(rejectedEvidence?.data);

    expect(rejectedEvidence?.kind).toBe("draft");
    expect(rejectedEvidenceData.externalExecution).toBe("blocked");
    expect(rejectedEvidenceData.externalSend).toBe(false);
    expect(objectValue(rejectedEvidenceData.rejectedPacket).status).toBe("rejected_closed");

    const [rejectedDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, String(output.rejectedPacketDocumentId ?? "")))
      .limit(1);
    const [rejectedPacketRow] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, String(output.rejectedEvidencePacketId ?? "")))
      .limit(1);

    expect(rejectedDocument?.state).toBe("closed");
    expect(rejectedPacketRow?.state).toBe("closed");
    expect(rejectedPacketRow?.documentId).toBe(output.rejectedPacketDocumentId);

    const [originalWorkerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const originalOutput = objectValue(objectValue(originalWorkerRun?.data).output);

    expect(objectValue(originalOutput.rejectionContinuation).workerRunId).toBe(
      continuation.workerRunId,
    );
    expect(originalOutput.rejectedPacketEvidenceId).toBe(output.rejectedPacketEvidenceId);
    expect(originalOutput.externalSend).toBe(false);

    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);
    const adapterReceipt = objectValue(adapterAction?.receipt);

    expect(adapterAction?.mode).toBe("dry_run");
    expect(objectValue(adapterReceipt.rejectionContinuation).externalExecution).toBe("blocked");
    expect(adapterReceipt.externalMutation).toBe(false);
    expect(adapterReceipt.externalSend).toBe(false);

    const replay = await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-rejected-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(continuation.workerRunId);
    expect(objectValue(replay.output).status).toBe("rejected_closed");
  }, 120_000);

  it("runs from persisted Core lead intake under config.intake", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:${runId}`,
      customerName: "Core Intake Roofing",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-event-${runId}`,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-lead-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead intake snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        ...leadPacket,
        raw: {
          formId: runId,
        },
      },
      db,
    });

    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-intake-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          objectId: objectResult.objectId,
          eventId: eventResult.eventId,
          evidenceId: evidenceResult.evidenceId,
        },
      },
    });
    const output = objectValue(first.output);
    const intake = objectValue(output.intake);

    expect(first.created).toBe(true);
    expect(output.source).toBe(leadPacket.source);
    expect(output.sourceEventId).toBe(leadPacket.sourceEventId);
    expect(output.sourceObjectId).toBe(objectResult.objectId);
    expect(output.sourceEventRowId).toBe(eventResult.eventId);
    expect(output.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(intake.mode).toBe("core_read");
    expect(intake.objectId).toBe(objectResult.objectId);
    expect(intake.eventId).toBe(eventResult.eventId);
    expect(intake.evidenceId).toBe(evidenceResult.evidenceId);
    expect(output.classification).toBe("quote_ready_for_owner_approval");
    expect(output.externalSend).toBe(false);

    const evalCase = revenueWorkerEvalCases.find((item) => item.id === "revenue.core_intake_refs.approval_blocked");
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      throw new Error("Missing core intake refs eval case.");
    }
    const scored = scoreRevenueWorkerRun(first, evalCase);
    expect(scored.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const runData = objectValue(workerRun?.data);
    const runInput = objectValue(runData.input);
    const resolvedConfig = objectValue(runInput.resolvedConfig);
    const resolvedLead = objectValue(resolvedConfig.leadPacket);

    expect(objectValue(runInput.config).intake).toEqual({
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      evidenceId: evidenceResult.evidenceId,
    });
    expect(resolvedLead.customerName).toBe(leadPacket.customerName);
    expect(resolvedLead.customerIntent).toBe(leadPacket.customerIntent);

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);
    const sourceLead = objectValue(sourceData.leadPacket);

    expect(sourceData.sourceObjectId).toBe(objectResult.objectId);
    expect(sourceData.sourceEventRowId).toBe(eventResult.eventId);
    expect(sourceData.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(sourceLead.customerName).toBe(leadPacket.customerName);

    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, first.approvalRequestId ?? ""))
      .limit(1);
    const requestedAction = objectValue(approval?.requestedAction);
    const approvalEvidence = objectValue(approval?.evidence);

    expect(approval?.state).toBe("pending");
    expect(requestedAction.externalSend).toBe(false);
    expect(requestedAction.sourceSnapshotEvidenceId).toBe(first.sourceSnapshotEvidenceId);
    expect(requestedAction.sourceObjectId).toBe(objectResult.objectId);
    expect(approvalEvidence.sourceEventRowId).toBe(eventResult.eventId);
    expect(approvalEvidence.sourceEvidenceId).toBe(evidenceResult.evidenceId);

    const replay = await runRevenueWorker({
      idempotencyKey: `ci-worker-intake-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          objectId: objectResult.objectId,
          eventId: eventResult.eventId,
          evidenceId: evidenceResult.evidenceId,
        },
      },
    });
    const replayOutput = objectValue(replay.output);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(first.workerRunId);
    expect(replayOutput.sourceEventRowId).toBe(eventResult.eventId);
    expect(objectValue(replayOutput.intake).evidenceId).toBe(evidenceResult.evidenceId);
  }, 120_000);

  it("runs from source-based lead intake under config.intake", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:source-lookup:${runId}`,
      customerName: "Source Lookup Roofing",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-source-lookup-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake source lookup integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: leadPacket.sourceEventId,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-source-lookup-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead source lookup snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: {
        leadPacket,
        source: leadPacket.source,
        sourceEventId: leadPacket.sourceEventId,
      },
      db,
    });

    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-source-lookup-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: {
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
        },
      },
    });
    const output = objectValue(first.output);
    const intake = objectValue(output.intake);

    expect(first.created).toBe(true);
    expect(output.source).toBe(leadPacket.source);
    expect(output.sourceEventId).toBe(leadPacket.sourceEventId);
    expect(output.sourceObjectId).toBe(objectResult.objectId);
    expect(output.sourceEventRowId).toBe(eventResult.eventId);
    expect(output.sourceEvidenceId).toBe(evidenceResult.evidenceId);
    expect(intake.mode).toBe("core_source_lookup");
    expect(intake.objectId).toBe(objectResult.objectId);
    expect(intake.eventId).toBe(eventResult.eventId);
    expect(intake.evidenceId).toBe(evidenceResult.evidenceId);
    expect(output.classification).toBe("quote_ready_for_owner_approval");
    expect(output.externalSend).toBe(false);

    const evalCase = revenueWorkerEvalCases.find(
      (item) => item.id === "revenue.source_intake_selector.approval_blocked",
    );
    expect(evalCase).toBeDefined();
    if (!evalCase) {
      throw new Error("Missing source intake selector eval case.");
    }
    const scored = scoreRevenueWorkerRun(first, evalCase);
    expect(scored.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
    expect(scored.passed).toBe(true);

    const [workerRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, first.workerRunId ?? ""))
      .limit(1);
    const runInput = objectValue(objectValue(workerRun?.data).input);

    expect(objectValue(runInput.config).intake).toEqual({
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
    });
    expect(objectValue(runInput.resolvedConfig).leadPacket).toMatchObject({
      customerName: leadPacket.customerName,
      customerIntent: leadPacket.customerIntent,
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
    });

    const [sourceSnapshot] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, first.sourceSnapshotEvidenceId ?? ""))
      .limit(1);
    const sourceData = objectValue(sourceSnapshot?.data);

    expect(sourceData.sourceObjectId).toBe(objectResult.objectId);
    expect(sourceData.sourceEventRowId).toBe(eventResult.eventId);
    expect(sourceData.sourceEvidenceId).toBe(evidenceResult.evidenceId);
  }, 120_000);

  it("reads inbound lead source records before running from the returned selector", async () => {
    const runId = randomUUID();
    const sourceEventId = `website_form:lead-read:${runId}`;
    const read = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-lead-read-${runId}`,
      config: {
        source: "website_form",
        records: [
          {
            sourceEventId,
            customerName: "Lead Read Roofing",
            customerIntent: "roof leak inspection",
            serviceArea: "roofing",
            urgency: "high",
            missingFacts: ["preferred_time_window"],
            payload: {
              formId: runId,
            },
          },
        ],
      },
    });
    const readResult = objectValue(read.result);
    const selectors = Array.isArray(readResult.selectors)
      ? readResult.selectors.map((selector) => objectValue(selector))
      : [];
    const selector = selectors[0] ?? {};

    expect(read.command).toBe("lead.read");
    expect(readResult.created).toBe(true);
    expect(readResult.readCount).toBe(1);
    expect(selector.source).toBe("website_form");
    expect(selector.sourceEventId).toBe(sourceEventId);
    expect(selector.objectId).toBeTruthy();
    expect(selector.eventId).toBeTruthy();
    expect(selector.evidenceId).toBeTruthy();
    expect(objectValue(selector.intake)).toEqual({
      source: "website_form",
      sourceEventId,
    });

    const replay = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-lead-read-${runId}`,
      config: {
        source: "website_form",
        records: [
          {
            sourceEventId,
            customerName: "Lead Read Roofing",
            customerIntent: "roof leak inspection",
            serviceArea: "roofing",
            urgency: "high",
            missingFacts: ["preferred_time_window"],
            payload: {
              formId: runId,
            },
          },
        ],
      },
    });

    expect(objectValue(replay.result).created).toBe(false);

    const classify = await executeWorkerCommand({
      command: "lead.classify",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-lead-classify-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const classifyResult = objectValue(classify.result);
    const classifyOutput = objectValue(classifyResult.output);

    expect(classify.command).toBe("lead.classify");
    expect(classifyResult.created).toBe(true);
    expect(classifyOutput.source).toBe("website_form");
    expect(classifyOutput.sourceEventId).toBe(sourceEventId);
    expect(classifyOutput.classification).toBe("quote_ready_for_owner_approval");
    expect(classifyOutput.externalExecution).toBe("blocked");
    expect(classifyOutput.externalSend).toBe(false);

    const draft = await executeWorkerCommand({
      command: "response.draft",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-response-draft-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const draftResult = objectValue(draft.result);
    const draftOutput = objectValue(draftResult.output);

    expect(draft.command).toBe("response.draft");
    expect(draftResult.created).toBe(true);
    expect(draftOutput.source).toBe("website_form");
    expect(draftOutput.sourceEventId).toBe(sourceEventId);
    expect(draftOutput.externalExecution).toBe("blocked");
    expect(draftOutput.externalSend).toBe(false);
    expect(objectValue(draftOutput.quote).policy).toMatchObject({
      approvalRequired: true,
      externalSend: false,
      moneyMovement: "blocked",
    });

    const [classifyRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(classifyResult.workerRunId)))
      .limit(1);
    const [classifyEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, stringValue(classifyResult.eventId)))
      .limit(1);
    const [classifyEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, stringValue(classifyResult.evidenceId)))
      .limit(1);
    const [classifyAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, stringValue(classifyResult.auditEventId)))
      .limit(1);
    const [classifyUsage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, stringValue(classifyResult.usageEventId)))
      .limit(1);

    expect(classifyRun?.mode).toBe("classification");
    expect(objectValue(objectValue(classifyRun?.data).input).command).toBe("lead.classify");
    expect(classifyEvent?.type).toBe("worker.revenue_operations.lead_classify.completed");
    expect(classifyEvidence?.kind).toBe("trace");
    expect(classifyAudit?.type).toBe("worker.revenue_operations.lead_classify.completed");
    expect(classifyUsage?.units).toBeGreaterThan(0);

    const [draftRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(draftResult.workerRunId)))
      .limit(1);
    const [draftEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, stringValue(draftResult.eventId)))
      .limit(1);
    const [draftEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, stringValue(draftResult.evidenceId)))
      .limit(1);
    const [draftAudit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, stringValue(draftResult.auditEventId)))
      .limit(1);
    const [draftUsage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, stringValue(draftResult.usageEventId)))
      .limit(1);

    expect(draftRun?.mode).toBe("draft");
    expect(objectValue(objectValue(draftRun?.data).input).command).toBe("response.draft");
    expect(draftEvent?.type).toBe("worker.revenue_operations.response_draft.completed");
    expect(draftEvidence?.kind).toBe("draft");
    expect(draftAudit?.type).toBe("worker.revenue_operations.response_draft.completed");
    expect(draftUsage?.units).toBeGreaterThan(0);

    const quote = await executeWorkerCommand({
      command: "quote.prepare",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-quote-prepare-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const quoteResult = objectValue(quote.result);
    const quoteOutput = objectValue(quoteResult.output);

    expect(quote.command).toBe("quote.prepare");
    expect(quoteResult.created).toBe(true);
    expect(quoteOutput.command).toBe("quote.prepare");
    expect(quoteOutput.source).toBe("website_form");
    expect(quoteOutput.sourceEventId).toBe(sourceEventId);
    expect(quoteOutput.externalExecution).toBe("blocked");
    expect(quoteOutput.externalSend).toBe(false);
    expect(objectValue(quoteOutput.quote).policy).toMatchObject({
      approvalRequired: true,
      externalSend: false,
      moneyMovement: "blocked",
    });

    const quoteReplay = await executeWorkerCommand({
      command: "quote.prepare",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-quote-prepare-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const quoteReplayResult = objectValue(quoteReplay.result);

    expect(quoteReplayResult.created).toBe(false);
    expect(stringValue(quoteReplayResult.workerRunId)).toBe(stringValue(quoteResult.workerRunId));

    const [quoteRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(quoteResult.workerRunId)))
      .limit(1);
    const [quoteEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, stringValue(quoteResult.eventId)))
      .limit(1);
    const [quoteApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stringValue(quoteResult.approvalRequestId)))
      .limit(1);
    const [quoteView] = await db
      .select()
      .from(generatedViews)
      .where(eq(generatedViews.id, stringValue(quoteResult.quoteApprovalViewId)))
      .limit(1);
    const [quoteAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, stringValue(quoteResult.adapterActionId)))
      .limit(1);
    const [quoteReceiptEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, stringValue(quoteResult.adapterReceiptEvidenceId)))
      .limit(1);

    expect(quoteRun?.mode).toBe("quote_preparation");
    expect(objectValue(objectValue(quoteRun?.data).input).command).toBe("quote.prepare");
    expect(quoteEvent?.type).toBe("worker.revenue_operations.quote_prepare.completed");
    expect(quoteApproval?.kind).toBe("quote_approval");
    expect(quoteApproval?.state).toBe("pending");
    expect(objectValue(quoteApproval?.requestedAction).command).toBe("quote.prepare");
    expect(quoteView?.key).toBe("quote.approval.review");
    expect(objectValue(objectValue(quoteView?.data).latest).command).toBe("quote.prepare");
    expect(quoteAction?.mode).toBe("dry_run");
    expect(quoteAction?.operation).toBe("draft_customer_response");
    expect(objectValue(quoteAction?.receipt).externalSend).toBe(false);
    expect(quoteReceiptEvidence?.kind).toBe("receipt");
    expect(objectValue(quoteReceiptEvidence?.data).externalMutation).toBe(false);

    const readiness = await executeWorkerView({
      view: "readiness",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
    });
    const readinessData = objectValue(readiness.data.readiness);
    const checks = Array.isArray(readinessData.checks)
      ? readinessData.checks.map((check) => objectValue(check))
      : [];
    const launchGates = Array.isArray(readinessData.launchGates)
      ? readinessData.launchGates.map((gate) => objectValue(gate))
      : [];
    const readinessProof = objectValue(readinessData.proof);

    expect(readiness.error).toBeNull();
    expect(readiness.data.view).toBe("readiness");
    expect(readinessData.status).toBe("ready");
    expect(readinessData.dryRunReady).toBe(true);
    expect(readinessData.launchStatus).toBe("blocked");
    expect(readinessData.launchReady).toBe(false);
    expect(checks.find((check) => check.key === "latest_dry_run_proof")?.state).toBe("ready");
    expect(checks.find((check) => check.key === "quote_approval_view")?.state).toBe("ready");
    expect(readinessProof.latestWorkerRunId).toBe(quoteResult.workerRunId);
    expect(readinessProof.quoteApprovalViewId).toBe(quoteResult.quoteApprovalViewId);
    expect(readinessProof.adapterReceiptEvidenceId).toBe(quoteResult.adapterReceiptEvidenceId);
    expect(launchGates.map((gate) => gate.key)).toEqual([
      "lead_source_connection",
      "lead_source_connection_health",
      "scheduler_lead_read_cursor",
      "controlled_customer_send_credentials",
      "controlled_send_receipt_and_rollback",
      "cash_and_payment_handoff_credentials",
    ]);
    expect(launchGates.some((gate) => gate.state === "blocked")).toBe(true);
    expect(launchGates.find((gate) => gate.key === "controlled_customer_send_credentials")?.state).toBe("blocked");
    expect(launchGates.find((gate) => gate.key === "controlled_send_receipt_and_rollback")?.state).toBe("blocked");
    expect(launchGates.find((gate) => gate.key === "cash_and_payment_handoff_credentials")?.state).toBe("blocked");

    const paymentLink = await executeWorkerCommand({
      command: "payment_link.prepare",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-payment-link-prepare-${runId}`,
      config: {
        invoiceObjectId: "33333333-3333-4333-8333-000000000006",
        sourceRefs: {
          quoteObjectId: "33333333-3333-4333-8333-000000000004",
        },
        policy: {
          requireOwnerApproval: true,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
      },
    });
    const paymentLinkResult = objectValue(paymentLink.result);
    const paymentLinkOutput = objectValue(paymentLinkResult.output);

    expect(paymentLink.command).toBe("payment_link.prepare");
    expect(paymentLinkResult.created).toBe(true);
    expect(paymentLinkOutput.command).toBe("payment_link.prepare");
    expect(paymentLinkOutput.invoiceId).toBe("44444444-4444-4444-8444-000000000006");
    expect(paymentLinkOutput.externalExecution).toBe("blocked");
    expect(paymentLinkOutput.providerPaymentLinkCreation).toBe("blocked");
    expect(paymentLinkOutput.moneyMovement).toBe("blocked");
    expect(paymentLinkOutput.externalMutation).toBe(false);
    expect(paymentLinkOutput.requiresApproval).toBe(true);

    const paymentLinkReplay = await executeWorkerCommand({
      command: "payment_link.prepare",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-payment-link-prepare-${runId}`,
      config: {
        invoiceObjectId: "33333333-3333-4333-8333-000000000006",
        sourceRefs: {
          quoteObjectId: "33333333-3333-4333-8333-000000000004",
        },
        policy: {
          requireOwnerApproval: true,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
      },
    });
    const paymentLinkReplayResult = objectValue(paymentLinkReplay.result);

    expect(paymentLinkReplayResult.created).toBe(false);
    expect(stringValue(paymentLinkReplayResult.workerRunId)).toBe(
      stringValue(paymentLinkResult.workerRunId),
    );

    const [paymentLinkRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(paymentLinkResult.workerRunId)))
      .limit(1);
    const [paymentLinkObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, stringValue(paymentLinkResult.paymentObjectId)))
      .limit(1);
    const [paymentLinkPayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, stringValue(paymentLinkResult.paymentId)))
      .limit(1);
    const [paymentLinkInstruction] = await db
      .select()
      .from(paymentInstructions)
      .where(eq(paymentInstructions.id, stringValue(paymentLinkResult.paymentInstructionId)))
      .limit(1);
    const [paymentLinkApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stringValue(paymentLinkResult.approvalRequestId)))
      .limit(1);
    const [paymentLinkPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, stringValue(paymentLinkResult.packetId)))
      .limit(1);
    const [paymentLinkView] = await db
      .select()
      .from(generatedViews)
      .where(eq(generatedViews.id, stringValue(paymentLinkResult.paymentReviewViewId)))
      .limit(1);
    const [paymentLinkReceipt] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, stringValue(paymentLinkResult.adapterReceiptEvidenceId)))
      .limit(1);

    expect(paymentLinkRun?.mode).toBe("payment_link_preparation");
    expect(objectValue(objectValue(paymentLinkRun?.data).input).command).toBe("payment_link.prepare");
    expect(paymentLinkObject?.type).toBe("payment");
    expect(paymentLinkObject?.state).toBe("approval_required");
    expect(paymentLinkPayment?.state).toBe("approval_required");
    expect(paymentLinkInstruction?.kind).toBe("revenue_payment_link");
    expect(paymentLinkApproval?.kind).toBe("payment_link_approval");
    expect(paymentLinkApproval?.state).toBe("pending");
    expect(paymentLinkPacket?.kind).toBe("revenue_payment_link_packet");
    expect(paymentLinkView?.key).toBe(`payment.approval.review.${paymentLinkResult.approvalRequestId}`);
    expect(objectValue(objectValue(paymentLinkView?.data).latest).approvalRequestId).toBe(
      paymentLinkResult.approvalRequestId,
    );
    expect(objectValue(objectValue(paymentLinkView?.data).latest).paymentInstructionId).toBe(
      paymentLinkResult.paymentInstructionId,
    );
    expect(paymentLinkReceipt?.kind).toBe("receipt");
    expect(objectValue(paymentLinkReceipt?.data).providerPaymentLinkCreation).toBe("blocked");

    const paymentReadiness = await executeWorkerView({
      view: "readiness",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
    });
    const paymentReadinessData = objectValue(paymentReadiness.data.readiness);
    const paymentReadinessChecks = Array.isArray(paymentReadinessData.checks)
      ? paymentReadinessData.checks.map((check) => objectValue(check))
      : [];
    const paymentReadinessProof = objectValue(paymentReadinessData.proof);

    expect(paymentReadiness.error).toBeNull();
    expect(paymentReadinessProof.latestWorkerRunId).toBe(paymentLinkResult.workerRunId);
    expect(paymentReadinessProof.latestWorkerRunMode).toBe("payment_link_preparation");
    expect(paymentReadinessProof.paymentReviewViewId).toBe(paymentLinkResult.paymentReviewViewId);
    expect(paymentReadinessProof.adapterReceiptEvidenceId).toBe(paymentLinkResult.adapterReceiptEvidenceId);
    expect(paymentReadinessChecks.find((check) => check.key === "payment_review_view")?.state).toBe("ready");

    const run = await runRevenueWorker({
      idempotencyKey: `ci-worker-run-from-lead-read-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const output = objectValue(run.output);
    const intake = objectValue(output.intake);

    expect(run.created).toBe(true);
    expect(output.source).toBe("website_form");
    expect(output.sourceEventId).toBe(sourceEventId);
    expect(output.sourceObjectId).toBe(selector.objectId);
    expect(output.sourceEventRowId).toBe(selector.eventId);
    expect(output.sourceEvidenceId).toBe(selector.evidenceId);
    expect(intake.mode).toBe("core_source_lookup");
    expect(output.externalSend).toBe(false);

    const [readRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringList([readResult.workerRunId])[0] ?? ""))
      .limit(1);
    const readRunData = objectValue(readRun?.data);

    expect(readRun?.mode).toBe("read_only");
    expect(objectValue(readRunData.input).command).toBe("lead.read");
    expect(objectValue(readRunData.output).readCount).toBe(1);
  }, 120_000);

  it("executes Revenue commands through the app-server worker command surface", async () => {
    const runId = randomUUID();
    const sourceEventId = `app-server:lead:${runId}`;
    const read = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "lead.read",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-app-server-lead-read-${runId}`,
      config: {
        source: "website_form",
        records: [
          {
            sourceEventId,
            customerName: "App Server Roofing",
            customerIntent: "roof leak inspection",
            serviceArea: "roofing",
            urgency: "high",
          },
        ],
      },
    });
    const readEnvelope = objectValue(read);
    const readResult = objectValue(readEnvelope.result);
    const selectors = Array.isArray(readResult.selectors)
      ? readResult.selectors.map((selector) => objectValue(selector))
      : [];
    const selector = selectors[0] ?? {};

    expect(readEnvelope.command).toBe("lead.read");
    expect(objectValue(readEnvelope.worker)).toMatchObject({
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    });
    expect(readResult.created).toBe(true);
    expect(selector.source).toBe("website_form");
    expect(selector.sourceEventId).toBe(sourceEventId);
    expect(selector.objectId).toBeTruthy();
    expect(selector.eventId).toBeTruthy();
    expect(selector.evidenceId).toBeTruthy();

    const run = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "run",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-app-server-worker-run-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const runEnvelope = objectValue(run);
    const runResult = objectValue(runEnvelope.result);
    const output = objectValue(runResult.output);

    expect(runEnvelope.command).toBe("run");
    expect(runResult.created).toBe(true);
    expect(output.source).toBe("website_form");
    expect(output.sourceEventId).toBe(sourceEventId);
    expect(output.sourceObjectId).toBe(selector.objectId);
    expect(output.sourceEventRowId).toBe(selector.eventId);
    expect(output.sourceEvidenceId).toBe(selector.evidenceId);
    expect(output.externalExecution).toBe("blocked");
    expect(output.externalSend).toBe(false);

    const quote = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "quote.prepare",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-app-server-quote-prepare-${runId}`,
      config: {
        intake: objectValue(selector.intake),
      },
    });
    const quoteEnvelope = objectValue(quote);
    const quoteResult = objectValue(quoteEnvelope.result);
    const quoteOutput = objectValue(quoteResult.output);

    expect(quoteEnvelope.command).toBe("quote.prepare");
    expect(quoteResult.created).toBe(true);
    expect(quoteOutput.command).toBe("quote.prepare");
    expect(quoteOutput.externalExecution).toBe("blocked");
    expect(quoteOutput.externalSend).toBe(false);

    const readiness = await executeAppServerWorkerTool("continuous.worker.view", {
      view: "readiness",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      config: {},
    });
    const readinessEnvelope = objectValue(readiness);
    const readinessPayload = objectValue(readinessEnvelope.readiness);
    const readinessWorker = objectValue(readinessEnvelope.worker);
    const readinessProof = objectValue(readinessPayload.proof);

    expect(readinessEnvelope.error).toBeNull();
    expect(readinessEnvelope.view).toBe("readiness");
    expect(readinessWorker.role).toBe("revenue_operations");
    expect(readinessPayload.status).toBe("ready");
    expect(readinessPayload.dryRunReady).toBe(true);
    expect(readinessProof.latestWorkerRunId).toBe(quoteResult.workerRunId);
    expect(readinessProof.quoteApprovalViewId).toBe(quoteResult.quoteApprovalViewId);
    expect(readinessProof.adapterReceiptEvidenceId).toBe(quoteResult.adapterReceiptEvidenceId);

    const paymentLink = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "payment_link.prepare",
      worker: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-app-server-payment-link-prepare-${runId}`,
      config: {
        invoiceObjectId: "33333333-3333-4333-8333-000000000006",
        sourceRefs: {
          quoteObjectId: "33333333-3333-4333-8333-000000000004",
        },
        policy: {
          requireOwnerApproval: true,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
      },
    });
    const paymentLinkEnvelope = objectValue(paymentLink);
    const paymentLinkResult = objectValue(paymentLinkEnvelope.result);
    const paymentLinkOutput = objectValue(paymentLinkResult.output);

    expect(paymentLinkEnvelope.command).toBe("payment_link.prepare");
    expect(objectValue(paymentLinkEnvelope.worker)).toMatchObject({
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    });
    expect(paymentLinkResult.created).toBe(true);
    expect(paymentLinkOutput.command).toBe("payment_link.prepare");
    expect(paymentLinkOutput.externalExecution).toBe("blocked");
    expect(paymentLinkOutput.providerPaymentLinkCreation).toBe("blocked");
    expect(paymentLinkOutput.moneyMovement).toBe("blocked");

    const [readRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(readResult.workerRunId)))
      .limit(1);
    const [runRow] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(runResult.workerRunId)))
      .limit(1);
    const [quoteRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(quoteResult.workerRunId)))
      .limit(1);
    const [quoteEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, stringValue(quoteResult.eventId)))
      .limit(1);
    const [paymentLinkRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, stringValue(paymentLinkResult.workerRunId)))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, stringValue(runResult.approvalRequestId)))
      .limit(1);

    expect(objectValue(objectValue(readRun?.data).input).command).toBe("lead.read");
    expect(runRow?.source).toBe("continuous.worker");
    expect(runRow?.state).toBe("done");
    expect(objectValue(objectValue(runRow?.data).input).inputHash).toBeTruthy();
    expect(quoteRun?.mode).toBe("quote_preparation");
    expect(objectValue(objectValue(quoteRun?.data).input).command).toBe("quote.prepare");
    expect(quoteEvent?.type).toBe("worker.revenue_operations.quote_prepare.completed");
    expect(paymentLinkRun?.mode).toBe("payment_link_preparation");
    expect(objectValue(objectValue(paymentLinkRun?.data).input).command).toBe("payment_link.prepare");
    expect(approval?.state).toBe("pending");
    expect(approval?.kind).toBe("quote_approval");
  }, 120_000);

  it("executes split Revenue action commands through the app-server worker command surface", async () => {
    for (const evalCase of revenueWorkerActionEvalCases) {
      const runId = randomUUID();
      const response = await executeAppServerWorkerTool("continuous.worker.command", {
        command: evalCase.command,
        worker: evalCase.worker,
        idempotencyKey: `${evalCase.idempotencyKey}-${runId}`,
        config: evalCase.config,
      });
      const responseEnvelope = objectValue(response);
      const result = responseEnvelope.result as Awaited<
        ReturnType<typeof import("./revenue").classifyRevenueLead>
      >;
      const score = scoreRevenueWorkerAction(result, evalCase);
      const [run] = await db
        .select()
        .from(workerRuns)
        .where(eq(workerRuns.id, result.workerRunId ?? ""))
        .limit(1);
      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, result.eventId ?? ""))
        .limit(1);
      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, result.auditEventId ?? ""))
        .limit(1);

      expect(responseEnvelope.command).toBe(evalCase.command);
      expect(objectValue(responseEnvelope.worker).role).toBe("revenue_operations");
      expect(score.dimensions.filter((dimension) => !dimension.passed)).toEqual([]);
      expect(score.passed).toBe(true);
      expect(score.score).toBeGreaterThanOrEqual(evalCase.expected.minScore);
      expect(run?.source).toBe("continuous.worker");
      expect(run?.mode).toBe(evalCase.expected.runMode);
      expect(run?.state).toBe(evalCase.expected.runState);
      expect(event?.type).toBe(`worker.revenue_operations.${evalCase.command.replace(".", "_")}.completed`);
      expect(audit?.type).toBe(event?.type);
    }
  }, 120_000);

  it("normalizes inbox and CRM source readers into persisted lead intake selectors", async () => {
    const runId = randomUUID();
    const inboxMessageId = `gmail:message:${runId}`;
    const inboxRead = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-inbox-read-${runId}`,
      config: {
        source: "google_workspace_inbox",
        reader: {
          kind: "inbox",
          provider: "google_workspace",
          credentialRef: "connection:google-workspace-demo",
          mode: "read_only",
        },
        records: [
          {
            messageId: inboxMessageId,
            threadId: `thread:${runId}`,
            from: "Northwind Buyer <buyer@example.com>",
            subject: "Need emergency roof leak inspection",
            snippet: "Water is coming through the ceiling after the storm.",
            receivedAt: "2026-05-19T02:00:00.000Z",
          },
        ],
      },
    });
    const inboxResult = objectValue(inboxRead.result);
    const inboxReader = objectValue(objectValue(inboxResult.output).sourceReader);
    const inboxSelector = objectValue(
      Array.isArray(inboxResult.selectors) ? inboxResult.selectors[0] : null,
    );

    expect(inboxResult.readCount).toBe(1);
    expect(inboxReader.kind).toBe("inbox");
    expect(inboxReader.authState).toBe("credential_ref_present");
    expect(inboxSelector.source).toBe("google_workspace_inbox");
    expect(inboxSelector.sourceEventId).toBe(inboxMessageId);

    const [inboxObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, stringList([inboxSelector.objectId])[0] ?? ""))
      .limit(1);
    const inboxLeadPacket = objectValue(objectValue(inboxObject?.data).leadPacket);

    expect(inboxObject?.source).toBe("google_workspace_inbox");
    expect(inboxLeadPacket.customerName).toBe("Northwind Buyer");
    expect(inboxLeadPacket.customerIntent).toBe("Need emergency roof leak inspection");
    expect(objectValue(inboxLeadPacket.sourceReader).kind).toBe("inbox");
    expect(objectValue(inboxLeadPacket.sourceRecord).messageId).toBe(inboxMessageId);

    await db
      .insert(adapters)
      .values({
        key: "google_workspace",
        name: "Google Workspace",
        kind: "inbox",
        auth: "oauth",
        capabilities: {
          read: ["lead.read"],
          sources: ["google_workspace_inbox"],
          providers: ["google_workspace"],
          readerKinds: ["inbox"],
        },
      })
      .onConflictDoUpdate({
        target: adapters.key,
        set: {
          name: "Google Workspace",
          kind: "inbox",
          capabilities: {
            read: ["lead.read"],
            sources: ["google_workspace_inbox"],
            providers: ["google_workspace"],
            readerKinds: ["inbox"],
          },
        },
      });
    const [googleAdapter] = await db
      .select({ id: adapters.id })
      .from(adapters)
      .where(eq(adapters.key, "google_workspace"))
      .limit(1);
    const [seedConnection] = await db.select({ tenantId: connections.tenantId }).from(connections).limit(1);
    const [connection] = await db
      .insert(connections)
      .values({
        tenantId: seedConnection.tenantId,
        adapterId: googleAdapter.id,
        name: `Google Workspace buffer ${runId}`,
        state: "active",
        externalAccountId: `google-workspace-demo-${runId}`,
        scopes: { reads: ["lead"] },
        config: {
          executable: false,
          sources: ["google_workspace_inbox"],
          providers: ["google_workspace"],
          readerKinds: ["inbox"],
          polling: {
            enabled: true,
            mode: "connection_buffer",
            source: "google_workspace_inbox",
            provider: "google_workspace",
          },
        },
      })
      .returning();
    const bufferedMessageId = `gmail:buffered:${runId}`;

    await db
      .update(connections)
      .set({
        config: {
          executable: false,
          sources: ["google_workspace_inbox"],
          providers: ["google_workspace"],
          readerKinds: ["inbox"],
          polling: {
            enabled: true,
            mode: "connection_buffer",
            source: "google_workspace_inbox",
            provider: "google_workspace",
          },
          inbox: {
            messages: [
              {
                messageId: bufferedMessageId,
                threadId: `thread:buffered:${runId}`,
                from: "Buffered Buyer <buffered@example.com>",
                subject: "Need gutter repair estimate",
                snippet: "The gutter pulled away during the last storm.",
                receivedAt: "2026-05-19T04:00:00.000Z",
              },
            ],
          },
        },
      })
      .where(eq(connections.id, connection.id));

    const bufferedRead = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-connection-buffer-read-${runId}`,
      config: {
        source: "google_workspace_inbox",
        reader: {
          kind: "inbox",
          provider: "google_workspace",
          credentialRef: `connection:${connection.id}`,
          mode: "read_only",
        },
      },
    });
    const bufferedResult = objectValue(bufferedRead.result);
    const bufferedOutput = objectValue(bufferedResult.output);
    const bufferedReader = objectValue(bufferedOutput.sourceReader);
    const bufferedSelector = objectValue(
      Array.isArray(bufferedResult.selectors) ? bufferedResult.selectors[0] : null,
    );
    const [updatedConnection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connection.id))
      .limit(1);
    const lastLeadRead = objectValue(objectValue(updatedConnection?.config).lastLeadRead);

    expect(bufferedRead.command).toBe("lead.read");
    expect(bufferedResult.readCount).toBe(1);
    expect(bufferedReader.sourceMode).toBe("connection_buffer");
    expect(bufferedReader.connectionId).toBe(connection.id);
    expect(bufferedSelector.sourceEventId).toBe(bufferedMessageId);
    expect(bufferedOutput.connectionId).toBe(connection.id);
    expect(bufferedOutput.cursor).toBe(bufferedMessageId);
    expect(updatedConnection?.lastSyncAt).toBeTruthy();
    expect(lastLeadRead).toMatchObject({
      command: "lead.read",
      workerRunId: bufferedResult.workerRunId,
      readCount: 1,
      cursor: bufferedMessageId,
      schedulerProof: null,
      externalExecution: "blocked",
    });

    const readinessHealth = await recordCoreConnectionHealth({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-buffered-readiness-health-${runId}`,
      connectionId: connection.id,
      env: {},
      db,
    });
    const launchReadiness = await executeWorkerView({
      view: "readiness",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
    });
    const launchReadinessData = objectValue(launchReadiness.data.readiness);
    const launchGates = Array.isArray(launchReadinessData.launchGates)
      ? launchReadinessData.launchGates.map((gate) => objectValue(gate))
      : [];

    expect(readinessHealth.status).toBe("needs_configuration");
    expect(launchReadinessData.status).toBe("ready");
    expect(launchReadinessData.dryRunReady).toBe(true);
    expect(launchReadinessData.launchStatus).toBe("blocked");
    expect(launchReadinessData.launchReady).toBe(false);
    expect(launchGates.find((gate) => gate.key === "lead_source_connection")?.state).toBe("ready");
    expect(launchGates.find((gate) => gate.key === "lead_source_connection_health")?.state).toBe("ready");
    expect(launchGates.find((gate) => gate.key === "scheduler_lead_read_cursor")?.state).toBe("blocked");
    expect(launchGates.find((gate) => gate.key === "controlled_customer_send_credentials")?.state).toBe("blocked");
    expect(JSON.stringify(launchReadinessData)).not.toContain("configured-fixture");

    const schedulerMessageId = `gmail:scheduler:${runId}`;
    await db
      .update(connections)
      .set({
        config: {
          ...objectValue(updatedConnection?.config),
          inbox: {
            messages: [
              {
                messageId: bufferedMessageId,
                threadId: `thread:buffered:${runId}`,
                from: "Buffered Buyer <buffered@example.com>",
                subject: "Need gutter repair estimate",
                snippet: "The gutter pulled away during the last storm.",
                receivedAt: "2026-05-19T04:00:00.000Z",
              },
              {
                messageId: schedulerMessageId,
                threadId: `thread:scheduler:${runId}`,
                from: "Scheduler Buyer <scheduler@example.com>",
                subject: "Need fascia repair estimate",
                snippet: "The fascia board needs repair before more rain.",
                receivedAt: "2026-05-19T04:10:00.000Z",
              },
            ],
          },
        },
      })
      .where(eq(connections.id, connection.id));

    const schedulerIdempotencyKey = `scheduler-lead-read:${connection.id}:${runId}`;
    const schedulerRead = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: schedulerIdempotencyKey,
      config: {
        source: "google_workspace_inbox",
        reader: {
          kind: "inbox",
          provider: "google_workspace",
          credentialRef: `connection:${connection.id}`,
          mode: "read_only",
        },
        scheduler: {
          source: "continuous.worker_scheduler",
          leaseOwner: "integration-test-scheduler",
          connectionId: connection.id,
          leadPollIdempotencyKey: schedulerIdempotencyKey,
        },
      },
    });
    const schedulerResult = objectValue(schedulerRead.result);
    const schedulerOutput = objectValue(schedulerResult.output);
    const schedulerProof = objectValue(schedulerOutput.schedulerProof);
    const [schedulerUpdatedConnection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connection.id))
      .limit(1);
    const schedulerLastLeadRead = objectValue(objectValue(schedulerUpdatedConnection?.config).lastLeadRead);
    const storedSchedulerProof = objectValue(schedulerLastLeadRead.schedulerProof);
    const schedulerReadinessHealth = await recordCoreConnectionHealth({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-worker-scheduler-readiness-health-${runId}`,
      connectionId: connection.id,
      env: {},
      db,
    });
    const schedulerReadiness = await executeWorkerView({
      view: "readiness",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
    });
    const schedulerReadinessData = objectValue(schedulerReadiness.data.readiness);
    const schedulerLaunchGates = Array.isArray(schedulerReadinessData.launchGates)
      ? schedulerReadinessData.launchGates.map((gate) => objectValue(gate))
      : [];

    expect(schedulerResult.readCount).toBe(1);
    expect(schedulerOutput.cursor).toBe(schedulerMessageId);
    expect(schedulerProof).toMatchObject({
      state: "verified",
      source: "continuous.worker_scheduler",
      leaseOwner: "integration-test-scheduler",
      connectionId: connection.id,
      leadPollIdempotencyKey: schedulerIdempotencyKey,
    });
    expect(schedulerLastLeadRead).toMatchObject({
      command: "lead.read",
      workerRunId: schedulerResult.workerRunId,
      readCount: 1,
      cursor: schedulerMessageId,
    });
    expect(storedSchedulerProof).toMatchObject({
      state: "verified",
      source: "continuous.worker_scheduler",
      connectionId: connection.id,
      leadPollIdempotencyKey: schedulerIdempotencyKey,
    });
    expect(schedulerReadinessHealth.status).toBe("ready");
    expect(schedulerLaunchGates.find((gate) => gate.key === "lead_source_connection_health")?.state).toBe("ready");
    expect(schedulerLaunchGates.find((gate) => gate.key === "scheduler_lead_read_cursor")?.state).toBe("ready");

    await expect(
      executeWorkerCommand({
        command: "lead.read",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: `ci-worker-connection-buffer-reread-${runId}`,
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
            credentialRef: `connection:${connection.id}`,
            mode: "read_only",
          },
        },
      }),
    ).rejects.toThrow("no unread buffered lead source records");

    await expect(
      executeWorkerCommand({
        command: "lead.read",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: `ci-worker-connection-buffer-mismatch-${runId}`,
        config: {
          source: "hubspot_crm",
          reader: {
            kind: "crm",
            provider: "hubspot",
            credentialRef: `connection:${connection.id}`,
            mode: "read_only",
          },
        },
      }),
    ).rejects.toThrow("not compatible with the requested lead source");

    const liveMessageId = `gmail:live:${runId}`;
    const previousToken = process.env.CONTINUOUS_TEST_GOOGLE_TOKEN;
    process.env.CONTINUOUS_TEST_GOOGLE_TOKEN = "ci-google-token";
    let apiHitCount = 0;
    const apiServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer ci-google-token") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      apiHitCount += 1;

      if (url.pathname === "/gmail/v1/users/me/messages") {
        response.end(
          JSON.stringify({
            messages: [{ id: liveMessageId, threadId: `thread:live:${runId}` }],
          }),
        );
        return;
      }

      if (url.pathname === `/gmail/v1/users/me/messages/${encodeURIComponent(liveMessageId)}`) {
        response.end(
          JSON.stringify({
            id: liveMessageId,
            threadId: `thread:live:${runId}`,
            internalDate: String(Date.parse("2026-05-19T05:00:00.000Z")),
            snippet: "Can you look at a roof leak this week?",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "Live Buyer <live@example.com>" },
                { name: "Subject", value: "Roof leak this week" },
                { name: "Date", value: "Tue, 19 May 2026 05:00:00 GMT" },
              ],
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    });
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));

    try {
      const address = apiServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Gmail test server did not expose a TCP address.");
      }

      const [liveConnection] = await db
        .insert(connections)
        .values({
          tenantId: seedConnection.tenantId,
          adapterId: googleAdapter.id,
          name: `Google Workspace API poll ${runId}`,
          state: "active",
          externalAccountId: `google-workspace-api-${runId}`,
          scopes: { reads: ["lead"] },
          config: {
            executable: false,
            sources: ["google_workspace_inbox"],
            providers: ["google_workspace"],
            readerKinds: ["inbox"],
            polling: {
              enabled: true,
              provider: "google_workspace",
              endpointBase: `http://127.0.0.1:${address.port}/gmail/v1`,
              credentialRef: "env:CONTINUOUS_TEST_GOOGLE_TOKEN",
              maxResults: 1,
            },
          },
        })
        .returning();
      const liveRead = await executeWorkerCommand({
        command: "lead.read",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: `ci-worker-connection-api-read-${runId}`,
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
            credentialRef: `connection:${liveConnection.id}`,
            mode: "read_only",
          },
        },
      });
      const liveResult = objectValue(liveRead.result);
      const liveOutput = objectValue(liveResult.output);
      const liveReader = objectValue(liveOutput.sourceReader);
      const liveReceipt = objectValue(liveOutput.pollingReceipt);
      const liveSelector = objectValue(Array.isArray(liveResult.selectors) ? liveResult.selectors[0] : null);
      const [updatedLiveConnection] = await db
        .select()
        .from(connections)
        .where(eq(connections.id, liveConnection.id))
        .limit(1);
      const liveLastRead = objectValue(objectValue(updatedLiveConnection?.config).lastLeadRead);

      expect(liveResult.readCount).toBe(1);
      expect(liveReader.sourceMode).toBe("connection_api");
      expect(liveOutput.connectionId).toBe(liveConnection.id);
      expect(liveOutput.cursor).toBe(liveMessageId);
      expect(liveSelector.sourceEventId).toBe(liveMessageId);
      expect(liveReceipt).toMatchObject({
        provider: "google_workspace",
        api: "gmail",
        credentialRef: "env:CONTINUOUS_TEST_GOOGLE_TOKEN",
        returned: 1,
        externalSend: false,
      });
      expect(JSON.stringify(liveOutput)).not.toContain("ci-google-token");
      expect(liveLastRead).toMatchObject({
        sourceMode: "connection_api",
        cursor: liveMessageId,
        externalExecution: "blocked",
      });

      const apiHitsAfterFirstRead = apiHitCount;
      const liveReplay = await executeWorkerCommand({
        command: "lead.read",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: `ci-worker-connection-api-read-${runId}`,
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
            credentialRef: `connection:${liveConnection.id}`,
            mode: "read_only",
          },
        },
      });

      expect(objectValue(liveReplay.result).created).toBe(false);
      expect(apiHitCount).toBe(apiHitsAfterFirstRead);

      await expect(
        executeWorkerCommand({
          command: "lead.read",
          target: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          operatorEmail: "owner@continuoushq.com",
          idempotencyKey: `ci-worker-connection-api-read-${runId}`,
          config: {
            source: "google_workspace_inbox",
            reader: {
              kind: "inbox",
              provider: "google_workspace",
              credentialRef: `connection:${liveConnection.id}`,
              mode: "snapshot",
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "worker_idempotency_conflict",
        status: 409,
      });
      expect(apiHitCount).toBe(apiHitsAfterFirstRead);
    } finally {
      await new Promise<void>((resolve, reject) => {
        apiServer.close((error) => (error ? reject(error) : resolve()));
      });
      if (previousToken === undefined) {
        delete process.env.CONTINUOUS_TEST_GOOGLE_TOKEN;
      } else {
        process.env.CONTINUOUS_TEST_GOOGLE_TOKEN = previousToken;
      }
    }

    const inboxRun = await runRevenueWorker({
      idempotencyKey: `ci-worker-run-from-inbox-read-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        intake: objectValue(inboxSelector.intake),
      },
    });
    const inboxOutput = objectValue(inboxRun.output);

    expect(inboxOutput.source).toBe("google_workspace_inbox");
    expect(inboxOutput.sourceEventId).toBe(inboxMessageId);
    expect(inboxOutput.externalSend).toBe(false);

    const crmExternalId = `hubspot:deal:${runId}`;
    const crmRead = await executeWorkerCommand({
      command: "lead.read",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-worker-crm-read-${runId}`,
      config: {
        source: "hubspot_crm",
        reader: {
          kind: "crm",
          provider: "hubspot",
          credentialRef: "connection:hubspot-demo",
          mode: "read_only",
        },
        records: [
          {
            externalId: crmExternalId,
            companyName: "CRM Expansion Co",
            contactName: "Casey Buyer",
            dealName: "Window replacement quote",
            stage: "qualified",
            serviceArea: "windows",
            updatedAt: "2026-05-19T03:00:00.000Z",
          },
        ],
      },
    });
    const crmResult = objectValue(crmRead.result);
    const crmReader = objectValue(objectValue(crmResult.output).sourceReader);
    const crmSelector = objectValue(Array.isArray(crmResult.selectors) ? crmResult.selectors[0] : null);
    const [crmEvidence] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.id, stringList([crmSelector.evidenceId])[0] ?? ""))
      .limit(1);
    const crmEvidenceData = objectValue(crmEvidence?.data);
    const crmLeadPacket = objectValue(crmEvidenceData.leadPacket);

    expect(crmResult.readCount).toBe(1);
    expect(crmReader.kind).toBe("crm");
    expect(crmReader.authState).toBe("credential_ref_present");
    expect(crmSelector.source).toBe("hubspot_crm");
    expect(crmSelector.sourceEventId).toBe(crmExternalId);
    expect(crmLeadPacket.customerName).toBe("Casey Buyer");
    expect(crmLeadPacket.customerIntent).toBe("Window replacement quote");
    expect(objectValue(crmLeadPacket.sourceReader).kind).toBe("crm");
    expect(objectValue(crmLeadPacket.sourceRecord).externalId).toBe(crmExternalId);
    expect(crmEvidenceData.externalSend).toBe(false);
  }, 120_000);

  it("rejects mixed persisted intake and direct lead payloads through the worker registry", async () => {
    const runId = randomUUID();
    const leadPacket = {
      source: "website_form",
      sourceEventId: `website_form:${runId}`,
      customerName: "Core Intake Authority",
      customerIntent: "roof leak inspection",
      serviceArea: "roofing",
      urgency: "high",
      missingFacts: ["preferred_time_window"],
    };
    const objectResult = await upsertCoreObject({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-object-${runId}`,
      type: "lead",
      name: leadPacket.customerName,
      state: "received",
      source: leadPacket.source,
      externalId: leadPacket.sourceEventId,
      data: leadPacket,
      reason: "Core lead intake conflict integration test",
      db,
    });
    const eventResult = await ingestCoreEvent({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-event-${runId}`,
      type: "lead.received",
      source: leadPacket.source,
      objectId: objectResult.objectId,
      data: leadPacket,
      db,
    });
    const evidenceResult = await attachCoreEvidence({
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      idempotencyKey: `ci-conflict-lead-evidence-${runId}`,
      kind: "snapshot",
      name: "Core lead intake authority snapshot",
      objectId: objectResult.objectId,
      eventId: eventResult.eventId,
      data: leadPacket,
      db,
    });
    const idempotencyKey = `ci-worker-intake-conflict-${runId}`;

    await expect(
      executeWorkerCommand({
        command: "run",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey,
        config: {
          intake: {
            objectId: objectResult.objectId,
            eventId: eventResult.eventId,
            evidenceId: evidenceResult.evidenceId,
          },
          leadPacket: {
            source: "manual_override",
            sourceEventId: `manual_override:${runId}`,
            customerName: "Conflicting Payload",
            customerIntent: "discounted window replacement",
            serviceArea: "windows",
            urgency: "low",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "worker_intake_conflict",
      status: 400,
    });

    const [workerRunCount] = await db
      .select({ count: count() })
      .from(workerRuns)
      .where(eq(workerRuns.idempotencyKey, idempotencyKey));

    expect(workerRunCount.count).toBe(0);
  }, 120_000);

  it("rejects empty Revenue run, classify, and draft configs before synthetic lead defaults", async () => {
    const runId = randomUUID();

    await expect(
      runRevenueWorker({
        idempotencyKey: `ci-worker-empty-run-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {},
      }),
    ).rejects.toMatchObject({
      code: "worker_intake_required",
      status: 400,
    });

    await expect(
      classifyRevenueLead({
        idempotencyKey: `ci-worker-empty-classify-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {},
      }),
    ).rejects.toMatchObject({
      code: "worker_intake_required",
      status: 400,
    });

    await expect(
      draftRevenueResponse({
        idempotencyKey: `ci-worker-empty-draft-${runId}`,
        tenantSlug: "continuous-demo",
        operatorEmail: "owner@continuoushq.com",
        config: {},
      }),
    ).rejects.toMatchObject({
      code: "worker_intake_required",
      status: 400,
    });

    const [matchingRuns] = await db
      .select({ value: count() })
      .from(workerRuns)
      .where(sql`${workerRuns.idempotencyKey} like ${`ci-worker-empty-%-${runId}`}`);

    expect(matchingRuns.value).toBe(0);
  }, 120_000);

  it("applies budget capacity guardrails to split Revenue commands", async () => {
    const runId = randomUUID();
    const [revenueWorker] = await db
      .select({ id: workers.id, tenantId: workers.tenantId })
      .from(workers)
      .where(eq(workers.role, "revenue_operations"))
      .limit(1);
    const [budgetAccount] = await db
      .select({ id: budgetAccounts.id })
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, revenueWorker?.id ?? ""),
          eq(budgetAccounts.active, true),
        ),
      )
      .limit(1);

    expect(budgetAccount?.id).toBeTruthy();

    const [held] = await db
      .insert(budgetReservations)
      .values({
        tenantId: revenueWorker?.tenantId ?? "",
        accountId: budgetAccount?.id ?? "",
        units: 10_000_000,
        state: "held",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: budgetReservations.id });

    try {
      await expect(
        classifyRevenueLead({
          idempotencyKey: `ci-worker-budget-classify-${runId}`,
          tenantSlug: "continuous-demo",
          operatorEmail: "owner@continuoushq.com",
          config: {
            leadPacket: {
              source: "website_form",
              sourceEventId: `budget-classify:${runId}`,
              customerName: "Budget Guard Electric",
              customerIntent: "panel inspection",
              serviceArea: "electrical",
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "worker_budget_exceeded",
      });
    } finally {
      await db.delete(budgetReservations).where(eq(budgetReservations.id, held.id));
    }
  }, 120_000);

  it("keeps first-pass adapter reconciliation from advancing Revenue workflows past approval", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-adapter-first-pass-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "adapter_first_pass_test",
          sourceEventId: `adapter-first-pass-test:${runId}`,
          customerName: "Adapter First Pass Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "medium",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    await db
      .update(adapterRuns)
      .set({
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        data: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        error: {},
      })
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""));
    await db
      .update(adapterActions)
      .set({
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        request: {
          workflowRunId: first.workflowRunId,
          externalSend: false,
        },
        response: {
          status: "prepared",
        },
        receipt: {
          workflowRunId: first.workflowRunId,
          externalMutation: false,
          externalSend: false,
        },
        error: {},
      })
      .where(eq(adapterActions.id, first.adapterActionId ?? ""));

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T00:45:00.000Z"),
      db,
    });

    const [workflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const reconciliationSteps = await db
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.workflowRunId, first.workflowRunId ?? ""),
          eq(workflowSteps.kind, "adapter_reconciliation"),
        ),
      );

    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(workflowRun?.state).toBe("approval_requested");
    expect(reconciliationSteps).toHaveLength(0);
  }, 120_000);

  it("moves Revenue workflows through adapter retry and post-retry reconciliation states", async () => {
    const runId = randomUUID();
    const first = await runRevenueWorker({
      idempotencyKey: `ci-worker-adapter-workflow-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      config: {
        leadPacket: {
          source: "adapter_workflow_test",
          sourceEventId: `adapter-workflow-test:${runId}`,
          customerName: "Adapter Workflow Roofing",
          customerIntent: "roof leak inspection",
          serviceArea: "roofing",
          urgency: "high",
          missingFacts: ["preferred_time_window"],
        },
      },
      db,
    });

    await decideApproval({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-adapter-workflow-approval-${runId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Approve before adapter workflow retry smoke.",
      subject: "worker",
      db,
    });
    await continueRevenueWorker({
      approvalId: first.approvalRequestId ?? "",
      idempotencyKey: `ci-worker-adapter-workflow-continue-${runId}`,
      tenantSlug: "continuous-demo",
      operatorEmail: "owner@continuoushq.com",
      db,
    });

    const [executionWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);

    expect(executionWorkflowRun?.state).toBe("execution_blocked");

    const [adapterRun] = await db
      .select()
      .from(adapterRuns)
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""))
      .limit(1);
    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, first.adapterActionId ?? ""))
      .limit(1);

    expect(adapterRun).toBeTruthy();
    expect(adapterAction).toBeTruthy();

    await db
      .update(adapterRuns)
      .set({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          ...objectValue(adapterRun?.receipt),
          externalMutation: false,
          externalSend: false,
        },
        error: {
          code: "adapter_timeout",
        },
        endedAt: null,
      })
      .where(eq(adapterRuns.id, first.adapterRunId ?? ""));
    await db
      .update(adapterActions)
      .set({
        state: "failed",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        nextAttemptAt: null,
        receipt: {
          ...objectValue(adapterAction?.receipt),
          externalMutation: false,
          externalSend: false,
        },
        error: {
          code: "adapter_timeout",
        },
      })
      .where(eq(adapterActions.id, first.adapterActionId ?? ""));

    const retrySchedule = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T01:00:00.000Z"),
      db,
    });

    expect(retrySchedule.retryScheduled).toBeGreaterThanOrEqual(2);
    expect(retrySchedule.workflowStepIds.length).toBeGreaterThanOrEqual(2);

    const [retryWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const retryWorkflowData = objectValue(retryWorkflowRun?.data);
    const retryBlockers = objectValue(retryWorkflowRun?.blockers);
    const retrySteps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, retrySchedule.workflowStepIds));

    expect(retryWorkflowRun?.state).toBe("adapter_retry_scheduled");
    expect(retryBlockers.open).toEqual(["adapter_retry_pending", "external_execution_blocked"]);
    expect(objectValue(retryWorkflowData.lastAdapterReconciliation).decision).toBe(
      "retry_scheduled",
    );
    expect(retrySteps.filter((step) => step.workflowRunId === first.workflowRunId)).toHaveLength(2);
    expect(
      retrySteps
        .filter((step) => step.workflowRunId === first.workflowRunId)
        .every((step) => step.kind === "adapter_reconciliation" && step.toState === "adapter_retry_scheduled"),
    ).toBe(true);

    const retryExecution = await executeWorkerCommand({
      command: "adapters.retry",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      config: {
        limit: 100,
      },
    });
    const retryOutput = objectValue(retryExecution.result);

    expect(stringList(retryOutput.retryRunIds)).toContain(first.adapterRunId);
    expect(stringList(retryOutput.retryActionIds)).toContain(first.adapterActionId);
    expect(retryOutput.liveCredentialChecks).toBeGreaterThanOrEqual(2);
    expect(retryOutput.rollbackPlans).toBeGreaterThanOrEqual(2);
    expect(retryOutput.blockedLiveExecutions).toBeGreaterThanOrEqual(2);

    const postRetry = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 100,
      now: new Date("2026-05-19T01:10:00.000Z"),
      db,
    });

    expect(postRetry.matched).toBeGreaterThanOrEqual(2);
    expect(postRetry.workflowStepIds.length).toBeGreaterThanOrEqual(2);

    const [postRetryWorkflowRun] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, first.workflowRunId ?? ""))
      .limit(1);
    const postRetryWorkflowData = objectValue(postRetryWorkflowRun?.data);
    const postRetryBlockers = objectValue(postRetryWorkflowRun?.blockers);
    const postRetrySteps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.id, postRetry.workflowStepIds));

    expect(postRetryWorkflowRun?.state).toBe("post_retry_reconciled");
    expect(postRetryBlockers.open).toEqual([
      "external_execution_blocked",
      "scoped_live_credentials_required",
    ]);
    expect(objectValue(postRetryWorkflowData.lastAdapterReconciliation).decision).toBe("matched");
    expect(
      postRetrySteps
        .filter((step) => step.workflowRunId === first.workflowRunId)
        .every((step) => step.kind === "adapter_reconciliation" && step.toState === "post_retry_reconciled"),
    ).toBe(true);
  }, 120_000);

  it("reconciles pending dry-run adapter rows without external execution", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-reconcile-${runId}`;
    const now = new Date("2026-05-19T00:00:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_reconciliation_check",
      idempotencyKey: `${key}:run`,
      state: "running",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {},
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "done",
      mode: "dry_run",
      operation: "ci_reconciliation_check",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      response: {
        status: "prepared",
      },
      receipt: {
        externalMutation: false,
      },
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 10,
      now,
      db,
    });

    expect(result.processed).toBeGreaterThanOrEqual(2);
    expect(result.matched).toBeGreaterThanOrEqual(2);
    expect(result.retryScheduled).toBe(0);
    expect(result.needsReview).toBe(0);

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);

    expect(run?.state).toBe("done");
    expect(run?.reconciliationState).toBe("matched");
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("done");
    expect(action?.reconciliationState).toBe("matched");
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(inArray(auditEvents.id, result.auditEventIds));
    const [evidenceCount] = await db
      .select({ value: count() })
      .from(evidence)
      .where(inArray(evidence.id, result.evidenceIds));

    expect(auditCount.value).toBe(result.auditEventIds.length);
    expect(evidenceCount.value).toBe(result.evidenceIds.length);
  }, 120_000);

  it("creates retry tasks for failed adapter rows that still have attempts remaining", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-retry-${runId}`;
    const createdAt = new Date("2000-01-01T00:00:00.000Z");
    const now = new Date("2026-05-19T00:00:00.000Z");
    const nextAttemptAt = new Date("2026-05-19T00:05:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_retry_check",
      idempotencyKey: `${key}:run`,
      state: "failed",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "adapter_timeout",
      },
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
      createdAt,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "failed",
      mode: "dry_run",
      operation: "ci_retry_check",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "adapter_timeout",
      },
      createdAt,
      updatedAt: createdAt,
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now,
      db,
    });

    expect(result.processed).toBe(2);
    expect(result.retryScheduled).toBe(2);
    expect(result.needsReview).toBe(0);
    expect(result.retryTaskIds).toHaveLength(2);
    expect(result.reviewTaskIds).toHaveLength(0);
    expect(result.taskIds).toEqual(expect.arrayContaining(result.retryTaskIds));

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const retryTasks = await db.select().from(tasks).where(inArray(tasks.id, result.retryTaskIds));
    const retryEvents = await db.select().from(events).where(inArray(events.taskId, result.retryTaskIds));
    const retryEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.taskId, result.retryTaskIds));

    expect(run?.state).toBe("queued");
    expect(run?.attempt).toBe(2);
    expect(run?.reconciliationState).toBe("retry_scheduled");
    expect(run?.nextAttemptAt?.toISOString()).toBe(nextAttemptAt.toISOString());
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("queued");
    expect(action?.attempt).toBe(2);
    expect(action?.reconciliationState).toBe("retry_scheduled");
    expect(action?.nextAttemptAt?.toISOString()).toBe(nextAttemptAt.toISOString());
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    expect(retryTasks).toHaveLength(2);
    for (const task of retryTasks) {
      expect(task.state).toBe("waiting");
      expect(task.priority).toBe("normal");
      expect(task.ownerType).toBe("system");
      expect(task.ownerRef).toBe("system:adapter-reconciliation");
      expect(task.dueAt?.toISOString()).toBe(nextAttemptAt.toISOString());
      expect(objectValue(task.outcome).decision).toBe("retry_scheduled");
      expect(objectValue(task.outcome).externalExecution).toBe("blocked");
      expect(objectValue(task.outcome).executable).toBe(false);
      expect(objectValue(objectValue(task.outcome).liveCredentialCheck).state).toBe("blocked");
      expect(objectValue(objectValue(task.outcome).rollbackPlan).state).toBe("required");
    }
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents.every((event) => event.type === "adapter.retry_task.created")).toBe(true);
    expect(retryEvidence.length).toBeGreaterThanOrEqual(2);
    expect(retryEvidence.some((item) => item.name === "Adapter retry task created")).toBe(true);
    expect(retryEvidence.every((item) => objectValue(item.data).externalExecution === "blocked")).toBe(
      true,
    );

    const retryExecution = await executeWorkerCommand({
      command: "adapters.retry",
      target: {
        role: "revenue_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      config: {
        limit: 1,
      },
    });
    const retryOutput = objectValue(retryExecution.result);

    expect(retryExecution.command).toBe("adapters.retry");
    expect(retryOutput.processed).toBe(2);
    expect(retryOutput.runs).toBe(1);
    expect(retryOutput.actions).toBe(1);
    expect(retryOutput.liveCredentialChecks).toBe(2);
    expect(retryOutput.rollbackPlans).toBe(2);
    expect(retryOutput.blockedLiveExecutions).toBe(2);
    expect(retryOutput.retryRunIds).toEqual([runId]);
    expect(retryOutput.retryActionIds).toEqual([actionId]);
    expect(retryOutput.closedRetryTaskIds).toEqual(
      expect.arrayContaining(result.retryTaskIds),
    );

    const [retriedRun] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [retriedAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const closedRetryTasks = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, result.retryTaskIds));
    const retryExecutionEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.id, stringList(retryOutput.evidenceIds)));

    expect(retriedRun?.state).toBe("done");
    expect(retriedRun?.reconciliationState).toBe("pending");
    expect(retriedRun?.nextAttemptAt).toBeNull();
    expect(objectValue(retriedRun?.error)).toEqual({});
    expect(objectValue(retriedRun?.receipt).externalMutation).toBe(false);
    expect(objectValue(retriedRun?.receipt).externalSend).toBe(false);
    expect(objectValue(objectValue(retriedRun?.receipt).liveCredentialCheck).state).toBe("blocked");
    expect(objectValue(objectValue(retriedRun?.receipt).liveCredentialCheck).missingScopes).toEqual([
      "adapter.write",
    ]);
    expect(objectValue(objectValue(retriedRun?.receipt).rollbackPlan).state).toBe("required");
    expect(retriedAction?.state).toBe("done");
    expect(retriedAction?.reconciliationState).toBe("pending");
    expect(retriedAction?.nextAttemptAt).toBeNull();
    expect(objectValue(retriedAction?.error)).toEqual({});
    expect(objectValue(retriedAction?.receipt).externalMutation).toBe(false);
    expect(objectValue(retriedAction?.receipt).externalSend).toBe(false);
    expect(objectValue(objectValue(retriedAction?.receipt).liveCredentialCheck).state).toBe(
      "blocked",
    );
    expect(objectValue(objectValue(retriedAction?.receipt).rollbackPlan).state).toBe("required");
    expect(closedRetryTasks.every((task) => task.state === "done")).toBe(true);
    expect(
      closedRetryTasks.every(
        (task) => objectValue(task.outcome).status === "adapter_retry_executed",
      ),
    ).toBe(true);
    expect(
      closedRetryTasks.every(
        (task) => objectValue(objectValue(task.outcome).liveCredentialCheck).state === "blocked",
      ),
    ).toBe(true);
    expect(retryExecutionEvidence).toHaveLength(2);
    expect(retryExecutionEvidence.every((item) => item.name === "Adapter retry executed")).toBe(true);
    expect(
      retryExecutionEvidence.every(
        (item) => objectValue(item.data).externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      retryExecutionEvidence.every(
        (item) => objectValue(objectValue(item.data).rollbackPlan).required === true,
      ),
    ).toBe(true);

    const retryReconcile = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now: new Date("2026-05-19T00:10:00.000Z"),
      db,
    });

    expect(retryReconcile.processed).toBe(2);
    expect(retryReconcile.matched).toBe(2);

    const [matchedRun] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [matchedAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);

    expect(matchedRun?.reconciliationState).toBe("matched");
    expect(matchedAction?.reconciliationState).toBe("matched");
  }, 120_000);

  it("creates review tasks for failed adapter rows that exhausted retries", async () => {
    const [connection] = await db.select().from(connections).limit(1);
    expect(connection).toBeDefined();

    const runId = randomUUID();
    const actionId = randomUUID();
    const key = `ci-adapter-review-${runId}`;
    const createdAt = new Date("2000-01-01T00:01:00.000Z");
    const now = new Date("2026-05-19T00:00:00.000Z");

    await db.insert(adapterRuns).values({
      id: runId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      mode: "dry_run",
      operation: "ci_review_check",
      idempotencyKey: `${key}:run`,
      state: "failed",
      attempt: 3,
      maxAttempts: 3,
      reconciliationState: "pending",
      readCount: 1,
      writeCount: 0,
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "max_retries_exhausted",
      },
      data: {
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
      createdAt,
    });
    await db.insert(adapterActions).values({
      id: actionId,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      adapterRunId: runId,
      idempotencyKey: `${key}:action`,
      state: "failed",
      mode: "dry_run",
      operation: "ci_review_check",
      attempt: 3,
      maxAttempts: 3,
      reconciliationState: "pending",
      request: {
        dryRun: true,
        externalSend: false,
      },
      receipt: {
        externalMutation: false,
      },
      error: {
        code: "max_retries_exhausted",
      },
      createdAt,
      updatedAt: createdAt,
    });

    const result = await reconcileAdapterLedger({
      tenantSlug: "continuous-demo",
      limit: 1,
      now,
      db,
    });

    expect(result.processed).toBe(2);
    expect(result.retryScheduled).toBe(0);
    expect(result.needsReview).toBe(2);
    expect(result.reviewTaskIds).toHaveLength(2);
    expect(result.retryTaskIds).toHaveLength(0);
    expect(result.taskIds).toEqual(expect.arrayContaining(result.reviewTaskIds));

    const [run] = await db.select().from(adapterRuns).where(eq(adapterRuns.id, runId)).limit(1);
    const [action] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, actionId))
      .limit(1);
    const reviewTasks = await db.select().from(tasks).where(inArray(tasks.id, result.reviewTaskIds));
    const reviewEvents = await db
      .select()
      .from(events)
      .where(inArray(events.taskId, result.reviewTaskIds));
    const reviewEvidence = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.taskId, result.reviewTaskIds));

    expect(run?.state).toBe("failed");
    expect(run?.attempt).toBe(3);
    expect(run?.reconciliationState).toBe("needs_review");
    expect(run?.nextAttemptAt).toBeNull();
    expect(objectValue(run?.receipt).externalMutation).toBe(false);
    expect(action?.state).toBe("failed");
    expect(action?.attempt).toBe(3);
    expect(action?.reconciliationState).toBe("needs_review");
    expect(action?.nextAttemptAt).toBeNull();
    expect(objectValue(action?.receipt).externalMutation).toBe(false);

    expect(reviewTasks).toHaveLength(2);
    for (const task of reviewTasks) {
      expect(task.state).toBe("blocked");
      expect(task.priority).toBe("high");
      expect(task.ownerType).toBe("system");
      expect(task.ownerRef).toBe("system:adapter-reconciliation");
      expect(task.dueAt?.toISOString()).toBe(now.toISOString());
      expect(objectValue(task.outcome).decision).toBe("needs_review");
      expect(objectValue(task.outcome).externalExecution).toBe("blocked");
      expect(objectValue(task.outcome).executable).toBe(false);
    }
    expect(reviewEvents).toHaveLength(2);
    expect(reviewEvents.every((event) => event.type === "adapter.review_task.created")).toBe(true);
    expect(reviewEvidence.length).toBeGreaterThanOrEqual(2);
    expect(reviewEvidence.some((item) => item.name === "Adapter review task created")).toBe(true);
    expect(reviewEvidence.every((item) => objectValue(item.data).externalExecution === "blocked")).toBe(
      true,
    );
  }, 120_000);

  it("runs the Owner Chief-of-Staff worker as a read-only brief generator", async () => {
    const runId = randomUUID();
    const result = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "brief.generate",
      worker: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-owner-brief-${runId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
        includeEvidence: true,
      },
    });
    const resultEnvelope = objectValue(result);
    const ownerResult = resultEnvelope.result as Awaited<ReturnType<typeof import("./owner").generateOwnerBrief>>;
    const score = scoreOwnerBriefRun(ownerResult, ownerBriefEvalCases[0]);

    expect(objectValue(resultEnvelope.worker).role).toBe("owner_chief_of_staff");
    expect(resultEnvelope.command).toBe("brief.generate");
    expect(ownerResult.created).toBe(true);
    expect(ownerResult.objectId).toBeTruthy();
    expect(ownerResult.objectVersionId).toBeTruthy();
    expect(ownerResult.evidenceId).toBeTruthy();
    expect(ownerResult.documentId).toBeTruthy();
    expect(ownerResult.packetId).toBeTruthy();
    expect(ownerResult.approvalRequestId).toBeTruthy();
    expect(ownerResult.workflowRunId).toBeTruthy();
    expect(ownerResult.workflowStepIds).toHaveLength(3);
    expect(ownerResult.decisionIds.length).toBeGreaterThanOrEqual(1);
    expect(ownerResult.viewIds).toHaveLength(3);
    expect(score.passed).toBe(true);

    const [briefObject] = await db.select().from(objects).where(eq(objects.id, ownerResult.objectId ?? "")).limit(1);
    const [version] = await db
      .select()
      .from(objectVersions)
      .where(eq(objectVersions.id, ownerResult.objectVersionId ?? ""))
      .limit(1);
    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, ownerResult.packetId ?? ""))
      .limit(1);
    const [approval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, ownerResult.approvalRequestId ?? ""))
      .limit(1);
    const [run] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, ownerResult.workerRunId ?? ""))
      .limit(1);
    const [ownerWorker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.role, "owner_chief_of_staff"))
      .limit(1);
    const replay = await executeWorkerCommand({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-brief-${runId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks"],
      },
    });
    const replayResult = replay.result as Awaited<ReturnType<typeof import("./owner").generateOwnerBrief>>;

    expect(briefObject?.type).toBe("owner_brief");
    expect(briefObject?.state).toBe("review_ready");
    expect(version?.objectId).toBe(ownerResult.objectId);
    expect(packet?.kind).toBe("owner_brief_packet");
    expect(objectValue(packet?.data).externalExecution).toBe("blocked");
    expect(approval?.kind).toBe("owner_brief_approval");
    expect(approval?.state).toBe("pending");
    expect(approval?.workerRunId).toBe(ownerResult.workerRunId);
    expect(objectValue(approval?.requestedAction).externalExecution).toBe("blocked");
    expect(run?.mode).toBe("read_only");
    expect(run?.workerId).toBe(ownerWorker?.id);
    expect(objectValue(ownerResult.output).externalExecution).toBe("blocked");
    expect(objectValue(ownerResult.output).externalSend).toBe(false);
    expect(replayResult.created).toBe(false);
    expect(replayResult.workerRunId).toBe(ownerResult.workerRunId);
  }, 120_000);

  it("continues Owner Chief-of-Staff approval outcomes through the worker command spine", async () => {
    const approvedRunId = randomUUID();
    const approvedBrief = await executeWorkerCommand({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-approved-brief-${approvedRunId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
      },
    });
    const approvedBriefResult = approvedBrief.result as Awaited<
      ReturnType<typeof import("./owner").generateOwnerBrief>
    >;

    await decideApproval({
      approvalId: approvedBriefResult.approvalRequestId ?? "",
      idempotencyKey: `ci-owner-approved-approval-${approvedRunId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "approved",
      note: "Publish this owner brief.",
      subject: "worker",
    });

    const approvedContinuation = await executeWorkerCommand({
      command: "continue",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-approved-continue-${approvedRunId}`,
      config: {
        approvalId: approvedBriefResult.approvalRequestId,
      },
    });
    const approvedResult = approvedContinuation.result as Awaited<
      ReturnType<typeof import("./owner").continueOwnerWorker>
    >;
    const approvedOutput = objectValue(approvedResult.output);

    expect(approvedContinuation.worker.role).toBe("owner_chief_of_staff");
    expect(approvedContinuation.command).toBe("continue");
    expect(approvedResult.created).toBe(true);
    expect(approvedOutput.status).toBe("owner_brief_published");
    expect(approvedOutput.externalExecution).toBe("blocked");
    expect(approvedOutput.externalSend).toBe(false);
    expect(approvedResult.workflowStepId).toBeTruthy();

    const [publishedObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, approvedBriefResult.objectId ?? ""))
      .limit(1);
    const [publishedDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, approvedBriefResult.documentId ?? ""))
      .limit(1);
    const [publishedPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, approvedBriefResult.packetId ?? ""))
      .limit(1);
    const [publishedWorkflow] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, approvedBriefResult.workflowRunId ?? ""))
      .limit(1);
    const [publishedStep] = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, approvedResult.workflowStepId ?? ""))
      .limit(1);
    const [continuedOriginalRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, approvedBriefResult.workerRunId ?? ""))
      .limit(1);
    const approvedReplay = await executeWorkerCommand({
      command: "continue",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-approved-continue-${approvedRunId}`,
      config: {
        approvalId: approvedBriefResult.approvalRequestId,
      },
    });
    const approvedReplayResult = approvedReplay.result as Awaited<
      ReturnType<typeof import("./owner").continueOwnerWorker>
    >;

    expect(publishedObject?.state).toBe("published");
    expect(publishedDocument?.state).toBe("published");
    expect(publishedPacket?.state).toBe("published");
    expect(publishedWorkflow?.state).toBe("published");
    expect(publishedStep?.kind).toBe("approval_continuation");
    expect(publishedStep?.approvalRequestId).toBe(approvedBriefResult.approvalRequestId);
    expect(objectValue(objectValue(continuedOriginalRun?.data).output).lastOwnerContinuation).toEqual(
      expect.objectContaining({
        status: "owner_brief_published",
        approvalRequestId: approvedBriefResult.approvalRequestId,
      }),
    );
    expect(approvedReplayResult.created).toBe(false);
    expect(approvedReplayResult.workerRunId).toBe(approvedResult.workerRunId);

    const revisionRunId = randomUUID();
    const revisionBrief = await executeWorkerCommand({
      command: "brief.generate",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-revision-brief-${revisionRunId}`,
      config: {
        window: {
          from: "2026-05-19T00:00:00.000Z",
          to: "2026-05-20T00:00:00.000Z",
        },
        scopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
      },
    });
    const revisionBriefResult = revisionBrief.result as Awaited<
      ReturnType<typeof import("./owner").generateOwnerBrief>
    >;

    await decideApproval({
      approvalId: revisionBriefResult.approvalRequestId ?? "",
      idempotencyKey: `ci-owner-revision-approval-${revisionRunId}`,
      operatorEmail: "owner@continuoushq.com",
      tenantSlug: "continuous-demo",
      action: "revision_requested",
      note: "Call out the stale source before publishing.",
      subject: "worker",
    });

    const revisionContinuation = await executeWorkerCommand({
      command: "continue",
      target: {
        role: "owner_chief_of_staff",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-owner-revision-continue-${revisionRunId}`,
      config: {
        approvalId: revisionBriefResult.approvalRequestId,
      },
    });
    const revisionResult = revisionContinuation.result as Awaited<
      ReturnType<typeof import("./owner").continueOwnerWorker>
    >;
    const revisionOutput = objectValue(revisionResult.output);
    const [revisionObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, revisionBriefResult.objectId ?? ""))
      .limit(1);
    const [revisionTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, revisionResult.taskId ?? ""))
      .limit(1);
    const [revisionWorkflow] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, revisionBriefResult.workflowRunId ?? ""))
      .limit(1);
    const revisionBlockers = objectValue(revisionWorkflow?.blockers);

    expect(revisionOutput.status).toBe("owner_brief_revision_requested");
    expect(revisionOutput.externalExecution).toBe("blocked");
    expect(revisionObject?.state).toBe("draft");
    expect(revisionTask?.state).toBe("active");
    expect(objectValue(revisionTask?.outcome).approvalRequestId).toBe(
      revisionBriefResult.approvalRequestId,
    );
    expect(stringList(revisionBlockers.open)).toContain("revision_requested");
  }, 120_000);

  it("prepares workforce hire and payroll-readiness packets through the generic /worker registry", async () => {
    const runId = randomUUID();
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const personId = "55555555-5555-4555-8555-000000000003";
    const employmentId = "55555555-5555-4555-8555-000000000004";
    const payrollRunId = "55555555-5555-4555-8555-000000000007";
    const workLocationObjectId = "33333333-3333-4333-8333-000000000102";

    const hireResponse = await executeWorkerCommand({
      command: "hire.packet.prepare",
      target: {
        role: "workforce_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-workforce-hire-${runId}`,
      config: {
        personId,
        positionId: "field_operations_lead",
        workLocationId: workLocationObjectId,
        employmentId,
        documents: [
          { type: "identity_verification", state: "verified", sensitivity: "high" },
          { type: "employment_eligibility", state: "verified", sensitivity: "high" },
          { type: "tax_withholding", state: "provided", sensitivity: "high" },
          { type: "direct_deposit", state: "provided", sensitivity: "high" },
          { type: "policy_acknowledgement", state: "signed", sensitivity: "medium" },
        ],
      },
    });
    const hireResult = hireResponse.result as Awaited<
      ReturnType<typeof import("./workforce").prepareWorkforceHirePacket>
    >;
    const hireOutput = objectValue(hireResult.output);
    const [hireRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, hireResult.workerRunId))
      .limit(1);
    const [hireObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, hireResult.employmentObjectId ?? ""))
      .limit(1);
    const [hireApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, hireResult.approvalRequestId ?? ""))
      .limit(1);
    const [hirePacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, hireResult.packetId ?? ""))
      .limit(1);
    const [hireDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, hireResult.documentId ?? ""))
      .limit(1);
    const [hireView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "workforce.hire.review")))
      .limit(1);

    expect(hireResponse.command).toBe("hire.packet.prepare");
    expect(hireResponse.worker.role).toBe("workforce_operations");
    expect(hireResult.created).toBe(true);
    expect(hireResult.workflowStepIds).toHaveLength(2);
    expect(hireResult.externalExecution).toBe("blocked");
    expect(hireOutput.externalExecution).toBe("blocked");
    expect(objectValue(hireOutput.restrictedDocuments).rawContentStored).toBe(false);
    expect(hireRun?.state).toBe("done");
    expect(hireObject?.type).toBe("employment");
    expect(hireApproval?.kind).toBe("workforce_hire_packet_approval");
    expect(hireApproval?.state).toBe("pending");
    expect(hirePacket?.kind).toBe("workforce_packet");
    expect(hireDocument?.kind).toBe("new_hire_packet");
    expect(hireView?.key).toBe("workforce.hire.review");

    const hireReplay = await executeWorkerCommand({
      command: "hire.packet.prepare",
      target: {
        role: "workforce_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-workforce-hire-${runId}`,
      config: {
        personId,
        positionId: "field_operations_lead",
        workLocationId: workLocationObjectId,
        employmentId,
        documents: [
          { type: "identity_verification", state: "verified", sensitivity: "high" },
          { type: "employment_eligibility", state: "verified", sensitivity: "high" },
          { type: "tax_withholding", state: "provided", sensitivity: "high" },
          { type: "direct_deposit", state: "provided", sensitivity: "high" },
          { type: "policy_acknowledgement", state: "signed", sensitivity: "medium" },
        ],
      },
    });
    const hireReplayResult = hireReplay.result as Awaited<
      ReturnType<typeof import("./workforce").prepareWorkforceHirePacket>
    >;

    expect(hireReplayResult.created).toBe(false);
    expect(hireReplayResult.workerRunId).toBe(hireResult.workerRunId);
    expect(hireReplayResult.packetId).toBe(hireResult.packetId);

    const payrollResponse = await executeWorkerCommand({
      command: "payroll_input.prepare",
      target: {
        role: "workforce_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-workforce-payroll-input-${runId}`,
      config: {
        employmentId,
        payrollRunId,
        period: "2026-05",
        hours: 80,
        earnings: [{ code: "regular_hours", amountCents: 336000, currency: "USD" }],
        deductions: [],
      },
    });
    const payrollResult = payrollResponse.result as Awaited<
      ReturnType<typeof import("./workforce").prepareWorkforcePayrollInput>
    >;
    const payrollOutput = objectValue(payrollResult.output);
    const [payrollObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, payrollResult.objectId ?? ""))
      .limit(1);
    const [payrollApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, payrollResult.approvalRequestId ?? ""))
      .limit(1);
    const [payrollPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, payrollResult.packetId ?? ""))
      .limit(1);
    const [payrollView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "workforce.payroll_input.review")))
      .limit(1);

    expect(payrollResponse.command).toBe("payroll_input.prepare");
    expect(payrollResponse.worker.role).toBe("workforce_operations");
    expect(payrollResult.created).toBe(true);
    expect(payrollResult.workflowStepIds).toHaveLength(2);
    expect(payrollResult.externalExecution).toBe("dry_run");
    expect(payrollOutput.payrollSubmission).toBe("blocked");
    expect(payrollOutput.moneyMovement).toBe("blocked");
    expect(payrollObject?.type).toBe("payroll_input");
    expect(payrollApproval?.kind).toBe("workforce_payroll_input_approval");
    expect(payrollPacket?.kind).toBe("workforce_packet");
    expect(payrollView?.key).toBe("workforce.payroll_input.review");

    const readiness = await executeWorkerView({
      view: "readiness",
      target: {
        role: "workforce_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
    });
    const readinessData = objectValue(readiness.data.readiness);

    expect(readiness.error).toBeNull();
    expect(Array.isArray(readinessData.documentBlockers)).toBe(true);
    expect(Array.isArray(readinessData.payrollBlockers)).toBe(true);
    expect((readinessData.documentBlockers as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((readinessData.payrollBlockers as unknown[]).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("promotes approved Revenue quote handoffs into Dispatch schedule proposals through /worker", async () => {
    const runId = randomUUID();
    const customerObjectId = randomUUID();
    const quoteObjectId = randomUUID();
    const jobObjectId = randomUUID();
    const workOrderObjectId = randomUUID();
    const jobRowId = randomUUID();
    const approvalRequestId = randomUUID();
    const adapterReceiptEvidenceId = randomUUID();
    const completionEvidenceId = randomUUID();
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const [scheduleCapability] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(eq(capabilities.key, "schedule.propose"))
      .limit(1);
    const [quoteCapability] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(eq(capabilities.key, "quote.prepare"))
      .limit(1);

    expect(scheduleCapability?.id).toBeTruthy();

    await db.insert(objects).values([
      {
        id: customerObjectId,
        tenantId,
        type: "customer",
        name: "Dispatch Handoff Customer",
        state: "active",
        source: "test",
        externalId: `ci-dispatch-customer-${runId}`,
        data: { email: "dispatch@example.com" },
      },
      {
        id: quoteObjectId,
        tenantId,
        type: "quote",
        name: "Approved dispatch handoff quote",
        state: "approved",
        source: "test",
        externalId: `ci-dispatch-quote-${runId}`,
        data: {
          totalCents: 24900,
          total_cents: 24900,
          currency: "USD",
          policy: "standard_inspection",
        },
      },
      {
        id: jobObjectId,
        tenantId,
        type: "job",
        name: "Approved dispatch handoff job",
        state: "ready_to_schedule",
        source: "test",
        externalId: `ci-dispatch-job-object-${runId}`,
        data: {
          customerId: customerObjectId,
          quoteId: quoteObjectId,
          serviceArea: "roofing",
          status: "ready_to_schedule",
        },
      },
      {
        id: workOrderObjectId,
        tenantId,
        type: "work_order",
        name: "Approved dispatch handoff work order",
        state: "closeout_ready",
        source: "test",
        externalId: `ci-dispatch-work-order-${runId}`,
        data: {
          jobObjectId,
          customerObjectId,
          scope: "Inspection completed and ready for closeout packet review.",
          crewRequirements: ["roofing"],
          riskFlags: [],
        },
      },
    ]);

    await db.insert(jobs).values({
      id: jobRowId,
      tenantId,
      objectId: jobObjectId,
      state: "ready_to_schedule",
      externalId: `ci-dispatch-job-${runId}`,
      data: { quoteObjectId, customerObjectId, status: "ready_to_schedule" },
    });

    await db
      .insert(objectLinks)
      .values([
        {
          tenantId,
          fromId: jobObjectId,
          toId: customerObjectId,
          type: "for_customer",
        },
        {
          tenantId,
          fromId: jobObjectId,
          toId: quoteObjectId,
          type: "from_quote",
        },
        {
          tenantId,
          fromId: jobObjectId,
          toId: workOrderObjectId,
          type: "has_work_order",
        },
        {
          tenantId,
          fromId: workOrderObjectId,
          toId: jobObjectId,
          type: "fulfills_job",
        },
      ])
      .onConflictDoNothing();

    await db.insert(approvalRequests).values({
      id: approvalRequestId,
      tenantId,
      objectId: quoteObjectId,
      capabilityId: quoteCapability?.id ?? scheduleCapability?.id ?? null,
      requesterType: "worker",
      requesterRef: "worker:test-revenue",
      kind: "quote_approval",
      state: "approved",
      priority: "high",
      risk: "medium",
      title: "Approved quote handoff for dispatch",
      summary: "Quote has owner approval and can move into dispatch scheduling.",
      requestedAction: {
        action: "approve_quote_for_dispatch",
        quoteObjectId,
        jobObjectId,
      },
      evidence: {},
      policy: { externalSend: "approved", schedule: "approval_required" },
      decision: { action: "approved", note: "Approved for schedule proposal." },
      data: { quoteObjectId, jobObjectId },
      decidedAt: new Date(),
    });

    await db.insert(evidence).values([
      {
        id: adapterReceiptEvidenceId,
        tenantId,
        kind: "receipt",
        name: "Revenue quote no-send receipt",
        objectId: quoteObjectId,
        capabilityId: quoteCapability?.id ?? scheduleCapability?.id ?? null,
        actorType: "adapter",
        hash: `ci-dispatch-receipt-${runId}`,
        data: {
          mode: "dry_run",
          quoteObjectId,
          jobObjectId,
          externalMutation: false,
          externalSend: false,
        },
      },
      {
        id: completionEvidenceId,
        tenantId,
        kind: "snapshot",
        name: "Work order completion proof",
        objectId: workOrderObjectId,
        capabilityId: scheduleCapability?.id ?? null,
        actorType: "worker",
        hash: `ci-dispatch-completion-${runId}`,
        data: {
          workOrderObjectId,
          jobObjectId,
          photosAttached: true,
          externalMutation: false,
          externalSend: false,
        },
      },
    ]);

    const response = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "schedule.propose",
      worker: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-dispatch-schedule-${runId}`,
      config: {
        sourceRefs: {
          customerObjectId,
          quoteObjectId,
          jobObjectId,
          approvalRequestId,
          adapterReceiptEvidenceId,
        },
        constraints: {
          serviceWindow: "2026-05-21",
          durationMinutes: 120,
          crewSkills: ["roofing"],
        },
      },
    });
    const responseEnvelope = objectValue(response);
    const result = responseEnvelope.result as Awaited<
      ReturnType<typeof import("./dispatch").proposeDispatchSchedule>
    >;
    const output = objectValue(result.output);

    expect(responseEnvelope.command).toBe("schedule.propose");
    expect(objectValue(responseEnvelope.worker).role).toBe("dispatch_operations");
    expect(result.created).toBe(true);
    expect(result.workflowStepIds).toHaveLength(4);
    expect(output.externalExecution).toBe("dry_run");
    expect(output.externalMutation).toBe(false);
    expect(output.externalSend).toBe(false);
    expect(objectValue(output.sourceRefs).quoteObjectId).toBe(quoteObjectId);

    const [run] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, result.workerRunId))
      .limit(1);
    const [appointment] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, result.appointmentObjectId ?? ""))
      .limit(1);
    const [dispatchApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, result.approvalRequestId ?? ""))
      .limit(1);
    const [adapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, result.adapterActionId ?? ""))
      .limit(1);
    const [packet] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, result.packetId ?? ""))
      .limit(1);
    const [view] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "dispatch.schedule.review")))
      .limit(1);

    expect(run?.source).toBe("continuous.worker");
    expect(run?.state).toBe("done");
    expect(appointment?.type).toBe("appointment");
    expect(appointment?.state).toBe("approval_required");
    expect(dispatchApproval?.state).toBe("pending");
    expect(dispatchApproval?.kind).toBe("dispatch_schedule_approval");
    expect(adapterAction?.mode).toBe("dry_run");
    expect(objectValue(adapterAction?.receipt).externalMutation).toBe(false);
    expect(packet?.kind).toBe("dispatch_packet");
    expect(view?.key).toBe("dispatch.schedule.review");
    expect(result.snapshot.controls.externalExecution).toBe("dry_run");

    const replay = await executeWorkerCommand({
      command: "schedule.propose",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-schedule-${runId}`,
      config: {
        sourceRefs: {
          customerObjectId,
          quoteObjectId,
          jobObjectId,
          approvalRequestId,
          adapterReceiptEvidenceId,
        },
        constraints: {
          serviceWindow: "2026-05-21",
          durationMinutes: 120,
          crewSkills: ["roofing"],
        },
      },
    });
    const replayResult = replay.result as Awaited<
      ReturnType<typeof import("./dispatch").proposeDispatchSchedule>
    >;

    expect(replayResult.created).toBe(false);
    expect(replayResult.workerRunId).toBe(result.workerRunId);
    expect(replayResult.appointmentObjectId).toBe(result.appointmentObjectId);

    const appointmentObjectId = result.appointmentObjectId ?? "";
    expect(appointmentObjectId).toBeTruthy();

    const customerUpdateResponse = await executeWorkerCommand({
      command: "customer_update.draft",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-customer-update-${runId}`,
      config: {
        jobId: jobObjectId,
        updateKind: "schedule_proposed",
        channel: "email",
        sourceRefs: {
          customerObjectId,
          quoteObjectId,
          appointmentObjectId,
        },
        messageContext: {
          customerFacingSummary: "We have prepared a proposed service window and are reviewing it before sending.",
        },
      },
    });
    const customerUpdateResult = customerUpdateResponse.result as Awaited<
      ReturnType<typeof import("./dispatch").draftDispatchCustomerUpdate>
    >;
    const customerUpdateOutput = objectValue(customerUpdateResult.output);
    const [customerUpdateRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, customerUpdateResult.workerRunId))
      .limit(1);
    const [customerUpdateObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, customerUpdateResult.customerUpdateObjectId ?? ""))
      .limit(1);
    const [customerUpdateApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, customerUpdateResult.approvalRequestId ?? ""))
      .limit(1);
    const [customerUpdatePacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, customerUpdateResult.packetId ?? ""))
      .limit(1);
    const [customerUpdateView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "dispatch.customer_update.review")))
      .limit(1);

    expect(customerUpdateResponse.command).toBe("customer_update.draft");
    expect(customerUpdateResponse.worker.role).toBe("dispatch_operations");
    expect(customerUpdateResult.created).toBe(true);
    expect(customerUpdateResult.workflowStepIds).toHaveLength(3);
    expect(customerUpdateOutput.externalExecution).toBe("blocked");
    expect(customerUpdateOutput.externalSend).toBe(false);
    expect(customerUpdateOutput.jobObjectId).toBe(jobObjectId);
    expect(customerUpdateOutput.customerUpdateObjectId).toBe(customerUpdateResult.customerUpdateObjectId);
    expect(objectValue(customerUpdateOutput.draft).body).toContain("proposed service window");
    expect(customerUpdateRun?.source).toBe("continuous.worker");
    expect(customerUpdateRun?.state).toBe("done");
    expect(customerUpdateObject?.type).toBe("customer_update");
    expect(customerUpdateObject?.state).toBe("approval_required");
    expect(objectValue(customerUpdateObject?.data).externalSend).toBe(false);
    expect(customerUpdateApproval?.state).toBe("pending");
    expect(customerUpdateApproval?.kind).toBe("dispatch_customer_update_approval");
    expect(customerUpdatePacket?.kind).toBe("dispatch_customer_update_packet");
    expect(customerUpdateView?.key).toBe("dispatch.customer_update.review");

    const customerUpdateReplay = await executeWorkerCommand({
      command: "customer_update.draft",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-customer-update-${runId}`,
      config: {
        jobId: jobObjectId,
        updateKind: "schedule_proposed",
        channel: "email",
        sourceRefs: {
          customerObjectId,
          quoteObjectId,
          appointmentObjectId,
        },
        messageContext: {
          customerFacingSummary: "We have prepared a proposed service window and are reviewing it before sending.",
        },
      },
    });
    const customerUpdateReplayResult = customerUpdateReplay.result as Awaited<
      ReturnType<typeof import("./dispatch").draftDispatchCustomerUpdate>
    >;

    expect(customerUpdateReplayResult.created).toBe(false);
    expect(customerUpdateReplayResult.workerRunId).toBe(customerUpdateResult.workerRunId);
    expect(customerUpdateReplayResult.customerUpdateObjectId).toBe(customerUpdateResult.customerUpdateObjectId);

    const closeoutResponse = await executeWorkerCommand({
      command: "closeout.prepare",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-closeout-${runId}`,
      config: {
        workOrderId: workOrderObjectId,
        sourceRefs: {
          jobObjectId,
          customerObjectId,
          appointmentObjectId,
          customerUpdateObjectId: customerUpdateResult.customerUpdateObjectId,
          evidenceIds: [completionEvidenceId],
        },
        qaChecklist: {
          scopeCompleted: true,
          photosAttached: true,
          customerSignoff: true,
          safetyReviewed: true,
          blockers: [],
        },
        completionNotes: "Inspection work is complete and ready for owner closeout review.",
        invoiceReady: true,
        billableLines: [
          {
            description: "Roof leak inspection",
            amountCents: 24900,
            currency: "USD",
          },
        ],
      },
    });
    const closeoutResult = closeoutResponse.result as Awaited<
      ReturnType<typeof import("./dispatch").prepareDispatchCloseout>
    >;
    const closeoutOutput = objectValue(closeoutResult.output);
    const [closeoutRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, closeoutResult.workerRunId))
      .limit(1);
    const [closeoutObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, closeoutResult.closeoutObjectId ?? ""))
      .limit(1);
    const [closeoutApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, closeoutResult.approvalRequestId ?? ""))
      .limit(1);
    const [closeoutPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, closeoutResult.packetId ?? ""))
      .limit(1);
    const [closeoutView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "dispatch.closeout.review")))
      .limit(1);

    expect(closeoutResponse.command).toBe("closeout.prepare");
    expect(closeoutResponse.worker.role).toBe("dispatch_operations");
    expect(closeoutResult.created).toBe(true);
    expect(closeoutResult.workflowStepIds).toHaveLength(4);
    expect(closeoutOutput.externalExecution).toBe("blocked");
    expect(closeoutOutput.externalSend).toBe(false);
    expect(closeoutOutput.workOrderObjectId).toBe(workOrderObjectId);
    expect(closeoutOutput.closeoutObjectId).toBe(closeoutResult.closeoutObjectId);
    expect(closeoutOutput.invoiceReady).toBe(true);
    expect(stringList(closeoutOutput.blockers)).toHaveLength(0);
    expect(objectValue(closeoutOutput.financeHandoff).name).toBe("dispatch.closeout_to_finance");
    expect(closeoutRun?.source).toBe("continuous.worker");
    expect(closeoutRun?.state).toBe("done");
    expect(closeoutObject?.type).toBe("closeout");
    expect(closeoutObject?.state).toBe("review_ready");
    expect(objectValue(closeoutObject?.data).externalExecution).toBe("blocked");
    expect(closeoutApproval?.state).toBe("pending");
    expect(closeoutApproval?.kind).toBe("dispatch_closeout_approval");
    expect(closeoutPacket?.kind).toBe("dispatch_closeout_packet");
    expect(closeoutView?.key).toBe("dispatch.closeout.review");

    const closeoutReplay = await executeWorkerCommand({
      command: "closeout.prepare",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-closeout-${runId}`,
      config: {
        workOrderId: workOrderObjectId,
        sourceRefs: {
          jobObjectId,
          customerObjectId,
          appointmentObjectId,
          customerUpdateObjectId: customerUpdateResult.customerUpdateObjectId,
          evidenceIds: [completionEvidenceId],
        },
        qaChecklist: {
          scopeCompleted: true,
          photosAttached: true,
          customerSignoff: true,
          safetyReviewed: true,
          blockers: [],
        },
        completionNotes: "Inspection work is complete and ready for owner closeout review.",
        invoiceReady: true,
        billableLines: [
          {
            description: "Roof leak inspection",
            amountCents: 24900,
            currency: "USD",
          },
        ],
      },
    });
    const closeoutReplayResult = closeoutReplay.result as Awaited<
      ReturnType<typeof import("./dispatch").prepareDispatchCloseout>
    >;

    expect(closeoutReplayResult.created).toBe(false);
    expect(closeoutReplayResult.workerRunId).toBe(closeoutResult.workerRunId);
    expect(closeoutReplayResult.closeoutObjectId).toBe(closeoutResult.closeoutObjectId);

    const financeResponse = await executeWorkerCommand({
      command: "invoice.prepare",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-invoice-${runId}`,
      config: {
        sourceRefs: {
          jobObjectId,
          customerObjectId,
          closeoutObjectId: closeoutResult.closeoutObjectId,
          evidenceIds: [completionEvidenceId],
        },
        policy: {
          requireOwnerApproval: true,
        },
      },
    });
    const financeResult = financeResponse.result as Awaited<
      ReturnType<typeof import("./finance").prepareFinanceInvoice>
    >;
    const financeOutput = objectValue(financeResult.output);
    const [financeRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, financeResult.workerRunId))
      .limit(1);
    const [financeInvoiceObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, financeResult.invoiceObjectId ?? ""))
      .limit(1);
    const [financeInvoiceRow] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, financeResult.invoiceId ?? ""))
      .limit(1);
    const [financeApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, financeResult.approvalRequestId ?? ""))
      .limit(1);
    const [financeAdapterRun] = await db
      .select()
      .from(adapterRuns)
      .where(eq(adapterRuns.id, financeResult.adapterRunId ?? ""))
      .limit(1);
    const [financeAdapterAction] = await db
      .select()
      .from(adapterActions)
      .where(eq(adapterActions.id, financeResult.adapterActionId ?? ""))
      .limit(1);
    const [financePacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, financeResult.packetId ?? ""))
      .limit(1);
    const [financeDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, financeResult.documentId ?? ""))
      .limit(1);
    const [financeView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "finance.invoice.review")))
      .limit(1);

    expect(financeResponse.command).toBe("invoice.prepare");
    expect(financeResponse.worker.role).toBe("finance_operations");
    expect(financeResult.created).toBe(true);
    expect(financeResult.workflowStepIds).toHaveLength(3);
    expect(financeOutput.externalExecution).toBe("dry_run");
    expect(financeOutput.externalMutation).toBe(false);
    expect(financeOutput.externalSend).toBe(false);
    expect(financeOutput.moneyMovement).toBe("blocked");
    expect(financeOutput.requiresApproval).toBe(true);
    expect(financeOutput.totalCents).toBe(24900);
    expect(financeOutput.closeoutObjectId).toBe(closeoutResult.closeoutObjectId);
    expect(objectValue(financeOutput.financeHandoff).name).toBe("finance.invoice_to_owner_review");
    expect(financeRun?.source).toBe("continuous.worker");
    expect(financeRun?.state).toBe("done");
    expect(financeInvoiceObject?.type).toBe("invoice");
    expect(financeInvoiceObject?.state).toBe("approval_required");
    expect(financeInvoiceRow?.state).toBe("approval_required");
    expect(financeApproval?.state).toBe("pending");
    expect(financeApproval?.kind).toBe("finance_invoice_approval");
    expect(financeAdapterRun?.mode).toBe("dry_run");
    expect(financeAdapterAction?.mode).toBe("dry_run");
    expect(objectValue(financeAdapterAction?.receipt).externalMutation).toBe(false);
    expect(objectValue(financeAdapterAction?.receipt).moneyMovement).toBe("blocked");
    expect(financePacket?.kind).toBe("cash_packet");
    expect(financeDocument?.kind).toBe("finance_invoice_draft");
    expect(financeView?.key).toBe("finance.invoice.review");
    expect(financeResult.snapshot.controls.externalExecution).toBe("dry_run");
    expect(financeResult.snapshot.invoices.some((invoice) => invoice.id === financeResult.invoiceObjectId)).toBe(
      true,
    );

    const financeReplay = await executeWorkerCommand({
      command: "invoice.prepare",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-invoice-${runId}`,
      config: {
        sourceRefs: {
          jobObjectId,
          customerObjectId,
          closeoutObjectId: closeoutResult.closeoutObjectId,
          evidenceIds: [completionEvidenceId],
        },
        policy: {
          requireOwnerApproval: true,
        },
      },
    });
    const financeReplayResult = financeReplay.result as Awaited<
      ReturnType<typeof import("./finance").prepareFinanceInvoice>
    >;

    expect(financeReplayResult.created).toBe(false);
    expect(financeReplayResult.workerRunId).toBe(financeResult.workerRunId);
    expect(financeReplayResult.invoiceObjectId).toBe(financeResult.invoiceObjectId);

    const arFollowupResponse = await executeWorkerCommand({
      command: "ar_followup.draft",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-ar-followup-${runId}`,
      config: {
        invoiceId: financeResult.invoiceId,
        tonePolicy: "friendly_first_reminder",
        channel: "email",
        messageContext: {
          customerName: "Acme Roof Repair",
        },
        policy: {
          requireOwnerApproval: true,
          externalSend: "blocked",
          moneyMovement: "blocked",
        },
      },
    });
    const arFollowupResult = arFollowupResponse.result as Awaited<
      ReturnType<typeof import("./finance").draftFinanceArFollowup>
    >;
    const arFollowupOutput = objectValue(arFollowupResult.output);
    const [arFollowupRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, arFollowupResult.workerRunId))
      .limit(1);
    const [arFollowupObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, arFollowupResult.arFollowupObjectId ?? ""))
      .limit(1);
    const [arFollowupApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, arFollowupResult.approvalRequestId ?? ""))
      .limit(1);
    const [arFollowupPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, arFollowupResult.packetId ?? ""))
      .limit(1);
    const [arFollowupDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, arFollowupResult.documentId ?? ""))
      .limit(1);
    const [arFollowupView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "finance.ar_followup.review")))
      .limit(1);

    expect(arFollowupResponse.command).toBe("ar_followup.draft");
    expect(arFollowupResponse.worker.role).toBe("finance_operations");
    expect(arFollowupResult.created).toBe(true);
    expect(arFollowupResult.workflowStepIds).toHaveLength(3);
    expect(arFollowupOutput.externalExecution).toBe("blocked");
    expect(arFollowupOutput.externalMutation).toBe(false);
    expect(arFollowupOutput.externalSend).toBe(false);
    expect(arFollowupOutput.paymentLink).toBe("blocked");
    expect(arFollowupOutput.moneyMovement).toBe("blocked");
    expect(arFollowupOutput.requiresApproval).toBe(true);
    expect(arFollowupOutput.invoiceId).toBe(financeResult.invoiceId);
    expect(arFollowupRun?.source).toBe("continuous.worker");
    expect(arFollowupRun?.state).toBe("done");
    expect(arFollowupObject?.type).toBe("ar_followup");
    expect(arFollowupObject?.state).toBe("approval_required");
    expect(arFollowupApproval?.state).toBe("pending");
    expect(arFollowupApproval?.kind).toBe("finance_ar_followup_approval");
    expect(arFollowupPacket?.kind).toBe("cash_packet");
    expect(arFollowupDocument?.kind).toBe("finance_ar_followup_draft");
    expect(arFollowupView?.key).toBe("finance.ar_followup.review");
    expect(arFollowupResult.snapshot.arFollowups.some((followup) => followup.id === arFollowupResult.arFollowupObjectId)).toBe(
      true,
    );

    const arFollowupReplay = await executeWorkerCommand({
      command: "ar_followup.draft",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-ar-followup-${runId}`,
      config: {
        invoiceId: financeResult.invoiceId,
        tonePolicy: "friendly_first_reminder",
        channel: "email",
        messageContext: {
          customerName: "Acme Roof Repair",
        },
        policy: {
          requireOwnerApproval: true,
          externalSend: "blocked",
          moneyMovement: "blocked",
        },
      },
    });
    const arFollowupReplayResult = arFollowupReplay.result as Awaited<
      ReturnType<typeof import("./finance").draftFinanceArFollowup>
    >;

    expect(arFollowupReplayResult.created).toBe(false);
    expect(arFollowupReplayResult.workerRunId).toBe(arFollowupResult.workerRunId);
    expect(arFollowupReplayResult.arFollowupObjectId).toBe(arFollowupResult.arFollowupObjectId);

    const cashForecastResponse = await executeWorkerCommand({
      command: "cash_forecast.generate",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-cash-forecast-${runId}`,
      config: {
        window: {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-06-01T00:00:00.000Z",
        },
        accounts: ["Operating account"],
        startingBalanceCents: 500000,
        expectedInflowCents: 24900,
        expectedOutflowCents: 336000,
        policy: {
          requireOwnerApproval: true,
          moneyMovement: "blocked",
        },
      },
    });
    const cashForecastResult = cashForecastResponse.result as Awaited<
      ReturnType<typeof import("./finance").generateFinanceCashForecast>
    >;
    const cashForecastOutput = objectValue(cashForecastResult.output);
    const [cashForecastRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, cashForecastResult.workerRunId))
      .limit(1);
    const [cashForecastObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, cashForecastResult.cashForecastObjectId ?? ""))
      .limit(1);
    const [cashForecastApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, cashForecastResult.approvalRequestId ?? ""))
      .limit(1);
    const [cashForecastPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, cashForecastResult.packetId ?? ""))
      .limit(1);
    const [cashForecastDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, cashForecastResult.documentId ?? ""))
      .limit(1);
    const [cashForecastWorkflow] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, cashForecastResult.workflowRunId ?? ""))
      .limit(1);
    const [cashForecastView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "finance.cash.review")))
      .limit(1);

    expect(cashForecastResponse.command).toBe("cash_forecast.generate");
    expect(cashForecastResponse.worker.role).toBe("finance_operations");
    expect(cashForecastResult.created).toBe(true);
    expect(cashForecastResult.workflowStepIds).toHaveLength(3);
    expect(cashForecastOutput.externalExecution).toBe("blocked");
    expect(cashForecastOutput.externalMutation).toBe(false);
    expect(cashForecastOutput.externalSend).toBe(false);
    expect(cashForecastOutput.moneyMovement).toBe("blocked");
    expect(cashForecastOutput.requiresApproval).toBe(true);
    expect(cashForecastOutput.startingBalanceCents).toBe(500000);
    expect(cashForecastOutput.expectedInflowCents).toBe(24900);
    expect(cashForecastOutput.expectedOutflowCents).toBe(336000);
    expect(cashForecastOutput.endingBalanceCents).toBe(188900);
    expect(cashForecastRun?.source).toBe("continuous.worker");
    expect(cashForecastRun?.state).toBe("done");
    expect(cashForecastObject?.type).toBe("cash_forecast");
    expect(cashForecastObject?.state).toBe("review_ready");
    expect(cashForecastWorkflow?.state).toBe("review_ready");
    expect(cashForecastApproval?.state).toBe("pending");
    expect(cashForecastApproval?.kind).toBe("finance_cash_forecast_approval");
    expect(cashForecastPacket?.kind).toBe("cash_packet");
    expect(cashForecastDocument?.kind).toBe("finance_cash_forecast");
    expect(cashForecastView?.key).toBe("finance.cash.review");
    expect(
      cashForecastResult.snapshot.cashForecasts.some(
        (forecast) => forecast.id === cashForecastResult.cashForecastObjectId,
      ),
    ).toBe(true);

    const cashForecastReplay = await executeWorkerCommand({
      command: "cash_forecast.generate",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-cash-forecast-${runId}`,
      config: {
        window: {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-06-01T00:00:00.000Z",
        },
        accounts: ["Operating account"],
        startingBalanceCents: 500000,
        expectedInflowCents: 24900,
        expectedOutflowCents: 336000,
        policy: {
          requireOwnerApproval: true,
          moneyMovement: "blocked",
        },
      },
    });
    const cashForecastReplayResult = cashForecastReplay.result as Awaited<
      ReturnType<typeof import("./finance").generateFinanceCashForecast>
    >;

    expect(cashForecastReplayResult.created).toBe(false);
    expect(cashForecastReplayResult.workerRunId).toBe(cashForecastResult.workerRunId);
    expect(cashForecastReplayResult.cashForecastObjectId).toBe(cashForecastResult.cashForecastObjectId);

    const paymentDraftResponse = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "payment_draft.prepare",
      worker: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      idempotencyKey: `ci-finance-payment-draft-${runId}`,
      config: {
        sourceRefs: {
          paymentId: "44444444-4444-4444-8444-000000000007",
        },
        payee: "Acme Roofing Supplies",
        method: "ach",
        policy: {
          requireOwnerApproval: true,
          requireDualControl: true,
          moneyMovement: "blocked",
        },
      },
    });
    const paymentDraftEnvelope = objectValue(paymentDraftResponse);
    const paymentDraftResult = objectValue(paymentDraftEnvelope.result) as Awaited<
      ReturnType<typeof import("./finance").prepareFinancePaymentDraft>
    >;
    const paymentDraftOutput = objectValue(paymentDraftResult.output);
    const [paymentDraftRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, paymentDraftResult.workerRunId))
      .limit(1);
    const [paymentDraftObject] = await db
      .select()
      .from(objects)
      .where(eq(objects.id, paymentDraftResult.paymentObjectId ?? ""))
      .limit(1);
    const [paymentDraftPayment] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentDraftResult.paymentId ?? ""))
      .limit(1);
    const [paymentDraftInstruction] = await db
      .select()
      .from(paymentInstructions)
      .where(eq(paymentInstructions.id, paymentDraftResult.paymentInstructionId ?? ""))
      .limit(1);
    const [paymentDraftApproval] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, paymentDraftResult.approvalRequestId ?? ""))
      .limit(1);
    const [paymentDraftPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, paymentDraftResult.packetId ?? ""))
      .limit(1);
    const [paymentDraftDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, paymentDraftResult.documentId ?? ""))
      .limit(1);
    const [paymentDraftWorkflow] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, paymentDraftResult.workflowRunId ?? ""))
      .limit(1);
    const [paymentDraftView] = await db
      .select()
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, tenantId), eq(generatedViews.key, "finance.payment.review")))
      .limit(1);
    const [paymentDraftReservation] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.id, stringValue(objectValue(paymentDraftRun?.data).reservationId)))
      .limit(1);
    const [paymentDraftUsage] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.id, stringValue(objectValue(paymentDraftRun?.data).usageEventId)))
      .limit(1);
    const [paymentDraftAudit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workerRunId, paymentDraftResult.workerRunId),
          eq(auditEvents.type, "worker.finance_operations.payment_draft_prepare.completed"),
        ),
      )
      .limit(1);

    expect(paymentDraftEnvelope.command).toBe("payment_draft.prepare");
    expect(objectValue(paymentDraftEnvelope.worker).role).toBe("finance_operations");
    expect(paymentDraftResult.created).toBe(true);
    expect(paymentDraftResult.workflowStepIds).toHaveLength(3);
    expect(paymentDraftOutput.externalExecution).toBe("blocked");
    expect(paymentDraftOutput.externalMutation).toBe(false);
    expect(paymentDraftOutput.externalSend).toBe(false);
    expect(paymentDraftOutput.paymentLink).toBe("blocked");
    expect(paymentDraftOutput.moneyMovement).toBe("blocked");
    expect(paymentDraftOutput.requiresApproval).toBe(true);
    expect(paymentDraftOutput.requiresDualControl).toBe(true);
    expect(paymentDraftOutput.paymentInstructionId).toBe(paymentDraftResult.paymentInstructionId);
    expect(paymentDraftRun?.source).toBe("continuous.worker");
    expect(paymentDraftRun?.state).toBe("done");
    expect(paymentDraftObject?.type).toBe("payment");
    expect(paymentDraftObject?.state).toBe("dual_control_pending");
    expect(paymentDraftPayment?.state).toBe("dual_control_pending");
    expect(paymentDraftInstruction?.kind).toBe("finance_payment_draft");
    expect(paymentDraftInstruction?.state).toBe("dual_control_pending");
    expect(objectValue(paymentDraftInstruction?.data).moneyMovement).toBe("blocked");
    expect(paymentDraftWorkflow?.state).toBe("dual_control_pending");
    expect(paymentDraftApproval?.state).toBe("pending");
    expect(paymentDraftApproval?.kind).toBe("finance_payment_draft_approval");
    expect(paymentDraftPacket?.kind).toBe("cash_packet");
    expect(paymentDraftDocument?.kind).toBe("finance_payment_draft");
    expect(paymentDraftView?.key).toBe("finance.payment.review");
    expect(objectValue(paymentDraftView?.contract).externalExecution).toBe("blocked");
    expect(objectValue(paymentDraftView?.actions).decisionCommand).toBe("approval.decide");
    expect(objectValue(objectValue(paymentDraftView?.data).latest).paymentInstructionId).toBe(
      paymentDraftResult.paymentInstructionId,
    );
    expect(paymentDraftReservation?.state).toBe("used");
    expect(paymentDraftUsage?.reservationId).toBe(paymentDraftReservation?.id);
    expect(objectValue(paymentDraftAudit?.data).moneyMovement).toBe("blocked");
    expect(
      paymentDraftResult.snapshot.paymentDrafts.some(
        (payment) => payment.id === paymentDraftResult.paymentObjectId,
      ),
    ).toBe(true);

    const paymentDraftReplayResponse = await executeWorkerCommand({
      command: "payment_draft.prepare",
      target: {
        role: "finance_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-finance-payment-draft-${runId}`,
      config: {
        sourceRefs: {
          paymentId: "44444444-4444-4444-8444-000000000007",
        },
        payee: "Acme Roofing Supplies",
        method: "ach",
        policy: {
          requireOwnerApproval: true,
          requireDualControl: true,
          moneyMovement: "blocked",
        },
      },
    });
    const paymentDraftReplayResult = paymentDraftReplayResponse.result as Awaited<
      ReturnType<typeof import("./finance").prepareFinancePaymentDraft>
    >;

    expect(paymentDraftReplayResult.created).toBe(false);
    expect(paymentDraftReplayResult.workerRunId).toBe(paymentDraftResult.workerRunId);
    expect(paymentDraftReplayResult.paymentObjectId).toBe(paymentDraftResult.paymentObjectId);
    expect(paymentDraftReplayResult.paymentInstructionId).toBe(paymentDraftResult.paymentInstructionId);

    const exceptionResponse = await executeWorkerCommand({
      command: "exception.route",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-exception-${runId}`,
      config: {
        jobId: jobObjectId,
        reason: "missing_photos",
        severity: "high",
        sourceRefs: {
          customerObjectId,
          workOrderObjectId,
          appointmentObjectId,
          closeoutObjectId: closeoutResult.closeoutObjectId,
          evidenceIds: [completionEvidenceId],
        },
        notes: "Route missing photo exception before finance handoff.",
      },
    });
    const exceptionResult = exceptionResponse.result as Awaited<
      ReturnType<typeof import("./dispatch").routeDispatchException>
    >;
    const exceptionOutput = objectValue(exceptionResult.output);
    const [exceptionRun] = await db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.id, exceptionResult.workerRunId))
      .limit(1);
    const [exceptionTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, exceptionResult.taskId ?? ""))
      .limit(1);
    const [exceptionDecision] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, exceptionResult.decisionId ?? ""))
      .limit(1);
    const [exceptionPacket] = await db
      .select()
      .from(evidencePackets)
      .where(eq(evidencePackets.id, exceptionResult.packetId ?? ""))
      .limit(1);
    const [exceptionDocument] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, exceptionResult.documentId ?? ""))
      .limit(1);

    expect(exceptionResponse.command).toBe("exception.route");
    expect(exceptionResponse.worker.role).toBe("dispatch_operations");
    expect(exceptionResult.created).toBe(true);
    expect(exceptionResult.workflowStepIds).toHaveLength(2);
    expect(exceptionOutput.externalExecution).toBe("blocked");
    expect(exceptionOutput.externalSend).toBe(false);
    expect(exceptionOutput.requiresOperatorReview).toBe(true);
    expect(exceptionOutput.jobObjectId).toBe(jobObjectId);
    expect(exceptionOutput.workOrderObjectId).toBe(workOrderObjectId);
    expect(exceptionOutput.closeoutObjectId).toBe(closeoutResult.closeoutObjectId);
    expect(exceptionOutput.reason).toBe("missing_photos");
    expect(exceptionOutput.severity).toBe("high");
    expect(exceptionOutput.taskId).toBe(exceptionResult.taskId);
    expect(exceptionOutput.decisionId).toBe(exceptionResult.decisionId);
    expect(exceptionRun?.source).toBe("continuous.worker");
    expect(exceptionRun?.state).toBe("done");
    expect(exceptionTask?.state).toBe("blocked");
    expect(exceptionTask?.priority).toBe("high");
    expect(objectValue(exceptionTask?.outcome).status).toBe("dispatch_exception_routed");
    expect(exceptionDecision?.kind).toBe("dispatch_exception_route");
    expect(exceptionDecision?.decision).toBe("route_to_dispatch_review");
    expect(exceptionPacket?.kind).toBe("dispatch_exception_packet");
    expect(exceptionDocument?.kind).toBe("dispatch_exception_packet");
    expect(exceptionResult.snapshot.exceptions.some((task) => task.id === exceptionResult.taskId)).toBe(true);

    const exceptionReplay = await executeWorkerCommand({
      command: "exception.route",
      target: {
        role: "dispatch_operations",
        tenantSlug: "continuous-demo",
      },
      operatorEmail: "owner@continuoushq.com",
      idempotencyKey: `ci-dispatch-exception-${runId}`,
      config: {
        jobId: jobObjectId,
        reason: "missing_photos",
        severity: "high",
        sourceRefs: {
          customerObjectId,
          workOrderObjectId,
          appointmentObjectId,
          closeoutObjectId: closeoutResult.closeoutObjectId,
          evidenceIds: [completionEvidenceId],
        },
        notes: "Route missing photo exception before finance handoff.",
      },
    });
    const exceptionReplayResult = exceptionReplay.result as Awaited<
      ReturnType<typeof import("./dispatch").routeDispatchException>
    >;

    expect(exceptionReplayResult.created).toBe(false);
    expect(exceptionReplayResult.workerRunId).toBe(exceptionResult.workerRunId);
    expect(exceptionReplayResult.taskId).toBe(exceptionResult.taskId);
    expect(exceptionReplayResult.decisionId).toBe(exceptionResult.decisionId);
  }, 120_000);
});
