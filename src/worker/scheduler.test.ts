import { describe, expect, it, vi } from "vitest";

import {
  parseSchedulerConfig,
  runScheduler,
  runSchedulerCycle,
  type ScheduledCommandResult,
} from "./scheduler";

function scheduledResult(command: string): ScheduledCommandResult {
  return {
    endpoint: command === "steps.execute" ? "/workflow" : "/worker",
    command,
    api: command === "steps.execute" ? "continuous.workflow.v1" : "continuous.worker.v1",
    result: {
      processed: 0,
    },
  };
}

describe("worker scheduler", () => {
  it("parses scheduler config with safe defaults and bounded limits", () => {
    const config = parseSchedulerConfig({
      argv: ["--once"],
      env: {
        APP_URL: "https://continuoushq.com/",
        WORKER_RUN_TOKEN: "test-token",
        WORKER_SCHEDULER_ENABLED: "true",
        WORKER_SCHEDULER_TENANT_SLUG: "continuous-demo",
        WORKER_SCHEDULER_INTERVAL_MS: "1",
        WORKER_SCHEDULER_WORKFLOW_LIMIT: "999",
        WORKER_SCHEDULER_ADAPTER_LIMIT: "0",
        WORKER_SCHEDULER_WORKFLOW_LEASE_MS: "1",
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      once: true,
      baseUrl: "https://continuoushq.com",
      token: "test-token",
      tenantSlug: "continuous-demo",
      intervalMs: 5_000,
      workflowLimit: 50,
      adapterLimit: 1,
      leaseMs: 30_000,
    });
  });

  it("posts the canonical workflow and worker command envelopes", async () => {
    const postCommand = vi.fn(async ({ payload }) => {
      return scheduledResult(String(payload.command));
    });

    const result = await runSchedulerCycle(
      {
        enabled: true,
        once: true,
        baseUrl: "http://app:3000",
        token: "test-token",
        tenantSlug: "continuous-demo",
        intervalMs: 60_000,
        workflowLimit: 7,
        adapterLimit: 11,
        leaseMs: 120_000,
        leaseOwner: "scheduler-test",
      },
      {
        postCommand,
      },
    );

    expect(result.workflow.command).toBe("steps.execute");
    expect(result.adapterRetry.command).toBe("adapters.retry");
    expect(result.adapterReconcile.command).toBe("adapters.reconcile");
    expect(postCommand).toHaveBeenCalledTimes(3);
    expect(postCommand).toHaveBeenNthCalledWith(1, {
      baseUrl: "http://app:3000",
      token: "test-token",
      endpoint: "/workflow",
      payload: {
        command: "steps.execute",
        workflow: {
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 7,
          leaseMs: 120_000,
          leaseOwner: "scheduler-test",
        },
      },
    });
    expect(postCommand).toHaveBeenNthCalledWith(2, {
      baseUrl: "http://app:3000",
      token: "test-token",
      endpoint: "/worker",
      payload: {
        command: "adapters.retry",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 11,
        },
      },
    });
    expect(postCommand).toHaveBeenNthCalledWith(3, {
      baseUrl: "http://app:3000",
      token: "test-token",
      endpoint: "/worker",
      payload: {
        command: "adapters.reconcile",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 11,
        },
      },
    });
  });

  it("does not run commands when the scheduler is disabled", async () => {
    const postCommand = vi.fn();
    const log = vi.fn();

    await runScheduler(
      {
        enabled: false,
        once: true,
        baseUrl: "http://app:3000",
        tenantSlug: "continuous-demo",
        intervalMs: 60_000,
        workflowLimit: 10,
        adapterLimit: 25,
        leaseMs: 300_000,
        leaseOwner: "scheduler-test",
      },
      {
        postCommand,
        log,
      },
    );

    expect(postCommand).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({
      level: "info",
      event: "scheduler_disabled",
      tenantSlug: "continuous-demo",
    });
  });

  it("requires the worker token when enabled", async () => {
    await expect(
      runSchedulerCycle({
        enabled: true,
        once: true,
        baseUrl: "http://app:3000",
        tenantSlug: "continuous-demo",
        intervalMs: 60_000,
        workflowLimit: 10,
        adapterLimit: 25,
        leaseMs: 300_000,
        leaseOwner: "scheduler-test",
      }),
    ).rejects.toThrow("WORKER_RUN_TOKEN is required");
  });
});
