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

  it("exposes registry-backed repo-owned worker tools", () => {
    expect(workerTools.map((tool) => tool.name)).toEqual([
      "worker.snapshot",
      "worker.run",
      "worker.continue",
      "worker.approvals.list",
      "worker.approvals.decide",
      "worker.adapters.reconcile",
    ]);
    expect(workerToolSchema.tools).toBe(workerTools);
    expect(workerToolSchema.registry.commands).toEqual(registeredWorkerCommands());
    expect(workerToolSchema.registry.views).toEqual(registeredWorkerViews());
    expect(workerToolSchema.registry.commands.map((command) => command.name)).toEqual([
      "run",
      "continue",
      "approval.decide",
      "adapters.reconcile",
    ]);
    expect(workerToolSchema.registry.views.map((view) => view.name)).toEqual([
      "snapshot",
      "approvals",
    ]);
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
    ).rejects.toThrow("worker.tenantSlug is required for adapter reconciliation.");
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

  it("exposes one read-only app-server worker discovery tool", () => {
    expect(appServerWorkerTools.map((tool) => tool.name)).toEqual([
      "continuous.worker.schema",
    ]);
    expect(appServerWorkerToolManifest.mode).toBe("read_only_discovery");
    expect(appServerWorkerToolManifest.boundary.sideEffects).toBe("none");
    expect(appServerWorkerToolManifest.boundary.mutationTools).toBe("not_exposed");

    const result = executeAppServerWorkerTool("continuous.worker.schema");

    expect(result.registry.commands).toEqual(registeredWorkerCommands());
    expect(result.workerToolSchema).toBe(workerToolSchema);
    expect(result.manifest.tools).toBe(appServerWorkerTools);
    expect(() =>
      executeAppServerWorkerTool("continuous.worker.schema", {
        worker: { role: "revenue_operations" },
      }),
    ).toThrow("continuous.worker.schema does not accept arguments.");
  });
});
