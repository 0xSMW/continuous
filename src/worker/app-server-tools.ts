import type { JsonObject } from "../db/schema";
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
] as const satisfies readonly AppServerDynamicToolSpec[];

export const appServerWorkerToolManifest = {
  protocol: "codex.app-server.dynamic_tools",
  mode: "read_only_discovery",
  owner: "continuous",
  boundary: {
    sideEffects: "none",
    externalExecution: "blocked",
    mutationTools: "not_exposed",
    runtimeControl: "Use POST /worker or bun run worker:tool for explicit operator-gated commands.",
  },
  tools: appServerWorkerTools,
} as const;

export function executeAppServerWorkerTool(name: string, args: JsonObject = {}) {
  if (name !== "continuous.worker.schema") {
    throw new Error(`Unknown app-server worker tool: ${name}`);
  }

  if (Object.keys(args).length > 0) {
    throw new Error("continuous.worker.schema does not accept arguments.");
  }

  return {
    manifest: appServerWorkerToolManifest,
    registry: workerToolSchema.registry,
    workerToolSchema,
  };
}
