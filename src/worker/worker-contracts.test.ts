import { readFileSync } from "node:fs";
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
  },
  {
    path: "docs/dispatch-operations-worker-v1-contract.md",
    role: "dispatch_operations",
    evidencePacket: "dispatch_packet",
  },
  {
    path: "docs/finance-operations-worker-v1-contract.md",
    role: "finance_operations",
    evidencePacket: "cash_packet",
  },
  {
    path: "docs/workforce-operations-worker-v1-contract.md",
    role: "workforce_operations",
    evidencePacket: "workforce_packet",
  },
  {
    path: "docs/compliance-operations-worker-v1-contract.md",
    role: "compliance_operations",
    evidencePacket: "compliance_packet",
  },
  {
    path: "docs/systems-operations-worker-v1-contract.md",
    role: "systems_operations",
    evidencePacket: "systems_packet",
  },
] as const;

const runtimeRoles = new Set(["owner_chief_of_staff"]);

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("future worker contracts", () => {
  it("has implementation-grade contracts for every future worker", () => {
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
      expect(source).toContain(contract.evidencePacket);
      expect(source).toMatch(/External execution \| `(blocked|dry_run|approved_only)`/);
      expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);

      for (const section of requiredSections) {
        expect(source).toContain(section);
      }
    }
  });

  it("links the future contracts from the worker expansion map", () => {
    const expansion = read("docs/worker-expansion.md");

    for (const contract of contracts) {
      const filename = contract.path.split("/").at(-1);

      expect(expansion).toContain(filename);
    }
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
