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
    name: "worker.lead.read",
    description: "Read inbound lead source records into persisted Core intake selectors.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "lead.read",
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
          description:
            "Read-only source intake configuration. Provide source records directly or reference an active connection through config.reader; records are persisted as Core lead object/event/evidence rows and returned as config.intake selectors for worker.run.",
          properties: {
            source: { type: "string" },
            sourceKind: { type: "string" },
            reader: { $ref: "#/$defs/sourceReader" },
            records: {
              type: "array",
              minItems: 1,
              maxItems: 25,
              items: { $ref: "#/$defs/leadSourceRecord" },
            },
            record: { $ref: "#/$defs/leadSourceRecord" },
          },
          required: ["source"],
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.lead.classify",
    description: "Classify a persisted or direct lead packet without external execution.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "lead.classify",
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
          description:
            "Lead classification configuration. Prefer persisted config.intake selectors; config.leadPacket is a direct operator/test fallback.",
          properties: {
            intake: { $ref: "#/$defs/intake" },
            leadPacket: { $ref: "#/$defs/leadPacket" },
            expectedAction: { type: "string" },
          },
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.response.draft",
    description: "Draft an owner-reviewable customer response without sending it.",
    registry: {
      role: "revenue_operations",
      surface: "command",
      command: "response.draft",
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
          description:
            "Response draft configuration. Prefer persisted config.intake selectors; config.leadPacket is a direct operator/test fallback.",
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
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.dispatch.schedule.propose",
    description: "Prepare a dry-run dispatch schedule proposal from Core job and handoff refs.",
    registry: {
      role: "dispatch_operations",
      surface: "command",
      command: "schedule.propose",
      idempotency: "required",
      externalExecution: "dry_run",
      requiresTenant: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description:
            "Dispatch schedule proposal config. Put Core handoff selectors under sourceRefs and schedule constraints under constraints.",
          properties: {
            jobId: { type: "string" },
            sourceRefs: { $ref: "#/$defs/sourceRefs" },
            constraints: { $ref: "#/$defs/scheduleConstraints" },
          },
          required: ["constraints"],
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.dispatch.customer_update.draft",
    description: "Draft a customer update from Core job evidence without sending it.",
    registry: {
      role: "dispatch_operations",
      surface: "command",
      command: "customer_update.draft",
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
          description:
            "Dispatch customer update draft config. Put operation data under config with jobId, updateKind, optional channel, sourceRefs, and messageContext.",
          properties: {
            jobId: { type: "string" },
            updateKind: { type: "string" },
            channel: { type: "string" },
            sourceRefs: { $ref: "#/$defs/sourceRefs" },
            messageContext: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["jobId", "updateKind"],
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.dispatch.closeout.prepare",
    description: "Prepare a closeout packet and QA checklist without external invoice or customer send.",
    registry: {
      role: "dispatch_operations",
      surface: "command",
      command: "closeout.prepare",
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
          description:
            "Dispatch closeout config. Put work order selectors and source evidence under config, with sourceRefs as a keyed object and optional QA checklist, notes, invoice readiness, and billable lines.",
          properties: {
            workOrderId: { type: "string" },
            sourceRefs: { $ref: "#/$defs/sourceRefs" },
            photoEvidenceIds: {
              type: "array",
              items: { type: "string" },
            },
            evidenceIds: {
              type: "array",
              items: { type: "string" },
            },
            completionEvidenceIds: {
              type: "array",
              items: { type: "string" },
            },
            qaChecklist: {
              type: "object",
              additionalProperties: true,
            },
            completionNotes: { type: "string" },
            invoiceReady: { type: "boolean" },
            billableLines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
          required: ["workOrderId"],
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.dispatch.exception.route",
    description: "Route a dispatch exception into Core task, decision, and evidence records.",
    registry: {
      role: "dispatch_operations",
      surface: "command",
      command: "exception.route",
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
          description:
            "Dispatch exception config. Put the job selector, reason, severity, and optional related Core refs under config.",
          properties: {
            jobId: { type: "string" },
            reason: { type: "string" },
            severity: { enum: ["low", "medium", "high", "critical"] },
            kind: { type: "string" },
            notes: { type: "string" },
            note: { type: "string" },
            sourceRefs: { $ref: "#/$defs/sourceRefs" },
            evidenceIds: {
              type: "array",
              items: { type: "string" },
            },
            sourceEvidenceIds: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["jobId", "reason", "severity"],
          additionalProperties: true,
        },
      },
      required: ["worker", "idempotencyKey", "config"],
    },
  },
  {
    name: "worker.continue",
    description: "Continue a worker-owned approval outcome with structured config.",
    registry: {
      role: "*",
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
      role: "*",
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
      role: "*",
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
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
      required: ["worker"],
    },
  },
  {
    name: "worker.adapters.retry",
    description:
      "Execute due dry-run adapter retries, recording live-credential and rollback readiness while external execution stays blocked.",
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
            limit: { type: "integer", minimum: 1, maximum: 100 },
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
              minItems: 1,
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
              minItems: 1,
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
    leadSourceRecord: {
      type: "object",
      properties: {
        sourceEventId: { type: "string" },
        externalId: { type: "string" },
        messageId: { type: "string" },
        threadId: { type: "string" },
        from: { type: "string" },
        subject: { type: "string" },
        snippet: { type: "string" },
        receivedAt: { type: "string", format: "date-time" },
        accountName: { type: "string" },
        companyName: { type: "string" },
        contactName: { type: "string" },
        opportunityName: { type: "string" },
        dealName: { type: "string" },
        stage: { type: "string" },
        occurredAt: { type: "string", format: "date-time" },
        customerName: { type: "string" },
        customerIntent: { type: "string" },
        serviceArea: { type: "string" },
        urgency: { enum: ["low", "normal", "high", "urgent", "emergency", "same_day"] },
        missingFacts: {
          type: "array",
          items: { type: "string" },
        },
        leadPacket: { $ref: "#/$defs/leadPacket" },
        payload: {
          type: "object",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
    sourceReader: {
      type: "object",
      properties: {
        kind: { enum: ["website_form", "source_record", "inbox", "crm"] },
        type: { enum: ["website_form", "source_record", "inbox", "crm"] },
        provider: { type: "string" },
        connectionRef: { type: "string" },
        connectionId: { type: "string" },
        credentialRef: { type: "string" },
        cursor: { type: "string" },
        syncCursor: { type: "string" },
        mode: { enum: ["read_only", "read", "snapshot"] },
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
    sourceRefs: {
      type: "object",
      description: "Core handoff selectors from another worker or workflow.",
      properties: {
        customerObjectId: { type: "string" },
        quoteObjectId: { type: "string" },
        jobObjectId: { type: "string" },
        jobId: { type: "string" },
        workOrderObjectId: { type: "string" },
        workOrderId: { type: "string" },
        appointmentObjectId: { type: "string" },
        customerUpdateObjectId: { type: "string" },
        closeoutObjectId: { type: "string" },
        approvalRequestId: { type: "string" },
        adapterReceiptEvidenceId: { type: "string" },
        workflowRunId: { type: "string" },
        evidenceIds: {
          type: "array",
          items: { type: "string" },
        },
        sourceEvidenceIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: true,
    },
    scheduleConstraints: {
      type: "object",
      properties: {
        serviceWindow: { type: "string" },
        durationMinutes: { type: "integer", minimum: 15, maximum: 480 },
        crewSkills: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      additionalProperties: true,
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

const workerToolEnvelopeFields = new Set(["worker", "idempotencyKey", "config", "operatorEmail"]);

function assertWorkerToolEnvelope(payload: JsonObject) {
  const unexpectedFields = Object.keys(payload).filter((field) => !workerToolEnvelopeFields.has(field));

  if (unexpectedFields.length > 0) {
    throw new Error(
      `Worker tool payload fields must be worker, idempotencyKey, config, and operatorEmail. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
    );
  }
}

export async function executeWorkerTool(name: string, payload: JsonObject = {}) {
  assertWorkerToolEnvelope(payload);

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

  if (name === "worker.lead.read") {
    return executeWorkerCommand({
      command: "lead.read",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.lead.classify") {
    return executeWorkerCommand({
      command: "lead.classify",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.response.draft") {
    return executeWorkerCommand({
      command: "response.draft",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.dispatch.schedule.propose") {
    return executeWorkerCommand({
      command: "schedule.propose",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.dispatch.customer_update.draft") {
    return executeWorkerCommand({
      command: "customer_update.draft",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.dispatch.closeout.prepare") {
    return executeWorkerCommand({
      command: "closeout.prepare",
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  if (name === "worker.dispatch.exception.route") {
    return executeWorkerCommand({
      command: "exception.route",
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
