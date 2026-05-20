import { describe, expect, it, vi } from "vitest";

import {
  parseSchedulerConfig,
  runScheduler,
  runSchedulerCycle,
  type LeadPollCommand,
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

function leadPollCommand(): LeadPollCommand {
  return {
    connectionId: "conn-google-workspace",
    source: "google_workspace_inbox",
    idempotencyKey: "scheduler-lead-read:conn-google-workspace:123",
    config: {
      source: "google_workspace_inbox",
      reader: {
        kind: "inbox",
        provider: "google_workspace",
        credentialRef: "connection:conn-google-workspace",
        mode: "read_only",
      },
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
        WORKER_SCHEDULER_LEAD_POLL_LIMIT: "999",
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
      leadPollLimit: 50,
      leaseMs: 30_000,
    });
  });

  it("posts the canonical workflow and worker command envelopes", async () => {
    const postCommand = vi.fn(async ({ payload }) => {
      return scheduledResult(String(payload.command));
    });
    const listLeadPollCommands = vi.fn(async () => [leadPollCommand()]);

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
        leadPollLimit: 5,
        leaseMs: 120_000,
        leaseOwner: "scheduler-test",
      },
      {
        postCommand,
        listLeadPollCommands,
      },
    );

    expect(result.workflow.command).toBe("steps.execute");
    expect(result.leadPolls).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(result.adapterRetry.command).toBe("adapters.retry");
    expect(result.adapterReconcile.command).toBe("adapters.reconcile");
    expect(listLeadPollCommands).toHaveBeenCalledWith({
      tenantSlug: "continuous-demo",
      limit: 5,
    });
    expect(postCommand).toHaveBeenCalledTimes(4);
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
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "scheduler-lead-read:conn-google-workspace:123",
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
            credentialRef: "connection:conn-google-workspace",
            mode: "read_only",
          },
        },
      },
    });
    expect(postCommand).toHaveBeenNthCalledWith(3, {
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
    expect(postCommand).toHaveBeenNthCalledWith(4, {
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

  it("isolates lead poll failures from workflow and adapter draining", async () => {
    const postCommand = vi.fn(async ({ payload }) => {
      if (payload.command === "lead.read") {
        throw new Error("poll failed");
      }

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
        leadPollLimit: 5,
        leaseMs: 120_000,
        leaseOwner: "scheduler-test",
      },
      {
        postCommand,
        listLeadPollCommands: vi.fn(async () => [leadPollCommand()]),
      },
    );

    expect(result.leadPolls).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      commands: [
        {
          connectionId: "conn-google-workspace",
          source: "google_workspace_inbox",
          status: "failed",
          error: {
            message: "poll failed",
          },
        },
      ],
    });
    expect(result.workflow.command).toBe("steps.execute");
    expect(result.adapterRetry.command).toBe("adapters.retry");
    expect(result.adapterReconcile.command).toBe("adapters.reconcile");
    expect(postCommand).toHaveBeenCalledTimes(4);
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
        leadPollLimit: 5,
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
        leadPollLimit: 5,
        leaseMs: 300_000,
        leaseOwner: "scheduler-test",
      }),
    ).rejects.toThrow("WORKER_RUN_TOKEN is required");
  });
});
