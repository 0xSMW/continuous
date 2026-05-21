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
  runtimeWorkerContracts,
  workerContracts,
  workerExpansionCatalog,
  workerFollowUpCommands,
  workerFollowUpViews,
} from "./planned-workers";
import {
  unexpectedEnvelopeFields,
  validateWorkerConfigEnvelope,
  validateWorkerTargetEnvelope,
  workerCommandEnvelopeDescription,
  workerCommandEnvelopeFieldSet,
  workerEnvelopeFieldError,
  workerViewEnvelopeDescription,
  workerViewEnvelopeFieldSet,
} from "./envelope";

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
          description: "Registered view name.",
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
      },
      required: ["view", "worker", "config"],
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
      },
      required: ["command", "worker", "config"],
      additionalProperties: false,
    },
  },
] as const;

const registeredCommands = registeredWorkerCommands();
const registeredViews = registeredWorkerViews();
const followUpCommands = workerFollowUpCommands(registeredCommands);
const followUpViews = workerFollowUpViews(registeredViews);

function contractSummary(contract: (typeof workerContracts)[number]) {
  return {
    role: contract.role,
    name: contract.name,
    apiRoute: contract.apiRoute,
    contractPath: contract.contractPath,
    firstOutcome: contract.firstOutcome,
    autonomyLevel: contract.autonomyLevel,
    externalExecution: contract.externalExecution,
    evidencePacket: contract.evidencePacket,
  };
}

export const workerToolSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  registry: {
    commands: registeredCommands,
    views: registeredViews,
    contracts: workerContracts.map(contractSummary),
    runtimeContracts: runtimeWorkerContracts.map(contractSummary),
    plannedContracts: plannedWorkerContracts.map(contractSummary),
    followUpCommands,
    followUpViews,
    plannedCommands: followUpCommands,
    plannedViews: followUpViews,
    plannedFutureWorkerCommands: plannedWorkerCommands(),
    plannedFutureWorkerViews: plannedWorkerViews(),
    expansion: workerExpansionCatalog,
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
      additionalProperties: false,
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

export function assertTrustedLocalWorkerMutation(surface: string) {
  if (
    process.env.APP_ENV === "production" &&
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS !== "true"
  ) {
    throw new Error(
      `${surface} is a trusted local mutation surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.`,
    );
  }
}

export function assertTrustedLocalWorkerRead(surface: string) {
  if (
    process.env.APP_ENV === "production" &&
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS !== "true"
  ) {
    throw new Error(
      `${surface} is a trusted local read surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.`,
    );
  }
}

export function requiredLocalWorkerOperatorEmail(surface: string) {
  const operatorEmail = stringValue(process.env.WORKER_OPERATOR_EMAIL);

  if (!operatorEmail) {
    throw new Error(
      `${surface} requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.`,
    );
  }

  return operatorEmail;
}

function workerToolEnvelope(name: string) {
  if (name === "worker.command") {
    return {
      fields: workerCommandEnvelopeFieldSet,
      description: workerCommandEnvelopeDescription,
    };
  }

  if (name === "worker.view") {
    return {
      fields: workerViewEnvelopeFieldSet,
      description: workerViewEnvelopeDescription,
    };
  }

  return null;
}

function assertWorkerToolEnvelope(name: string, payload: JsonObject) {
  const envelope = workerToolEnvelope(name);

  if (!envelope) {
    throw new Error(`Unknown worker tool: ${name}`);
  }

  const unexpectedFields = unexpectedEnvelopeFields(payload, envelope.fields);

  if (unexpectedFields.length > 0) {
    throw new Error(workerEnvelopeFieldError("Worker tool payload", envelope.description, unexpectedFields));
  }

  const worker = payload.worker;
  const targetResult = validateWorkerTargetEnvelope(worker);

  if (!targetResult.ok) {
    throw new Error(targetResult.message);
  }

  if (name === "worker.command" || name === "worker.view") {
    const configResult = validateWorkerConfigEnvelope(payload.config);

    if (!configResult.ok) {
      throw new Error(configResult.message);
    }
  }
}

export async function executeWorkerTool(name: string, payload: JsonObject = {}) {
  assertWorkerToolEnvelope(name, payload);

  const target = targetFrom(payload);
  const config = payload.config;
  const viewConfig = objectValue(payload.config);

  if (name === "worker.view") {
    const view = stringValue(payload.view);

    if (!view) {
      throw new Error("worker.view requires view.");
    }
    assertTrustedLocalWorkerRead("worker.view");
    const operatorEmail = requiredLocalWorkerOperatorEmail("worker.view");

    const result = await executeWorkerView({
      view,
      target,
      operatorEmail,
      config: viewConfig,
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

    assertTrustedLocalWorkerMutation("worker.command");
    const operatorEmail = requiredLocalWorkerOperatorEmail("worker.command");

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
