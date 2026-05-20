import { afterEach, describe, expect, it } from "vitest";

import {
  appServerWorkerToolManifest,
  executeAppServerWorkerTool,
} from "./app-server-tools";

const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

afterEach(() => {
  if (originalAppEnv === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = originalAppEnv;
  }

  if (originalTrustedLocalWorkerTools === undefined) {
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
  } else {
    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = originalTrustedLocalWorkerTools;
  }
});

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
    expect(schema.registry.commands.some((command) => command.name === "lead.classify")).toBe(true);
    expect(schema.registry.commands.some((command) => command.name === "response.draft")).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "brief.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "decision_queue.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "anomaly.triage" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "schedule.propose",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "customer_update.draft",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "closeout.prepare",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "dispatch_operations" &&
          command.name === "exception.route" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "invoice.prepare" &&
          command.externalExecution === "dry_run",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "ar_followup.draft" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "cash_forecast.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      schema.registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "payment_draft.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
  });

  it("requires a clean canonical command envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-envelope-test-001",
        approvalId: "approval-1",
        limit: 25,
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command payload fields must be command, worker, operatorEmail, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: approvalId, limit.",
    );

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

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          approvalId: "approval-1",
        },
        idempotencyKey: "app-server-nested-worker-envelope-test-001",
        config: {
          intake: {
            source: "website_form",
            sourceEventId: "app-server-nested-worker-envelope-form-001",
          },
        },
      }),
    ).rejects.toThrow(
      "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: approvalId.",
    );
  });

  it("routes unavailable future workers through the shared registry guard", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "hire.packet.prepare",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "workforce_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-planned-worker-test",
        config: {},
      }),
    ).rejects.toThrow("planned but not available yet");
  });

  it("disables app-server worker mutations in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-app-server-mutation-guard-001",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command is a trusted local mutation surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );

    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "missing.command",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-app-server-mutation-guard-002",
        config: {},
      }),
    ).rejects.toThrow("Worker command must be run");
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

  it("applies registry schemas to dispatch commands through the app-server envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "customer_update.draft",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-update-schema",
        config: {
          jobId: "job_object_uuid",
        },
      }),
    ).rejects.toThrow("config.updateKind is required for customer_update.draft.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "closeout.prepare",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-closeout-schema",
        config: {
          sourceRefs: {
            jobObjectId: "job_object_uuid",
          },
        },
      }),
    ).rejects.toThrow("config.workOrderId is required for closeout.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "exception.route",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-dispatch-exception-schema",
        config: {
          jobId: "job_object_uuid",
          reason: "missing_photos",
        },
      }),
    ).rejects.toThrow("config.severity is required for exception.route.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "invoice.prepare",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-invoice-schema",
        config: {},
      }),
    ).rejects.toThrow("config.jobId, closeoutId or sourceRefs is required for invoice.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "ar_followup.draft",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-ar-followup-schema",
        config: {
          invoiceId: "invoice_uuid",
        },
      }),
    ).rejects.toThrow("config.tonePolicy is required for ar_followup.draft.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "cash_forecast.generate",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-cash-forecast-schema",
        config: {
          window: {
            from: "2026-05-01T00:00:00.000Z",
            to: "2026-06-01T00:00:00.000Z",
          },
        },
      }),
    ).rejects.toThrow("config.accounts is required for cash_forecast.generate.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "payment_draft.prepare",
        operatorEmail: "owner@continuoushq.com",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-finance-payment-draft-schema",
        config: {},
      }),
    ).rejects.toThrow("config.billId, paymentId or sourceRefs is required for payment_draft.prepare.");
  });
});
