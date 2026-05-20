import { describe, expect, it } from "vitest";

import {
  appServerWorkerToolManifest,
  executeAppServerWorkerTool,
} from "./app-server-tools";

describe("app-server worker tools", () => {
  it("exposes schema discovery and registry-backed worker command control", async () => {
    const schema = await executeAppServerWorkerTool("continuous.worker.schema");

    expect(appServerWorkerToolManifest.mode).toBe("registry_backed_worker_control");
    expect(appServerWorkerToolManifest.tools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
      "continuous.worker.command",
    ]);
    if (!("registry" in schema)) {
      throw new Error("Expected schema result.");
    }
    expect(schema.registry.commands.some((command) => command.name === "run")).toBe(true);
    expect(schema.registry.commands.some((command) => command.name === "approval.decide")).toBe(true);
  });

  it("requires a clean canonical command envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("continuous.worker.command requires command.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("continuous.worker.command requires operatorEmail.");
  });

  it("routes unavailable future workers through the shared registry guard", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-planned-worker-test",
        config: {},
      }),
    ).rejects.toThrow("planned but not available yet");
  });

  it("forwards nested lead reader config through the registry-backed command envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "lead.read",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-inbox-reader-test",
        config: {
          source: "google_workspace_inbox",
          reader: {
            kind: "inbox",
            provider: "google_workspace",
          },
          records: [
            {
              messageId: "message-001",
              from: "Buyer One <buyer@example.com>",
              subject: "Need roof leak inspection",
            },
          ],
        },
      }),
    ).rejects.toThrow("config.reader.credentialRef is required for inbox and CRM lead readers.");
  });
});
