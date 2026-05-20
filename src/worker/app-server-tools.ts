import type { JsonObject } from "../db/schema";
import { executeWorkerCommand, type WorkerTargetInput } from "./registry";
import { workerToolSchema } from "./tools";

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
        operatorEmail: { type: "string" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["command", "worker", "operatorEmail"],
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
      "App-server worker commands delegate to the same command registry used by POST /worker and bun run worker:tool. Caller supplies operatorEmail, worker target, idempotencyKey, and config; no production token is loaded.",
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
    const command = stringValue(args.command);
    const operatorEmail = stringValue(args.operatorEmail);

    if (!command) {
      throw new Error("continuous.worker.command requires command.");
    }

    if (!operatorEmail) {
      throw new Error("continuous.worker.command requires operatorEmail.");
    }

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
