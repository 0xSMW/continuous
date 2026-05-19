import { env } from "../env";
import type { JsonObject } from "../db/schema";
import { reconcileAdapterLedger } from "../core/adapters";
import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
} from "../core/approvals";
import { getRevenueWorkerSnapshotSafe, runRevenueWorker } from "./revenue";
import { normalizeIdempotencyKey } from "./security";

export const workerTools = [
  {
    name: "worker.snapshot",
    description: "Read a worker snapshot by role, tenant, or worker id.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        config: { type: "object" },
      },
      required: ["worker"],
    },
  },
  {
    name: "worker.run",
    description: "Run a worker with an idempotency key and structured config.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: { type: "object" },
      },
      required: ["worker", "idempotencyKey"],
    },
  },
  {
    name: "worker.approvals.list",
    description: "List pending or decided worker approval requests.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        config: {
          type: "object",
          properties: {
            state: { type: "string" },
          },
        },
      },
      required: ["worker"],
    },
  },
  {
    name: "worker.approvals.decide",
    description: "Decide a worker approval request with an operator action.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        config: {
          type: "object",
          properties: {
            approvalId: { type: "string" },
            action: {
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          required: ["approvalId", "action"],
        },
      },
      required: ["worker", "config"],
    },
  },
  {
    name: "worker.adapters.reconcile",
    description: "Reconcile pending dry-run adapter runs/actions without external execution.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        config: {
          type: "object",
          properties: {
            limit: { type: "number", minimum: 1, maximum: 100 },
          },
        },
      },
      required: ["worker"],
    },
  },
] as const;

export const workerToolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    workerTarget: {
      type: "object",
      properties: {
        role: { type: "string", default: "revenue_operations" },
        id: { type: "string" },
        tenantSlug: { type: "string" },
      },
    },
  },
  tools: workerTools,
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetFrom(payload: JsonObject) {
  const target = objectValue(payload.worker);
  const role = stringValue(target.role) ?? "revenue_operations";

  if (role !== "revenue_operations") {
    throw new Error(`Worker role ${role} is not available yet.`);
  }

  return {
    role,
    workerId: stringValue(target.id),
    tenantSlug: stringValue(target.tenantSlug),
  };
}

export async function executeWorkerTool(name: string, payload: JsonObject = {}) {
  const target = targetFrom(payload);
  const config = jsonObject(payload.config);
  const operatorEmail = stringValue(payload.operatorEmail) ?? env.REVENUE_WORKER_OPERATOR_EMAIL;

  if (name === "worker.snapshot") {
    const result = await getRevenueWorkerSnapshotSafe({
      role: target.role,
      tenantSlug: target.tenantSlug,
      workerId: target.workerId,
    });

    return {
      worker: target,
      snapshot: result.snapshot,
      error: result.error,
    };
  }

  if (name === "worker.run") {
    const idempotency = normalizeIdempotencyKey(payload.idempotencyKey);

    if (!idempotency.ok) {
      throw new Error(idempotency.message);
    }

    return {
      worker: target,
      result: await runRevenueWorker({
        idempotencyKey: idempotency.key,
        tenantSlug: target.tenantSlug,
        workerId: target.workerId,
        operatorEmail,
        config,
      }),
    };
  }

  if (name === "worker.approvals.list") {
    return {
      worker: target,
      result: await listApprovals({
        operatorEmail,
        tenantSlug: target.tenantSlug,
        state: stringValue(config.state),
        subject: "worker",
      }),
    };
  }

  if (name === "worker.approvals.decide") {
    const approvalId = stringValue(config.approvalId);
    const action = normalizeApprovalDecision(config.action);

    if (!approvalId || !action) {
      throw new Error("config.approvalId and config.action are required.");
    }

    return {
      worker: target,
      result: await decideApproval({
        approvalId,
        operatorEmail,
        tenantSlug: target.tenantSlug,
        action,
        note: stringValue(config.note),
        subject: "worker",
      }),
    };
  }

  if (name === "worker.adapters.reconcile") {
    if (!target.tenantSlug) {
      throw new Error("worker.tenantSlug is required for adapter reconciliation.");
    }

    return {
      worker: target,
      result: await reconcileAdapterLedger({
        tenantSlug: target.tenantSlug,
        limit: typeof config.limit === "number" ? config.limit : undefined,
      }),
    };
  }

  throw new Error(`Unknown worker tool: ${name}`);
}
