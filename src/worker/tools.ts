import type { JsonObject } from "../db/schema";
import {
  executeWorkerCommand,
  executeWorkerView,
  registeredWorkerCommands,
  registeredWorkerViews,
  type WorkerTargetInput,
} from "./registry";
import {
  plannedWorkerCommands,
  plannedWorkerContracts,
  plannedWorkerViews,
} from "./planned-workers";

export const workerTools = [
  {
    name: "worker.snapshot",
    description: "Read a worker snapshot by role, tenant, or worker id.",
    registry: {
      role: "*",
      surface: "view",
      view: "snapshot",
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
      },
      required: ["worker"],
    },
  },
  {
    name: "worker.owner.briefs.list",
    description: "List generated owner briefs.",
    registry: {
      role: "owner_chief_of_staff",
      surface: "view",
      view: "briefs",
    },
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
    name: "worker.owner.decisions.list",
    description: "List owner decision proposals.",
    registry: {
      role: "owner_chief_of_staff",
      surface: "view",
      view: "decisions",
    },
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
    name: "worker.run",
    description: "Run a worker with an idempotency key and structured config.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "run",
      idempotency: "required",
      externalExecution: "blocked",
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description:
            "Worker-specific run configuration. Revenue operations runs prefer intake references to persisted Core records; leadPacket is a direct operator/test fallback.",
          properties: {
            intake: { $ref: "#/$defs/intake" },
            leadPacket: { $ref: "#/$defs/leadPacket" },
            pricing: {
              type: "object",
              properties: {
                baseCents: { type: "number", minimum: 0 },
              },
            },
            expectedAction: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey"],
    },
  },
  {
    name: "worker.continue",
    description: "Continue a worker-owned approval outcome with structured config.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "continue",
      idempotency: "required",
      externalExecution: "blocked",
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          properties: {
            approvalId: { type: "string" },
          },
          required: ["approvalId"],
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.approvals.list",
    description: "List pending or decided worker approval requests.",
    registry: {
      role: "revenue_operations",
      surface: "view",
      view: "approvals",
    },
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
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "approval.decide",
      idempotency: "none",
      externalExecution: "blocked",
    },
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
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "adapters.reconcile",
      idempotency: "none",
      externalExecution: "blocked",
      requiresTenant: true,
    },
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
  {
    name: "worker.adapters.retry",
    description: "Execute due dry-run adapter retries without external execution.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "adapters.retry",
      idempotency: "none",
      externalExecution: "blocked",
      requiresTenant: true,
    },
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
  {
    name: "worker.owner.brief.generate",
    description: "Generate an owner brief from tenant-scoped Core records.",
    registry: {
      role: "owner_chief_of_staff",
      surface: "command",
      command: "brief.generate",
      idempotency: "required",
      externalExecution: "blocked",
      requiresTenant: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          properties: {
            window: { $ref: "#/$defs/window" },
            scopes: {
              type: "array",
              items: {
                enum: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
              },
            },
            includeEvidence: { type: "boolean" },
          },
          required: ["window", "scopes"],
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.owner.decision_queue.prepare",
    description: "Prepare source-backed owner decision proposals.",
    registry: {
      role: "owner_chief_of_staff",
      surface: "command",
      command: "decision_queue.prepare",
      idempotency: "required",
      externalExecution: "blocked",
      requiresTenant: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          properties: {
            window: { $ref: "#/$defs/window" },
            priorityFloor: { type: "string" },
          },
          required: ["window"],
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.owner.anomaly.triage",
    description: "Triage owner-facing metric anomalies without external execution.",
    registry: {
      role: "owner_chief_of_staff",
      surface: "command",
      command: "anomaly.triage",
      idempotency: "required",
      externalExecution: "blocked",
      requiresTenant: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          properties: {
            window: { $ref: "#/$defs/window" },
            metricKeys: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["window", "metricKeys"],
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
] as const;

export const workerToolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  registry: {
    commands: registeredWorkerCommands(),
    views: registeredWorkerViews(),
    plannedContracts: plannedWorkerContracts.map((contract) => ({
      role: contract.role,
      name: contract.name,
      contractPath: contract.contractPath,
      firstOutcome: contract.firstOutcome,
      autonomyLevel: contract.autonomyLevel,
      externalExecution: contract.externalExecution,
      evidencePacket: contract.evidencePacket,
    })),
    plannedCommands: plannedWorkerCommands(),
    plannedViews: plannedWorkerViews(),
  },
  $defs: {
    workerTarget: {
      type: "object",
      properties: {
        role: { type: "string" },
        id: { type: "string" },
        tenantSlug: { type: "string" },
      },
      required: ["role"],
    },
    leadPacket: {
      type: "object",
      properties: {
        source: { type: "string" },
        sourceEventId: { type: "string" },
        customerName: { type: "string" },
        customerIntent: { type: "string" },
        serviceArea: { type: "string" },
        urgency: { enum: ["low", "normal", "high", "urgent", "emergency", "same_day"] },
        missingFacts: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: true,
    },
    intake: {
      type: "object",
      description:
        "Persisted Core lead intake selector. Prefer source plus sourceEventId for external callers; eventId/objectId/evidenceId are internal Core row ids.",
      properties: {
        eventId: { type: "string" },
        objectId: { type: "string" },
        evidenceId: { type: "string" },
        source: { type: "string" },
        sourceEventId: { type: "string" },
      },
      additionalProperties: true,
    },
    window: {
      type: "object",
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
      },
      required: ["from", "to"],
    },
  },
  tools: workerTools,
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetFrom(payload: JsonObject): WorkerTargetInput {
  const target = objectValue(payload.worker);
  return {
    role: stringValue(target.role),
    id: stringValue(target.id),
    tenantSlug: stringValue(target.tenantSlug),
  };
}

export async function executeWorkerTool(name: string, payload: JsonObject = {}) {
  const target = targetFrom(payload);
  const config = payload.config;
  const viewConfig = objectValue(payload.config);
  const operatorEmail = stringValue(payload.operatorEmail) ?? process.env.WORKER_OPERATOR_EMAIL ?? "";

  if (name === "worker.snapshot") {
    const result = await executeWorkerView({
      view: "snapshot",
      target,
      operatorEmail,
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  if (name === "worker.run") {
    return executeWorkerCommand({
      command: "run",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.continue") {
    return executeWorkerCommand({
      command: "continue",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.approvals.list") {
    const result = await executeWorkerView({
      view: "approvals",
      target,
      operatorEmail,
      state: stringValue(viewConfig.state),
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  if (name === "worker.owner.briefs.list") {
    const result = await executeWorkerView({
      view: "briefs",
      target,
      operatorEmail,
      state: stringValue(viewConfig.state),
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  if (name === "worker.owner.decisions.list") {
    const result = await executeWorkerView({
      view: "decisions",
      target,
      operatorEmail,
      state: stringValue(viewConfig.state),
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  if (name === "worker.approvals.decide") {
    return executeWorkerCommand({
      command: "approval.decide",
      target,
      operatorEmail,
      config,
    });
  }

  if (name === "worker.adapters.reconcile") {
    return executeWorkerCommand({
      command: "adapters.reconcile",
      target,
      operatorEmail,
      config,
    });
  }

  if (name === "worker.adapters.retry") {
    return executeWorkerCommand({
      command: "adapters.retry",
      target,
      operatorEmail,
      config,
    });
  }

  if (name === "worker.owner.brief.generate") {
    return executeWorkerCommand({
      command: "brief.generate",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.owner.decision_queue.prepare") {
    return executeWorkerCommand({
      command: "decision_queue.prepare",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.owner.anomaly.triage") {
    return executeWorkerCommand({
      command: "anomaly.triage",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  throw new Error(`Unknown worker tool: ${name}`);
}
