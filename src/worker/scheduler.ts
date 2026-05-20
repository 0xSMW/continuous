import { pathToFileURL } from "node:url";

const schedulerSource = "continuous.worker_scheduler";
const revenueWorkerRole = "revenue_operations";

export type SchedulerConfig = {
  enabled: boolean;
  once: boolean;
  baseUrl: string;
  token?: string;
  tenantSlug: string;
  intervalMs: number;
  workflowLimit: number;
  adapterLimit: number;
  leaseMs: number;
  leaseOwner: string;
};

type SchedulerDependencies = {
  postCommand: typeof postCommand;
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
  result: unknown;
};

export type SchedulerCycleResult = {
  workflow: ScheduledCommandResult;
  adapterRetry: ScheduledCommandResult;
  adapterReconcile: ScheduledCommandResult;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    result: envelope.data?.result ?? null,
  };
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

  if (!config.token) {
    throw new Error("WORKER_RUN_TOKEN is required when the worker scheduler is enabled.");
  }

  const workflow = await post({
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
  const adapterRetry = await post({
    baseUrl: config.baseUrl,
    token: config.token,
    endpoint: "/worker",
    payload: {
      command: "adapters.retry",
      worker: {
        role: revenueWorkerRole,
        tenantSlug: config.tenantSlug,
      },
      config: {
        limit: config.adapterLimit,
      },
    },
  });
  const adapterReconcile = await post({
    baseUrl: config.baseUrl,
    token: config.token,
    endpoint: "/worker",
    payload: {
      command: "adapters.reconcile",
      worker: {
        role: revenueWorkerRole,
        tenantSlug: config.tenantSlug,
      },
      config: {
        limit: config.adapterLimit,
      },
    },
  });

  return {
    workflow,
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
        workflow: result.workflow.result,
        adapterRetry: result.adapterRetry.result,
        adapterReconcile: result.adapterReconcile.result,
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
