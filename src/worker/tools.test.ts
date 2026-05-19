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

describe("worker tool contract", () => {
  it("keeps the HTTP worker surface route-generic", () => {
    const root = process.cwd();
    const routePath = join(root, "app", "worker", "route.ts");
    const routeSource = readFileSync(routePath, "utf8");
    const appRoutes = routeFiles(join(root, "app")).map((path) => path.slice(root.length));
    const routeList = appRoutes.join("\n");

    expect(existsSync(routePath)).toBe(true);
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
        expect.arrayContaining(["role", "tenantSlug", "leadPacket", "approvalId", "limit"]),
      );
      if (tool.registry.idempotency === "required") {
        expect(properties.idempotencyKey).toBeTruthy();
      }
      if (properties.config) {
        expect((properties.config as { type?: string }).type).toBe("object");
      }
    }
  });

  it("exposes registry-backed repo-owned worker tools", () => {
    expect(workerTools.map((tool) => tool.name)).toEqual([
      "worker.snapshot",
      "worker.owner.briefs.list",
      "worker.owner.decisions.list",
      "worker.run",
      "worker.continue",
      "worker.approvals.list",
      "worker.approvals.decide",
      "worker.adapters.reconcile",
      "worker.adapters.retry",
      "worker.owner.brief.generate",
      "worker.owner.decision_queue.prepare",
      "worker.owner.anomaly.triage",
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
          name: "continue",
          idempotency: "required",
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
      ]),
    );
    expect(workerToolSchema.registry.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "revenue_operations", name: "snapshot" }),
        expect.objectContaining({ role: "revenue_operations", name: "approvals" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "snapshot" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "briefs" }),
        expect.objectContaining({ role: "owner_chief_of_staff", name: "decisions" }),
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
      executeWorkerTool("worker.snapshot", {
        worker: {},
      }),
    ).rejects.toThrow("worker.role is required.");
  });

  it("rejects unsupported worker roles before runtime work", async () => {
    await expect(
      executeWorkerTool("worker.snapshot", {
        worker: {
          role: "payroll_operations",
        },
      }),
    ).rejects.toThrow("Worker role payroll_operations is not available yet.");
  });

  it("exposes planned worker metadata without enabling future runtime handlers", () => {
    expect(workerToolSchema.registry.plannedContracts.map((contract) => contract.role)).toEqual([
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "compliance_operations",
      "systems_operations",
    ]);
    expect(workerToolSchema.registry.plannedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "dispatch_operations",
          name: "schedule.propose",
          externalExecution: "dry_run",
        }),
        expect.objectContaining({
          role: "finance_operations",
          name: "payment_draft.prepare",
          externalExecution: "blocked",
        }),
        expect.objectContaining({
          role: "systems_operations",
          name: "sync.repair.plan",
          sideEffects: "dry_run",
        }),
      ]),
    );
    expect(workerToolSchema.registry.plannedCommands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "owner_chief_of_staff",
          name: "brief.generate",
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
      executeWorkerTool("worker.run", {
        worker: {
          role: "revenue_operations",
        },
        idempotencyKey: "bad key!",
        config: {},
      }),
    ).rejects.toThrow(
      "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    );
  });

  it("validates worker continuation idempotency before invoking the worker", async () => {
    await expect(
      executeWorkerTool("worker.continue", {
        worker: {
          role: "revenue_operations",
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
      executeWorkerTool("worker.owner.brief.generate", {
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

  it("requires tenant scope for adapter reconciliation", async () => {
    await expect(
      executeWorkerTool("worker.adapters.reconcile", {
        worker: {
          role: "revenue_operations",
        },
        config: {
          limit: 25,
        },
      }),
    ).rejects.toThrow("worker.tenantSlug is required for adapters.reconcile.");
  });

  it("requires tenant scope for adapter retry execution", async () => {
    await expect(
      executeWorkerTool("worker.adapters.retry", {
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
      executeWorkerTool("worker.approvals.decide", {
        worker: {
          role: "revenue_operations",
        },
        config: "approval-id",
      }),
    ).rejects.toThrow("config must be an object when provided.");
  });

  it("uses registry validation for adapter reconciliation limits", async () => {
    await expect(
      executeWorkerTool("worker.adapters.reconcile", {
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
      executeWorkerTool("worker.adapters.retry", {
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

  it("exposes one read-only app-server worker discovery tool", () => {
    expect(appServerWorkerTools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
    ]);
    expect(appServerWorkerToolManifest.mode).toBe("read_only_discovery");
    expect(appServerWorkerToolManifest.boundary.sideEffects).toBe("none");
    expect(appServerWorkerToolManifest.boundary.mutationTools).toBe("not_exposed");

    const result = executeAppServerWorkerTool("continuous.worker.schema");

    expect(result.registry.commands).toEqual(registeredWorkerCommands());
    expect(result.plannedWorkers).toEqual(workerToolSchema.registry.plannedContracts);
    expect(result.workerToolSchema).toBe(workerToolSchema);
    expect(result.manifest.tools).toBe(appServerWorkerTools);
    expect(() =>
      executeAppServerWorkerTool("continuous.worker.schema", {
        worker: { role: "revenue_operations" },
      }),
    ).toThrow("continuous.worker.schema does not accept arguments.");
  });
});
