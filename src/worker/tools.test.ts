import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  appServerWorkerToolManifest,
  appServerWorkerTools,
  executeAppServerWorkerTool,
} from "./app-server-tools";
import { executeWorkerTool, workerToolSchema, workerTools } from "./tools";
import { registeredWorkerCommands, registeredWorkerViews } from "./registry";
import {
  plannedWorkerCommands,
  plannedWorkerContracts,
  plannedWorkerViews,
} from "./planned-workers";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return routeFiles(path);
    }

    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  });
}

function workerFamilyApiEntries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    const nested = entry.isDirectory() ? workerFamilyApiEntries(path) : [];

    return /(?:^|\/)[a-z0-9-]+-worker(?:\/|$)/.test(path) ? [path, ...nested] : nested;
  });
}

describe("worker tool contract", () => {
  it("keeps the HTTP worker surface route-generic", () => {
    const root = process.cwd();
    const routePath = join(root, "app", "worker", "route.ts");
    const routeSource = readFileSync(routePath, "utf8");
    const appRoutes = routeFiles(join(root, "app")).map((path) => path.slice(root.length));
    const routeList = appRoutes.join("\n");
    const workerFamilyApiPaths = workerFamilyApiEntries(join(root, "app", "api"));

    expect(existsSync(routePath)).toBe(true);
    expect(workerFamilyApiPaths).toEqual([]);
    expect(routeList).not.toMatch(/\/app\/(?:api\/)?[a-z0-9-]+-worker\/route\.ts/);
    expect(routeSource).toContain("executeWorkerCommand");
    expect(routeSource).toContain("executeWorkerView");
    expect(routeSource).not.toContain("runRevenueWorker");
    expect(routeSource).not.toContain("reconcileAdapterLedger");
    expect(routeSource).not.toContain("decideApproval");
  });

  it("keeps local mutation entrypoints registry-generic", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["worker:tool"]).toBe("bun src/worker/run-tool.ts");

    for (const scriptName of Object.keys(pkg.scripts)) {
      expect(scriptName).not.toMatch(/^worker:[a-z0-9-]+-(?:worker|operations)$/);
      expect(pkg.scripts[scriptName]).not.toContain("run-revenue");
    }
  });

  it("keeps command tool inputs inside the worker command envelope", () => {
    for (const tool of workerTools) {
      if (tool.registry.surface !== "command") {
        continue;
      }

      const properties = tool.inputSchema.properties as Record<string, unknown>;

      expect(properties.worker).toBeTruthy();
      expect(Object.keys(properties)).not.toEqual(
        expect.arrayContaining(["role", "tenantSlug", "leadPacket", "approvalId", "limit", "source", "records"]),
      );
      expect(properties.idempotencyKey).toBeTruthy();
      if (properties.config) {
        expect((properties.config as { type?: string }).type).toBe("object");
      }
    }
  });

  it("rejects local worker tool payloads with top-level operation fields", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "local-envelope-test-001",
        leadPacket: {
          customerName: "Acme Roof Repair",
        },
        approvalId: "approval-1",
        config: {},
      }),
    ).rejects.toThrow(
      "Worker tool payload fields must be command, worker, idempotencyKey, config, and operatorEmail. Move operation inputs into config. Unexpected fields: leadPacket, approvalId.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "local-envelope-test-002",
        config: {},
      }),
    ).rejects.toThrow(
      "Worker tool payload fields must be command, worker, idempotencyKey, config, and operatorEmail. Move operation inputs into config. Unexpected fields: view.",
    );

    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
      }),
    ).rejects.toThrow(
      "Worker tool payload fields must be view, worker, config, and operatorEmail. Move operation inputs into config. Unexpected fields: command.",
    );
  });

  it("exposes registry-backed repo-owned worker tools", () => {
    expect(workerTools.map((tool) => tool.name)).toEqual([
      "worker.view",
      "worker.command",
    ]);
    expect(workerToolSchema.tools).toBe(workerTools);
    expect(workerToolSchema.registry.commands).toEqual(registeredWorkerCommands());
    expect(workerToolSchema.registry.views).toEqual(registeredWorkerViews());
    expect(workerToolSchema.registry.plannedContracts).toEqual(
      plannedWorkerContracts.map((contract) => ({
        role: contract.role,
        name: contract.name,
        contractPath: contract.contractPath,
        firstOutcome: contract.firstOutcome,
        autonomyLevel: contract.autonomyLevel,
        externalExecution: contract.externalExecution,
        evidencePacket: contract.evidencePacket,
      })),
    );
    expect(workerToolSchema.registry.plannedCommands).toEqual(plannedWorkerCommands());
    expect(workerToolSchema.registry.plannedViews).toEqual(plannedWorkerViews());
    expect(workerToolSchema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "revenue_operations",
          name: "run",
          idempotency: "required",
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "lead.read",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "lead.classify",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "response.draft",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "run",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "continue",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "adapters.reconcile",
          requiresTenant: true,
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "adapters.retry",
          requiresTenant: true,
        }),
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "brief.generate",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "decision_queue.prepare",
          idempotency: "required",
          requiresTenant: true,
        }),
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "anomaly.triage",
          idempotency: "required",
          requiresTenant: true,
        }),
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "continue",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "schedule.propose",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "dry_run",
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "customer_update.draft",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "closeout.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "exception.route",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "invoice.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "dry_run",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "ar_followup.draft",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "cash_forecast.generate",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "payment_draft.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
      ]),
    );
    expect(workerToolSchema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "revenue_operations",
          name: "lead.read",
          configSchema: expect.objectContaining({
            required: ["source"],
            oneRequired: ["record", "records", "items", "leads", "reader"],
            properties: expect.objectContaining({
              records: expect.objectContaining({ minItems: 1, maxItems: 25 }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "brief.generate",
          configSchema: expect.objectContaining({
            required: ["window", "scopes"],
            properties: expect.objectContaining({
              scopes: expect.objectContaining({ minItems: 1 }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "schedule.propose",
          configSchema: expect.objectContaining({
            required: ["constraints"],
            oneRequired: ["jobId", "sourceRefs"],
            properties: expect.objectContaining({
              constraints: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "customer_update.draft",
          configSchema: expect.objectContaining({
            required: ["jobId", "updateKind"],
            properties: expect.objectContaining({
              messageContext: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "closeout.prepare",
          configSchema: expect.objectContaining({
            required: ["workOrderId"],
            properties: expect.objectContaining({
              sourceRefs: expect.objectContaining({ type: "object" }),
              qaChecklist: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "exception.route",
          configSchema: expect.objectContaining({
            required: ["jobId", "reason", "severity"],
            properties: expect.objectContaining({
              severity: expect.objectContaining({
                enum: ["low", "medium", "high", "critical"],
              }),
              sourceRefs: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "invoice.prepare",
          configSchema: expect.objectContaining({
            oneRequired: ["jobId", "closeoutId", "sourceRefs"],
            properties: expect.objectContaining({
              sourceRefs: expect.objectContaining({ type: "object" }),
              billableLines: expect.objectContaining({ type: "array" }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "ar_followup.draft",
          configSchema: expect.objectContaining({
            required: ["invoiceId", "tonePolicy"],
            properties: expect.objectContaining({
              invoiceId: expect.objectContaining({ type: "string" }),
              tonePolicy: expect.objectContaining({ type: "string" }),
              sourceRefs: expect.objectContaining({ type: "object" }),
              messageContext: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "cash_forecast.generate",
          configSchema: expect.objectContaining({
            required: ["window", "accounts"],
            properties: expect.objectContaining({
              window: expect.objectContaining({ type: "object" }),
              accounts: expect.objectContaining({ type: "array", minItems: 1 }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "payment_draft.prepare",
          configSchema: expect.objectContaining({
            oneRequired: ["billId", "paymentId", "sourceRefs"],
            properties: expect.objectContaining({
              sourceRefs: expect.objectContaining({ type: "object" }),
              bankAccountId: expect.objectContaining({ type: "string" }),
              amountCents: expect.objectContaining({ type: "number", minimum: 0 }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
      ]),
    );
    expect(workerToolSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "revenue_operations", name: "snapshot" }),
        expect.objectContaining({ role: "revenue_operations", name: "approvals" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "snapshot" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "briefs" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "decisions" }),
        expect.objectContaining({ role: "dispatch_operations", name: "snapshot" }),
        expect.objectContaining({ role: "dispatch_operations", name: "board" }),
        expect.objectContaining({ role: "dispatch_operations", name: "exceptions" }),
        expect.objectContaining({ role: "finance_operations", name: "snapshot" }),
        expect.objectContaining({ role: "finance_operations", name: "approvals" }),
      ]),
    );
    expect(workerToolSchema.$defs.workerTarget.properties.tenantSlug.type).toBe("string");
    expect(workerToolSchema.$defs.workerTarget.required).toContain("role");
    for (const tool of workerTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties.worker).toBeTruthy();
    }
  });

  it("requires an explicit worker role before runtime work", async () => {
    await expect(
      executeWorkerTool("worker.view", {
        worker: {},
      }),
    ).rejects.toThrow("worker.role is required.");
  });

  it("rejects unsupported worker roles before runtime work", async () => {
    await expect(
      executeWorkerTool("worker.view", {
        worker: {
          role: "payroll_operations",
        },
      }),
    ).rejects.toThrow("Worker role payroll_operations is not available yet.");
  });

  it("exposes planned worker metadata without enabling unavailable runtime handlers", () => {
    const plannedCommands = workerToolSchema.registry.plannedCommands as Array<{
      role: string;
      name: string;
      requiredConfig: string[];
      oneRequiredConfig?: string[];
      configSchema: {
        type: string;
        required?: string[];
        oneRequired?: string[];
        properties?: Record<string, { type?: string; minItems?: number }>;
      };
    }>;

    expect(workerToolSchema.registry.plannedContracts.map((contract) => contract.role)).toEqual([
      "workforce_operations",
      "compliance_operations",
      "systems_operations",
    ]);
    expect(workerToolSchema.registry.plannedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "systems_operations",
          name: "sync.repair.plan",
          sideEffects: "dry_run",
        }),
      ]),
    );
    for (const command of plannedCommands) {
      expect(command.configSchema.type).toBe("object");
      expect(command.configSchema.required).toEqual(command.requiredConfig);
      for (const field of command.requiredConfig) {
        expect(command.configSchema.properties?.[field]).toBeTruthy();
      }
      if (command.oneRequiredConfig) {
        expect(command.configSchema.oneRequired).toEqual(command.oneRequiredConfig);
        for (const field of command.oneRequiredConfig) {
          expect(command.configSchema.properties?.[field]).toBeTruthy();
        }
      }
    }
    expect(
      plannedCommands.find(
        (command) => command.role === "systems_operations" && command.name === "connector.health.scan",
      )?.configSchema.properties?.checks?.type,
    ).toBe("array");
    expect(
      plannedCommands.find(
        (command) => command.role === "systems_operations" && command.name === "permission.review",
      )?.configSchema.oneRequired,
    ).toEqual(["connectionId", "grantId"]);
    expect(workerToolSchema.registry.plannedCommands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "brief.generate",
        }),
        expect.objectContaining({
          role: "dispatch_operations",
          name: "schedule.propose",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "invoice.prepare",
        }),
      ]),
    );
    expect(workerToolSchema.registry.plannedViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "compliance_operations",
          name: "snapshot",
          requiresTenant: true,
          evidencePacket: null,
        }),
      ]),
    );
  });

  it("validates worker run idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          intake: {
            source: "website_form",
            sourceEventId: "form-001",
          },
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("requires explicit Revenue run intake or lead payload", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "revenue-run-empty-config-001",
        config: {},
      }),
    ).rejects.toThrow("config.intake, leadPacket or lead is required for run.");
  });

  it("validates lead read idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          source: "website_form",
          records: [
            {
              sourceEventId: "source-event-001",
              customerName: "Acme Roof Repair",
            },
          ],
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("validates split revenue action idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.classify",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          leadPacket: {
            customerName: "Acme Roof Repair",
          },
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "response.draft",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          leadPacket: {
            customerName: "Acme Roof Repair",
          },
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("validates worker continuation idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "continue",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          approvalId: "approval_uuid",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("validates owner brief idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "brief.generate",
        worker: {
          role: "owner_chief_of_staff",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          window: {
            from: "2026-05-19T00:00:00.000Z",
            to: "2026-05-20T00:00:00.000Z",
          },
          scopes: ["tasks"],
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("validates dispatch schedule proposal envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "schedule.propose",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          jobId: "job_object_uuid",
          constraints: {
            serviceWindow: "2026-05-21",
          },
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "schedule.propose",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "dispatch-schema-001",
        config: {
          constraints: {
            durationMinutes: 120,
          },
        },
      }),
    ).rejects.toThrow("config.jobId or sourceRefs is required for schedule.propose.");
  });

  it("validates dispatch customer update draft envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "customer_update.draft",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          jobId: "job_object_uuid",
          updateKind: "schedule_proposed",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "customer_update.draft",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "dispatch-customer-update-schema-001",
        config: {
          jobId: "job_object_uuid",
        },
      }),
    ).rejects.toThrow("config.updateKind is required for customer_update.draft.");
  });

  it("validates dispatch closeout prepare envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "closeout.prepare",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          workOrderId: "work_order_uuid",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "closeout.prepare",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "dispatch-closeout-schema-001",
        config: {
          sourceRefs: {
            jobObjectId: "job_object_uuid",
          },
        },
      }),
    ).rejects.toThrow("config.workOrderId is required for closeout.prepare.");
  });

  it("validates dispatch exception route envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "exception.route",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          jobId: "job_object_uuid",
          reason: "missing_photos",
          severity: "high",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "exception.route",
        worker: {
          role: "dispatch_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "dispatch-exception-schema-001",
        config: {
          jobId: "job_object_uuid",
          reason: "missing_photos",
        },
      }),
    ).rejects.toThrow("config.severity is required for exception.route.");
  });

  it("validates finance invoice prepare envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "invoice.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          sourceRefs: {
            closeoutObjectId: "closeout_object_uuid",
          },
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "invoice.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "finance-invoice-schema-001",
        config: {},
      }),
    ).rejects.toThrow("config.jobId, closeoutId or sourceRefs is required for invoice.prepare.");
  });

  it("validates finance AR follow-up envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "ar_followup.draft",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          invoiceId: "invoice_uuid",
          tonePolicy: "friendly_first_reminder",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "ar_followup.draft",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "finance-ar-followup-schema-001",
        config: {
          invoiceId: "invoice_uuid",
        },
      }),
    ).rejects.toThrow("config.tonePolicy is required for ar_followup.draft.");
  });

  it("validates finance cash forecast envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "cash_forecast.generate",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          window: {
            from: "2026-05-01T00:00:00.000Z",
            to: "2026-06-01T00:00:00.000Z",
          },
          accounts: ["Operating account"],
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "cash_forecast.generate",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "finance-cash-forecast-schema-001",
        config: {
          window: {
            from: "2026-05-01T00:00:00.000Z",
            to: "2026-06-01T00:00:00.000Z",
          },
        },
      }),
    ).rejects.toThrow("config.accounts is required for cash_forecast.generate.");
  });

  it("validates finance payment draft envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_draft.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "bad key!",
        config: {
          paymentId: "payment_uuid",
        },
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_draft.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "finance-payment-draft-schema-001",
        config: {},
      }),
    ).rejects.toThrow("config.billId, paymentId or sourceRefs is required for payment_draft.prepare.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_draft.prepare",
        worker: {
          role: "finance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "finance-payment-draft-schema-002",
        config: {
          paymentId: "payment_uuid",
          amountCents: -1,
        },
      }),
    ).rejects.toThrow("config.amountCents must be greater than or equal to 0.");
  });

  it("requires tenant scope for adapter reconciliation", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "adapters.reconcile",
        worker: {
          role: "revenue_operations",
        },
        config: {
          limit: 25,
        },
      }),
    ).rejects.toThrow("worker.tenantSlug is required for adapters.reconcile.");
  });

  it("requires tenant scope for lead source reads", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
        },
        idempotencyKey: "lead-read-001",
        config: {
          source: "website_form",
          records: [
            {
              sourceEventId: "source-event-001",
              customerName: "Acme Roof Repair",
            },
          ],
        },
      }),
    ).rejects.toThrow("worker.tenantSlug is required for lead.read.");
  });

  it("requires tenant scope for adapter retry execution", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "adapters.retry",
        worker: {
          role: "revenue_operations",
        },
        config: {
          limit: 25,
        },
      }),
    ).rejects.toThrow("worker.tenantSlug is required for adapters.retry.");
  });

  it("rejects malformed command config instead of silently normalizing it", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "approval.decide",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: "approval-id",
      }),
    ).rejects.toThrow("config must be an object when provided.");
  });

  it("uses registry validation for adapter reconciliation limits", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "adapters.reconcile",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 1.5,
        },
      }),
    ).rejects.toThrow("config.limit must be an integer between 1 and 100.");
  });

  it("uses registry validation for adapter retry limits", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "adapters.retry",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 1.5,
        },
      }),
    ).rejects.toThrow("config.limit must be an integer between 1 and 100.");
  });

  it("uses registry config schemas for lead source reads", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "lead-read-schema-001",
        config: {
          records: [
            {
              sourceEventId: "source-event-001",
              customerName: "Acme Roof Repair",
            },
          ],
        },
      }),
    ).rejects.toThrow("config.source is required for lead.read.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "lead-read-schema-002",
        config: {
          source: "website_form",
        },
      }),
    ).rejects.toThrow("config.record, records, items, leads or reader is required for lead.read.");
  });

  it("requires source reader credential references without embedded credential material", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "lead-read-reader-001",
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

    await expect(
      executeWorkerTool("worker.command", {
        command: "lead.read",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "lead-read-reader-002",
        config: {
          source: "hubspot_crm",
          reader: {
            kind: "crm",
            provider: "hubspot",
            credentialRef: "connection:hubspot-demo",
            ["api" + "Key"]: true,
          },
          records: [
            {
              externalId: "deal-001",
              companyName: "CRM Buyer",
              dealName: "Window replacement quote",
            },
          ],
        },
      }),
    ).rejects.toThrow(
      "config.reader must reference credentials by credentialRef instead of embedding credential material.",
    );
  });

  it("uses registry config schemas for owner commands", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "brief.generate",
        worker: {
          role: "owner_chief_of_staff",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "owner-brief-schema-001",
        config: {
          window: {
            from: "2026-05-19T00:00:00.000Z",
            to: "2026-05-20T00:00:00.000Z",
          },
        },
      }),
    ).rejects.toThrow("config.scopes is required for brief.generate.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "anomaly.triage",
        worker: {
          role: "owner_chief_of_staff",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "owner-anomaly-schema-001",
        config: {
          window: {
            from: "2026-05-19T00:00:00.000Z",
            to: "2026-05-20T00:00:00.000Z",
          },
          metricKeys: [],
        },
      }),
    ).rejects.toThrow("config.metricKeys must contain at least 1 item.");
  });

  it("applies the same registry config schemas through app-server commands", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.command", {
        command: "approval.decide",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        config: {
          approvalId: "approval-1",
        },
      }),
    ).rejects.toThrow("config.action is required for approval.decide.");
  });

  it("exposes app-server worker discovery and registry command tools", async () => {
    expect(appServerWorkerTools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
      "continuous.worker.command",
    ]);
    expect(appServerWorkerToolManifest.mode).toBe("registry_backed_worker_control");
    expect(appServerWorkerToolManifest.boundary.sideEffects).toBe("registered_worker_commands_only");
    expect(appServerWorkerToolManifest.boundary.mutationTools).toBe("continuous.worker.command");

    const result = await executeAppServerWorkerTool("continuous.worker.schema");

    if (!("registry" in result)) {
      throw new Error("Expected schema result.");
    }
    expect(result.registry.commands).toEqual(registeredWorkerCommands());
    expect(result.plannedWorkers).toEqual(workerToolSchema.registry.plannedContracts);
    expect(result.workerToolSchema).toBe(workerToolSchema);
    expect(result.manifest.tools).toBe(appServerWorkerTools);
    await expect(
      executeAppServerWorkerTool("continuous.worker.schema", {
        worker: { role: "revenue_operations" },
      }),
    ).rejects.toThrow("continuous.worker.schema does not accept arguments.");
  });
});
