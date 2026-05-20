import type { JsonObject } from "../db/schema";
import { executeWorkerCommand, type WorkerTargetInput } from "./registry";
import { assertTrustedLocalWorkerMutation, workerToolSchema } from "./tools";

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
      required: ["command", "worker"],
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
    mutationTools: "continuous.worker.command",
    runtimeControl:
      "App-server worker commands delegate to the same command registry used by POST /worker and bun run worker:tool. Caller supplies command, worker target, idempotencyKey, and config; operator identity is resolved from the trusted local environment and no production token is loaded.",
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

const appServerWorkerCommandEnvelopeFields = new Set([
  "command",
  "worker",
  "idempotencyKey",
  "config",
]);
const workerTargetEnvelopeFields = new Set(["role", "id", "tenantSlug"]);

function assertAppServerWorkerCommandEnvelope(args: JsonObject) {
  const unexpectedFields = Object.keys(args).filter((field) => !appServerWorkerCommandEnvelopeFields.has(field));

  if (unexpectedFields.length > 0) {
    throw new Error(
      `continuous.worker.command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
    );
  }

  const worker = args.worker;

  if (worker === undefined || worker === null) {
    return;
  }

  if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
    throw new Error("worker must be an object with role, id, and tenantSlug selectors.");
  }

  const unexpectedWorkerFields = Object.keys(worker as Record<string, unknown>).filter(
    (field) => !workerTargetEnvelopeFields.has(field),
  );

  if (unexpectedWorkerFields.length > 0) {
    throw new Error(
      `worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: ${unexpectedWorkerFields.join(", ")}.`,
    );
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
    const operatorEmail = process.env.WORKER_OPERATOR_EMAIL ?? "owner@continuoushq.com";

    if (!command) {
      throw new Error("continuous.worker.command requires command.");
    }

    assertTrustedLocalWorkerMutation("continuous.worker.command");

    return executeWorkerCommand({
      command,
      target: targetFrom(args),
      operatorEmail,
      idempotencyKey: args.idempotencyKey,
      config: args.config,
    });
  }

  throw new Error(`Unknown app-server worker tool: ${name}`);
}
