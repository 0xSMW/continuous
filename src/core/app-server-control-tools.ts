import { decideApproval, listApprovals, normalizeApprovalDecision, type ApprovalSubject } from "./approvals";
import {
  executeWorkflowSteps,
  listWorkflows,
  startWorkflowRun,
  transitionWorkflowRun,
} from "./workflows";
import type { JsonObject } from "../db/schema";
import { normalizeIdempotencyKey } from "../worker/security";

export type AppServerControlTransportContext =
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

export type AppServerControlDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonObject;
};

export type AppServerControlDynamicToolCallParams = {
  tool: string;
  arguments: unknown;
  callId: string;
  threadId: string;
  turnId: string;
};

export type AppServerControlDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{
    type: "inputText";
    text: string;
  }>;
};

export type AppServerControlBridgeTarget = {
  plane: "workflow" | "approval";
  access: "read" | "write";
  controlCommand: string;
  innerCommand: string;
  tenantSlug?: string;
};

const operationPattern =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
export const controlOperationDescription =
  "Control command and view names must be registered lower_snake_case or dotted operation identifiers such as steps.execute or inbox; do not use URL paths, route names, family-worker names, or query strings.";
const workflowCommandEnvelopeFields = ["command", "workflow", "idempotencyKey", "config"] as const;
const workflowViewEnvelopeFields = ["view", "workflow", "config"] as const;
const approvalCommandEnvelopeFields = ["command", "approval", "idempotencyKey", "config"] as const;
const approvalViewEnvelopeFields = ["view", "approval", "config"] as const;
const workflowCommandEnvelopeFieldSet = new Set<string>(workflowCommandEnvelopeFields);
const workflowViewEnvelopeFieldSet = new Set<string>(workflowViewEnvelopeFields);
const approvalCommandEnvelopeFieldSet = new Set<string>(approvalCommandEnvelopeFields);
const approvalViewEnvelopeFieldSet = new Set<string>(approvalViewEnvelopeFields);
const workflowTargetFields = ["tenantSlug", "key", "runId", "objectId", "workerId"] as const;
const approvalTargetFields = ["tenantSlug", "id", "subject"] as const;
const workflowTargetFieldSet = new Set<string>(workflowTargetFields);
const approvalTargetFieldSet = new Set<string>(approvalTargetFields);
const approvalSubjects = new Set<ApprovalSubject>(["all", "core", "worker", "workflow", "task"]);
const approvalCommandSubjects = new Set<ApprovalSubject>(["core", "worker", "workflow", "task"]);

export const appServerWorkflowCommandNames = [
  "start",
  "transition",
  "steps.execute",
  "approval.decide",
] as const;
export const appServerWorkflowViewNames = ["overview", "approvals"] as const;
export const appServerApprovalCommandNames = ["approval.decide"] as const;
export const appServerApprovalViewNames = ["inbox"] as const;

const workflowCommandSet = new Set<string>(appServerWorkflowCommandNames);
const workflowViewSet = new Set<string>(appServerWorkflowViewNames);
const approvalCommandSet = new Set<string>(appServerApprovalCommandNames);
const approvalViewSet = new Set<string>(appServerApprovalViewNames);

const workflowTargetInputSchema = {
  type: "object",
  properties: {
    tenantSlug: { type: "string" },
    key: { type: "string" },
    runId: { type: "string" },
    objectId: { type: "string" },
    workerId: { type: "string" },
  },
  required: ["tenantSlug"],
  additionalProperties: false,
} satisfies JsonObject;

const approvalViewTargetInputSchema = {
  type: "object",
  properties: {
    tenantSlug: { type: "string" },
    id: { type: "string" },
    subject: {
      type: "string",
      enum: ["all", "core", "worker", "workflow", "task"],
    },
  },
  required: ["tenantSlug"],
  additionalProperties: false,
} satisfies JsonObject;

const approvalCommandTargetInputSchema = {
  type: "object",
  properties: {
    tenantSlug: { type: "string" },
    id: { type: "string" },
    subject: {
      type: "string",
      enum: ["core", "worker", "workflow", "task"],
    },
  },
  required: ["tenantSlug", "id", "subject"],
  additionalProperties: false,
} satisfies JsonObject;

export const appServerControlTools = [
  {
    name: "continuous.workflow.schema",
    description:
      "Read the Continuous workflow command and view registry exposed through the app-server bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "continuous.workflow.command",
    description:
      "Invoke a registered Continuous workflow command through the canonical workflow payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: controlOperationDescription,
          pattern: operationPattern.source,
        },
        workflow: { $ref: "#/$defs/workflowTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description: "Workflow command config. Put every operation-specific input under config.",
          additionalProperties: true,
        },
      },
      required: ["command", "workflow", "config"],
      additionalProperties: false,
      $defs: {
        workflowTarget: workflowTargetInputSchema,
      },
    },
  },
  {
    name: "continuous.workflow.view",
    description:
      "Read a registered Continuous workflow view through the canonical workflow view payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          description: controlOperationDescription,
          pattern: operationPattern.source,
        },
        workflow: { $ref: "#/$defs/workflowTarget" },
        config: {
          type: "object",
          description: "Workflow view config. Put read filters under config.",
          additionalProperties: true,
        },
      },
      required: ["view", "workflow", "config"],
      additionalProperties: false,
      $defs: {
        workflowTarget: workflowTargetInputSchema,
      },
    },
  },
  {
    name: "continuous.approval.schema",
    description:
      "Read the shared approval command and view registry exposed through the app-server bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "continuous.approval.command",
    description:
      "Invoke a registered shared approval command through the canonical approval payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: controlOperationDescription,
          pattern: operationPattern.source,
        },
        approval: { $ref: "#/$defs/approvalTarget" },
        idempotencyKey: { type: "string" },
        config: {
          type: "object",
          description: "Approval command config. Put every operation-specific input under config.",
          additionalProperties: true,
        },
      },
      required: ["command", "approval", "idempotencyKey", "config"],
      additionalProperties: false,
      $defs: {
        approvalTarget: approvalCommandTargetInputSchema,
      },
    },
  },
  {
    name: "continuous.approval.view",
    description:
      "Read a registered shared approval view through the canonical approval view payload envelope.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          description: controlOperationDescription,
          pattern: operationPattern.source,
        },
        approval: { $ref: "#/$defs/approvalTarget" },
        config: {
          type: "object",
          description: "Approval view config. Put read filters under config.",
          additionalProperties: true,
        },
      },
      required: ["view", "approval", "config"],
      additionalProperties: false,
      $defs: {
        approvalTarget: approvalViewTargetInputSchema,
      },
    },
  },
] as const satisfies readonly AppServerControlDynamicToolSpec[];

export const appServerControlToolManifest = {
  protocol: "codex.app-server.dynamic_tools",
  mode: "registry_backed_control_plane",
  owner: "continuous",
  boundary: {
    workflowRoute: "/workflow",
    approvalRoute: "/approval",
    readTools: "continuous.workflow.view and continuous.approval.view",
    mutationTools: "continuous.workflow.command and continuous.approval.command",
    runtimeControl:
      "App-server workflow and approval reads and commands use the same workflow or approval, command or view, idempotencyKey, and config payload envelopes as POST /workflow and POST /approval. Operator identity and route-qualified scope come from authenticated transport context, not tool arguments.",
  },
  tools: appServerControlTools,
} as const;

export const appServerControlRegistry = {
  workflow: {
    apiRoute: "/workflow",
    commands: appServerWorkflowCommandNames.map((name) => ({
      name,
      apiRoute: "/workflow",
      tool: "continuous.workflow.command",
      idempotency: name === "steps.execute" ? "not_required" : "required",
      requiresTenant: true,
    })),
    views: appServerWorkflowViewNames.map((name) => ({
      name,
      apiRoute: "/workflow",
      tool: "continuous.workflow.view",
      requiresTenant: true,
    })),
  },
  approval: {
    apiRoute: "/approval",
    commands: appServerApprovalCommandNames.map((name) => ({
      name,
      apiRoute: "/approval",
      tool: "continuous.approval.command",
      idempotency: "required",
      requiresTenant: true,
    })),
    views: appServerApprovalViewNames.map((name) => ({
      name,
      apiRoute: "/approval",
      tool: "continuous.approval.view",
      requiresTenant: true,
    })),
  },
} as const;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
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

function describeEnvelopeFields(fields: readonly string[]) {
  if (fields.length === 1) {
    return fields[0] ?? "";
  }

  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

function unexpectedEnvelopeFields(payload: Record<string, unknown>, allowedFields: ReadonlySet<string>) {
  return Object.keys(payload).filter((field) => !allowedFields.has(field));
}

function envelopeFieldError(subject: string, allowedFields: readonly string[], unexpectedFields: string[]) {
  return `${subject} fields must be ${describeEnvelopeFields(allowedFields)}. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`;
}

function appServerEnvelopeFieldError(
  subject: string,
  allowedFields: readonly string[],
  unexpectedFields: string[],
) {
  return envelopeFieldError(subject, allowedFields, unexpectedFields).replace(
    "Move operation inputs into config.",
    "Put operation inputs under arguments.config.",
  );
}

function appServerToolArgs(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error("Dynamic app-server control tool arguments must be an object.");
}

function appServerToolCallResponse(
  success: boolean,
  value: unknown,
): AppServerControlDynamicToolCallResponse {
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

export function isControlOperationIdentifier(value: string) {
  const operation = value.trim();
  const reservedRouteSegments = new Set(["api", "app_server", "worker", "workers"]);

  return (
    operationPattern.test(operation) &&
    !operation.includes("_worker") &&
    operation.split(".").every((segment) => !reservedRouteSegments.has(segment))
  );
}

function validateConfigEnvelope(value: unknown):
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

function validateWorkflowTargetEnvelope(value: unknown):
  | { ok: true }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: "workflow must be an object with tenantSlug selector.",
    };
  }

  const unexpectedFields = unexpectedEnvelopeFields(
    value as Record<string, unknown>,
    workflowTargetFieldSet,
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      message: envelopeFieldError("Workflow target", workflowTargetFields, unexpectedFields),
    };
  }

  const target = value as Record<string, unknown>;

  if (typeof target.tenantSlug !== "string" || !target.tenantSlug.trim()) {
    return {
      ok: false,
      message: "workflow.tenantSlug is required.",
    };
  }

  return { ok: true };
}

function validateApprovalTargetEnvelope(
  value: unknown,
  kind: "command" | "view",
):
  | { ok: true }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: "approval must be an object with tenantSlug selector.",
    };
  }

  const unexpectedFields = unexpectedEnvelopeFields(
    value as Record<string, unknown>,
    approvalTargetFieldSet,
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      message: envelopeFieldError("Approval target", approvalTargetFields, unexpectedFields),
    };
  }

  const target = value as Record<string, unknown>;

  if (typeof target.tenantSlug !== "string" || !target.tenantSlug.trim()) {
    return {
      ok: false,
      message: "approval.tenantSlug is required.",
    };
  }

  const subject = stringValue(target.subject);

  if (kind === "command") {
    if (!stringValue(target.id)) {
      return {
        ok: false,
        message: "approval.id is required for approval commands.",
      };
    }

    if (!subject) {
      return {
        ok: false,
        message: "approval.subject is required for approval commands.",
      };
    }

    if (!approvalCommandSubjects.has(subject as ApprovalSubject)) {
      return {
        ok: false,
        message: "approval.subject must be core, worker, workflow, or task for approval commands.",
      };
    }

    return { ok: true };
  }

  if (subject && !approvalSubjects.has(subject as ApprovalSubject)) {
    return {
      ok: false,
      message: "Approval subject must be all, core, worker, workflow, or task.",
    };
  }

  return { ok: true };
}

export function validateAppServerControlArguments(
  args: Record<string, unknown>,
  plane: "workflow" | "approval",
  kind: "command" | "view",
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  const fields =
    plane === "workflow"
      ? kind === "command"
        ? workflowCommandEnvelopeFieldSet
        : workflowViewEnvelopeFieldSet
      : kind === "command"
        ? approvalCommandEnvelopeFieldSet
        : approvalViewEnvelopeFieldSet;
  const fieldNames =
    plane === "workflow"
      ? kind === "command"
        ? workflowCommandEnvelopeFields
        : workflowViewEnvelopeFields
      : kind === "command"
        ? approvalCommandEnvelopeFields
        : approvalViewEnvelopeFields;
  const subject = `continuous.${plane}.${kind} arguments`;
  const unexpectedFields = unexpectedEnvelopeFields(args, fields);

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: appServerEnvelopeFieldError(subject, fieldNames, unexpectedFields),
      },
    };
  }

  const targetResult =
    plane === "workflow"
      ? validateWorkflowTargetEnvelope(args.workflow)
      : validateApprovalTargetEnvelope(args.approval, kind);

  if (!targetResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_app_server_tool_call",
        message: targetResult.message,
      },
    };
  }

  const configResult = validateConfigEnvelope(args.config);

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

function assertControlEnvelope(
  args: JsonObject,
  plane: "workflow" | "approval",
  kind: "command" | "view",
) {
  const result = validateAppServerControlArguments(args, plane, kind);

  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

export function isAppServerWorkflowCommand(name: string) {
  return workflowCommandSet.has(name);
}

export function isAppServerWorkflowView(name: string) {
  return workflowViewSet.has(name);
}

export function isAppServerApprovalCommand(name: string) {
  return approvalCommandSet.has(name);
}

export function isAppServerApprovalView(name: string) {
  return approvalViewSet.has(name);
}

function workflowTargetFrom(args: Record<string, unknown>) {
  const workflow = objectValue(args.workflow);

  return {
    tenantSlug: stringValue(workflow.tenantSlug),
    key: stringValue(workflow.key),
    runId: stringValue(workflow.runId),
    objectId: stringValue(workflow.objectId),
    workerId: stringValue(workflow.workerId),
  };
}

function approvalTargetFrom(args: Record<string, unknown>) {
  const approval = objectValue(args.approval);

  return {
    tenantSlug: stringValue(approval.tenantSlug),
    id: stringValue(approval.id),
    subject: stringValue(approval.subject),
  };
}

export function appServerControlBridgeTarget(
  tool: string,
  args: Record<string, unknown>,
):
  | { ok: true; target: AppServerControlBridgeTarget }
  | { ok: false; error: { code: string; message: string } }
  | null {
  if (tool === "continuous.workflow.command") {
    const envelope = validateAppServerControlArguments(args, "workflow", "command");

    if (!envelope.ok) {
      return { ok: false, error: envelope.error };
    }

    const command = stringValue(args.command);

    if (!command) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.workflow.command requires arguments.command.",
        },
      };
    }

    if (!isControlOperationIdentifier(command)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: controlOperationDescription,
        },
      };
    }

    if (!isAppServerWorkflowCommand(command)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server workflow command: ${command}`,
        },
      };
    }

    const target = workflowTargetFrom(args);

    return {
      ok: true,
      target: {
        plane: "workflow",
        access: "write",
        controlCommand: `workflow.command.${command}`,
        innerCommand: `workflow:${command}`,
        tenantSlug: target.tenantSlug,
      },
    };
  }

  if (tool === "continuous.workflow.view") {
    const envelope = validateAppServerControlArguments(args, "workflow", "view");

    if (!envelope.ok) {
      return { ok: false, error: envelope.error };
    }

    const view = stringValue(args.view);

    if (!view) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.workflow.view requires arguments.view.",
        },
      };
    }

    if (!isControlOperationIdentifier(view)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: controlOperationDescription,
        },
      };
    }

    if (!isAppServerWorkflowView(view)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server workflow view: ${view}`,
        },
      };
    }

    const target = workflowTargetFrom(args);

    return {
      ok: true,
      target: {
        plane: "workflow",
        access: "read",
        controlCommand: `workflow.view.${view}`,
        innerCommand: `workflow:view.${view}`,
        tenantSlug: target.tenantSlug,
      },
    };
  }

  if (tool === "continuous.workflow.schema") {
    if (Object.keys(args).length > 0) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.workflow.schema does not accept arguments.",
        },
      };
    }

    return {
      ok: true,
      target: {
        plane: "workflow",
        access: "read",
        controlCommand: "workflow.schema",
        innerCommand: "workflow:schema",
      },
    };
  }

  if (tool === "continuous.approval.command") {
    const envelope = validateAppServerControlArguments(args, "approval", "command");

    if (!envelope.ok) {
      return { ok: false, error: envelope.error };
    }

    const command = stringValue(args.command);

    if (!command) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.approval.command requires arguments.command.",
        },
      };
    }

    if (!isControlOperationIdentifier(command)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: controlOperationDescription,
        },
      };
    }

    if (!isAppServerApprovalCommand(command)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server approval command: ${command}`,
        },
      };
    }

    const target = approvalTargetFrom(args);

    return {
      ok: true,
      target: {
        plane: "approval",
        access: "write",
        controlCommand: `approval.command.${command}`,
        innerCommand: `approval:${command}`,
        tenantSlug: target.tenantSlug,
      },
    };
  }

  if (tool === "continuous.approval.view") {
    const envelope = validateAppServerControlArguments(args, "approval", "view");

    if (!envelope.ok) {
      return { ok: false, error: envelope.error };
    }

    const view = stringValue(args.view);

    if (!view) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.approval.view requires arguments.view.",
        },
      };
    }

    if (!isControlOperationIdentifier(view)) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: controlOperationDescription,
        },
      };
    }

    if (!isAppServerApprovalView(view)) {
      return {
        ok: false,
        error: {
          code: "unknown_app_server_tool",
          message: `Unsupported app-server approval view: ${view}`,
        },
      };
    }

    const target = approvalTargetFrom(args);

    return {
      ok: true,
      target: {
        plane: "approval",
        access: "read",
        controlCommand: `approval.view.${view}`,
        innerCommand: `approval:view.${view}`,
        tenantSlug: target.tenantSlug,
      },
    };
  }

  if (tool === "continuous.approval.schema") {
    if (Object.keys(args).length > 0) {
      return {
        ok: false,
        error: {
          code: "invalid_app_server_tool_call",
          message: "continuous.approval.schema does not accept arguments.",
        },
      };
    }

    return {
      ok: true,
      target: {
        plane: "approval",
        access: "read",
        controlCommand: "approval.schema",
        innerCommand: "approval:schema",
      },
    };
  }

  return null;
}

function assertTrustedLocalControlAccess(surface: string, access: "read" | "write") {
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

function requiredLocalControlOperatorEmail(surface: string) {
  const operatorEmail = stringValue(process.env.WORKER_OPERATOR_EMAIL);

  if (!operatorEmail) {
    throw new Error(`${surface} requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.`);
  }

  return operatorEmail;
}

function operatorEmailFromTransportContext(
  surface: string,
  access: "read" | "write",
  commandKey: string,
  target: { tenantSlug?: string },
  context?: AppServerControlTransportContext,
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

      return operatorEmail;
    }

    if (context.source === "trusted_local") {
      assertTrustedLocalControlAccess(surface, access);
      return operatorEmail;
    }

    throw new Error(`${surface} requires a supported authenticated transport context source.`);
  }

  assertTrustedLocalControlAccess(surface, access);
  return requiredLocalControlOperatorEmail(surface);
}

function requireIdempotency(value: unknown) {
  const idempotency = normalizeIdempotencyKey(value);

  if (!idempotency.ok) {
    throw new Error(idempotency.message);
  }

  return idempotency.key;
}

function optionalFilter(value: unknown) {
  const filter = stringValue(value);

  return filter && filter !== "all" ? filter : undefined;
}

function parseApprovalSubject(value: unknown, defaultSubject: ApprovalSubject | null = "all") {
  const subject = stringValue(value);

  if (!subject) {
    return defaultSubject ?? undefined;
  }

  return approvalSubjects.has(subject as ApprovalSubject) ? (subject as ApprovalSubject) : null;
}

function optionalBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
) {
  if (value === undefined || value === null || value === "") {
    return { ok: true as const, value: undefined };
  }

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue < min || numericValue > max) {
    return {
      ok: false as const,
      message: `${field} must be an integer between ${min} and ${max}.`,
    };
  }

  return { ok: true as const, value: numericValue };
}

function publicWorkflowStepError(error: unknown): JsonObject {
  const data = jsonObject(error);

  return {
    ...data,
    code:
      typeof data.code === "string" && data.code.trim()
        ? data.code
        : "workflow_step_execution_failed",
    message: "Workflow step execution failed.",
  };
}

function publicWorkflowStepExecutionResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }

  const execution = result as Record<string, unknown>;
  const results = Array.isArray(execution.results)
    ? execution.results.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return item;
        }

        const step = item as Record<string, unknown>;
        return step.error
          ? {
              ...step,
              error: publicWorkflowStepError(step.error),
            }
          : step;
      })
    : execution.results;

  return {
    ...execution,
    results,
  };
}

async function executeWorkflowControlCommand(input: {
  command: string;
  target: ReturnType<typeof workflowTargetFrom>;
  operatorEmail: string;
  idempotencyKey?: string;
  config: Record<string, unknown>;
}) {
  const { command, target, operatorEmail, idempotencyKey, config } = input;

  if (command === "start") {
    if (!target.key) {
      throw new Error("workflow.key is required for start.");
    }

    return startWorkflowRun({
      operatorEmail,
      workflowKey: target.key,
      idempotencyKey: requireIdempotency(idempotencyKey),
      tenantSlug: target.tenantSlug,
      objectId: target.objectId,
      workerId: target.workerId,
      initialState: stringValue(config.initialState),
      data: jsonObject(config.data),
      blockers: jsonObject(config.blockers),
      metrics: jsonObject(config.metrics),
    });
  }

  if (command === "transition") {
    const toState = stringValue(config.toState);

    if (!target.runId || !toState) {
      throw new Error("workflow.runId, idempotencyKey, and config.toState are required for transition.");
    }

    return transitionWorkflowRun({
      operatorEmail,
      tenantSlug: target.tenantSlug,
      runId: target.runId,
      toState,
      idempotencyKey: requireIdempotency(idempotencyKey),
      reason: stringValue(config.reason),
      data: jsonObject(config.data),
      blockers: jsonObject(config.blockers),
      metrics: jsonObject(config.metrics),
    });
  }

  if (command === "steps.execute") {
    const limit = optionalBoundedInteger(config.limit, "config.limit", 1, 50);
    const leaseMs = optionalBoundedInteger(config.leaseMs, "config.leaseMs", 30_000, 900_000);

    if (!limit.ok) {
      throw new Error(limit.message);
    }

    if (!leaseMs.ok) {
      throw new Error(leaseMs.message);
    }

    return publicWorkflowStepExecutionResult(
      await executeWorkflowSteps({
        operatorEmail,
        tenantSlug: target.tenantSlug,
        limit: limit.value,
        leaseOwner: stringValue(config.leaseOwner),
        leaseMs: leaseMs.value,
      }),
    );
  }

  if (command === "approval.decide") {
    const approvalId = stringValue(config.approvalId);
    const action = normalizeApprovalDecision(config.action);

    if (!approvalId || !action) {
      throw new Error("config.approvalId, config.action, and idempotencyKey are required for approval.decide.");
    }

    return decideApproval({
      approvalId,
      idempotencyKey: requireIdempotency(idempotencyKey),
      operatorEmail,
      tenantSlug: target.tenantSlug,
      action,
      note: stringValue(config.note),
      subject: "workflow",
    });
  }

  throw new Error(`Unsupported app-server workflow command: ${command}`);
}

async function executeWorkflowControlView(input: {
  view: string;
  target: ReturnType<typeof workflowTargetFrom>;
  operatorEmail: string;
  config: Record<string, unknown>;
}) {
  const { view, target, operatorEmail, config } = input;

  if (view === "overview") {
    const result = await listWorkflows({
      operatorEmail,
      tenantSlug: target.tenantSlug,
      state: stringValue(config.state),
    });

    return {
      view,
      workflow: {
        tenantSlug: target.tenantSlug ?? null,
      },
      result,
    };
  }

  if (view === "approvals") {
    const approvals = await listApprovals({
      operatorEmail,
      tenantSlug: target.tenantSlug,
      state: stringValue(config.state),
      subject: "workflow",
    });

    return {
      view,
      workflow: {
        tenantSlug: target.tenantSlug ?? null,
      },
      approvals,
    };
  }

  throw new Error(`Unsupported app-server workflow view: ${view}`);
}

async function executeApprovalControlCommand(input: {
  command: string;
  target: ReturnType<typeof approvalTargetFrom>;
  operatorEmail: string;
  idempotencyKey: string;
  config: Record<string, unknown>;
}) {
  const { command, target, operatorEmail, idempotencyKey, config } = input;

  if (command !== "approval.decide") {
    throw new Error(`Unsupported app-server approval command: ${command}`);
  }

  const subject = parseApprovalSubject(target.subject, null);
  const action = normalizeApprovalDecision(config.action);

  if (!target.id || !action) {
    throw new Error("approval.id and config.action are required for approval.decide.");
  }

  if (subject === undefined) {
    throw new Error("approval.subject is required for approval.decide.");
  }

  if (subject === null) {
    throw new Error("Approval subject must be all, core, worker, workflow, or task.");
  }

  if (subject === "all") {
    throw new Error("approval.subject must be core, worker, workflow, or task for approval.decide.");
  }

  return decideApproval({
    approvalId: target.id,
    idempotencyKey,
    operatorEmail,
    tenantSlug: target.tenantSlug,
    action,
    note: stringValue(config.note),
    subject,
  });
}

async function executeApprovalControlView(input: {
  view: string;
  target: ReturnType<typeof approvalTargetFrom>;
  operatorEmail: string;
  config: Record<string, unknown>;
}) {
  const { view, target, operatorEmail, config } = input;

  if (view !== "inbox") {
    throw new Error(`Unsupported app-server approval view: ${view}`);
  }

  const subject = parseApprovalSubject(target.subject);

  if (!subject) {
    throw new Error("Approval subject must be all, core, worker, workflow, or task.");
  }

  const approvals = await listApprovals({
    operatorEmail,
    tenantSlug: target.tenantSlug,
    state: optionalFilter(config.state),
    subject,
    priority: optionalFilter(config.priority),
    risk: optionalFilter(config.risk),
    kind: optionalFilter(config.kind),
  });

  return {
    view,
    approval: {
      tenantSlug: target.tenantSlug ?? null,
      subject,
    },
    approvals,
  };
}

export async function executeAppServerControlTool(
  name: string,
  args: JsonObject = {},
  context?: AppServerControlTransportContext,
) {
  if (name === "continuous.workflow.schema") {
    if (Object.keys(args).length > 0) {
      throw new Error("continuous.workflow.schema does not accept arguments.");
    }

    return {
      manifest: appServerControlToolManifest,
      registry: appServerControlRegistry.workflow,
    };
  }

  if (name === "continuous.approval.schema") {
    if (Object.keys(args).length > 0) {
      throw new Error("continuous.approval.schema does not accept arguments.");
    }

    return {
      manifest: appServerControlToolManifest,
      registry: appServerControlRegistry.approval,
    };
  }

  if (name === "continuous.workflow.command") {
    assertControlEnvelope(args, "workflow", "command");
    const command = stringValue(args.command);

    if (!command) {
      throw new Error("continuous.workflow.command requires command.");
    }

    if (!isControlOperationIdentifier(command)) {
      throw new Error(controlOperationDescription);
    }

    if (!isAppServerWorkflowCommand(command)) {
      throw new Error(`Unsupported app-server workflow command: ${command}`);
    }

    const target = workflowTargetFrom(args);
    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.workflow.command",
      "write",
      `workflow:${command}`,
      target,
      context,
    );
    const result = await executeWorkflowControlCommand({
      command,
      target,
      operatorEmail,
      idempotencyKey: stringValue(args.idempotencyKey),
      config: objectValue(args.config),
    });

    return {
      command,
      workflow: {
        key: target.key ?? null,
        runId: target.runId ?? null,
        tenantSlug: target.tenantSlug ?? null,
      },
      result,
    };
  }

  if (name === "continuous.workflow.view") {
    assertControlEnvelope(args, "workflow", "view");
    const view = stringValue(args.view);

    if (!view) {
      throw new Error("continuous.workflow.view requires view.");
    }

    if (!isControlOperationIdentifier(view)) {
      throw new Error(controlOperationDescription);
    }

    if (!isAppServerWorkflowView(view)) {
      throw new Error(`Unsupported app-server workflow view: ${view}`);
    }

    const target = workflowTargetFrom(args);
    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.workflow.view",
      "read",
      `workflow:view.${view}`,
      target,
      context,
    );

    return executeWorkflowControlView({
      view,
      target,
      operatorEmail,
      config: objectValue(args.config),
    });
  }

  if (name === "continuous.approval.command") {
    assertControlEnvelope(args, "approval", "command");
    const command = stringValue(args.command);

    if (!command) {
      throw new Error("continuous.approval.command requires command.");
    }

    if (!isControlOperationIdentifier(command)) {
      throw new Error(controlOperationDescription);
    }

    if (!isAppServerApprovalCommand(command)) {
      throw new Error(`Unsupported app-server approval command: ${command}`);
    }

    const target = approvalTargetFrom(args);
    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.approval.command",
      "write",
      `approval:${command}`,
      target,
      context,
    );
    const idempotencyKey = requireIdempotency(args.idempotencyKey);
    const result = await executeApprovalControlCommand({
      command,
      target,
      operatorEmail,
      idempotencyKey,
      config: objectValue(args.config),
    });

    return {
      command,
      approval: {
        id: target.id ?? null,
        tenantSlug: target.tenantSlug ?? null,
        subject: target.subject ?? null,
      },
      result,
    };
  }

  if (name === "continuous.approval.view") {
    assertControlEnvelope(args, "approval", "view");
    const view = stringValue(args.view);

    if (!view) {
      throw new Error("continuous.approval.view requires view.");
    }

    if (!isControlOperationIdentifier(view)) {
      throw new Error(controlOperationDescription);
    }

    if (!isAppServerApprovalView(view)) {
      throw new Error(`Unsupported app-server approval view: ${view}`);
    }

    const target = approvalTargetFrom(args);
    const operatorEmail = operatorEmailFromTransportContext(
      "continuous.approval.view",
      "read",
      `approval:view.${view}`,
      target,
      context,
    );

    return executeApprovalControlView({
      view,
      target,
      operatorEmail,
      config: objectValue(args.config),
    });
  }

  throw new Error(`Unknown app-server control tool: ${name}`);
}

export async function executeAppServerControlDynamicToolCall(
  params: AppServerControlDynamicToolCallParams,
  context?: AppServerControlTransportContext,
): Promise<AppServerControlDynamicToolCallResponse> {
  try {
    const data = await executeAppServerControlTool(
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
      error: error instanceof Error ? error.message : "Unknown app-server control tool error",
    });
  }
}
