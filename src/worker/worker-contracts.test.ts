import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  plannedWorkerCommands,
  plannedWorkerContracts,
  plannedWorkerViews,
  runtimeWorkerContracts,
  workerContractForRole,
  workerContracts,
  workerExpansionCatalog,
  workerFollowUpCommands,
  workerFollowUpViews,
  workerApiRoute,
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
    runtime: true,
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
    runtime: true,
  },
] as const;

const runtimeRoles = new Set<string>(
  contracts.filter((contract) => contract.runtime).map((contract) => contract.role),
);
const workerFamilyRoutePattern = new RegExp(
  "^app/(?:[a-z0-9_-]+[-_]worker/|worker/[^/]+/|workers/[^/]+/|api/(?:[a-z0-9_-]+[-_]worker|worker|workers)(?:/|$))",
);
const apiCommandRoutePattern = new RegExp(
  "^app/api/(?:worker|workers)(?:/|-|$)",
);
const forbiddenWorkerUrlPattern = new RegExp(
  '(?:^|["\'`\\s(])/(?:(?:api/)?[a-z0-9_-]+[-_]worker(?:/[a-z0-9_-]+)?|api/workers?(?:/[a-z0-9_-]+)?|workers?/[a-z0-9_-]+)(?:/|["\'`\\s),.;?]|$)',
);
const forbiddenWorkerNamespacePattern = new RegExp(
  "continuous\\.[a-z0-9_]+_worker|[a-z0-9_]+_worker\\.",
);
const forbiddenWorkerQueryPattern = new RegExp("/worker\\?");

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
      "app/app-server/route.ts",
      "app/approval/route.ts",
      "app/core/route.ts",
      "app/health/route.ts",
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
    const offenders = files.filter((path) => {
      const source = read(path);

      return forbiddenWorkerUrlPattern.test(source) || forbiddenWorkerQueryPattern.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("treats worker-family URL shapes as non-canonical", () => {
    const path = (...segments: string[]) => `/${segments.join("/")}`;
    const workerQuery = (query: string) => `/worker${"?"}${query}`;
    const nonCanonical = [
      path("api", "revenue-worker"),
      path("api", "revenue-worker", "run"),
      path("api", "revenue_worker"),
      path("api", "revenue_worker", "run"),
      path("api", "marketing-operations-worker"),
      path("api", "marketing_operations_worker"),
      path("api", "field_robotics-worker", "run"),
      path("api", "field_robotics_worker", "run"),
      path("api", "worker"),
      path("api", "worker", "revenue"),
      path("api", "workers", "finance"),
      path("worker", "revenue"),
      workerQuery("view=snapshot"),
      workerQuery("view=approvals&role=revenue_operations"),
      path("worker", "marketing-operations"),
      path("workers", "finance"),
      path("dispatch-worker"),
      path("dispatch_worker"),
      path("field_robotics-worker"),
      path("field_robotics_worker"),
    ];

    for (const url of nonCanonical) {
      const sample = ` ${url} `;

      expect(forbiddenWorkerUrlPattern.test(sample) || forbiddenWorkerQueryPattern.test(sample)).toBe(true);
    }

    expect(forbiddenWorkerUrlPattern.test(" /worker ")).toBe(false);
    expect(forbiddenWorkerQueryPattern.test(` ${workerQuery("view=snapshot")} `)).toBe(true);
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
    expect(source).not.toMatch(/\/api\/[a-z0-9_-]+[-_]worker/);
  });

  it("publishes worker contracts and follow-up commands without route-specific API names", () => {
    const registeredCommands = [
      "run",
      "lead.read",
      "lead.classify",
      "response.draft",
      "quote.prepare",
      "continue",
      "approval.decide",
      "adapters.reconcile",
      "adapters.retry",
    ].map((name) => ({ role: "revenue_operations", name }));
    const registeredViews = ["snapshot", "approvals"].map((name) => ({
      role: "revenue_operations",
      name,
    }));
    const revenueFollowUps = workerFollowUpCommands(registeredCommands).filter(
      (command) => command.role === "revenue_operations",
    );
    const revenueViews = workerFollowUpViews(registeredViews).filter(
      (view) => view.role === "revenue_operations",
    );

    expect(workerContracts.map((contract) => contract.role)).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "compliance_operations",
      "systems_operations",
    ]);
    expect(new Set(workerContracts.map((contract) => contract.apiRoute))).toEqual(
      new Set([workerApiRoute]),
    );
    expect(runtimeWorkerContracts.map((contract) => contract.role)).toEqual([
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations",
      "workforce_operations",
      "systems_operations",
    ]);
    expect(workerContractForRole("revenue_operations")?.contractPath).toBe(
      "docs/revenue-operations-worker-v1-contract.md",
    );
    expect(revenueFollowUps.map((command) => command.name)).toEqual(["payment_link.prepare"]);
    expect(new Set(revenueFollowUps.map((command) => command.apiRoute))).toEqual(
      new Set([workerApiRoute]),
    );
    expect(new Set(revenueViews.map((view) => view.apiRoute))).toEqual(new Set([workerApiRoute]));
    expect(
      revenueFollowUps.find((command) => command.name === "payment_link.prepare")?.configSchema.properties?.sourceRefs
        ?.type,
    ).toBe("object");
    expect(revenueViews.map((view) => view.name)).toEqual(["quote_review"]);
    expect(workerContracts.every((contract) => contract.apiRoute === "/worker")).toBe(true);
    expect(revenueFollowUps.every((command) => command.apiRoute === "/worker")).toBe(true);
    expect(revenueViews.every((view) => view.apiRoute === "/worker")).toBe(true);
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
    expect(read("app/worker/route.ts")).not.toContain('request.headers.get("idempotency-key")');
    expect(read("app/worker/route.ts")).not.toContain('request.headers.get("x-worker-run-token")');
    expect(read("src/worker/security.ts")).not.toContain("headerToken");
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
      expect(source).not.toMatch(/\/api\/[a-z0-9_-]+[-_]worker/);

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
    expect(source).not.toMatch(/\/api\/[a-z0-9_-]+[-_]worker/);
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
    expect(source).not.toMatch(/\/api\/[a-z0-9_-]+[-_]worker/);
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
    expect(expansion).toContain("the exact `/worker` `command`, `worker`, `idempotencyKey`,");
  });

  it("keeps the worker roadmap pinned to generic worker routes", () => {
    const roadmap = read("docs/worker-roadmap.md");

    expect(roadmap).toContain("Do not add worker-specific HTTP routes.");
    expect(roadmap).toContain("New worker families extend `/worker`");
    expect(roadmap).toContain("Revenue Completion Gate");
    expect(roadmap).toContain("Controlled send");
    expect(roadmap).toContain("Phase 8+: Post-Systems Worker Waves");
    expect(roadmap).toContain("Offer and Pricing Worker");
    expect(roadmap).toContain("Vertical packaged workers");
    expect(roadmap).toContain("keep operation inputs under `config`");
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
      "Production connector credentials and live provider egress remain blocked; scheduler polling needs real connection coverage",
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
    const coreWorkerLifecycleSmokeScript = read("scripts/smoke-core-worker-lifecycle-on-host.sh");
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
    expect(deployment).toContain("control-plane auth requires a catalog");
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
    expect(attestationScript).toContain("worker:hire.packet.prepare");
    expect(attestationScript).toContain("worker:payroll_input.prepare");
    expect(attestationScript).toContain("worker:view.readiness");
    expect(attestationScript).toContain("worker:view.health");
    expect(attestationScript).toContain("worker:view.repairs");
    expect(attestationScript).toContain("worker:sync.repair.plan");
    expect(attestationScript).toContain("worker:permission.review");
    expect(attestationScript).toContain("workforce_operations");
    expect(attestationScript).toContain("systems_operations");
    expect(coreWorkerLifecycleSmokeScript).toContain('command: "worker.upsert"');
    expect(coreWorkerLifecycleSmokeScript).toContain('command: "worker.transition"');
    expect(coreWorkerLifecycleSmokeScript).toContain("systems_operations");
    expect(rotationScript).toContain("control_plane.token_rotation.attest");
    expect(rotationScript).toContain("TOKEN_ROTATION_ATTESTATION_ID");
    expect(rotationScript).toContain("NEXT_WORKER_RUN_TOKEN");
    expect(deployScript).toContain("core:control_plane.token_rotation.attest");
    expect(deployScript).toContain("core:ai.infer");
    expect(deployScript).toContain("core:control_plane.credential.upsert");
    expect(deployScript).toContain("core:control_plane.credential.revoke");
    expect(deployScript).toContain("core:control_plane.session.review");
    expect(deployScript).toContain("worker:payment_draft.prepare");
    expect(deployScript).toContain("worker:hire.packet.prepare");
    expect(deployScript).toContain("worker:payroll_input.prepare");
    expect(deployScript).toContain("worker:view.readiness");
    expect(deployScript).toContain("worker:view.health");
    expect(deployScript).toContain("worker:view.repairs");
    expect(deployScript).toContain("worker:sync.repair.plan");
    expect(deployScript).toContain("worker:permission.review");
    expect(deployScript).toContain("scripts/rotate-control-plane-token-on-host.sh");
    expect(deployScript).toContain("scripts/smoke-core-worker-lifecycle-on-host.sh");
    expect(deployScript).toContain("preserving the existing bootstrap token");
    expect(deployScript).toContain('SITE_HOST="$SITE_HOST"');
    expect(deployWorkflow).toContain("core:control_plane.token_rotation.attest");
    expect(deployWorkflow).toContain("core:ai.infer");
    expect(deployWorkflow).toContain("core:control_plane.credential.upsert");
    expect(deployWorkflow).toContain("core:control_plane.credential.revoke");
    expect(deployWorkflow).toContain("core:control_plane.session.review");
    expect(deployWorkflow).toContain("worker:payment_draft.prepare");
    expect(deployWorkflow).toContain("worker:hire.packet.prepare");
    expect(deployWorkflow).toContain("worker:payroll_input.prepare");
    expect(deployWorkflow).toContain("worker:view.readiness");
    expect(deployWorkflow).toContain("worker:view.health");
    expect(deployWorkflow).toContain("worker:view.repairs");
    expect(deployWorkflow).toContain("worker:sync.repair.plan");
    expect(deployWorkflow).toContain("worker:permission.review");
    expect(deployWorkflow).toContain("scripts/attest-control-plane-on-host.sh");
    expect(deployWorkflow).toContain("scripts/rotate-control-plane-token-on-host.sh");
    expect(deployWorkflow).toContain("scripts/smoke-core-worker-lifecycle-on-host.sh");
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
      "revenue.quote_to_pricing",
      "customer.signal_to_experience",
      "dispatch.asset_need_to_supply",
      "growth.campaign_to_owner_review",
      "systems.connection_to_packaged_worker",
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
      "Offer and Pricing",
      "Customer Experience",
      "Asset and Supply",
      "Growth",
      "Vertical packaged workers",
    ]) {
      expect(handoffs).toContain(`| ${role} |`);
    }

    expect(handoffs).toContain("Consumers must resolve handoffs from Core records");
    expect(handoffs).toContain("config.sourceRefs");

    for (const entry of workerExpansionCatalog) {
      if (entry.incomingHandoff) {
        expect(handoffs).toContain(entry.incomingHandoff);
      }
      expect(entry.apiRoute).toBe(workerApiRoute);
      expect(entry.firstCommand).not.toMatch(/_worker|worker\./);
      expect(entry.firstView).not.toMatch(/_worker|worker\./);
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
      expect(planned?.apiRoute).toBe(workerApiRoute);
      expect(planned?.evidencePacket).toBe(contract.evidencePacket);
      expect(commandRoles.has(contract.role)).toBe(true);
      expect(viewRoles.has(contract.role)).toBe(true);
      expect(
        plannedWorkerCommands().every((command) => command.role !== contract.role || command.apiRoute === workerApiRoute),
      ).toBe(true);
      expect(
        plannedWorkerViews().every((view) => view.role !== contract.role || view.apiRoute === workerApiRoute),
      ).toBe(true);
      expect(
        plannedWorkerCommands().some(
          (command) => command.role === contract.role && command.name === "approval.decide",
        ),
      ).toBe(true);
    }
  });
});
