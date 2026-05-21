import type { JsonObject } from "../db/schema";
import { executeAiInference } from "./ai-gateway";
import { requestApproval } from "./approvals";
import { reserveBudget, chargeBudget, releaseBudget } from "./budgets";
import { grantCapability } from "./capabilities";
import { recordEntitySetup } from "./entity";
import { getHealth } from "./health";
import { scanObligations } from "./obligations";
import { preparePayrollPreviewPacket, recordPayrollPreview } from "./payroll";
import {
  attachCoreEvidence,
  createCoreDocument,
  ingestCoreEvent,
  linkCoreObjects,
  prepareCorePacket,
  publishCoreView,
  recordAdapterIntent,
  recordCoreConnectionHealth,
  recordCoreDecision,
  recordCustomerSignal,
  recordExternalAction,
  recordRuleChange,
  upsertCoreAdapter,
  upsertCoreConnection,
  upsertCoreObject,
} from "./primitives";
import { getCoreSummarySafe } from "./summary";
import { createCoreTask, transitionCoreTask } from "./tasks";
import { transitionCoreWorker, upsertCoreWorker } from "./workers";
import { completeCoreWorkerRun, startCoreWorkerRun } from "./worker-runs";
import { normalizeIdempotencyKey } from "../worker/security";

export type AppServerDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export type AppServerCoreTransportContext =
  | {
      operatorEmail: string;
      source: "control_plane";
      allowedAccess: Array<"read" | "write">;
      allowedCommands: string[];
      allowedTenants: string[];
      allowedWorkerRoles: string[];
    }
  | {
      operatorEmail: string;
      source: "trusted_local";
    };

export type AppServerCoreDynamicToolCallParams = {
  tool: string;
  arguments: unknown;
  callId: string;
  threadId: string;
  turnId: string;
};

export type AppServerCoreDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
};

const coreTargetEnvelopeFields = ["tenantSlug"] as const;
const coreCommandEnvelopeFields = ["command", "core", "idempotencyKey", "config"] as const;
const coreViewEnvelopeFields = ["view", "core", "config"] as const;
const coreTargetEnvelopeFieldSet = new Set<string>(coreTargetEnvelopeFields);
const coreCommandEnvelopeFieldSet = new Set<string>(coreCommandEnvelopeFields);
const coreViewEnvelopeFieldSet = new Set<string>(coreViewEnvelopeFields);
const coreOperationPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
export const coreOperationDescription =
  "Core command and view names must be registered lower_snake_case or dotted operation identifiers such as object.upsert or summary; do not use URL paths, route names, family-worker names, or query strings.";
const coreTargetEnvelopeDescription = describeEnvelopeFields(coreTargetEnvelopeFields);
const coreCommandEnvelopeDescription = describeEnvelopeFields(coreCommandEnvelopeFields);
const coreViewEnvelopeDescription = describeEnvelopeFields(coreViewEnvelopeFields);
const apiRoute = "/core";

export const appServerCoreCommandNames = [
  "task.create",
  "task.transition",
  "object.upsert",
  "adapter.upsert",
  "connection.upsert",
  "connection.health.record",
  "entity.setup.record",
  "worker.upsert",
  "worker.transition",
  "worker.run.start",
  "worker.run.complete",
  "object.link",
  "event.ingest",
  "evidence.attach",
  "document.create",
  "packet.prepare",
  "document.packet.prepare",
  "decision.record",
  "approval.request",
  "adapter.intent.record",
  "rule.change.record",
  "obligation.scan",
  "external_action.record",
  "capability.grant",
  "budget.reserve",
  "budget.charge",
  "budget.release",
  "ai.infer",
  "view.publish",
  "customer_signal.record",
  "payroll.preview.record",
  "payroll.preview.packet.prepare",
] as const;

export const appServerCoreViewNames = ["summary"] as const;

const appServerCoreCommandSet = new Set<string>(appServerCoreCommandNames);
const appServerCoreViewSet = new Set<string>(appServerCoreViewNames);

const coreTargetInputSchema = {
  type: "object",
  properties: {
    tenantSlug: { type: "string" },
  },
  required: ["tenantSlug"],
  additionalProperties: false,
} satisfies JsonObject;

export const appServerCoreTools = [
  {
    name: "continuous.core.schema",
    description:
      "Read the Continuous Core command and view registry exposed through the app-server bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "continuous.core.command",
    description:
      "Invoke a registered Continuous Core command through the canonical core payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: coreOperationDescription,
          pattern: coreOperationPattern.source,
        },
        core: { $ref: "#/$defs/coreTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description: "Command config. Put every operation-specific input under config.",
          additionalProperties: true,
        },
      },
      required: ["command", "core", "idempotencyKey", "config"],
      additionalProperties: false,
      $defs: {
        coreTarget: coreTargetInputSchema,
      },
    },
  },
  {
    name: "continuous.core.view",
    description:
      "Read a registered Continuous Core view through the canonical core view payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          description: coreOperationDescription,
          pattern: coreOperationPattern.source,
        },
        core: { $ref: "#/$defs/coreTarget" },
        config: {
          type: "object",
          description: "View config. Put read filters under config.",
          additionalProperties: true,
        },
      },
      required: ["view", "core", "config"],
      additionalProperties: false,
      $defs: {
        coreTarget: coreTargetInputSchema,
      },
    },
  },
] as const satisfies readonly AppServerDynamicToolSpec[];

export const appServerCoreToolManifest = {
  protocol: "codex.app-server.dynamic_tools",
  mode: "registry_backed_core_control",
  owner: "continuous",
  boundary: {
    apiRoute,
    sideEffects: "registered_core_commands_only",
    externalExecution: "blocked_by_command_policy",
    readTools: "continuous.core.view",
    mutationTools: "continuous.core.command",
    runtimeControl:
      "App-server Core reads and commands use the same core, command or view, idempotencyKey, and config payload envelope as POST /core. Operator identity and route-qualified scope come from authenticated transport context, not tool arguments.",
    excludedCommands:
      "Control-plane credential and token-rotation administration remains on POST /core and is not exposed through app-server dynamic tools.",
  },
  tools: appServerCoreTools,
} as const;

export const appServerCoreRegistry = {
  apiRoute,
  commands: appServerCoreCommandNames.map((name) => ({
    name,
    apiRoute,
    tool: "continuous.core.command",
    idempotency: "required",
    requiresTenant: true,
  })),
  views: appServerCoreViewNames.map((name) => ({
    name,
    apiRoute,
    tool: "continuous.core.view",
    requiresTenant: true,
  })),
  excludedCommands: [
    "control_plane.token_rotation.attest",
    "control_plane.credential.upsert",
    "control_plane.credential.revoke",
    "control_plane.session.review",
  ],
} as const;

function describeEnvelopeFields(fields: readonly string[]) {
  if (fields.length === 1) {
    return fields[0] ?? "";
  }

  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function appServerToolArgs(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error("Dynamic app-server Core tool arguments must be an object.");
}

function appServerToolCallResponse(success: boolean, value: unknown): AppServerCoreDynamicToolCallResponse {
  return {
    success,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function unexpectedEnvelopeFields(payload: Record<string, unknown>, allowedFields: ReadonlySet<string>) {
  return Object.keys(payload).filter((field) => !allowedFields.has(field));
}

export function coreEnvelopeFieldError(subject: string, allowedDescription: string, unexpectedFields: string[]) {
  return `${subject} fields must be ${allowedDescription}. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`;
}

export function isCoreOperationIdentifier(value: string) {
  const operation = value.trim();
  const reservedRouteSegments = new Set(["api", "app_server", "core", "workers"]);

  return (
    coreOperationPattern.test(operation) &&
    !operation.includes("_worker") &&
    operation.split(".").every((segment) => !reservedRouteSegments.has(segment))
  );
}

export function validateCoreTargetEnvelope(value: unknown):
  | { ok: true }
  | { ok: false; message: string } {
  if (value === undefined || value === null || !value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: "core must be an object with tenantSlug selector.",
    };
  }

  const unexpectedFields = unexpectedEnvelopeFields(
    value as Record<string, unknown>,
    coreTargetEnvelopeFieldSet,
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      message: coreEnvelopeFieldError("Core target", coreTargetEnvelopeDescription, unexpectedFields),
    };
  }

  const target = value as Record<string, unknown>;

  if (typeof target.tenantSlug !== "string" || !target.tenantSlug.trim()) {
    return {
      ok: false,
      message: "core.tenantSlug is required.",
    };
  }

  return { ok: true };
}

export function validateCoreConfigEnvelope(value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }

  return {
    ok: false,
    message: "config is required and must be an object.",
  };
}

function assertCoreCommandEnvelope(args: JsonObject) {
  const unexpectedFields = unexpectedEnvelopeFields(args, coreCommandEnvelopeFieldSet);

  if (unexpectedFields.length > 0) {
    throw new Error(
      coreEnvelopeFieldError("continuous.core.command payload", coreCommandEnvelopeDescription, unexpectedFields),
    );
  }

  const targetResult = validateCoreTargetEnvelope(args.core);

  if (!targetResult.ok) {
    throw new Error(targetResult.message);
  }

  const configResult = validateCoreConfigEnvelope(args.config);

  if (!configResult.ok) {
    throw new Error(configResult.message);
  }
}

function assertCoreViewEnvelope(args: JsonObject) {
  const unexpectedFields = unexpectedEnvelopeFields(args, coreViewEnvelopeFieldSet);

  if (unexpectedFields.length > 0) {
    throw new Error(
      coreEnvelopeFieldError("continuous.core.view payload", coreViewEnvelopeDescription, unexpectedFields),
    );
  }

  const targetResult = validateCoreTargetEnvelope(args.core);

  if (!targetResult.ok) {
    throw new Error(targetResult.message);
  }

  const configResult = validateCoreConfigEnvelope(args.config);

  if (!configResult.ok) {
    throw new Error(configResult.message);
  }
}

export function appServerCoreArgumentsEnvelopeError(
  subject: string,
  allowedDescription: string,
  unexpectedFields: string[],
) {
  return coreEnvelopeFieldError(subject, allowedDescription, unexpectedFields).replace(
    "Move operation inputs into config.",
    "Put Core operation inputs under arguments.config.",
  );
}

export function validateAppServerCoreArguments(
  args: Record<string, unknown>,
  kind: "command" | "view",
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  const fields = kind === "command" ? coreCommandEnvelopeFieldSet : coreViewEnvelopeFieldSet;
  const description =
    kind === "command" ? coreCommandEnvelopeDescription : coreViewEnvelopeDescription;
  const subject =
    kind === "command" ? "continuous.core.command arguments" : "continuous.core.view arguments";
  const unexpectedFields = unexpectedEnvelopeFields(args, fields);

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: appServerCoreArgumentsEnvelopeError(subject, description, unexpectedFields),
      },
    };
  }

  const targetResult = validateCoreTargetEnvelope(args.core);

  if (!targetResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: targetResult.message,
      },
    };
  }

  const configResult = validateCoreConfigEnvelope(args.config);

  if (!configResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: configResult.message,
      },
    };
  }

  return { ok: true };
}

export function isAppServerCoreCommand(name: string) {
  return appServerCoreCommandSet.has(name);
}

export function isAppServerCoreView(name: string) {
  return appServerCoreViewSet.has(name);
}

export function coreTargetFrom(args: Record<string, unknown>) {
  const target = objectValue(args.core);

  return {
    tenantSlug: optionalString(target.tenantSlug),
  };
}

function assertTrustedLocalCoreAccess(surface: string, access: "read" | "write") {
  if (
    access === "write" &&
    process.env.APP_ENV === "production" &&
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS !== "true"
  ) {
    throw new Error(
      `${surface} is a trusted local mutation surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.`,
    );
  }

  if (
    access === "read" &&
    process.env.APP_ENV === "production" &&
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS !== "true"
  ) {
    throw new Error(
      `${surface} is a trusted local read surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.`,
    );
  }
}

function requiredLocalCoreOperatorEmail(surface: string) {
  const operatorEmail = optionalString(process.env.WORKER_OPERATOR_EMAIL);

  if (!operatorEmail) {
    throw new Error(`${surface} requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.`);
  }

  return operatorEmail;
}

function operatorEmailFromTransportContext(
  surface: string,
  access: "read" | "write",
  commandKey: string,
  target: { tenantSlug?: string; workerRole?: string; requireWorkerRole?: boolean },
  context?: AppServerCoreTransportContext,
) {
  if (context) {
    const operatorEmail = optionalString(context.operatorEmail);

    if (!operatorEmail) {
      throw new Error(`${surface} requires operatorEmail from authenticated transport context.`);
    }

    if (context.source === "control_plane") {
      const allowedAccess = stringList(context.allowedAccess);
      const allowedCommands = stringList(context.allowedCommands);
      const allowedTenants = stringList(context.allowedTenants);
      const allowedWorkerRoles = stringList(context.allowedWorkerRoles);

      if (allowedAccess.length === 0 || allowedCommands.length === 0 || allowedTenants.length === 0) {
        throw new Error(`${surface} requires scoped authenticated transport context.`);
      }

      if (!allowedAccess.includes(access)) {
        throw new Error(`${surface} transport context is not allowed to ${access}.`);
      }

      if (!target.tenantSlug || !allowedTenants.includes(target.tenantSlug)) {
        throw new Error(`${surface} transport context is not allowed for this tenant.`);
      }

      if (!allowedCommands.includes(commandKey)) {
        throw new Error(`${surface} transport context is not allowed for ${commandKey}.`);
      }

      if (target.requireWorkerRole && !target.workerRole) {
        throw new Error(`${surface} requires worker.role for scoped worker lifecycle access.`);
      }

      if (target.requireWorkerRole && allowedWorkerRoles.length === 0) {
        throw new Error(`${surface} requires scoped worker-role transport context.`);
      }

      if (
        target.workerRole &&
        allowedWorkerRoles.length > 0 &&
        !allowedWorkerRoles.includes("*") &&
        !allowedWorkerRoles.includes(target.workerRole)
      ) {
        throw new Error(`${surface} transport context is not allowed for this worker role.`);
      }

      return operatorEmail;
    }

    if (context.source === "trusted_local") {
      assertTrustedLocalCoreAccess(surface, access);
      return operatorEmail;
    }

    throw new Error(`${surface} requires a supported authenticated transport context source.`);
  }

  assertTrustedLocalCoreAccess(surface, access);
  return requiredLocalCoreOperatorEmail(surface);
}

function coreWorkerRoleFromCommandConfig(command: string, config: Record<string, unknown>) {
  if (command === "worker.upsert") {
    return optionalString(config.role);
  }

  if (command === "worker.transition") {
    return optionalString(config.role) ?? optionalString(objectValue(config.worker).role);
  }

  if (command === "worker.run.start" || command === "worker.run.complete") {
    return optionalString(objectValue(config.worker).role);
  }

  return undefined;
}

function coreCommandRequiresWorkerRoleScope(command: string) {
  return (
    command === "worker.upsert" ||
    command === "worker.transition" ||
    command === "worker.run.start" ||
    command === "worker.run.complete"
  );
}

function requireIdempotency(value: unknown) {
  const idempotency = normalizeIdempotencyKey(value);

  if (!idempotency.ok) {
    throw new Error(idempotency.message);
  }

  return idempotency.key;
}

function actorFrom(value: unknown) {
  const actor = objectValue(value);
  return {
    type: optionalString(actor.type),
    id: optionalString(actor.id),
    ref: optionalString(actor.ref),
  };
}

async function executeCoreCommand(input: {
  command: string;
  target: { tenantSlug?: string };
  operatorEmail: string;
  idempotencyKey: string;
  config: Record<string, unknown>;
}) {
  const { command, target, operatorEmail, idempotencyKey, config } = input;
  const tenantSlug = target.tenantSlug;

  if (command === "task.create") {
    return createCoreTask({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      title: optionalString(config.title) ?? "",
      objectId: optionalString(config.objectId),
      capabilityId: optionalString(config.capabilityId),
      triggerEventId: optionalString(config.triggerEventId),
      state: optionalString(config.state),
      priority: optionalString(config.priority),
      owner: jsonObject(config.owner),
      ownerRef: optionalString(config.ownerRef),
      reviewerUserId: optionalString(config.reviewerUserId),
      dueAt: optionalString(config.dueAt),
      evidence: jsonObject(config.evidence),
      outcome: jsonObject(config.outcome),
      cost: jsonObject(config.cost),
      kpi: jsonObject(config.kpi),
    });
  }

  if (command === "task.transition") {
    return transitionCoreTask({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      taskId: optionalString(config.taskId) ?? "",
      toState: optionalString(config.toState) ?? optionalString(config.state),
      reason: optionalString(config.reason),
      evidence: jsonObject(config.evidence),
      outcome: jsonObject(config.outcome),
      cost: jsonObject(config.cost),
      kpi: jsonObject(config.kpi),
    });
  }

  if (command === "object.upsert") {
    const rawVersion = config.version;
    const version = objectValue(rawVersion);
    const versionConfig =
      rawVersion && typeof rawVersion === "object" && !Array.isArray(rawVersion)
        ? {
            data: jsonObject(version.data),
            reason: optionalString(version.reason) ?? null,
          }
        : undefined;

    return upsertCoreObject({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      objectId: optionalString(config.objectId) ?? optionalString(config.id),
      type: optionalString(config.type) ?? "",
      name: optionalString(config.name) ?? "",
      state: optionalString(config.state),
      source: optionalString(config.source),
      externalId: optionalString(config.externalId),
      data: jsonObject(config.data),
      effectiveAt: optionalString(config.effectiveAt),
      archivedAt: optionalString(config.archivedAt),
      reason: optionalString(config.reason),
      version: versionConfig,
    });
  }

  if (command === "adapter.upsert") {
    return upsertCoreAdapter({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      adapterId: optionalString(config.adapterId) ?? optionalString(config.id),
      key: optionalString(config.key) ?? "",
      name: optionalString(config.name) ?? "",
      kind: optionalString(config.kind) ?? "",
      auth: optionalString(config.auth) ?? "",
      configSchema: jsonObject(config.configSchema),
      eventSchema: jsonObject(config.eventSchema),
      capabilities: jsonObject(config.capabilities),
      active: optionalBoolean(config.active),
    });
  }

  if (command === "connection.upsert") {
    return upsertCoreConnection({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      connectionId: optionalString(config.connectionId) ?? optionalString(config.id),
      adapterId: optionalString(config.adapterId),
      adapterKey: optionalString(config.adapterKey),
      name: optionalString(config.name) ?? "",
      state: optionalString(config.state),
      externalAccountId: optionalString(config.externalAccountId),
      scopes: jsonObject(config.scopes),
      config: jsonObject(config.config),
      lastSyncAt: optionalString(config.lastSyncAt),
    });
  }

  if (command === "connection.health.record") {
    return recordCoreConnectionHealth({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      connectionId: optionalString(config.connectionId) ?? "",
      checks: config.checks,
      observedAt: optionalString(config.observedAt),
    });
  }

  if (command === "entity.setup.record") {
    return recordEntitySetup({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      legalEntity: config.legalEntity,
      identifiers: config.identifiers,
      locations: config.locations,
      bankAccount: config.bankAccount,
      bankAccounts: config.bankAccounts,
      paymentInstruction: config.paymentInstruction,
      paymentInstructions: config.paymentInstructions,
      workflow: config.workflow,
      packet: config.packet,
    });
  }

  if (command === "worker.upsert") {
    return upsertCoreWorker({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      workerId: optionalString(config.workerId) ?? optionalString(config.id),
      kind: optionalString(config.kind),
      state: optionalString(config.state),
      name: optionalString(config.name),
      role: optionalString(config.role),
      mission: optionalString(config.mission),
      managerUserId: config.managerUserId,
      scope: config.scope,
      memory: config.memory,
      policy: config.policy,
      kpis: config.kpis,
      autonomyLevel: config.autonomyLevel,
      lifecycle: config.lifecycle,
      evidence: config.evidence,
    });
  }

  if (command === "worker.transition") {
    return transitionCoreWorker({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      workerId: optionalString(config.workerId) ?? optionalString(config.id) ?? "",
      state: optionalString(config.state),
      toState: optionalString(config.toState),
      reason: optionalString(config.reason),
      lifecycle: config.lifecycle,
      evidence: config.evidence,
    });
  }

  if (command === "event.ingest") {
    return ingestCoreEvent({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      type: optionalString(config.type) ?? "",
      source: optionalString(config.source),
      actor: actorFrom(config.actor),
      objectId: optionalString(config.objectId),
      taskId: optionalString(config.taskId),
      capabilityId: optionalString(config.capabilityId),
      adapterId: optionalString(config.adapterId),
      connectionId: optionalString(config.connectionId),
      data: jsonObject(config.data),
      occurredAt: optionalString(config.occurredAt),
    });
  }

  if (command === "evidence.attach") {
    return attachCoreEvidence({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      kind: optionalString(config.kind) ?? "",
      name: optionalString(config.name) ?? "",
      actor: actorFrom(config.actor),
      objectId: optionalString(config.objectId),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      capabilityId: optionalString(config.capabilityId),
      uri: optionalString(config.uri),
      hash: optionalString(config.hash),
      data: jsonObject(config.data),
      redaction: jsonObject(config.redaction),
      retainedUntil: optionalString(config.retainedUntil),
    });
  }

  if (command === "document.create") {
    return createCoreDocument({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      kind: optionalString(config.kind) ?? "",
      name: optionalString(config.name) ?? "",
      state: optionalString(config.state),
      sensitivity: optionalString(config.sensitivity),
      objectId: optionalString(config.objectId),
      workflowRunId: optionalString(config.workflowRunId),
      hash: optionalString(config.hash),
      data: jsonObject(config.data),
      retainedUntil: optionalString(config.retainedUntil),
    });
  }

  if (command === "packet.prepare" || command === "document.packet.prepare") {
    return prepareCorePacket({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      kind: optionalString(config.kind) ?? "",
      name: optionalString(config.name) ?? "",
      state: optionalString(config.state),
      sensitivity: optionalString(config.sensitivity),
      objectId: optionalString(config.objectId),
      taskId: optionalString(config.taskId),
      workflowRunId: optionalString(config.workflowRunId),
      eventId: optionalString(config.eventId),
      capabilityId: optionalString(config.capabilityId),
      evidenceIds: config.evidenceIds,
      documentIds: config.documentIds,
      sections: jsonObject(config.sections),
      hash: optionalString(config.hash),
      data: jsonObject(config.data),
      retainedUntil: optionalString(config.retainedUntil),
    });
  }

  if (command === "decision.record") {
    return recordCoreDecision({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      kind: optionalString(config.kind) ?? "",
      decision: optionalString(config.decision) ?? "",
      rationale: optionalString(config.rationale),
      state: optionalString(config.state),
      actor: actorFrom(config.actor),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      workflowRunId: optionalString(config.workflowRunId),
      capabilityId: optionalString(config.capabilityId),
      data: jsonObject(config.data),
    });
  }

  if (command === "approval.request") {
    return requestApproval({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      kind: optionalString(config.kind) ?? "",
      title: optionalString(config.title) ?? "",
      summary: optionalString(config.summary),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      objectId: optionalString(config.objectId),
      capabilityId: optionalString(config.capabilityId),
      reviewerUserId: optionalString(config.reviewerUserId),
      priority: optionalString(config.priority),
      risk: optionalString(config.risk),
      dueAt: optionalString(config.dueAt),
      requestedAction: jsonObject(config.requestedAction),
      evidence: jsonObject(config.evidence),
      policy: jsonObject(config.policy),
      data: jsonObject(config.data),
    });
  }

  if (command === "adapter.intent.record") {
    return recordAdapterIntent({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      connectionId: optionalString(config.connectionId) ?? "",
      operation: optionalString(config.operation) ?? "",
      mode: optionalString(config.mode),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      capabilityId: optionalString(config.capabilityId),
      request: jsonObject(config.request),
      data: jsonObject(config.data),
      maxAttempts: config.maxAttempts,
    });
  }

  if (command === "rule.change.record") {
    return recordRuleChange({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      rulePackId: optionalString(config.rulePackId),
      ruleKey: optionalString(config.ruleKey) ?? "",
      changeType: optionalString(config.changeType) ?? "",
      title: optionalString(config.title) ?? "",
      summary: optionalString(config.summary),
      state: optionalString(config.state),
      decision: optionalString(config.decision),
      rationale: optionalString(config.rationale),
      taskId: optionalString(config.taskId),
      workflowRunId: optionalString(config.workflowRunId),
      capabilityId: optionalString(config.capabilityId),
      sourceRefs: jsonObject(config.sourceRefs),
      before: jsonObject(config.before),
      after: jsonObject(config.after),
      impact: jsonObject(config.impact),
      data: jsonObject(config.data),
      effectiveAt: optionalString(config.effectiveAt),
    });
  }

  if (command === "obligation.scan") {
    return scanObligations({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      scope: jsonObject(config.scope),
      jurisdiction: optionalString(config.jurisdiction),
      asOf: optionalString(config.asOf),
      dueAt: optionalString(config.dueAt),
      rulePackId: optionalString(config.rulePackId),
      filingRequirementId: optionalString(config.filingRequirementId),
      workflowRunId: optionalString(config.workflowRunId),
      taskId: optionalString(config.taskId),
      facts: jsonObject(config.facts),
      data: jsonObject(config.data),
    });
  }

  if (command === "capability.grant") {
    return grantCapability({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      capabilityId: optionalString(config.capabilityId),
      capabilityKey: optionalString(config.capabilityKey),
      capabilityVersion: optionalString(config.capabilityVersion),
      actor: jsonObject(config.actor),
      scope: jsonObject(config.scope),
      policy: jsonObject(config.policy),
      active: optionalBoolean(config.active),
      startsAt: optionalString(config.startsAt),
      endsAt: optionalString(config.endsAt),
      approvalRequestId: optionalString(config.approvalRequestId),
      reason: optionalString(config.reason),
    });
  }

  if (command === "budget.reserve") {
    return reserveBudget({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      budgetAccountId: optionalString(config.budgetAccountId) ?? "",
      units: config.units,
      taskId: optionalString(config.taskId),
      capabilityId: optionalString(config.capabilityId),
      expiresAt: optionalString(config.expiresAt),
      reason: optionalString(config.reason),
      data: jsonObject(config.data),
    });
  }

  if (command === "budget.charge") {
    return chargeBudget({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      reservationId: optionalString(config.reservationId) ?? "",
      units: config.units,
      costUsd: config.costUsd,
      actor: jsonObject(config.actor),
      taskId: optionalString(config.taskId),
      capabilityId: optionalString(config.capabilityId),
      inferenceId: optionalString(config.inferenceId),
      reason: optionalString(config.reason),
      data: jsonObject(config.data),
    });
  }

  if (command === "budget.release") {
    return releaseBudget({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      reservationId: optionalString(config.reservationId) ?? "",
      reason: optionalString(config.reason),
      data: jsonObject(config.data),
    });
  }

  if (command === "worker.run.start") {
    return startCoreWorkerRun({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      worker: jsonObject(config.worker),
      command: optionalString(config.command),
      mode: optionalString(config.mode),
      taskId: optionalString(config.taskId),
      capabilityId: optionalString(config.capabilityId),
      capabilityKey: optionalString(config.capabilityKey),
      capabilityVersion: optionalString(config.capabilityVersion),
      connectionId: optionalString(config.connectionId),
      budgetAccountId: optionalString(config.budgetAccountId),
      units: config.units,
      expiresAt: optionalString(config.expiresAt),
      input: config.input,
      policy: config.policy,
      evidence: config.evidence,
    });
  }

  if (command === "worker.run.complete") {
    return completeCoreWorkerRun({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      worker: jsonObject(config.worker),
      workerRunId: optionalString(config.workerRunId),
      state: optionalString(config.state),
      output: config.output,
      reason: optionalString(config.reason),
      costUsd: config.costUsd,
      evidence: config.evidence,
    });
  }

  if (command === "ai.infer") {
    return executeAiInference({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      routeKey: optionalString(config.routeKey),
      routePurpose: optionalString(config.routePurpose),
      budgetAccountId: optionalString(config.budgetAccountId) ?? "",
      maxUnits: config.maxUnits,
      costUsd: config.costUsd,
      actor: jsonObject(config.actor),
      taskId: optionalString(config.taskId),
      objectId: optionalString(config.objectId),
      capabilityId: optionalString(config.capabilityId),
      input: jsonObject(config.input),
      redaction: jsonObject(config.redaction),
      evaluation: jsonObject(config.evaluation),
    });
  }

  if (command === "object.link") {
    return linkCoreObjects({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      fromObjectId: optionalString(config.fromObjectId) ?? optionalString(config.fromId) ?? "",
      toObjectId: optionalString(config.toObjectId) ?? optionalString(config.toId) ?? "",
      type: optionalString(config.type) ?? "",
      data: jsonObject(config.data),
      effectiveAt: optionalString(config.effectiveAt),
      endedAt: optionalString(config.endedAt),
    });
  }

  if (command === "view.publish") {
    return publishCoreView({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      key: optionalString(config.key) ?? "",
      name: optionalString(config.name) ?? "",
      purpose: optionalString(config.purpose) ?? "",
      version: optionalString(config.version),
      surface: optionalString(config.surface),
      capabilityId: optionalString(config.capabilityId),
      objectType: optionalString(config.objectType),
      taskState: optionalString(config.taskState),
      contract: jsonObject(config.contract),
      actions: jsonObject(config.actions),
      data: jsonObject(config.data),
      mask: jsonObject(config.mask),
      active: optionalBoolean(config.active),
    });
  }

  if (command === "customer_signal.record") {
    return recordCustomerSignal({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      type: optionalString(config.type) ?? "",
      name: optionalString(config.name) ?? "",
      state: optionalString(config.state),
      source: optionalString(config.source),
      externalId: optionalString(config.externalId),
      customerObjectId: optionalString(config.customerObjectId),
      relatedObjectId: optionalString(config.relatedObjectId),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      data: jsonObject(config.data),
      occurredAt: optionalString(config.occurredAt),
    });
  }

  if (command === "payroll.preview.record") {
    return recordPayrollPreview({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      payrollRunId: optionalString(config.payrollRunId) ?? "",
      statement: jsonObject(config.statement),
      lines: config.lines,
      liabilities: config.liabilities,
      trace: config.trace,
    });
  }

  if (command === "payroll.preview.packet.prepare") {
    return preparePayrollPreviewPacket({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      payrollRunId: optionalString(config.payrollRunId) ?? "",
      objectId: optionalString(config.objectId),
      reviewerUserId: optionalString(config.reviewerUserId),
      dueAt: optionalString(config.dueAt),
      variance: jsonObject(config.variance),
      data: jsonObject(config.data),
    });
  }

  if (command === "external_action.record") {
    return recordExternalAction({
      operatorEmail,
      idempotencyKey,
      tenantSlug,
      targetType: optionalString(config.targetType) ?? "",
      targetId: optionalString(config.targetId) ?? "",
      kind: optionalString(config.kind) ?? "",
      state: optionalString(config.state) ?? "",
      connectionId: optionalString(config.connectionId),
      adapterActionId: optionalString(config.adapterActionId),
      taskId: optionalString(config.taskId),
      eventId: optionalString(config.eventId),
      capabilityId: optionalString(config.capabilityId),
      amountCents: config.amountCents,
      currency: optionalString(config.currency),
      occurredAt: optionalString(config.occurredAt),
      receipt: jsonObject(config.receipt),
      response: jsonObject(config.response),
      data: jsonObject(config.data),
    });
  }

  throw new Error(`Unsupported app-server Core command: ${command}`);
}

export async function executeAppServerCoreTool(
  name: string,
  args: JsonObject = {},
  context?: AppServerCoreTransportContext,
) {
  if (name === "continuous.core.schema") {
    if (Object.keys(args).length > 0) {
      throw new Error("continuous.core.schema does not accept arguments.");
    }

    return {
      manifest: appServerCoreToolManifest,
      registry: appServerCoreRegistry,
    };
  }

  if (name === "continuous.core.view") {
    assertCoreViewEnvelope(args);

    const view = optionalString(args.view);

    if (!view) {
      throw new Error("continuous.core.view requires view.");
    }

    if (!isCoreOperationIdentifier(view)) {
      throw new Error(coreOperationDescription);
    }

    if (!isAppServerCoreView(view)) {
      throw new Error(`Unsupported app-server Core view: ${view}`);
    }

    const target = coreTargetFrom(args);
    operatorEmailFromTransportContext(
      "continuous.core.view",
      "read",
      `core:view.${view}`,
      target,
      context,
    );
    const result = await getCoreSummarySafe({ tenantSlug: target.tenantSlug });
    const summaryError = result.ok ? null : "Core summary is unavailable.";
    const health = getHealth({
      dbOk: result.ok,
      dbError: summaryError,
      counts: result.summary.counts,
    });

    return {
      core: {
        tenantSlug: target.tenantSlug ?? null,
      },
      view,
      health,
      summary: result.summary,
      error: summaryError,
    };
  }

  if (name === "continuous.core.command") {
    assertCoreCommandEnvelope(args);

    const command = optionalString(args.command);

    if (!command) {
      throw new Error("continuous.core.command requires command.");
    }

    if (!isCoreOperationIdentifier(command)) {
      throw new Error(coreOperationDescription);
    }

    if (!isAppServerCoreCommand(command)) {
      throw new Error(`Unsupported app-server Core command: ${command}`);
    }

    const target = coreTargetFrom(args);
    const config = objectValue(args.config);
    const workerRole = coreWorkerRoleFromCommandConfig(command, config);
    const requireWorkerRole = coreCommandRequiresWorkerRoleScope(command);
    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.core.command",
      "write",
      `core:${command}`,
      {
        ...target,
        workerRole,
        requireWorkerRole,
      },
      context,
    );
    const idempotencyKey = requireIdempotency(args.idempotencyKey);
    const result = await executeCoreCommand({
      command,
      target,
      operatorEmail,
      idempotencyKey,
      config,
    });

    return {
      command,
      core: {
        tenantSlug: target.tenantSlug ?? null,
      },
      result,
    };
  }

  throw new Error(`Unknown app-server Core tool: ${name}`);
}

export async function executeAppServerCoreDynamicToolCall(
  params: AppServerCoreDynamicToolCallParams,
  context?: AppServerCoreTransportContext,
): Promise<AppServerCoreDynamicToolCallResponse> {
  try {
    const data = await executeAppServerCoreTool(params.tool, appServerToolArgs(params.arguments), context);

    return appServerToolCallResponse(true, {
      ok: true,
      tool: params.tool,
      callId: params.callId,
      data,
      error: null,
    });
  } catch (error) {
    return appServerToolCallResponse(false, {
      ok: false,
      tool: params.tool,
      callId: params.callId,
      data: null,
      error: error instanceof Error ? error.message : "Unknown app-server Core tool error",
    });
  }
}
