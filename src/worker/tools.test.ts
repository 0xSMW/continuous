import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  appServerWorkerToolManifest,
  appServerWorkerTools,
  executeAppServerWorkerTool,
} from "./app-server-tools";
import { executeWorkerTool, workerToolSchema, workerTools } from "./tools";
import { executeWorkerCommand, registeredWorkerCommands, registeredWorkerViews } from "./registry";
import {
  plannedWorkerCommands,
  plannedWorkerContracts,
  plannedWorkerViews,
  runtimeWorkerContracts,
  workerContracts,
  workerExpansionCatalog,
  workerFollowUpCommands,
  workerFollowUpViews,
} from "./planned-workers";

const originalAppEnv = process.env.APP_ENV;
const originalTrustedLocalWorkerTools = process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;
const originalWorkerOperatorEmail = process.env.WORKER_OPERATOR_EMAIL;
const runtimeContractRoles = [
  "revenue_operations",
  "owner_chief_of_staff",
  "dispatch_operations",
  "finance_operations",
  "workforce_operations",
  "compliance_operations",
  "systems_operations",
  "offer_pricing_operations",
];
const plannedContractRoles = [
  "customer_experience_operations",
  "asset_supply_operations",
  "growth_operations",
  "vertical_packages",
];
const contractRoles = [...runtimeContractRoles, ...plannedContractRoles];

beforeEach(() => {
  process.env.WORKER_OPERATOR_EMAIL = "owner@continuoushq.com";
});

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

  if (originalWorkerOperatorEmail === undefined) {
    delete process.env.WORKER_OPERATOR_EMAIL;
  } else {
    process.env.WORKER_OPERATOR_EMAIL = originalWorkerOperatorEmail;
  }
});

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

    return /(?:^|\/)[a-z0-9_-]+[-_]worker(?:\/|$)/.test(path) ? [path, ...nested] : nested;
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
    expect(routeList).not.toMatch(/\/app\/(?:api\/)?[a-z0-9_-]+[-_]worker\/route\.ts/);
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
    expect(Object.keys(pkg.scripts).filter((scriptName) => scriptName.startsWith("worker:"))).toEqual([
      "worker:tool",
    ]);

    for (const scriptName of Object.keys(pkg.scripts)) {
      if (scriptName !== "worker:tool") {
        expect(scriptName).not.toMatch(/^worker:/);
      }
      expect(pkg.scripts[scriptName]).not.toContain("run-revenue");
    }
  });

  it("rejects worker-family-specific local tool aliases", async () => {
    for (const alias of [
      "revenue.run",
      "worker.run",
      "lead.read",
      "invoice.prepare",
      "finance_operations.invoice.prepare",
    ]) {
      await expect(
        executeWorkerTool(alias, {
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          config: {},
        }),
      ).rejects.toThrow(`Unknown worker tool: ${alias}`);
    }
  });

  it("requires operator identity from the local worker transport environment", async () => {
    delete process.env.WORKER_OPERATOR_EMAIL;

    await expect(
      executeWorkerTool("worker.command", {
        command: "missing.command",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "local-missing-operator-command",
        config: {},
      }),
    ).rejects.toThrow(
      "worker.command requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.",
    );

    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow(
      "worker.view requires WORKER_OPERATOR_EMAIL from the trusted local transport environment.",
    );
  });

  it("keeps command tool inputs inside the worker command envelope", () => {
    for (const tool of workerTools) {
      if (tool.registry.surface !== "command") {
        continue;
      }

      const properties = tool.inputSchema.properties as Record<string, unknown>;

      expect(properties.worker).toBeTruthy();
      expect(Object.keys(properties)).not.toEqual(
        expect.arrayContaining([
          "role",
          "tenantSlug",
          "operatorEmail",
          "leadPacket",
          "approvalId",
          "limit",
          "source",
          "records",
        ]),
      );
      expect(properties.idempotencyKey).toBeTruthy();
      if (properties.config) {
        expect((properties.config as { type?: string }).type).toBe("object");
      }
    }
    expect(workerToolSchema.$defs.workerTarget.additionalProperties).toBe(false);
  });

  it("keeps local and app-server worker envelopes in parity", () => {
    const localCommand = workerTools.find((tool) => tool.name === "worker.command");
    const localView = workerTools.find((tool) => tool.name === "worker.view");
    const appServerCommand = appServerWorkerTools.find(
      (tool) => tool.name === "continuous.worker.command",
    );
    const appServerView = appServerWorkerTools.find((tool) => tool.name === "continuous.worker.view");

    if (!localCommand || !localView || !appServerCommand || !appServerView) {
      throw new Error("Expected local and app-server worker tool specs.");
    }

    expect(Object.keys(localCommand.inputSchema.properties)).toEqual([
      "command",
      "worker",
      "idempotencyKey",
      "config",
    ]);
    expect(Object.keys(appServerCommand.inputSchema.properties)).toEqual([
      "command",
      "worker",
      "idempotencyKey",
      "config",
    ]);
    expect(localCommand.inputSchema.required).toEqual(["command", "worker", "config"]);
    expect(appServerCommand.inputSchema.required).toEqual(["command", "worker", "config"]);
    expect(localCommand.inputSchema.additionalProperties).toBe(false);
    expect(appServerCommand.inputSchema.additionalProperties).toBe(false);

    expect(Object.keys(localView.inputSchema.properties)).toEqual(["view", "worker", "config"]);
    expect(Object.keys(appServerView.inputSchema.properties)).toEqual(["view", "worker", "config"]);
    expect(localView.inputSchema.required).toEqual(["view", "worker", "config"]);
    expect(appServerView.inputSchema.required).toEqual(["view", "worker", "config"]);
    expect(localView.inputSchema.additionalProperties).toBe(false);
    expect(appServerView.inputSchema.additionalProperties).toBe(false);

    const appServerCommandDefs = appServerCommand.inputSchema.$defs;
    const appServerViewDefs = appServerView.inputSchema.$defs;

    expect(appServerCommandDefs.workerTarget.properties).toEqual(
      workerToolSchema.$defs.workerTarget.properties,
    );
    expect(appServerViewDefs.workerTarget.properties).toEqual(
      workerToolSchema.$defs.workerTarget.properties,
    );
    expect(appServerCommandDefs.workerTarget.required).toEqual(["role"]);
    expect(appServerViewDefs.workerTarget.required).toEqual(["role"]);
    expect(appServerCommandDefs.workerTarget.additionalProperties).toBe(false);
    expect(appServerViewDefs.workerTarget.additionalProperties).toBe(false);
  });

  it("rejects local worker tool payloads with top-level operation fields", async () => {
    await expect(
      executeWorkerTool("worker.view", {
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("worker.view requires view.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        idempotencyKey: "local-missing-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker must be an object with role, id, and tenantSlug selectors.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {},
        idempotencyKey: "local-empty-worker-test-001",
        config: {},
      }),
    ).rejects.toThrow("worker.role is required.");

    const apiFamilyRole = ["api", "domain-worker"].join("/");

    for (const role of ["domain-worker", "domain_worker", apiFamilyRole, "worker/domain"]) {
      await expect(
        executeWorkerTool("worker.command", {
          command: "run",
          worker: {
            role,
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: `local-bad-worker-role-${role.replaceAll(/[^a-z0-9]+/g, "-")}`,
          config: {
            intake: {
              source: "website_form",
              sourceEventId: "local-bad-worker-role-form-001",
            },
          },
        }),
      ).rejects.toThrow(
        "worker.role must be a lower_snake_case role identifier such as revenue_operations; do not use route names, family-worker names, or URL fragments.",
      );
    }

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "local-missing-config-test-001",
      }),
    ).rejects.toThrow("config is required and must be an object.");

    for (const command of [
      ["", "api", "revenue-worker", "run"].join("/"),
      ["", "revenue-worker"].join("/"),
      "revenue-worker",
      ["revenue_worker", "run"].join("."),
      "worker.run",
      "worker?view=snapshot",
      "api.worker.run",
    ]) {
      await expect(
        executeWorkerTool("worker.command", {
          command,
          worker: {
            role: "revenue_operations",
            tenantSlug: "continuous-demo",
          },
          idempotencyKey: `local-bad-operation-${command.replaceAll(/[^a-z0-9]+/g, "-")}`,
          config: {},
        }),
      ).rejects.toThrow(
        "Worker command and view names must be registered lower_snake_case or dotted operation identifiers such as lead.read or quote.prepare; do not use URL paths, route names, family-worker names, or query strings.",
      );
    }

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
      "Worker tool payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: leadPacket, approvalId.",
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
      "Worker tool payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: view.",
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
      "Worker tool payload fields must be view, worker, and config. Move operation inputs into config. Unexpected fields: command.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          leadPacket: {
            customerName: "Acme Roof Repair",
          },
        },
        idempotencyKey: "nested-worker-envelope-test-001",
        config: {
          intake: {
            source: "website_form",
            sourceEventId: "nested-worker-envelope-test-form-001",
          },
        },
      }),
    ).rejects.toThrow(
      "worker target fields must be role, id, and tenantSlug. Move operation inputs into config. Unexpected fields: leadPacket.",
    );
  });

  it("rejects malformed optional worker selectors on local tools", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
          id: 42,
        },
        idempotencyKey: "local-malformed-worker-id",
        config: {},
      }),
    ).rejects.toThrow("worker.id must be a non-empty string when supplied.");

    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "",
        },
        config: {},
      }),
    ).rejects.toThrow("worker.tenantSlug must be a non-empty string when supplied.");
  });

  it("disables local worker mutations in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeWorkerTool("worker.command", {
        command: "run",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-local-mutation-guard-001",
        config: {},
      }),
    ).rejects.toThrow(
      "worker.command is a trusted local mutation surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );

    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    await expect(
      executeWorkerTool("worker.command", {
        command: "missing.command",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "production-local-mutation-guard-002",
        config: {},
      }),
    ).rejects.toThrow("Worker command must be run");
  });

  it("disables local worker reads in production unless explicitly trusted", async () => {
    process.env.APP_ENV = "production";
    delete process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS;

    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow(
      "worker.view is a trusted local read surface and is disabled in production unless CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true.",
    );

    process.env.CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS = "true";
    await expect(
      executeWorkerTool("worker.view", {
        view: "missing",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: {},
      }),
    ).rejects.toThrow("Worker view must be snapshot or approvals or readiness.");
  });

  it("exposes registry-backed repo-owned worker tools", () => {
    expect(workerTools.map((tool) => tool.name)).toEqual([
      "worker.view",
      "worker.command",
    ]);
    const contractSummary = (contract: (typeof workerContracts)[number]) => ({
      role: contract.role,
      name: contract.name,
      apiRoute: contract.apiRoute,
      contractPath: contract.contractPath,
      firstOutcome: contract.firstOutcome,
      autonomyLevel: contract.autonomyLevel,
      externalExecution: contract.externalExecution,
      evidencePacket: contract.evidencePacket,
    });

    expect(workerToolSchema.tools).toBe(workerTools);
    expect(workerToolSchema.registry.commands).toEqual(registeredWorkerCommands());
    expect(workerToolSchema.registry.views).toEqual(registeredWorkerViews());
    expect(workerToolSchema.registry.contracts).toEqual(workerContracts.map(contractSummary));
    expect(workerToolSchema.registry.runtimeContracts).toEqual(
      runtimeWorkerContracts.map(contractSummary),
    );
    expect(workerToolSchema.registry.plannedContracts).toEqual(
      plannedWorkerContracts.map(contractSummary),
    );
    expect(workerToolSchema.registry.plannedCommands).toEqual(
      workerFollowUpCommands(registeredWorkerCommands()),
    );
    expect(workerToolSchema.registry.plannedViews).toEqual(
      workerFollowUpViews(registeredWorkerViews()),
    );
    expect(workerToolSchema.registry.plannedFutureWorkerCommands).toEqual(
      plannedWorkerCommands(),
    );
    expect(workerToolSchema.registry.plannedFutureWorkerViews).toEqual(plannedWorkerViews());
    expect(workerToolSchema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "revenue_operations",
          name: "run",
          idempotency: "required",
          requiresTenant: true,
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
          name: "quote.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "revenue_operations",
          name: "continue",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "approved_only",
          configSchema: expect.objectContaining({
            properties: expect.objectContaining({
              approvalId: expect.objectContaining({ type: "string" }),
              execution: expect.objectContaining({
                type: "object",
                required: ["connectionId", "credentialRef", "recipient", "receipt", "rollback"],
                properties: expect.objectContaining({
                  connectionId: expect.objectContaining({ type: "string" }),
                  receipt: expect.objectContaining({ type: "object" }),
                  rollback: expect.objectContaining({ type: "object" }),
                }),
              }),
            }),
          }),
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
          role: "revenue_operations",
          name: "quote.prepare",
          configSchema: expect.objectContaining({
            oneRequired: ["intake", "leadPacket", "lead"],
            properties: expect.objectContaining({
              intake: expect.objectContaining({ type: "object" }),
              leadPacket: expect.objectContaining({ type: "object" }),
              lead: expect.objectContaining({ type: "object" }),
            }),
          }),
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
        expect.objectContaining({
          role: "workforce_operations",
          name: "hire.packet.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "workforce_operations",
          name: "payroll_input.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "dry_run",
        }),
        expect.objectContaining({
          role: "compliance_operations",
          name: "filing.prepare",
          idempotency: "required",
          requiresTenant: true,
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "compliance_operations",
          name: "approval.decide",
          idempotency: "none",
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
        expect.objectContaining({
          role: "workforce_operations",
          name: "hire.packet.prepare",
          configSchema: expect.objectContaining({
            required: ["personId", "positionId", "workLocationId"],
            properties: expect.objectContaining({
              personId: expect.objectContaining({ type: "string" }),
              positionId: expect.objectContaining({ type: "string" }),
              workLocationId: expect.objectContaining({ type: "string" }),
              sourceRefs: expect.objectContaining({ type: "object" }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "workforce_operations",
          name: "payroll_input.prepare",
          configSchema: expect.objectContaining({
            required: ["employmentId", "period"],
            properties: expect.objectContaining({
              employmentId: expect.objectContaining({ type: "string" }),
              period: expect.objectContaining({ type: "string" }),
              payrollRunId: expect.objectContaining({ type: "string" }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "compliance_operations",
          name: "filing.prepare",
          configSchema: expect.objectContaining({
            required: ["filingRequirementId", "period"],
            properties: expect.objectContaining({
              filingRequirementId: expect.objectContaining({ type: "string" }),
              period: expect.objectContaining({
                type: "object",
                required: ["from", "to"],
                properties: expect.objectContaining({
                  from: expect.objectContaining({ type: "string" }),
                  to: expect.objectContaining({ type: "string" }),
                }),
              }),
            }),
          }),
        }),
      ]),
    );
    expect(workerToolSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "revenue_operations", name: "snapshot" }),
        expect.objectContaining({ role: "revenue_operations", name: "approvals" }),
        expect.objectContaining({ role: "revenue_operations", name: "readiness" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "snapshot" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "briefs" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "decisions" }),
        expect.objectContaining({ role: "dispatch_operations", name: "snapshot" }),
        expect.objectContaining({ role: "dispatch_operations", name: "board" }),
        expect.objectContaining({ role: "dispatch_operations", name: "exceptions" }),
        expect.objectContaining({ role: "finance_operations", name: "snapshot" }),
        expect.objectContaining({ role: "finance_operations", name: "approvals" }),
        expect.objectContaining({ role: "workforce_operations", name: "snapshot" }),
        expect.objectContaining({ role: "workforce_operations", name: "readiness" }),
        expect.objectContaining({ role: "compliance_operations", name: "snapshot" }),
        expect.objectContaining({ role: "compliance_operations", name: "obligations" }),
        expect.objectContaining({ role: "compliance_operations", name: "packet" }),
      ]),
    );
    expect(workerToolSchema.$defs.workerTarget.properties.tenantSlug.type).toBe("string");
    expect(workerToolSchema.$defs.workerTarget.properties.role).toEqual(
      expect.objectContaining({
        type: "string",
        pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
        description: expect.stringContaining("do not use route names"),
      }),
    );
    expect(workerToolSchema.$defs.workerTarget.required).toEqual(["role"]);
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

  it("keeps direct registry calls on canonical worker role identifiers", async () => {
    await expect(
      executeWorkerCommand({
        command: "run",
        target: {
          role: "domain-worker",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "direct-bad-worker-role-001",
        config: {
          intake: {
            source: "website_form",
            sourceEventId: "direct-bad-worker-role-form-001",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_worker_target",
      message:
        "worker.role must be a lower_snake_case role identifier such as revenue_operations; do not use route names, family-worker names, or URL fragments.",
    });

    await expect(
      executeWorkerCommand({
        command: ["", "api", "revenue-worker", "run"].join("/"),
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: "direct-bad-worker-operation-001",
        config: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_worker_command",
      message:
        "Worker command and view names must be registered lower_snake_case or dotted operation identifiers such as lead.read or quote.prepare; do not use URL paths, route names, family-worker names, or query strings.",
    });

    await expect(
      executeWorkerCommand({
        command: "run",
        target: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        operatorEmail: "owner@continuoushq.com",
        idempotencyKey: ["", "api", "revenue-worker", "run"].join("/"),
        config: {},
      }),
    ).rejects.toMatchObject({
      code: "invalid_idempotency_key",
    });
  });

  it("rejects unsupported worker roles before runtime work", async () => {
    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "payroll_operations",
        },
        config: {},
      }),
    ).rejects.toThrow("Worker role payroll_operations is not available yet.");
  });

  it("exposes planned worker metadata and runtime follow-ups without enabling unavailable handlers", () => {
    const plannedCommands = workerToolSchema.registry.plannedCommands as Array<{
      role: string;
      name: string;
      apiRoute: string;
      toolAlias: string;
      requiredConfig: string[];
      oneRequiredConfig?: string[];
      configSchema: {
        type: string;
        required?: string[];
        oneRequired?: string[];
        properties?: Record<
          string,
          {
            type?: string;
            minItems?: number;
            required?: string[];
            properties?: Record<string, { type?: string }>;
          }
        >;
      };
    }>;
    const registeredSystemsCommands = workerToolSchema.registry.commands.filter(
      (command) => command.role === "systems_operations",
    );
    const systemsCommandMetadata =
      registeredSystemsCommands.length > 0
        ? registeredSystemsCommands
        : plannedCommands.filter((command) => command.role === "systems_operations");
    const registeredSystemsViews = workerToolSchema.registry.views.filter(
      (view) => view.role === "systems_operations",
    );
    const systemsViewMetadata =
      registeredSystemsViews.length > 0
        ? registeredSystemsViews
        : workerToolSchema.registry.plannedViews.filter(
            (view) => view.role === "systems_operations",
          );

    expect(workerToolSchema.registry.plannedContracts.map((contract) => contract.role)).toEqual(
      plannedContractRoles,
    );
    expect(workerToolSchema.registry.contracts.map((contract) => contract.role)).toEqual(
      contractRoles,
    );
    expect(workerToolSchema.registry.runtimeContracts.map((contract) => contract.role)).toEqual(
      runtimeContractRoles,
    );
    expect(workerToolSchema.registry.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "offer_pricing_operations",
          name: "margin.review.prepare",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["sourceRefs", "policy"],
            properties: expect.objectContaining({
              sourceRefs: expect.objectContaining({
                required: ["quoteObjectId", "evidencePacketId"],
                properties: expect.objectContaining({
                  quoteObjectId: expect.objectContaining({ type: "string" }),
                  leadObjectId: expect.objectContaining({ type: "string" }),
                  customerObjectId: expect.objectContaining({ type: "string" }),
                  evidencePacketId: expect.objectContaining({ type: "string" }),
                }),
              }),
              policy: expect.objectContaining({
                required: ["marginRuleId", "discountPolicyId"],
              }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "offer_pricing_operations",
          name: "approval.decide",
          apiRoute: "/worker",
        }),
      ]),
    );
    expect(workerToolSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "offer_pricing_operations",
          name: "snapshot",
          apiRoute: "/worker",
        }),
        expect.objectContaining({
          role: "offer_pricing_operations",
          name: "price_policy",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            properties: expect.objectContaining({
              quoteObjectId: expect.objectContaining({ type: "string" }),
              priceBookId: expect.objectContaining({ type: "string" }),
            }),
            additionalProperties: false,
          }),
        }),
      ]),
    );
    expect(
      workerToolSchema.registry.plannedFutureWorkerCommands.some(
        (command) => command.role === "offer_pricing_operations",
      ),
    ).toBe(false);
    expect(
      workerToolSchema.registry.plannedFutureWorkerViews.some(
        (view) => view.role === "offer_pricing_operations",
      ),
    ).toBe(false);
    expect(
      workerToolSchema.registry.plannedFutureWorkerCommands.some(
        (command) => command.role === "systems_operations",
      ),
    ).toBe(false);
    expect(
      workerToolSchema.registry.plannedFutureWorkerViews.some(
        (view) => view.role === "systems_operations",
      ),
    ).toBe(false);
    expect(workerToolSchema.registry.plannedFutureWorkerCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "customer_experience_operations",
          name: "recovery.draft",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["sourceRefs", "policy"],
            properties: expect.objectContaining({
              sourceRefs: expect.objectContaining({ type: "object" }),
              policy: expect.objectContaining({ type: "object" }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "asset_supply_operations",
          name: "reorder.plan",
          apiRoute: "/worker",
          externalExecution: "dry_run",
        }),
        expect.objectContaining({
          role: "growth_operations",
          name: "campaign.draft",
          apiRoute: "/worker",
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "vertical_packages",
          name: "package.flow.prepare",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["packageKey", "sourceRefs", "policy"],
          }),
        }),
      ]),
    );
    expect(workerToolSchema.registry.plannedFutureWorkerViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "vertical_packages",
          name: "package_readiness",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            required: ["packageKey"],
            additionalProperties: false,
          }),
        }),
      ]),
    );
    expect(workerToolSchema.registry.plannedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "finance_operations",
          name: "expense_code.propose",
          apiRoute: "/worker",
          sideEffects: "internal",
        }),
        expect.objectContaining({
          role: "workforce_operations",
          name: "contractor.packet.prepare",
          apiRoute: "/worker",
          sideEffects: "internal",
        }),
      ]),
    );
    for (const command of plannedCommands) {
      expect(command.apiRoute).toBe("/worker");
      expect(command.toolAlias).toBe("worker.command");
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
    expect(workerToolSchema.registry.plannedCommands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "revenue_operations",
          name: "quote.prepare",
        }),
      ]),
    );
    expect(
      workerContracts
        .find((contract) => contract.role === "dispatch_operations")
        ?.commands.find((command) => command.name === "schedule.propose")?.oneRequiredConfig,
    ).toEqual(["jobId", "sourceRefs"]);
    expect(
      workerContracts
        .find((contract) => contract.role === "finance_operations")
        ?.commands.find((command) => command.name === "invoice.prepare")?.oneRequiredConfig,
    ).toEqual(["jobId", "closeoutId", "sourceRefs"]);
    expect(
      workerContracts
        .find((contract) => contract.role === "finance_operations")
        ?.commands.find((command) => command.name === "payment_draft.prepare")?.oneRequiredConfig,
    ).toEqual(["billId", "paymentId", "sourceRefs"]);
    expect(
      systemsCommandMetadata.find(
        (command) => command.role === "systems_operations" && command.name === "connector.health.scan",
      )?.configSchema?.properties?.checks?.type,
    ).toBe("array");
    expect(
      systemsCommandMetadata.find(
        (command) => command.role === "systems_operations" && command.name === "sync.repair.plan",
      )?.configSchema?.required,
    ).toEqual(["connectionId", "issueId"]);
    expect(
      systemsCommandMetadata.find(
        (command) => command.role === "systems_operations" && command.name === "permission.review",
      )?.configSchema?.oneRequired,
    ).toEqual(["connectionId", "grantId"]);
    expect(
      systemsCommandMetadata.find(
        (command) => command.role === "systems_operations" && command.name === "automation.plan",
      )?.configSchema?.properties?.trigger?.type,
    ).toBe("object");
    expect(
      workerToolSchema.registry.commands.find(
        (command) => command.role === "compliance_operations" && command.name === "filing.prepare",
      )?.configSchema,
    ).toEqual(
      expect.objectContaining({
        required: ["filingRequirementId", "period"],
        properties: expect.objectContaining({
          filingRequirementId: expect.objectContaining({ type: "string" }),
          period: expect.objectContaining({
            type: "object",
            required: ["from", "to"],
          }),
        }),
      }),
    );
    expect(
      workerToolSchema.registry.commands
        .filter((command) => command.role === "compliance_operations")
        .map((command) => command.name),
    ).toEqual(["filing.prepare", "approval.decide"]);
    expect(
      workerToolSchema.registry.views
        .filter((view) => view.role === "compliance_operations")
        .map((view) => view.name),
    ).toEqual(["snapshot", "obligations", "packet"]);
    expect(
      workerToolSchema.registry.followUpCommands
        .filter((command) => command.role === "compliance_operations")
        .map((command) => command.name),
    ).toEqual([
      "obligation.scan",
      "notice.response.prepare",
      "license.renewal.prepare",
      "evidence_binder.export",
    ]);
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
        expect.objectContaining({
          role: "revenue_operations",
          name: "lead.read",
        }),
      ]),
    );
    expect(workerToolSchema.registry.plannedViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "revenue_operations",
          name: "quote_review",
          evidencePacket: "quote_approval_packet",
        }),
      ]),
    );
    expect(workerToolSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "compliance_operations", name: "snapshot", apiRoute: "/worker" }),
        expect.objectContaining({
          role: "compliance_operations",
          name: "obligations",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            properties: expect.objectContaining({
              state: expect.objectContaining({ type: "string" }),
              limit: expect.objectContaining({ type: "number", minimum: 1, maximum: 100 }),
            }),
          }),
        }),
        expect.objectContaining({
          role: "compliance_operations",
          name: "packet",
          apiRoute: "/worker",
          configSchema: expect.objectContaining({
            properties: expect.objectContaining({
              packetId: expect.objectContaining({ type: "string" }),
              filingDraftId: expect.objectContaining({ type: "string" }),
            }),
          }),
        }),
      ]),
    );
    expect(systemsViewMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "systems_operations", name: "snapshot", apiRoute: "/worker" }),
        expect.objectContaining({ role: "systems_operations", name: "health", apiRoute: "/worker" }),
        expect.objectContaining({ role: "systems_operations", name: "repairs", apiRoute: "/worker" }),
      ]),
    );
    expect(
      workerToolSchema.registry.plannedViews.every((view) => view.toolAlias === "worker.view"),
    ).toBe(true);
  });

  it("keeps registry command and view names role-neutral", () => {
    const roleNamedOperationPattern =
      /^(?:revenue|dispatch|finance|workforce|owner|compliance|systems)[._-]|(?:[-_](?:worker|operations)|_worker)/;
    const operations = [
      ...registeredWorkerCommands().map((command) => `${command.role}:${command.name}`),
      ...registeredWorkerViews().map((view) => `${view.role}:view.${view.name}`),
      ...workerToolSchema.registry.plannedCommands.map(
        (command) => `${command.role}:${command.name}`,
      ),
      ...workerToolSchema.registry.plannedViews.map((view) => `${view.role}:view.${view.name}`),
    ];
    const offenders = operations.filter((operation) => {
      const name = operation.split(":").at(1) ?? "";

      return roleNamedOperationPattern.test(name);
    });

    expect(offenders).toEqual([]);
  });

  it("exposes queryable expansion metadata through the generic worker registry", () => {
    const expansion = workerToolSchema.registry.expansion;
    const waves = new Set(expansion.map((entry) => entry.wave));
    const byKey = new Map(expansion.map((entry) => [entry.key, entry]));

    expect(expansion).toBe(workerExpansionCatalog);
    expect([...waves].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([...byKey.keys()]).toEqual(
      expect.arrayContaining([
        "revenue_operations",
        "compliance_operations",
        "offer_pricing_operations",
        "customer_experience_operations",
        "asset_supply_operations",
        "growth_operations",
        "vertical_packages",
        "package_quote_to_cash_field",
        "package_knowledge_delivery",
      ]),
    );
    expect(byKey.get("revenue_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "revenue_operations",
        firstCommand: "lead.read",
        firstView: "snapshot",
        status: "runtime",
      }),
    );
    expect(byKey.get("compliance_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "compliance_operations",
        firstCommand: "filing.prepare",
        firstView: "snapshot",
        status: "runtime",
      }),
    );
    expect(byKey.get("offer_pricing_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "offer_pricing_operations",
        firstCommand: "margin.review.prepare",
        firstView: "price_policy",
        incomingHandoff: "revenue.quote_to_pricing",
        status: "runtime",
        contractPath: "docs/offer-pricing-worker-v1-contract.md",
        evidencePacket: "pricing_review_packet",
      }),
    );
    expect(byKey.get("customer_experience_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "customer_experience_operations",
        firstCommand: "recovery.draft",
        firstView: "signals",
        status: "candidate",
        contractPath: "docs/customer-experience-worker-v1-contract.md",
        evidencePacket: "customer_experience_packet",
      }),
    );
    expect(byKey.get("asset_supply_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "asset_supply_operations",
        firstCommand: "reorder.plan",
        firstView: "stockouts",
        status: "candidate",
        contractPath: "docs/asset-supply-worker-v1-contract.md",
        evidencePacket: "asset_supply_packet",
      }),
    );
    expect(byKey.get("growth_operations")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "growth_operations",
        firstCommand: "campaign.draft",
        firstView: "campaigns",
        status: "candidate",
        contractPath: "docs/growth-worker-v1-contract.md",
        evidencePacket: "growth_campaign_packet",
      }),
    );
    expect(byKey.get("vertical_packages")).toEqual(
      expect.objectContaining({
        apiRoute: "/worker",
        workerRole: "vertical_packages",
        packageKey: "vertical_packages",
        firstCommand: "package.flow.prepare",
        firstView: "package_readiness",
        incomingHandoff: "systems.connection_to_packaged_worker",
        kind: "packaged_worker",
        contractPath: "docs/vertical-packaged-worker-v1-contract.md",
        evidencePacket: "package_readiness_packet",
      }),
    );

    for (const entry of expansion) {
      expect(entry.schemaVersion).toBe("continuous.worker_expansion.v1");
      expect(entry.apiRoute).toBe("/worker");
      expect(entry.firstCommand.length).toBeGreaterThan(0);
      expect(entry.firstView.length).toBeGreaterThan(0);
      expect(entry.coreObjects.length).toBeGreaterThan(0);
      expect(entry.acceptanceChecks.length).toBeGreaterThan(0);
      expect(entry.firstBlocker.length).toBeGreaterThan(0);
      expect(entry.launchGate.length).toBeGreaterThan(0);
      expect(entry.sourceDocs.length).toBeGreaterThan(0);
      if (entry.status === "candidate" || entry.status === "packaged") {
        expect(entry.contractPath).toBeTruthy();
        expect(entry.evidencePacket).toBeTruthy();
        expect(entry.sourceDocs).toContain(entry.contractPath);
      }
      if (entry.kind === "worker_family") {
        expect(entry.workerRole).toBeTruthy();
      }
      if (entry.kind === "packaged_worker") {
        expect(entry.packageKey).toBeTruthy();
        expect(entry.workerRole).toBe("vertical_packages");
      }
    }
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
        idempotencyKey: "worker-run-empty-config-001",
        config: {},
      }),
    ).rejects.toThrow("config.intake, leadPacket or lead is required for run.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "quote.prepare",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "quote-prepare-empty-config-001",
        config: {},
      }),
    ).rejects.toThrow("config.intake, leadPacket or lead is required for quote.prepare.");

    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_link.prepare",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "payment-link-empty-config-001",
        config: {},
      }),
    ).rejects.toThrow(
      "config.invoiceId, config.invoiceObjectId, config.sourceRefs.invoiceId or config.sourceRefs.invoiceObjectId is required for payment_link.prepare.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_link.prepare",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "payment-link-empty-source-refs-001",
        config: {
          sourceRefs: {},
        },
      }),
    ).rejects.toThrow(
      "config.invoiceId, config.invoiceObjectId, config.sourceRefs.invoiceId or config.sourceRefs.invoiceObjectId is required for payment_link.prepare.",
    );

    await expect(
      executeWorkerTool("worker.command", {
        command: "payment_link.prepare",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "payment-link-empty-invoice-object-001",
        config: {
          invoiceObjectId: "",
        },
      }),
    ).rejects.toThrow(
      "config.invoiceId, config.invoiceObjectId, config.sourceRefs.invoiceId or config.sourceRefs.invoiceObjectId is required for payment_link.prepare.",
    );
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

    await expect(
      executeWorkerTool("worker.command", {
        command: "quote.prepare",
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

  it("validates compliance filing prepare envelopes before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.command", {
        command: "filing.prepare",
        worker: {
          role: "compliance_operations",
          tenantSlug: "continuous-demo",
        },
        idempotencyKey: "compliance-filing-schema-001",
        config: {
          filingRequirementId: "filing_requirement_object_uuid",
        },
      }),
    ).rejects.toThrow("config.period is required for filing.prepare.");
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
    ).rejects.toThrow("config is required and must be an object.");
  });

  it("rejects malformed view config instead of silently normalizing it", async () => {
    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
      }),
    ).rejects.toThrow("config is required and must be an object.");

    await expect(
      executeWorkerTool("worker.view", {
        view: "snapshot",
        worker: {
          role: "revenue_operations",
          tenantSlug: "continuous-demo",
        },
        config: "ready",
      }),
    ).rejects.toThrow("config is required and must be an object.");
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
        config: {
          approvalId: "approval-1",
        },
      }),
    ).rejects.toThrow("config.action is required for approval.decide.");
  });

  it("applies the same registry config schemas through app-server views", async () => {
    await expect(
      executeAppServerWorkerTool("continuous.worker.view", {
        view: "obligations",
        worker: {
          role: "compliance_operations",
          tenantSlug: "continuous-demo",
        },
        config: {
          limit: 0,
        },
      }),
    ).rejects.toThrow("config.limit must be greater than or equal to 1.");
  });

  it("exposes app-server worker discovery and registry command tools", async () => {
    expect(appServerWorkerTools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
      "continuous.worker.command",
      "continuous.worker.view",
    ]);
    expect(appServerWorkerToolManifest.mode).toBe("registry_backed_worker_control");
    expect(appServerWorkerToolManifest.boundary.sideEffects).toBe("registered_worker_commands_only");
    expect(appServerWorkerToolManifest.boundary.readTools).toBe("continuous.worker.view");
    expect(appServerWorkerToolManifest.boundary.mutationTools).toBe("continuous.worker.command");

    const result = await executeAppServerWorkerTool("continuous.worker.schema");

    if (!("registry" in result) || !result.registry || !result.manifest) {
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
