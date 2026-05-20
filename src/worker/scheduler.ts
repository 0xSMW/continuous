import { pathToFileURL } from "node:url";

import { and, desc, eq } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import { connections, tenants, type JsonObject } from "../db/schema";

const schedulerSource = "continuous.worker_scheduler";
const revenueWorkerRole = "revenue_operations";

type SchedulerDatabase = typeof defaultDb;

export type SchedulerConfig = {
  enabled: boolean;
  once: boolean;
  baseUrl: string;
  token?: string;
  tenantSlug: string;
  intervalMs: number;
  workflowLimit: number;
  adapterLimit: number;
  leadPollLimit: number;
  leaseMs: number;
  leaseOwner: string;
};

type SchedulerDependencies = {
  postCommand: typeof postCommand;
  listLeadPollCommands: typeof listLeadPollCommands;
  sleep: (ms: number) => Promise<void>;
  log: (event: SchedulerLogEvent) => void;
};

type SchedulerLogEvent = {
  level: "info" | "error";
  event: string;
  [key: string]: unknown;
};

type ApiEnvelope = {
  api: string;
  data: {
    command?: string;
    result?: unknown;
  } | null;
  error: {
    code: string;
    message: string;
  } | null;
};

export type ScheduledCommandResult = {
  endpoint: "/workflow" | "/worker";
  command: string;
  api: string;
  status: "succeeded" | "failed";
  result: unknown;
  error?: { message: string };
};

export type ScheduledRevenueRunResult = {
  connectionId: string;
  source: string;
  sourceEventId: string;
  idempotencyKey: string;
  status: "succeeded" | "failed";
  result?: unknown;
  error?: { message: string };
};

export type LeadPollCommand = {
  connectionId: string;
  source: string;
  idempotencyKey: string;
  config: {
    source: string;
    reader: {
      kind: string;
      provider: string;
      credentialRef: string;
      mode: "read_only";
    };
  };
};

export type ScheduledLeadPollResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  error?: { message: string };
  revenueRuns: {
    attempted: number;
    succeeded: number;
    failed: number;
  };
  commands: Array<{
    connectionId: string;
    source: string;
    idempotencyKey: string;
    status: "succeeded" | "failed";
    result?: unknown;
    error?: { message: string };
    revenueRuns: ScheduledRevenueRunResult[];
  }>;
};

export type SchedulerCycleResult = {
  workflow: ScheduledCommandResult;
  leadPolls: ScheduledLeadPollResult;
  adapterRetry: ScheduledCommandResult;
  adapterReconcile: ScheduledCommandResult;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    const output = stringValue(value);

    if (output) {
      return output;
    }
  }

  return "";
}

function booleanEnv(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numericValue = Number(value);

  if (!Number.isInteger(numericValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(numericValue, max));
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function firstConfiguredStringList(config: JsonObject, key: string) {
  const direct = stringList(config[key]);

  if (direct.length > 0) {
    return direct;
  }

  return stringList(config[`supported${key[0].toUpperCase()}${key.slice(1)}`]);
}

function inferredPollKind(source: string, provider: string) {
  const normalized = `${source} ${provider}`.toLowerCase();

  if (normalized.includes("inbox") || normalized.includes("gmail") || normalized.includes("google")) {
    return "inbox";
  }

  if (normalized.includes("crm") || normalized.includes("hubspot") || normalized.includes("salesforce")) {
    return "crm";
  }

  return "source_record";
}

function sourcePollingConfig(config: JsonObject) {
  return objectValue(config.polling ?? config.liveRead ?? config.apiRead);
}

function latestPollDate(config: JsonObject, lastSyncAt: Date | null) {
  const lastLeadRead = objectValue(config.lastLeadRead);
  const rawDate = firstStringValue(lastLeadRead.readAt, lastLeadRead.checkedAt);
  const date = rawDate ? new Date(rawDate) : lastSyncAt;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function pollIntervalMs(pollingConfig: JsonObject) {
  return boundedInteger(
    pollingConfig.intervalMs ?? pollingConfig.pollIntervalMs,
    5 * 60_000,
    60_000,
    24 * 60 * 60_000,
  );
}

function pollWindow(now: Date, intervalMs: number) {
  return Math.floor(now.getTime() / intervalMs);
}

function leadPollCommandFromConnection(input: {
  connection: typeof connections.$inferSelect;
  now: Date;
}) {
  const config = objectValue(input.connection.config);
  const polling = sourcePollingConfig(config);

  if (polling.enabled !== true) {
    return null;
  }

  const intervalMs = pollIntervalMs(polling);
  const latestPoll = latestPollDate(config, input.connection.lastSyncAt);

  if (latestPoll && input.now.getTime() - latestPoll.getTime() < intervalMs) {
    return null;
  }

  const sources = firstConfiguredStringList(config, "sources");
  const providers = firstConfiguredStringList(config, "providers");
  const readerKinds = firstConfiguredStringList(config, "readerKinds");
  const source = firstStringValue(polling.source, sources[0], config.source);
  const provider = firstStringValue(polling.provider, providers[0], config.provider, source);
  const kind = firstStringValue(polling.kind, polling.readerKind, readerKinds[0], inferredPollKind(source, provider));

  if (!source || !provider) {
    return null;
  }

  return {
    connectionId: input.connection.id,
    source,
    idempotencyKey: `scheduler-lead-read:${input.connection.id}:${pollWindow(input.now, intervalMs)}`,
    config: {
      source,
      reader: {
        kind,
        provider,
        credentialRef: `connection:${input.connection.id}`,
        mode: "read_only" as const,
      },
    },
  };
}

function leadReadSelectors(result: unknown) {
  const data = objectValue(result);
  const output = objectValue(data.output);

  if (Array.isArray(data.selectors)) {
    return data.selectors;
  }

  return Array.isArray(output.selectors) ? output.selectors : [];
}

function revenueRunInput(selectorValue: unknown): {
  source: string;
  sourceEventId: string;
  intake: unknown;
} | null {
  const selector = objectValue(selectorValue);
  const source = stringValue(selector.source);
  const sourceEventId = stringValue(selector.sourceEventId);

  if (!source || !sourceEventId) {
    return null;
  }

  return {
    source,
    sourceEventId,
    intake: selector.intake || { source, sourceEventId },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jsonLog(event: SchedulerLogEvent) {
  const line = JSON.stringify({
    source: schedulerSource,
    at: new Date().toISOString(),
    ...event,
  });

  if (event.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
  return import.meta.url === entry;
}

function errorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    message: "Unknown scheduler error.",
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function parseJsonResponse(response: Response): Promise<ApiEnvelope> {
  const fallback: ApiEnvelope = {
    api: "continuous.scheduler.unknown",
    data: null,
    error: {
      code: "scheduler_response_invalid",
      message: `Scheduler command returned HTTP ${response.status}.`,
    },
  };

  try {
    const parsed = (await response.json()) as ApiEnvelope;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function postCommand(input: {
  baseUrl: string;
  token: string;
  endpoint: "/workflow" | "/worker";
  payload: Record<string, unknown>;
}): Promise<ScheduledCommandResult> {
  const command = optionalString(input.payload.command) ?? "unknown";
  const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}${input.endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.payload),
  });
  const envelope = await parseJsonResponse(response);

  if (!response.ok || envelope.error) {
    throw new Error(
      `${input.endpoint} ${command} failed: ${envelope.error?.message ?? `HTTP ${response.status}`}`,
    );
  }

  return {
    endpoint: input.endpoint,
    command,
    api: envelope.api,
    status: "succeeded",
    result: envelope.data?.result ?? null,
  };
}

async function runScheduledCommand(input: {
  postCommand: typeof postCommand;
  baseUrl: string;
  token: string;
  endpoint: "/workflow" | "/worker";
  payload: Record<string, unknown>;
}): Promise<ScheduledCommandResult> {
  const command = optionalString(input.payload.command) ?? "unknown";

  try {
    return await input.postCommand({
      baseUrl: input.baseUrl,
      token: input.token,
      endpoint: input.endpoint,
      payload: input.payload,
    });
  } catch (error) {
    return {
      endpoint: input.endpoint,
      command,
      api: "continuous.scheduler.error",
      status: "failed",
      result: null,
      error: {
        message: errorMessage(error, `${input.endpoint} ${command} failed.`),
      },
    };
  }
}

export async function listLeadPollCommands(input: {
  tenantSlug: string;
  limit: number;
  now?: Date;
  db?: SchedulerDatabase;
}): Promise<LeadPollCommand[]> {
  if (input.limit <= 0) {
    return [];
  }

  const database = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const rows = await database
    .select({ connection: connections })
    .from(connections)
    .innerJoin(tenants, eq(connections.tenantId, tenants.id))
    .where(and(eq(tenants.slug, input.tenantSlug), eq(connections.state, "active")))
    .orderBy(desc(connections.updatedAt));

  return rows
    .map((row) => leadPollCommandFromConnection({ connection: row.connection, now }))
    .filter((command): command is LeadPollCommand => Boolean(command))
    .slice(0, input.limit);
}

async function runLeadPollCommands(input: {
  config: SchedulerConfig;
  postCommand: typeof postCommand;
  listCommands: typeof listLeadPollCommands;
}) {
  let commands: LeadPollCommand[];

  try {
    commands = await input.listCommands({
      tenantSlug: input.config.tenantSlug,
      limit: input.config.leadPollLimit,
    });
  } catch (error) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 1,
      error: {
        message: errorMessage(error, "Lead source discovery failed."),
      },
      revenueRuns: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
      },
      commands: [],
    } satisfies ScheduledLeadPollResult;
  }

  const result: ScheduledLeadPollResult = {
    attempted: commands.length,
    succeeded: 0,
    failed: 0,
    revenueRuns: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    },
    commands: [],
  };

  for (const command of commands) {
    try {
      const response = await input.postCommand({
        baseUrl: input.config.baseUrl,
        token: input.config.token ?? "",
        endpoint: "/worker",
        payload: {
          command: "lead.read",
          worker: {
            role: revenueWorkerRole,
            tenantSlug: input.config.tenantSlug,
          },
          idempotencyKey: command.idempotencyKey,
          config: command.config,
        },
      });
      const revenueRuns: ScheduledRevenueRunResult[] = [];

      for (const selector of leadReadSelectors(response.result)) {
        const runInput = revenueRunInput(selector);

        if (!runInput) {
          result.revenueRuns.attempted += 1;
          result.revenueRuns.failed += 1;
          revenueRuns.push({
            connectionId: command.connectionId,
            source: "",
            sourceEventId: "",
            idempotencyKey: "",
            status: "failed",
            error: {
              message: "lead.read selector must include source and sourceEventId.",
            },
          });
          continue;
        }

        result.revenueRuns.attempted += 1;

        const idempotencyKey =
          `scheduler-revenue-run:${command.connectionId}:${runInput.source}:${runInput.sourceEventId}`;

        try {
          const runResponse = await input.postCommand({
            baseUrl: input.config.baseUrl,
            token: input.config.token ?? "",
            endpoint: "/worker",
            payload: {
              command: "run",
              worker: {
                role: revenueWorkerRole,
                tenantSlug: input.config.tenantSlug,
              },
              idempotencyKey,
              config: {
                intake: runInput.intake,
              },
            },
          });

          result.revenueRuns.succeeded += 1;
          revenueRuns.push({
            connectionId: command.connectionId,
            source: runInput.source,
            sourceEventId: runInput.sourceEventId,
            idempotencyKey,
            status: "succeeded",
            result: runResponse.result,
          });
        } catch (error) {
          result.revenueRuns.failed += 1;
          revenueRuns.push({
            connectionId: command.connectionId,
            source: runInput.source,
            sourceEventId: runInput.sourceEventId,
            idempotencyKey,
            status: "failed",
            error: {
              message: error instanceof Error ? error.message : "Unknown revenue run failure.",
            },
          });
        }
      }

      result.succeeded += 1;
      result.commands.push({
        connectionId: command.connectionId,
        source: command.source,
        idempotencyKey: command.idempotencyKey,
        status: "succeeded",
        result: response.result,
        revenueRuns,
      });
    } catch (error) {
      result.failed += 1;
      result.commands.push({
        connectionId: command.connectionId,
        source: command.source,
        idempotencyKey: command.idempotencyKey,
        status: "failed",
        error: {
          message: error instanceof Error ? error.message : "Unknown lead source poll failure.",
        },
        revenueRuns: [],
      });
    }
  }

  return result;
}

export function parseSchedulerConfig(input: {
  env?: Record<string, string | undefined>;
  argv?: string[];
} = {}): SchedulerConfig {
  const runtimeEnv = input.env ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  const tenantSlug =
    optionalString(runtimeEnv.WORKER_SCHEDULER_TENANT_SLUG) ??
    optionalString(runtimeEnv.CONTROL_PLANE_ALLOWED_TENANTS?.split(",")[0]) ??
    "continuous-demo";

  return {
    enabled: booleanEnv(runtimeEnv.WORKER_SCHEDULER_ENABLED, false),
    once: argv.includes("--once"),
    baseUrl: normalizeBaseUrl(
      optionalString(runtimeEnv.WORKER_SCHEDULER_BASE_URL) ??
        optionalString(runtimeEnv.APP_URL) ??
        "http://127.0.0.1:3000",
    ),
    token: optionalString(runtimeEnv.WORKER_RUN_TOKEN),
    tenantSlug,
    intervalMs: boundedInteger(runtimeEnv.WORKER_SCHEDULER_INTERVAL_MS, 60_000, 5_000, 3_600_000),
    workflowLimit: boundedInteger(runtimeEnv.WORKER_SCHEDULER_WORKFLOW_LIMIT, 10, 1, 50),
    adapterLimit: boundedInteger(runtimeEnv.WORKER_SCHEDULER_ADAPTER_LIMIT, 25, 1, 100),
    leadPollLimit: boundedInteger(runtimeEnv.WORKER_SCHEDULER_LEAD_POLL_LIMIT, 5, 0, 50),
    leaseMs: boundedInteger(runtimeEnv.WORKER_SCHEDULER_WORKFLOW_LEASE_MS, 5 * 60_000, 30_000, 15 * 60_000),
    leaseOwner:
      optionalString(runtimeEnv.WORKER_SCHEDULER_LEASE_OWNER) ??
      `${schedulerSource}:${tenantSlug}`,
  };
}

export async function runSchedulerCycle(
  config: SchedulerConfig,
  dependencies: Partial<SchedulerDependencies> = {},
): Promise<SchedulerCycleResult> {
  const post = dependencies.postCommand ?? postCommand;
  const listCommands = dependencies.listLeadPollCommands ?? listLeadPollCommands;

  if (!config.token) {
    throw new Error("WORKER_RUN_TOKEN is required when the worker scheduler is enabled.");
  }

  const cycleKey = new Date().toISOString();
  const workflow = await runScheduledCommand({
    postCommand: post,
    baseUrl: config.baseUrl,
    token: config.token,
    endpoint: "/workflow",
    payload: {
      command: "steps.execute",
      workflow: {
        tenantSlug: config.tenantSlug,
      },
      config: {
        limit: config.workflowLimit,
        leaseMs: config.leaseMs,
        leaseOwner: config.leaseOwner,
      },
    },
  });
  const leadPolls = await runLeadPollCommands({
    config,
    postCommand: post,
    listCommands,
  });
  const adapterRetry = await runScheduledCommand({
    postCommand: post,
    baseUrl: config.baseUrl,
    token: config.token,
    endpoint: "/worker",
    payload: {
      command: "adapters.retry",
      worker: {
        role: revenueWorkerRole,
        tenantSlug: config.tenantSlug,
      },
      idempotencyKey: `scheduler-adapters-retry:${config.tenantSlug}:${cycleKey}`,
      config: {
        limit: config.adapterLimit,
      },
    },
  });
  const adapterReconcile = await runScheduledCommand({
    postCommand: post,
    baseUrl: config.baseUrl,
    token: config.token,
    endpoint: "/worker",
    payload: {
      command: "adapters.reconcile",
      worker: {
        role: revenueWorkerRole,
        tenantSlug: config.tenantSlug,
      },
      idempotencyKey: `scheduler-adapters-reconcile:${config.tenantSlug}:${cycleKey}`,
      config: {
        limit: config.adapterLimit,
      },
    },
  });

  return {
    workflow,
    leadPolls,
    adapterRetry,
    adapterReconcile,
  };
}

export async function runScheduler(
  config: SchedulerConfig,
  dependencies: Partial<SchedulerDependencies> = {},
) {
  const log = dependencies.log ?? jsonLog;
  const sleepFor = dependencies.sleep ?? sleep;

  if (!config.enabled) {
    log({
      level: "info",
      event: "scheduler_disabled",
      tenantSlug: config.tenantSlug,
    });
    return;
  }

  if (!config.token) {
    throw new Error("WORKER_RUN_TOKEN is required when the worker scheduler is enabled.");
  }

  let stopping = false;

  const stop = () => {
    stopping = true;
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  do {
    const startedAt = Date.now();

    try {
      const result = await runSchedulerCycle(config, dependencies);
      log({
        level: "info",
        event: "scheduler_cycle_completed",
        tenantSlug: config.tenantSlug,
        workflow: {
          status: result.workflow.status,
          result: result.workflow.result,
          error: result.workflow.error,
        },
        leadPolls: result.leadPolls,
        adapterRetry: {
          status: result.adapterRetry.status,
          result: result.adapterRetry.result,
          error: result.adapterRetry.error,
        },
        adapterReconcile: {
          status: result.adapterReconcile.status,
          result: result.adapterReconcile.result,
          error: result.adapterReconcile.error,
        },
      });
    } catch (error) {
      log({
        level: "error",
        event: "scheduler_cycle_failed",
        tenantSlug: config.tenantSlug,
        error: errorPayload(error),
      });
    }

    if (config.once || stopping) {
      break;
    }

    await sleepFor(Math.max(1_000, config.intervalMs - (Date.now() - startedAt)));
  } while (!stopping);
}

if (isMainModule()) {
  runScheduler(parseSchedulerConfig()).catch((error) => {
    jsonLog({
      level: "error",
      event: "scheduler_failed",
      error: errorPayload(error),
    });
    process.exitCode = 1;
  });
}
