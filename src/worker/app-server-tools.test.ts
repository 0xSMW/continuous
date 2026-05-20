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
      "continuous.worker.view",
    ]);
    expect(
      Object.keys(
        appServerWorkerToolManifest.tools.find((tool) => tool.name === "continuous.worker.command")
          ?.inputSchema.properties ?? {},
      ),
    ).not.toContain("operatorEmail");
    if (!("registry" in schema) || !schema.registry) {
      throw new Error("Expected schema result.");
    }
    const registry = schema.registry;
    const runtimeRoles = registry.runtimeContracts.map((contract) => contract.role);
    const plannedRoles = registry.plannedContracts.map((contract) => contract.role);
    const revenueFollowUpCommands = registry.followUpCommands.filter(
      (command) => command.role === "revenue_operations",
    );

    expect(registry.contracts.map((contract) => contract.role)).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "compliance_operations",
      "systems_operations",
    ]);
    expect(registry.contracts.every((contract) => contract.apiRoute === "/worker")).toBe(true);
    expect(registry.commands.every((command) => command.apiRoute === "/worker")).toBe(true);
    expect(registry.views.every((view) => view.apiRoute === "/worker")).toBe(true);
    expect(runtimeRoles).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
    ]);
    expect(plannedRoles).toEqual(["compliance_operations", "systems_operations"]);
    expect(registry.plannedCommands).toEqual(registry.followUpCommands);
    expect(registry.plannedViews).toEqual(registry.followUpViews);
    expect(revenueFollowUpCommands.map((command) => command.name)).toEqual([
      "quote.prepare",
      "payment_link.prepare",
    ]);
    expect(
      revenueFollowUpCommands.find((command) => command.name === "payment_link.prepare")?.configSchema.properties
        ?.sourceRefs?.type,
    ).toBe("object");
    expect(registry.commands.some((command) => command.name === "run")).toBe(true);
    expect(registry.commands.some((command) => command.name === "approval.decide")).toBe(true);
    expect(registry.commands.some((command) => command.name === "lead.classify")).toBe(true);
    expect(registry.commands.some((command) => command.name === "response.draft")).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "brief.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "decision_queue.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "owner_chief_of_staff" &&
          command.name === "anomaly.triage" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "schedule.propose",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "customer_update.draft",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) => command.role === "dispatch_operations" && command.name === "closeout.prepare",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "dispatch_operations" &&
          command.name === "exception.route" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "invoice.prepare" &&
          command.externalExecution === "dry_run",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "ar_followup.draft" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "cash_forecast.generate" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "finance_operations" &&
          command.name === "payment_draft.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "workforce_operations" &&
          command.name === "hire.packet.prepare" &&
          command.externalExecution === "blocked",
      ),
    ).toBe(true);
    expect(
      registry.commands.some(
        (command) =>
          command.role === "workforce_operations" &&
          command.name === "payroll_input.prepare" &&
          command.externalExecution === "dry_run",
      ),
    ).toBe(true);
    expect(registry.views.some((view) => view.role === "workforce_operations" && view.name === "readiness")).toBe(true);
  });

  it("requires a clean canonical command envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        idempotencyKey: "app-server-missing-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker must be an object with role, id, and tenantSlug selectors.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
        worker: {},
        idempotencyKey: "app-server-empty-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker.role is required.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
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
      "continuous.worker.command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: approvalId, limit.",
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
        operatorEmail: "owner@continuoushq.com",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: operatorEmail.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
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

  it("requires a clean canonical view envelope before dispatch", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        config: {},
      }),
    ).rejects.toThrow("worker must be an object with role, id, and tenantSlug selectors.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {},
        config: {},
      }),
    ).rejects.toThrow("worker.role is required.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        state: "active",
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.view payload fields must be view, worker, and config. Move operation inputs into config. Unexpected fields: state.",
    );

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          approvalId: "approval-1",
        },
        config: {
          state: "active",
        },
      }),
    ).rejects.toThrow(
      "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: approvalId.",
    );
  });

  it("applies registry schemas to workforce commands through the app-server envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "hire.packet.prepare",
        worker: {
          role: "workforce_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-planned-worker-test",
        config: {},
      }),
    ).rejects.toThrow("config.personId is required for hire.packet.prepare.");

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "payroll_input.prepare",
        worker: {
          role: "workforce_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "app-server-workforce-payroll-schema",
        config: {
          employmentId: "employment_uuid",
        },
      }),
    ).rejects.toThrow("config.period is required for payroll_input.prepare.");
  });

  it("disables app-server worker mutations in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "run",
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
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-app-server-mutation-guard-002",
        config: {},
      }),
    ).rejects.toThrow("Worker command must be run");
  });

  it("disables app-server worker reads in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow(
      "continuous.worker.view is a trusted local read surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );
  });

  it("forwards nested lead reader config through the registry-backed command envelope", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "lead.read",
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
