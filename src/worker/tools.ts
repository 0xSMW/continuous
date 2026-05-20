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
    name: "worker.view",
    description: "Read a registered Continuous worker view through the canonical worker view envelope.",
    registry: {
      role: "*",
      surface: "view",
      view: "*",
    },
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          description: "Registered view name. Defaults to snapshot when omitted.",
        },
        worker: { $ref: "#/$defs/workerTarget" },
        config: {
          type: "object",
          description: "View config. Put read filters such as state under config.",
          properties: {
            state: { type: "string" },
          },
          additionalProperties: true,
        },
        operatorEmail: { type: "string" },
      },
      required: ["worker"],
      additionalProperties: false,
    },
  },
  {
    name: "worker.command",
    description: "Invoke any registered Continuous worker command through the canonical worker command envelope.",
    registry: {
      role: "*",
      surface: "command",
      command: "*",
      idempotency: "per_command",
      externalExecution: "registry_controlled",
      requiresTenant: "per_command",
    },
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Registered command name from workerToolSchema.registry.commands.",
        },
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description: "Command config. Put every operation-specific input under config.",
          additionalProperties: true,
        },
        operatorEmail: { type: "string" },
      },
      required: ["command", "worker"],
      additionalProperties: false,
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

const workerCommandToolEnvelopeFields = new Set([
  "command",
  "worker",
  "idempotencyKey",
  "config",
  "operatorEmail",
]);

const workerViewToolEnvelopeFields = new Set(["view", "worker", "config", "operatorEmail"]);

function workerToolEnvelope(name: string) {
  if (name === "worker.command") {
    return {
      fields: workerCommandToolEnvelopeFields,
      description: "command, worker, idempotencyKey, config, and operatorEmail",
    };
  }

  if (name === "worker.view") {
    return {
      fields: workerViewToolEnvelopeFields,
      description: "view, worker, config, and operatorEmail",
    };
  }

  return null;
}

function assertWorkerToolEnvelope(name: string, payload: JsonObject) {
  const envelope = workerToolEnvelope(name);

  if (!envelope) {
    throw new Error(`Unknown worker tool: ${name}`);
  }

  const unexpectedFields = Object.keys(payload).filter((field) => !envelope.fields.has(field));

  if (unexpectedFields.length > 0) {
    throw new Error(
      `Worker tool payload fields must be ${envelope.description}. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
    );
  }
}

export async function executeWorkerTool(name: string, payload: JsonObject = {}) {
  assertWorkerToolEnvelope(name, payload);

  const target = targetFrom(payload);
  const config = payload.config;
  const viewConfig = objectValue(payload.config);
  const operatorEmail = stringValue(payload.operatorEmail) ?? process.env.WORKER_OPERATOR_EMAIL ?? "";

  if (name === "worker.view") {
    const view = stringValue(payload.view) ?? "snapshot";
    const result = await executeWorkerView({
      view,
      target,
      operatorEmail,
      state: stringValue(viewConfig.state),
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  if (name === "worker.command") {
    const command = stringValue(payload.command);

    if (!command) {
      throw new Error("worker.command requires command.");
    }

    return executeWorkerCommand({
      command,
      target,
      operatorEmail,
      config,
      idempotencyKey: payload.idempotencyKey,
    });
  }

  throw new Error(`Unknown worker tool: ${name}`);
}
