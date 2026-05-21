import type { JsonObject } from "../db/schema";
import { executeWorkerCommand, executeWorkerView, type WorkerTargetInput } from "./registry";
import {
  assertTrustedLocalWorkerMutation,
  assertTrustedLocalWorkerRead,
  requiredLocalWorkerOperatorEmail,
  workerTargetInputSchema,
  workerToolSchema,
} from "./tools";
import {
  unexpectedEnvelopeFields,
  isWorkerOperationIdentifier,
  validateWorkerConfigEnvelope,
  validateWorkerTargetEnvelope,
  workerCommandEnvelopeDescription,
  workerCommandEnvelopeFieldSet,
  workerEnvelopeFieldError,
  workerOperationDescription,
  workerOperationPattern,
  workerViewEnvelopeDescription,
  workerViewEnvelopeFieldSet,
} from "./envelope";

export type AppServerDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export type AppServerWorkerTransportContext =
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

export type AppServerDynamicToolCallParams = {
  tool: string;
  arguments: unknown;
  callId: string;
  threadId: string;
  turnId: string;
};

export type AppServerDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<
    | {
        type: "inputText";
        text: string;
      }
    | {
        type: "inputImage";
        imageUrl: string;
      }
  >;
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
        command: {
          type: "string",
          description: workerOperationDescription,
          pattern: workerOperationPattern.source,
        },
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
        workerTarget: workerTargetInputSchema,
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
          description: "Registered view name.",
          pattern: workerOperationPattern.source,
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
      $defs: {
        workerTarget: workerTargetInputSchema,
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
      "App-server worker reads and commands delegate to the same registry used by /worker and bun run worker:tool. Caller supplies view or command, worker target, idempotencyKey when needed, and config; operator identity must be supplied by authenticated transport context or by the trusted local transport environment, and no production token is loaded.",
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

  const configResult = validateWorkerConfigEnvelope(args.config);

  if (!configResult.ok) {
    throw new Error(configResult.message);
  }
}

function appServerToolArgs(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error("Dynamic app-server worker tool arguments must be an object.");
}

function appServerToolCallText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function appServerToolCallResponse(success: boolean, value: unknown): AppServerDynamicToolCallResponse {
  return {
    success,
    contentItems: [
      {
        type: "inputText",
        text: appServerToolCallText(value),
      },
    ],
  };
}

function operatorEmailFromTransportContext(
  surface: string,
  access: "read" | "write",
  commandKey: string,
  target: WorkerTargetInput,
  context?: AppServerWorkerTransportContext,
) {
  if (context) {
    const operatorEmail = stringValue(context.operatorEmail);

    if (!operatorEmail) {
      throw new Error(`${surface} requires operatorEmail from authenticated transport context.`);
    }

    if (context.source === "control_plane") {
      const allowedAccess = stringList(context.allowedAccess);
      const allowedCommands = stringList(context.allowedCommands);
      const allowedTenants = stringList(context.allowedTenants);
      const allowedWorkerRoles = stringList(context.allowedWorkerRoles);

      if (
        allowedAccess.length === 0 ||
        allowedCommands.length === 0 ||
        allowedTenants.length === 0 ||
        allowedWorkerRoles.length === 0
      ) {
        throw new Error(`${surface} requires scoped authenticated transport context.`);
      }

      if (!allowedAccess.includes(access)) {
        throw new Error(`${surface} transport context is not allowed to ${access}.`);
      }

      if (!target.tenantSlug || !allowedTenants.includes(target.tenantSlug)) {
        throw new Error(`${surface} transport context is not allowed for this tenant.`);
      }

      if (!target.role || !allowedWorkerRoles.includes(target.role)) {
        throw new Error(`${surface} transport context is not allowed for this worker role.`);
      }

      if (!allowedCommands.includes(commandKey)) {
        throw new Error(`${surface} transport context is not allowed for ${commandKey}.`);
      }

      return operatorEmail;
    }

    if (context.source === "trusted_local") {
      if (access === "write") {
        assertTrustedLocalWorkerMutation(surface);
      } else {
        assertTrustedLocalWorkerRead(surface);
      }

      return operatorEmail;
    }

    throw new Error(`${surface} requires a supported authenticated transport context source.`);
  }

  if (access === "write") {
    assertTrustedLocalWorkerMutation(surface);
  } else {
    assertTrustedLocalWorkerRead(surface);
  }

  return requiredLocalWorkerOperatorEmail(surface);
}

export async function executeAppServerWorkerTool(
  name: string,
  args: JsonObject = {},
  context?: AppServerWorkerTransportContext,
) {
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

    if (!isWorkerOperationIdentifier(command)) {
      throw new Error(workerOperationDescription);
    }

    const target = targetFrom(args);

    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.worker.command",
      "write",
      `worker:${command}`,
      target,
      context,
    );

    return executeWorkerCommand({
      command,
      target,
      operatorEmail,
      idempotencyKey: args.idempotencyKey,
      config: args.config,
    });
  }

  if (name === "continuous.worker.view") {
    assertAppServerWorkerViewEnvelope(args);

    const view = stringValue(args.view);

    if (!view) {
      throw new Error("continuous.worker.view requires view.");
    }

    if (!isWorkerOperationIdentifier(view)) {
      throw new Error(workerOperationDescription);
    }

    const config = objectValue(args.config);
    const target = targetFrom(args);

    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.worker.view",
      "read",
      `worker:view.${view}`,
      target,
      context,
    );

    const result = await executeWorkerView({
      view,
      target,
      operatorEmail,
      config,
    });

    return {
      ...result.data,
      error: result.error,
    };
  }

  throw new Error(`Unknown app-server worker tool: ${name}`);
}

export async function executeAppServerWorkerDynamicToolCall(
  params: AppServerDynamicToolCallParams,
  context?: AppServerWorkerTransportContext,
): Promise<AppServerDynamicToolCallResponse> {
  try {
    const data = await executeAppServerWorkerTool(
      params.tool,
      appServerToolArgs(params.arguments),
      context,
    );

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
      error: error instanceof Error ? error.message : "Unknown app-server worker tool error",
    });
  }
}
