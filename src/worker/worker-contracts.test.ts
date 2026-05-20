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
const workerFamilyNames = "(?:revenue|dispatch|finance|workforce|compliance|systems|owner)";
const workerFamilyRoutePattern = new RegExp(
  `^app/(?:api/)?${workerFamilyNames}[^/]*worker/`,
);
const apiCommandRoutePattern = new RegExp(
  `^app/api/(?:worker|workers|core|workflow|approval|approvals|revenue|dispatch|finance|workforce|compliance|systems|owner)(?:/|-)`,
);
const forbiddenWorkerUrlPattern = new RegExp(
  `(?:^|["'\`\\s(])/(?:api/(?:worker|workers|core|workflow|approval|approvals|revenue|dispatch|finance|workforce|compliance|systems|owner)(?:[-/][a-z0-9-]+)?|workers?/${workerFamilyNames}(?:[-/][a-z0-9-]+)?|${workerFamilyNames}[a-z0-9-]*worker)(?:/|["'\`\\s),.;]|$)`,
);
const forbiddenWorkerNamespacePattern = new RegExp(
  `continuous\\.(?:revenue|dispatch|finance|owner|workforce|compliance|systems)_worker|(?:revenue|dispatch|finance|owner|workforce|compliance|systems)_worker\\.`,
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

function trackedTextFiles(paths: string[]) {
  return paths.flatMap((path) => {
    const entry = readdirSync(join(root, path.split("/").slice(0, -1).join("/") || "."), {
      withFileTypes: true,
    }).find((item) => item.name === path.split("/").at(-1));

    if (entry?.isDirectory()) {
      return listFiles(path);
    }

    return [path];
  });
}

describe("future worker contracts", () => {
  it("does not expose worker-family-specific HTTP route files", () => {
    const routeFiles = listFiles("app").filter((path) => path.endsWith("/route.ts")).sort();

    expect(routeFiles).toEqual([
      "app/api/health/route.ts",
      "app/approval/route.ts",
      "app/core/route.ts",
      "app/worker/route.ts",
      "app/workflow/route.ts",
    ]);
    expect(routeFiles.filter((path) => workerFamilyRoutePattern.test(path))).toEqual([]);
    expect(routeFiles.filter((path) => apiCommandRoutePattern.test(path))).toEqual([]);
  });

  it("does not document or script worker-specific HTTP URLs", () => {
    const files = trackedTextFiles([
      "app",
      "docs",
      "notes",
      "scripts",
      "src",
      ".github/workflows",
      "README.md",
      "STRATEGY.md",
      "package.json",
    ]);
    const offenders = files.filter((path) => forbiddenWorkerUrlPattern.test(read(path)));

    expect(offenders).toEqual([]);
  });

  it("treats worker-family URL shapes as non-canonical", () => {
    const path = (...segments: string[]) => `/${segments.join("/")}`;
    const nonCanonical = [
      path("api", "revenue-worker"),
      path("api", "revenue-worker", "run"),
      path("api", "worker", "revenue"),
      path("worker", "revenue"),
      path("workers", "finance"),
      path("dispatch-worker"),
    ];

    for (const url of nonCanonical) {
      expect(forbiddenWorkerUrlPattern.test(` ${url} `)).toBe(true);
    }

    expect(forbiddenWorkerUrlPattern.test(" /worker ")).toBe(false);
    expect(forbiddenWorkerUrlPattern.test(" /core ")).toBe(false);
    expect(forbiddenWorkerUrlPattern.test(" /workflow ")).toBe(false);
  });

  it("keeps persisted worker source and event names role-qualified under the generic worker namespace", () => {
    const files = trackedTextFiles([
      "app",
      "docs",
      "notes",
      "scripts",
      "src",
      ".github/workflows",
      "README.md",
      "STRATEGY.md",
      "package.json",
    ]);
    const offenders = files.filter((path) => forbiddenWorkerNamespacePattern.test(read(path)));

    expect(offenders).toEqual([]);
    expect(read("src/worker/revenue.ts")).toContain("worker.revenue_operations.run.completed");
    expect(read("src/worker/dispatch.ts")).toContain(
      "worker.dispatch_operations.schedule_propose.completed",
    );
    expect(read("src/worker/finance.ts")).toContain(
      "worker.finance_operations.invoice_prepare.completed",
    );
    expect(read("src/worker/owner.ts")).toContain(
      "worker.owner_chief_of_staff.brief.generated",
    );
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

  it("uses one shared worker envelope guard across HTTP and tool surfaces", () => {
    const surfaces = [
      "app/worker/route.ts",
      "src/worker/tools.ts",
      "src/worker/app-server-tools.ts",
    ];

    for (const path of surfaces) {
      const source = read(path);

      expect(source).toContain(path.startsWith("app/") ? "src/worker/envelope" : "./envelope");
      expect(source).toContain("workerCommandEnvelope");
      expect(source).not.toMatch(/new Set\(\[\s*["']command["']/);
      expect(source).not.toMatch(/new Set\(\[\s*["']role["']/);
    }

    expect(read("src/worker/envelope.ts")).toContain(
      'export const workerCommandEnvelopeFields = ["command", "worker", "idempotencyKey", "config"] as const;',
    );
    expect(read("src/worker/envelope.ts")).toContain(
      'export const workerTargetEnvelopeFields = ["role", "id", "tenantSlug"] as const;',
    );
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
      expect(source).toContain("config");
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
    expect(source).toContain("`worker.command`");
    expect(source).toContain("customer update draft");
    expect(source).toContain("`closeout.prepare`");
    expect(source).toContain("closeout packet");
    expect(source).toContain("`exception.route`");
    expect(source).toContain("exception task");
    expect(source).not.toMatch(/\/api\/[a-z0-9-]+-worker/);
  });

  it("keeps the Finance runtime contract on generic worker commands", () => {
    const source = read("docs/finance-operations-worker-v1-contract.md");

    expect(source).toContain("All commands use `POST /worker`");
    expect(source).toContain("`worker.command`");
    expect(source).toContain("`worker.view`");
    expect(source).toContain("`invoice.prepare`");
    expect(source).toContain("`ar_followup.draft`");
    expect(source).toContain("`cash_forecast.generate`");
    expect(source).toContain("`payment_draft.prepare`");
    expect(source).toContain("Expense coding is a");
    expect(source).toContain("planned follow-up command");
    expect(source).toContain("| `expense_code.propose` | planned `worker.command` |");
    expect(source).toContain("cash packet");
    expect(source).toContain("AR follow-up draft");
    expect(source).toContain("cash forecast");
    expect(source).toContain("Payment instruction draft");
    expect(source).toContain("finance.payment.review");
    expect(source).toContain("Dual-control is required");
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
    expect(expansion).toContain("the same `/worker` registry");
    expect(expansion).toContain("the exact `/worker` `command`, `worker`, `config`, and");
  });

  it("keeps the worker roadmap pinned to generic worker routes", () => {
    const roadmap = read("docs/worker-roadmap.md");

    expect(roadmap).toContain("Do not add worker-specific HTTP routes.");
    expect(roadmap).toContain("New worker families extend `/worker`");
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
      "Proof",
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
    expect(readiness).toContain("Every promotion must update this matrix, the Proof column");
    expect(readiness).toContain("deploy smoke in `.github/workflows/deploy.yml`");
  });

  it("keeps production readiness tied to durable auth rotation evidence", () => {
    const deployment = read("docs/deployment.md");
    const compose = read("docker-compose.yml");
    const deployScript = read("scripts/deploy.sh");
    const deployWorkflow = read(".github/workflows/deploy.yml");
    const readinessScript = read("scripts/check-production-readiness-on-host.sh");
    const observabilityScript = read("scripts/check-observability-on-host.sh");
    const attestationScript = read("scripts/attest-control-plane-on-host.sh");
    const rotationScript = read("scripts/rotate-control-plane-token-on-host.sh");

    expect(deployment).toContain("control_plane.token_rotation.attest");
    expect(deployment).toContain("control_plane.credential.upsert");
    expect(deployment).toContain("control_plane.credential.revoke");
    expect(deployment).toContain("control_plane.session.review");
    expect(deployment).toContain("control_plane_token_rotation_attestations");
    expect(deployment).toContain("control_plane_credentials");
    expect(deployment).toContain("control_plane_auth_sessions");
    expect(deployment).toContain("TOKEN_ROTATION_ATTESTATION_ID");
    expect(deployment).toContain("CONTROL_PLANE_AUTH_SESSION_ID");
    expect(deployment).toContain("CONTROL_PLANE_CREDENTIAL_ID");
    expect(deployment).toContain("CONTROL_PLANE_CREDENTIAL_REVOCATION_AUDIT_ID");
    expect(deployment).toContain("CONTROL_PLANE_SESSION_REVIEW_VIEW_ID");
    expect(deployment).toContain("legacy single `WORKER_RUN_TOKEN` path as bootstrap-only");
    expect(compose).not.toContain("REVENUE_WORKER_");
    expect(readinessScript).toContain("TOKEN_ROTATION_ATTESTATION_ID");
    expect(readinessScript).toContain("CONTROL_PLANE_AUTH_AUDIT_ATTESTED_AT");
    expect(readinessScript).toContain("CONTROL_PLANE_AUTH_SESSION_ID");
    expect(readinessScript).toContain("CONTROL_PLANE_CREDENTIAL_ID");
    expect(readinessScript).toContain("CONTROL_PLANE_CREDENTIAL_REVOCATION_AUDIT_ID");
    expect(readinessScript).toContain("CONTROL_PLANE_SESSION_REVIEW_VIEW_ID");
    expect(readinessScript).toContain("REQUIRE_CONTROL_PLANE_CREDENTIAL_ATTESTATION");
    expect(observabilityScript).toContain("caddy_logs=");
    expect(observabilityScript).toContain("caddy_access_log_present:docker_stdout");
    expect(observabilityScript).not.toContain("logs --tail=400 caddy 2>/dev/null | grep -q");
    expect(deployment).toContain("structured Docker stdout logs");
    expect(attestationScript).toContain("control_plane.credential.upsert");
    expect(attestationScript).toContain("control_plane.credential.revoke");
    expect(attestationScript).toContain("control_plane.session.review");
    expect(attestationScript).toContain("CONTROL_PLANE_SESSION_REVIEW_VIEW_ID");
    expect(rotationScript).toContain("control_plane.token_rotation.attest");
    expect(rotationScript).toContain("TOKEN_ROTATION_ATTESTATION_ID");
    expect(rotationScript).toContain("NEXT_WORKER_RUN_TOKEN");
    expect(deployScript).toContain("core:control_plane.token_rotation.attest");
    expect(deployScript).toContain("core:ai.infer");
    expect(deployScript).toContain("core:control_plane.credential.upsert");
    expect(deployScript).toContain("core:control_plane.credential.revoke");
    expect(deployScript).toContain("core:control_plane.session.review");
    expect(deployScript).toContain("scripts/rotate-control-plane-token-on-host.sh");
    expect(deployScript).toContain("preserving the existing bootstrap token");
    expect(deployScript).toContain('SITE_HOST="$SITE_HOST"');
    expect(deployWorkflow).toContain("core:control_plane.token_rotation.attest");
    expect(deployWorkflow).toContain("core:ai.infer");
    expect(deployWorkflow).toContain("core:control_plane.credential.upsert");
    expect(deployWorkflow).toContain("core:control_plane.credential.revoke");
    expect(deployWorkflow).toContain("core:control_plane.session.review");
    expect(deployWorkflow).toContain("scripts/attest-control-plane-on-host.sh");
    expect(deployWorkflow).toContain("scripts/rotate-control-plane-token-on-host.sh");
    expect(deployWorkflow).toContain("preserving the existing bootstrap token");
    expect(deployWorkflow).toContain('SITE_HOST="$SITE_HOST"');
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
