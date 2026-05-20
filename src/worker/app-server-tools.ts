import type { JsonObject } from "../db/schema";
import { executeWorkerCommand, executeWorkerView, type WorkerTargetInput } from "./registry";
import {
  assertTrustedLocalWorkerMutation,
  assertTrustedLocalWorkerRead,
  requiredLocalWorkerOperatorEmail,
  workerToolSchema,
} from "./tools";
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

export type AppServerDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export const appServerWorkerTools = [
  {
    name: "continuous.worker.schema",
    description:
      "Read the Continuous worker command registry, repo-owned worker tool schema, and app-server integration boundary.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "continuous.worker.command",
    description:
      "Invoke a registered Continuous worker command through the canonical worker payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        worker: { $ref: "#/$defs/workerTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["command", "worker", "config"],
      additionalProperties: false,
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
      },
    },
  },
  {
    name: "continuous.worker.view",
    description:
      "Read a registered Continuous worker view through the canonical worker view payload envelope.",
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
      },
      required: ["worker"],
      additionalProperties: false,
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
      },
    },
  },
] as const satisfies readonly AppServerDynamicToolSpec[];

export const appServerWorkerToolManifest = {
  protocol: "codex.app-server.dynamic_tools",
  mode: "registry_backed_worker_control",
  owner: "continuous",
  boundary: {
    sideEffects: "registered_worker_commands_only",
    externalExecution: "blocked",
    readTools: "continuous.worker.view",
    mutationTools: "continuous.worker.command",
    runtimeControl:
      "App-server worker reads and commands delegate to the same registry used by /worker and bun run worker:tool. Caller supplies view or command, worker target, idempotencyKey when needed, and config; operator identity must be supplied by the trusted local transport environment and no production token is loaded.",
  },
  tools: appServerWorkerTools,
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetFrom(args: JsonObject): WorkerTargetInput {
  const target = objectValue(args.worker);

  return {
    role: stringValue(target.role),
    id: stringValue(target.id),
    tenantSlug: stringValue(target.tenantSlug),
  };
}

function assertAppServerWorkerCommandEnvelope(args: JsonObject) {
  const unexpectedFields = unexpectedEnvelopeFields(args, workerCommandEnvelopeFieldSet);

  if (unexpectedFields.length > 0) {
    throw new Error(
      workerEnvelopeFieldError(
        "continuous.worker.command payload",
        workerCommandEnvelopeDescription,
        unexpectedFields,
      ),
    );
  }

  const targetResult = validateWorkerTargetEnvelope(args.worker);

  if (!targetResult.ok) {
    throw new Error(targetResult.message);
  }

  const configResult = validateWorkerConfigEnvelope(args.config);

  if (!configResult.ok) {
    throw new Error(configResult.message);
  }
}

function assertAppServerWorkerViewEnvelope(args: JsonObject) {
  const unexpectedFields = unexpectedEnvelopeFields(args, workerViewEnvelopeFieldSet);

  if (unexpectedFields.length > 0) {
    throw new Error(
      workerEnvelopeFieldError(
        "continuous.worker.view payload",
        workerViewEnvelopeDescription,
        unexpectedFields,
      ),
    );
  }

  const targetResult = validateWorkerTargetEnvelope(args.worker);

  if (!targetResult.ok) {
    throw new Error(targetResult.message);
  }
}

export async function executeAppServerWorkerTool(name: string, args: JsonObject = {}) {
  if (name === "continuous.worker.schema") {
    if (Object.keys(args).length > 0) {
      throw new Error("continuous.worker.schema does not accept arguments.");
    }

    return {
      manifest: appServerWorkerToolManifest,
      registry: workerToolSchema.registry,
      plannedWorkers: workerToolSchema.registry.plannedContracts,
      workerToolSchema,
    };
  }

  if (name === "continuous.worker.command") {
    assertAppServerWorkerCommandEnvelope(args);

    const command = stringValue(args.command);

    if (!command) {
      throw new Error("continuous.worker.command requires command.");
    }

    assertTrustedLocalWorkerMutation("continuous.worker.command");
    const operatorEmail = requiredLocalWorkerOperatorEmail("continuous.worker.command");

    return executeWorkerCommand({
      command,
      target: targetFrom(args),
      operatorEmail,
      idempotencyKey: args.idempotencyKey,
      config: args.config,
    });
  }

  if (name === "continuous.worker.view") {
    assertAppServerWorkerViewEnvelope(args);

    const view = stringValue(args.view) ?? "snapshot";
    const config = objectValue(args.config);

    assertTrustedLocalWorkerRead("continuous.worker.view");
    const operatorEmail = requiredLocalWorkerOperatorEmail("continuous.worker.view");

    const result = await executeWorkerView({
      view,
      target: targetFrom(args),
      operatorEmail,
      state: stringValue(config.state),
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  throw new Error(`Unknown app-server worker tool: ${name}`);
}
