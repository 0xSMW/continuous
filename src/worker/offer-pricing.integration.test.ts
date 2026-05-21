import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../db/client";
import { executeAppServerWorkerTool } from "./app-server-tools";
import { executeWorkerCommand, executeWorkerView } from "./registry";

const runIntegration = Boolean(process.env.CI && process.env.DATABASE_URL);
const maybeDescribe = runIntegration ? describe : describe.skip;
const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;

const tenantSlug = "continuous-demo";
const operatorEmail = "owner@continuoushq.com";
const offerPricingWorker = {
  role: "offer_pricing_operations",
  tenantSlug,
};
const seedIds = {
  quoteObject: "33333333-3333-4333-8333-000000000004",
  leadObject: "33333333-3333-4333-8333-000000000002",
  customerObject: "33333333-3333-4333-8333-000000000001",
  priceBookObject: "33333333-3333-4333-8333-000000000014",
  marginRuleObject: "33333333-3333-4333-8333-000000000015",
  discountPolicyObject: "33333333-3333-4333-8333-000000000016",
  quotePacket: "88888888-8888-4888-8888-000000000007",
  quoteApproval: "99999999-9999-4999-8999-000000000003",
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function expectGeneratedId(value: unknown) {
  expect(stringValue(value)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

maybeDescribe("Offer and Pricing Worker integration", () => {
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

  it("prepares a margin review through the generic worker envelope and replays idempotently", async () => {
    const idempotencyKey = `ci-pricing-margin-review-${randomUUID()}`;
    const config = {
      sourceRefs: {
        quoteObjectId: seedIds.quoteObject,
        leadObjectId: seedIds.leadObject,
        customerObjectId: seedIds.customerObject,
        evidencePacketId: seedIds.quotePacket,
        approvalRequestId: seedIds.quoteApproval,
      },
      policy: {
        marginRuleId: seedIds.marginRuleObject,
        discountPolicyId: seedIds.discountPolicyObject,
        priceBookId: seedIds.priceBookObject,
        requireOwnerApproval: true,
      },
    };

    const response = await executeAppServerWorkerTool("continuous.worker.command", {
      command: "margin.review.prepare",
      worker: offerPricingWorker,
      idempotencyKey,
      config,
    });
    const envelope = objectValue(response);
    const result = objectValue(envelope.result);
    const output = objectValue(result.output);

    expect(envelope.command).toBe("margin.review.prepare");
    expect(objectValue(envelope.worker).role).toBe("offer_pricing_operations");
    expect(result.created).toBe(true);
    for (const field of [
      "workerRunId",
      "taskId",
      "eventId",
      "pricingReviewObjectId",
      "approvalRequestId",
      "evidenceId",
      "packetId",
      "documentId",
      "workflowRunId",
      "pricePolicyViewId",
    ]) {
      expectGeneratedId(result[field]);
    }
    expect(arrayValue(result.workflowStepIds)).toHaveLength(3);
    expect(result.externalExecution).toBe("blocked");
    expect(result.externalPublish).toBe("blocked");
    expect(result.externalSend).toBe(false);
    expect(objectValue(output.handoff).name).toBe("revenue.quote_to_pricing");
    expect(objectValue(output.marginVerdict).state).toBe("pass");
    expect(objectValue(output.discountVerdict).state).toBe("pass");

    const view = await executeWorkerView({
      view: "price_policy",
      target: offerPricingWorker,
      operatorEmail,
      config: {
        quoteObjectId: seedIds.quoteObject,
        priceBookId: seedIds.priceBookObject,
      },
    });
    const viewData = objectValue(view.data.pricePolicy);

    expect(view.error).toBeNull();
    expect(objectValue(viewData.latest).quoteObjectId).toBe(seedIds.quoteObject);
    expect(objectValue(viewData.latest).externalPublish).toBe("blocked");

    const replayResponse = await executeWorkerCommand({
      command: "margin.review.prepare",
      target: offerPricingWorker,
      operatorEmail,
      idempotencyKey,
      config,
    });
    const replay = objectValue(replayResponse.result);

    expect(replay.created).toBe(false);
    expect(replay.workerRunId).toBe(result.workerRunId);
    expect(replay.pricePolicyViewId).toBe(result.pricePolicyViewId);
  });
});
