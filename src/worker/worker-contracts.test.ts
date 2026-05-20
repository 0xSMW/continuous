import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  plannedWorkerCommands,
  plannedWorkerContracts,
  plannedWorkerViews,
} from "./planned-workers";

const root = process.cwd();

const contracts = [
  {
    path: "docs/owner-chief-of-staff-worker-v1-contract.md",
    role: "owner_chief_of_staff",
    evidencePacket: "owner_brief_packet",
    runtime: true,
  },
  {
    path: "docs/dispatch-operations-worker-v1-contract.md",
    role: "dispatch_operations",
    evidencePacket: "dispatch_packet",
    runtime: true,
  },
  {
    path: "docs/finance-operations-worker-v1-contract.md",
    role: "finance_operations",
    evidencePacket: "cash_packet",
    runtime: true,
  },
  {
    path: "docs/workforce-operations-worker-v1-contract.md",
    role: "workforce_operations",
    evidencePacket: "workforce_packet",
    runtime: false,
  },
  {
    path: "docs/compliance-operations-worker-v1-contract.md",
    role: "compliance_operations",
    evidencePacket: "compliance_packet",
    runtime: false,
  },
  {
    path: "docs/systems-operations-worker-v1-contract.md",
    role: "systems_operations",
    evidencePacket: "systems_packet",
    runtime: false,
  },
] as const;

const runtimeRoles = new Set<string>(
  contracts.filter((contract) => contract.runtime).map((contract) => contract.role),
);

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function listFiles(path: string): string[] {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const childPath = `${path}/${entry.name}`;

    return entry.isDirectory() ? listFiles(childPath) : [childPath];
  });
}

describe("future worker contracts", () => {
  it("does not expose worker-family-specific HTTP route files", () => {
    const routeFiles = listFiles("app").filter((path) => path.endsWith("/route.ts"));
    const workerFamilyRoutePattern =
      /^app\/(?:api\/)?(?:revenue|dispatch|finance|workforce|compliance|systems|owner)[^/]*worker\//;

    expect(routeFiles).toContain("app/worker/route.ts");
    expect(routeFiles).toContain("app/core/route.ts");
    expect(routeFiles).toContain("app/workflow/route.ts");
    expect(routeFiles.filter((path) => workerFamilyRoutePattern.test(path))).toEqual([]);
  });

  it("keeps the current revenue contract on the generic worker API", () => {
    const source = read("docs/revenue-operations-worker-v1-contract.md");

    expect(source).toContain("The canonical worker control-plane route is `/worker`.");
    expect(source).toContain('"role": "revenue_operations"');
    expect(source).toContain("`config` is the command payload envelope.");
    expect(source).toContain(
      "Only `command`, `worker`, `idempotencyKey`, and `config` are accepted as",
    );
    expect(source).toContain("HTTP and CLI callers both go through the registered `/worker` command");
    expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);
  });

  it("has implementation-grade contracts for every worker", () => {
    const requiredSections = [
      "## Header",
      "## API Shape",
      "## Registry Entries",
      "## Core Object Map",
      "## Workflow",
      "## Capabilities",
      "## Adapters",
      "## Evidence Packet",
      "## Generated Views",
      "## Evals",
      "## Security",
    ];

    for (const contract of contracts) {
      const source = read(contract.path);

      expect(source).toContain(`Worker role | \`${contract.role}\``);
      expect(source).toContain("POST /worker");
      expect(source).toContain("idempotencyKey");
      if (contract.evidencePacket) {
        expect(source).toContain(contract.evidencePacket);
      }
      expect(source).toMatch(/External execution \| `(blocked|dry_run|approved_only)`/);
      expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);

      for (const section of requiredSections) {
        expect(source).toContain(section);
      }
    }
  });

  it("keeps the Dispatch runtime contract on generic worker commands", () => {
    const source = read("docs/dispatch-operations-worker-v1-contract.md");

    expect(source).toContain("All commands use `POST /worker`; no dispatch-specific route is added.");
    expect(source).toContain("`customer_update.draft`");
    expect(source).toContain("`worker.dispatch.customer_update.draft`");
    expect(source).toContain("customer update draft");
    expect(source).toContain("`closeout.prepare`");
    expect(source).toContain("`worker.dispatch.closeout.prepare`");
    expect(source).toContain("closeout packet");
    expect(source).toContain("`exception.route`");
    expect(source).toContain("`worker.dispatch.exception.route`");
    expect(source).toContain("exception task");
    expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);
  });

  it("keeps the Finance runtime contract on generic worker commands", () => {
    const source = read("docs/finance-operations-worker-v1-contract.md");

    expect(source).toContain("All commands use `POST /worker`");
    expect(source).toContain("`invoice.prepare`");
    expect(source).toContain("`worker.finance.invoice.prepare`");
    expect(source).toContain("cash packet");
    expect(source).toContain("accounting dry-run");
    expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);
  });

  it("links the future contracts from the worker expansion map", () => {
    const expansion = read("docs/worker-expansion.md");

    for (const contract of contracts.filter((item) => !item.runtime)) {
      const filename = contract.path.split("/").at(-1);

      expect(expansion).toContain(filename);
    }

    expect(expansion).toContain("worker-readiness.md");
    expect(expansion).toContain("worker-handoffs.md");
  });

  it("tracks worker expansion readiness against shared launch gates", () => {
    const readiness = read("docs/worker-readiness.md");
    const gateNames = [
      "Contract",
      "Registry",
      "Object Map",
      "Workflow",
      "Capabilities",
      "Budget",
      "Approval",
      "Adapter",
      "Eval",
      "UI",
      "Launch",
    ];

    for (const gate of gateNames) {
      expect(readiness).toContain(`| ${gate} |`);
    }

    for (const role of [
      "Revenue Operations",
      "Owner Chief-of-Staff",
      "Dispatch/Ops",
      "Finance",
      "Workforce",
      "Compliance",
      "Systems",
    ]) {
      expect(readiness).toContain(`| ${role} |`);
    }

    expect(readiness).toContain(
      "Production connector credentials and approved external send remain blocked; scheduler polling needs real connection coverage",
    );
    expect(readiness).toContain("Every promotion must update this matrix");
  });

  it("defines Core-record handoffs for planned worker expansion", () => {
    const handoffs = read("docs/worker-handoffs.md");
    const requiredHandoffs = [
      "revenue.lead_to_owner_review",
      "revenue.quote_to_dispatch",
      "dispatch.closeout_to_finance",
      "finance.invoice_to_owner_review",
      "workforce.payroll_to_compliance",
      "compliance.obligation_to_owner_review",
      "systems.sync_issue_to_worker",
    ];

    for (const handoff of requiredHandoffs) {
      expect(handoffs).toContain(handoff);
    }

    for (const role of [
      "Owner Chief-of-Staff",
      "Dispatch/Ops",
      "Finance",
      "Workforce",
      "Compliance",
      "Systems",
    ]) {
      expect(handoffs).toContain(`| ${role} |`);
    }

    expect(handoffs).toContain("Consumers must resolve handoffs from Core records");
    expect(handoffs).toContain("config.sourceRefs");
  });

  it("has planned command metadata for every future contract without registered runtime", () => {
    const commandRoles = new Set(plannedWorkerCommands().map((command) => command.role));
    const viewRoles = new Set(plannedWorkerViews().map((view) => view.role));
    const plannedContracts = contracts.filter((contract) => !runtimeRoles.has(contract.role));

    expect(plannedWorkerContracts.map((contract) => contract.role)).toEqual(
      plannedContracts.map((contract) => contract.role),
    );

    for (const contract of plannedContracts) {
      const planned = plannedWorkerContracts.find((item) => item.role === contract.role);

      expect(planned?.contractPath).toBe(contract.path);
      expect(planned?.evidencePacket).toBe(contract.evidencePacket);
      expect(commandRoles.has(contract.role)).toBe(true);
      expect(viewRoles.has(contract.role)).toBe(true);
      expect(
        plannedWorkerCommands().some(
          (command) => command.role === contract.role && command.name === "approval.decide",
        ),
      ).toBe(true);
    }
  });
});
