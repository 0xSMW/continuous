import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../db/client";
import { budgetAccounts, budgetReservations, customers, objects, workers } from "../db/schema";
import { executeAppServerWorkerTool } from "./app-server-tools";
import { executeWorkerCommand, executeWorkerView } from "./registry";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;
const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

const tenantSlug = "continuous-demo";
const operatorEmail = "owner@continuoushq.com";
const growthWorker = {
  role: "growth_operations",
  tenantSlug,
};
const seedIds = {
  customerObject: "33333333-3333-4333-8333-000000000001",
  testimonial: "44444444-4444-4444-8444-000000000011",
  testimonialObject: "33333333-3333-4333-8333-000000000011",
  quotePacket: "88888888-8888-4888-8888-000000000007",
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function expectGeneratedId(value: unknown) {
  expect(stringValue(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

async function createGrowthBudgetReservation(input: { units?: number; state?: "held" | "used" } = {}) {
  const [worker] = await db
    .select({ id: workers.id, tenantId: workers.tenantId })
    .from(workers)
    .where(and(eq(workers.role, growthWorker.role), eq(workers.state, "training")))
    .limit(1);

  if (!worker) {
    throw new Error("Seeded Growth Worker is required for Growth integration tests.");
  }

  const [account] = await db
    .select({ id: budgetAccounts.id })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, worker.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .limit(1);

  if (!account) {
    throw new Error("Seeded Growth budget account is required for Growth integration tests.");
  }

  const [reservation] = await db
    .insert(budgetReservations)
    .values({
      tenantId: worker.tenantId,
      accountId: account.id,
      units: input.units ?? 75_000,
      state: input.state ?? "held",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ id: budgetReservations.id });

  if (!reservation) {
    throw new Error("Growth budget reservation insert did not return an id.");
  }

  return reservation.id;
}

async function createOtherCustomerObject() {
  const [worker] = await db
    .select({ tenantId: workers.tenantId })
    .from(workers)
    .where(and(eq(workers.role, growthWorker.role), eq(workers.state, "training")))
    .limit(1);
  const unique = randomUUID();

  if (!worker) {
    throw new Error("Seeded Growth Worker is required for Growth integration tests.");
  }

  const [object] = await db
    .insert(objects)
    .values({
      tenantId: worker.tenantId,
      type: "customer",
      name: "Other Growth Customer",
      state: "active",
      source: "test",
      externalId: `growth-customer-mismatch:${unique}`,
      data: { name: "Other Growth Customer" },
    })
    .returning({ id: objects.id });

  if (!object) {
    throw new Error("Growth customer object insert did not return an id.");
  }

  await db.insert(customers).values({
    tenantId: worker.tenantId,
    objectId: object.id,
    state: "active",
    externalId: `growth-customer-mismatch:${unique}`,
    data: { name: "Other Growth Customer" },
  });

  return object.id;
}

maybeDescribe("Growth Worker integration", () => {
  beforeAll(() => {
    process.env.APP_ENV = "test";
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    process.env.WORKER_OPERATOR_EMAIL = operatorEmail;

    execFileSync("bun", ["run", "db:migrate"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    execFileSync("bun", ["run", "db:seed"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
  }, 120_000);

  afterAll(async () => {
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }

    if (originalTrustedLocalWorkerTools === undefined) {
      delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
    } else {
      process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = originalTrustedLocalWorkerTools;
    }

    if (originalWorkerOperatorEmail === undefined) {
      delete process.env.WORKER_OPERATOR_EMAIL;
    } else {
      process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail;
    }

    await pool.end();
  });

  it("prepares a blocked growth campaign draft through the app-server worker envelope", async () => {
    const idempotencyKey = `ci-growth-campaign-${randomUUID()}`;
    const budgetReservationId = await createGrowthBudgetReservation();
    const config = {
      sourceRefs: {
        customerObjectId: seedIds.customerObject,
        customerSignalId: seedIds.testimonial,
        reviewObjectId: seedIds.testimonialObject,
        evidencePacketId: seedIds.quotePacket,
        budgetReservationId,
      },
      policy: {
        channel: "email",
        audience: "recent_customers",
        requiresOwnerApproval: true,
        allowPublish: false,
      },
      claims: [
        {
          text: "Customer feedback supports a campaign about reliable roof leak response.",
          sourceRefs: {
            customerSignalId: seedIds.testimonial,
            evidencePacketId: seedIds.quotePacket,
          },
        },
      ],
    };

    const response = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "campaign.draft",
      worker: growthWorker,
      idempotencyKey,
      config,
    });
    const envelope = objectValue(response);
    const result = objectValue(envelope.result);
    const output = objectValue(result.output);

    expect(envelope.command).toBe("campaign.draft");
    expect(objectValue(envelope.worker).role).toBe("growth_operations");
    expect(result.created).toBe(true);
    for (const field of [
      "workerRunId",
      "taskId",
      "eventId",
      "campaignObjectId",
      "contentDraftObjectId",
      "customerSignalId",
      "signalObjectId",
      "customerObjectId",
      "approvalRequestId",
      "evidenceId",
      "packetId",
      "documentId",
      "workflowRunId",
      "campaignsViewId",
      "budgetReservationId",
    ]) {
      expectGeneratedId(result[field]);
    }
    expect(arrayValue(result.workflowStepIds)).toHaveLength(4);
    expect(result.externalExecution).toBe("blocked");
    expect(result.externalPublish).toBe(false);
    expect(result.externalSend).toBe(false);
    expect(result.externalSpend).toBe(false);
    expect(result.trackingMutation).toBe("blocked");
    expect(objectValue(output.handoff).name).toBe("growth.campaign_to_owner_review");
    expect(objectValue(output.draft).externalPublish).toBe(false);
    expect(objectValue(output.draft).externalSend).toBe(false);
    expect(objectValue(output.draft).externalSpend).toBe(false);
    expect(objectValue(output.draft).trackingMutation).toBe("blocked");
    expect(objectValue(output.policy).adSpend).toBe("blocked");
    expect(objectValue(output.policy).allowPublish).toBe(false);
    expect(objectValue(output.policy).allowSend).toBe(false);
    expect(objectValue(output.policy).allowSpend).toBe(false);
    expect(objectValue(output.policy).allowTrackingMutation).toBe(false);

    const view = await executeWorkerView({
      view: "campaigns",
      target: growthWorker,
      operatorEmail,
      config: {
        channel: "email",
      },
    });
    const campaigns = objectValue(view.data.campaigns);

    expect(view.error).toBeNull();
    expect(view.data.view).toBe("campaigns");
    expect(objectValue(campaigns.controls).externalExecution).toBe("blocked");
    expect(objectValue(campaigns.controls).externalPublish).toBe("blocked");
    expect(objectValue(campaigns.controls).externalSend).toBe("blocked");
    expect(objectValue(campaigns.controls).adSpend).toBe("blocked");
    expect(objectValue(campaigns.controls).trackingMutation).toBe("blocked");
    expect(arrayValue(campaigns.campaigns).some((campaign) => objectValue(campaign).id === result.campaignObjectId)).toBe(true);
    expect(arrayValue(campaigns.contentDrafts).some((draft) => objectValue(draft).id === result.contentDraftObjectId)).toBe(true);

    const replayResponse = await executeWorkerCommand({
      command: "campaign.draft",
      target: growthWorker,
      operatorEmail,
      idempotencyKey,
      config,
    });
    const replay = objectValue(replayResponse.result);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(result.workerRunId);
    expect(replay.campaignObjectId).toBe(result.campaignObjectId);
    expect(replay.campaignsViewId).toBe(result.campaignsViewId);

    await expect(
      executeWorkerCommand({
        command: "campaign.draft",
        target: growthWorker,
        operatorEmail,
        idempotencyKey: `ci-growth-campaign-budget-reuse-${randomUUID()}`,
        config,
      }),
    ).rejects.toMatchObject({
      code: "worker_budget_reservation_already_bound",
      status: 409,
    });
  });

  it("rejects publish, send, spend, and tracking mutation requests", async () => {
    const budgetReservationId = await createGrowthBudgetReservation();

    await expect(
      executeWorkerCommand({
        command: "campaign.draft",
        target: growthWorker,
        operatorEmail,
        idempotencyKey: `ci-growth-publish-blocked-${randomUUID()}`,
        config: {
          sourceRefs: {
            customerObjectId: seedIds.customerObject,
            customerSignalId: seedIds.testimonial,
            evidencePacketId: seedIds.quotePacket,
            budgetReservationId,
          },
          policy: {
            channel: "email",
            audience: "recent_customers",
            requiresOwnerApproval: true,
            allowPublish: true,
            allowSend: true,
            allowSpend: true,
            allowTrackingMutation: true,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "worker_external_mutation_blocked",
    });
  });

  it("requires a held Growth budget reservation", async () => {
    const budgetReservationId = await createGrowthBudgetReservation({ state: "used" });

    await expect(
      executeWorkerCommand({
        command: "campaign.draft",
        target: growthWorker,
        operatorEmail,
        idempotencyKey: `ci-growth-budget-used-${randomUUID()}`,
        config: {
          sourceRefs: {
            customerObjectId: seedIds.customerObject,
            customerSignalId: seedIds.testimonial,
            evidencePacketId: seedIds.quotePacket,
            budgetReservationId,
          },
          policy: {
            channel: "email",
            audience: "recent_customers",
            requiresOwnerApproval: true,
            allowPublish: false,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "worker_budget_reservation_unavailable",
    });
  });

  it("rejects missing required source references", async () => {
    await expect(
      executeWorkerCommand({
        command: "campaign.draft",
        target: growthWorker,
        operatorEmail,
        idempotencyKey: `ci-growth-missing-refs-${randomUUID()}`,
        config: {
          sourceRefs: {
            customerSignalId: seedIds.testimonial,
            evidencePacketId: seedIds.quotePacket,
          },
          policy: {
            channel: "email",
            audience: "recent_customers",
            requiresOwnerApproval: true,
            allowPublish: false,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_worker_command_config",
    });
  });

  it("rejects customer refs that do not match the selected signal", async () => {
    const budgetReservationId = await createGrowthBudgetReservation();
    const otherCustomerObjectId = await createOtherCustomerObject();

    await expect(
      executeWorkerCommand({
        command: "campaign.draft",
        target: growthWorker,
        operatorEmail,
        idempotencyKey: `ci-growth-source-mismatch-${randomUUID()}`,
        config: {
          sourceRefs: {
            customerObjectId: otherCustomerObjectId,
            customerSignalId: seedIds.testimonial,
            evidencePacketId: seedIds.quotePacket,
            budgetReservationId,
          },
          policy: {
            channel: "email",
            audience: "recent_customers",
            requiresOwnerApproval: true,
            allowPublish: false,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "worker_customer_signal_mismatch",
    });
  });
});
