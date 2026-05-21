import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  events,
  evidence,
  filingRequirements,
  obligations,
  objects,
  rulePacks,
  tasks,
  workflowRuns,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext, type OperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const source = "continuous.core.obligations";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CoreObligationScanInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  scope?: unknown;
  jurisdiction?: string;
  asOf?: string;
  dueAt?: string;
  rulePackId?: string;
  filingRequirementId?: string;
  workflowRunId?: string;
  taskId?: string;
  facts?: unknown;
  data?: unknown;
  db?: Database;
};

type ObligationProposal = {
  identityHash: string;
  kind: string;
  name: string;
  state: string;
  dueAt: Date | null;
  rulePackId: string | null;
  filingRequirementId: string | null;
  legalEntityId: string | null;
  blockers: string[];
  sourceRefs: JsonObject;
  ruleSnapshot: JsonObject;
  data: JsonObject;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function optionalUuid(value: unknown, field: string) {
  const text = optionalString(value);

  if (!text) {
    return undefined;
  }

  if (!uuidPattern.test(text)) {
    throw new PlatformUnavailableError("invalid_core_command_config", `${field} must be a UUID.`, 400);
  }

  return text;
}

function optionalDate(value: unknown, field: string) {
  const text = optionalString(value);

  if (!text) {
    return undefined;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("invalid_core_command_config", `${field} must be an ISO date string.`, 400);
  }

  return date;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dueDateFor(input: {
  filingData?: JsonObject;
  facts: JsonObject;
  cadence?: string;
  requestedDueAt?: Date;
  asOf: Date;
}) {
  const explicit =
    input.requestedDueAt ??
    optionalDate(input.filingData?.nextDueAt, "filing_requirement.data.nextDueAt") ??
    optionalDate(input.filingData?.dueAt, "filing_requirement.data.dueAt") ??
    optionalDate(input.facts.nextDueAt, "config.facts.nextDueAt") ??
    optionalDate(input.facts.dueAt, "config.facts.dueAt");

  if (explicit) {
    return explicit;
  }

  const cadence = (input.cadence ?? "").toLowerCase();
  if (cadence.includes("weekly")) {
    return addDays(input.asOf, 7);
  }

  if (cadence.includes("monthly")) {
    return addDays(input.asOf, 30);
  }

  if (cadence.includes("quarter")) {
    return addDays(input.asOf, 90);
  }

  if (cadence.includes("annual") || cadence.includes("year")) {
    return addDays(input.asOf, 365);
  }

  return addDays(input.asOf, 30);
}

function blockersForRule(input: { sourceRefs: JsonObject; data: JsonObject; facts: JsonObject }) {
  const blockers = new Set<string>();

  if (input.sourceRefs.placeholder || stringList(input.data.blockers).includes("source_required")) {
    blockers.add("authoritative_source_required");
  }

  for (const blocker of stringList(input.facts.blockers)) {
    blockers.add(blocker);
  }

  return [...blockers].sort();
}

function proposalIdentity(input: {
  tenantId: string;
  kind: string;
  rulePackId: string | null;
  filingRequirementId: string | null;
  legalEntityId: string | null;
  asOf: string;
}) {
  return hashObject({
    tenantId: input.tenantId,
    kind: input.kind,
    rulePackId: input.rulePackId,
    filingRequirementId: input.filingRequirementId,
    legalEntityId: input.legalEntityId,
    asOf: input.asOf.slice(0, 10),
  });
}

async function evidenceForAudit(tx: Transaction, tenantId: string, auditEventId: string) {
  const [row] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.data}->>'auditEventId' = ${auditEventId}`))
    .limit(1);

  return row?.id ?? null;
}

async function assertWorkflowRun(tx: Transaction, tenantId: string, workflowRunId?: string) {
  if (!workflowRunId) {
    return;
  }

  const [row] = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, workflowRunId)))
    .limit(1);

  if (!row) {
    throw new PlatformUnavailableError(
      "core_workflow_run_not_found",
      "config.workflowRunId does not match a workflow run in this tenant.",
      404,
    );
  }
}

async function assertTask(tx: Transaction, tenantId: string, taskId?: string) {
  if (!taskId) {
    return;
  }

  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
    .limit(1);

  if (!row) {
    throw new PlatformUnavailableError(
      "core_task_not_found",
      "config.taskId does not match a task in this tenant.",
      404,
    );
  }
}

async function loadSources(input: {
  tx: Transaction;
  operator: OperatorContext;
  rulePackId?: string;
  filingRequirementId?: string;
  jurisdiction?: string;
  domain?: string;
  asOf: Date;
}) {
  const ruleConditions = [eq(rulePacks.active, true), sql`${rulePacks.effectiveAt} <= ${input.asOf}`];
  const filingConditions = [eq(filingRequirements.tenantId, input.operator.tenantId), eq(filingRequirements.state, "active")];

  if (input.rulePackId) {
    ruleConditions.push(eq(rulePacks.id, input.rulePackId));
    filingConditions.push(eq(filingRequirements.rulePackId, input.rulePackId));
  }

  if (input.filingRequirementId) {
    filingConditions.push(eq(filingRequirements.id, input.filingRequirementId));
  }

  if (input.jurisdiction) {
    ruleConditions.push(eq(rulePacks.jurisdiction, input.jurisdiction));
  }

  if (input.domain) {
    ruleConditions.push(eq(rulePacks.domain, input.domain));
  }

  const [ruleRows, filingRows] = await Promise.all([
    input.tx.select().from(rulePacks).where(and(...ruleConditions)).orderBy(desc(rulePacks.effectiveAt)).limit(50),
    input.tx.select().from(filingRequirements).where(and(...filingConditions)).orderBy(desc(filingRequirements.createdAt)).limit(100),
  ]);

  if (input.rulePackId && ruleRows.length === 0) {
    throw new PlatformUnavailableError(
      "core_rule_pack_not_found",
      "config.rulePackId does not match an active rule pack for this scan.",
      404,
    );
  }

  if (input.filingRequirementId && filingRows.length === 0) {
    throw new PlatformUnavailableError(
      "core_filing_requirement_not_found",
      "config.filingRequirementId does not match an active filing requirement in this tenant.",
      404,
    );
  }

  const activeRulePackIds = new Set(ruleRows.map((rule) => rule.id));
  const unavailableFilingRows = filingRows.filter(
    (filing) => filing.rulePackId && !activeRulePackIds.has(filing.rulePackId),
  );

  if (input.filingRequirementId && unavailableFilingRows.length > 0) {
    throw new PlatformUnavailableError(
      "core_filing_requirement_rule_pack_unavailable",
      "config.filingRequirementId belongs to a rule pack that is not active and effective for this scan.",
      409,
    );
  }

  return {
    ruleRows,
    filingRows: filingRows.filter((filing) => !filing.rulePackId || activeRulePackIds.has(filing.rulePackId)),
  };
}

function proposalsFor(input: {
  operator: OperatorContext;
  rules: Array<typeof rulePacks.$inferSelect>;
  filings: Array<typeof filingRequirements.$inferSelect>;
  facts: JsonObject;
  scanData: JsonObject;
  asOf: Date;
  dueAt?: Date;
}) {
  const rulesById = new Map(input.rules.map((rule) => [rule.id, rule]));
  const proposals: ObligationProposal[] = [];

  for (const filing of input.filings) {
    const rule = filing.rulePackId ? rulesById.get(filing.rulePackId) : undefined;
    const missingRulePack = !rule;
    const ruleData = missingRulePack
      ? ({ blockers: ["source_required"], sourceState: "missing_rule_pack" } satisfies JsonObject)
      : objectValue(rule.rules);
    const sourceRefs = missingRulePack
      ? ({
          placeholder: true,
          reason: filing.rulePackId ? "active_rule_pack_required" : "rule_pack_required",
        } satisfies JsonObject)
      : objectValue(rule.sourceRefs);
    const filingData = objectValue(filing.data);
    const kind = optionalString(filingData.obligationKind) ?? "filing_due";
    const dueAt = dueDateFor({
      filingData,
      facts: input.facts,
      cadence: filing.cadence,
      requestedDueAt: input.dueAt,
      asOf: input.asOf,
    });
    const blockers = [
      ...blockersForRule({ sourceRefs, data: ruleData, facts: input.facts }),
      ...(missingRulePack ? ["rule_pack_required"] : []),
      ...(filing.legalEntityId ? [] : ["legal_entity_missing"]),
    ].sort();
    const identityHash = proposalIdentity({
      tenantId: input.operator.tenantId,
      kind,
      rulePackId: filing.rulePackId ?? null,
      filingRequirementId: filing.id,
      legalEntityId: filing.legalEntityId ?? null,
      asOf: input.asOf.toISOString(),
    });

    proposals.push({
      identityHash,
      kind,
      name: `${filing.agency} ${filing.form} filing obligation`,
      state: blockers.length > 0 ? "blocked" : "open",
      dueAt,
      rulePackId: filing.rulePackId ?? null,
      filingRequirementId: filing.id,
      legalEntityId: filing.legalEntityId ?? null,
      blockers,
      sourceRefs: {
        ...sourceRefs,
        filingRequirementId: filing.id,
        rulePackId: filing.rulePackId ?? null,
        legalEntityId: filing.legalEntityId ?? null,
      },
      ruleSnapshot: {
        rulePackId: rule?.id ?? filing.rulePackId ?? null,
        rulePackKey: rule?.key ?? null,
        rulePackVersion: rule?.version ?? null,
        domain: rule?.domain ?? "filing",
        jurisdiction: rule?.jurisdiction ?? null,
        sourceState: missingRulePack ? "missing_rule_pack" : "active",
        form: filing.form,
        agency: filing.agency,
        cadence: filing.cadence,
        rules: ruleData,
      },
      data: {
        ...input.scanData,
        filingRequirement: {
          id: filing.id,
          form: filing.form,
          agency: filing.agency,
          cadence: filing.cadence,
          state: filing.state,
        },
      },
    });
  }

  if (proposals.length === 0) {
    for (const rule of input.rules) {
      const sourceRefs = objectValue(rule.sourceRefs);
      const ruleData = objectValue(rule.rules);
      const kind = `${rule.domain}_rule_review`;
      const blockers = blockersForRule({ sourceRefs, data: ruleData, facts: input.facts });
      const identityHash = proposalIdentity({
        tenantId: input.operator.tenantId,
        kind,
        rulePackId: rule.id,
        filingRequirementId: null,
        legalEntityId: null,
        asOf: input.asOf.toISOString(),
      });

      proposals.push({
        identityHash,
        kind,
        name: `${rule.name} obligation review`,
        state: blockers.length > 0 ? "blocked" : "open",
        dueAt: input.dueAt ?? addDays(input.asOf, 30),
        rulePackId: rule.id,
        filingRequirementId: null,
        legalEntityId: null,
        blockers,
        sourceRefs,
        ruleSnapshot: {
          rulePackId: rule.id,
          rulePackKey: rule.key,
          rulePackVersion: rule.version,
          domain: rule.domain,
          jurisdiction: rule.jurisdiction,
          rules: ruleData,
        },
        data: input.scanData,
      });
    }
  }

  return proposals;
}

async function writeProposal(input: {
  tx: Transaction;
  operator: OperatorContext;
  proposal: ObligationProposal;
  taskId?: string;
  workflowRunId?: string;
  asOf: Date;
  now: Date;
}) {
  const objectData = {
    kind: input.proposal.kind,
    state: input.proposal.state,
    dueAt: input.proposal.dueAt?.toISOString() ?? null,
    rulePackId: input.proposal.rulePackId,
    filingRequirementId: input.proposal.filingRequirementId,
    legalEntityId: input.proposal.legalEntityId,
    blockers: input.proposal.blockers,
    sourceRefs: input.proposal.sourceRefs,
    ruleSnapshot: input.proposal.ruleSnapshot,
    externalExecution: "blocked",
    scan: {
      identityHash: input.proposal.identityHash,
      asOf: input.asOf.toISOString(),
      workflowRunId: input.workflowRunId ?? null,
    },
  } satisfies JsonObject;
  const [existingObject] = await input.tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.tenantId, input.operator.tenantId),
        eq(objects.source, source),
        eq(objects.externalId, input.proposal.identityHash),
      ),
    )
    .limit(1);
  const objectRow = existingObject
    ? (
        await input.tx
          .update(objects)
          .set({
            name: input.proposal.name,
            state: input.proposal.state,
            data: objectData,
            updatedAt: input.now,
          })
          .where(eq(objects.id, existingObject.id))
          .returning({ id: objects.id })
      )[0]
    : (
        await input.tx
          .insert(objects)
          .values({
            tenantId: input.operator.tenantId,
            type: "obligation",
            name: input.proposal.name,
            state: input.proposal.state,
            source,
            externalId: input.proposal.identityHash,
            data: objectData,
            createdByUserId: input.operator.userId,
            effectiveAt: input.asOf,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: objects.id })
      )[0];

  const obligationData = {
    ...input.proposal.data,
    ...objectData,
    objectId: objectRow.id,
  };
  const [existingObligation] = await input.tx
    .select({ id: obligations.id })
    .from(obligations)
    .where(
      and(
        eq(obligations.tenantId, input.operator.tenantId),
        sql`${obligations.data}->'scan'->>'identityHash' = ${input.proposal.identityHash}`,
      ),
    )
    .limit(1);
  const obligationRow = existingObligation
    ? (
        await input.tx
          .update(obligations)
          .set({
            objectId: objectRow.id,
            rulePackId: input.proposal.rulePackId,
            kind: input.proposal.kind,
            state: input.proposal.state,
            name: input.proposal.name,
            dueAt: input.proposal.dueAt,
            data: obligationData,
            updatedAt: input.now,
          })
          .where(eq(obligations.id, existingObligation.id))
          .returning({ id: obligations.id })
      )[0]
    : (
        await input.tx
          .insert(obligations)
          .values({
            tenantId: input.operator.tenantId,
            objectId: objectRow.id,
            rulePackId: input.proposal.rulePackId,
            kind: input.proposal.kind,
            state: input.proposal.state,
            name: input.proposal.name,
            dueAt: input.proposal.dueAt,
            data: obligationData,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: obligations.id })
      )[0];
  const [existingTask] = await input.tx
    .select({ id: tasks.id, outcome: tasks.outcome })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, input.operator.tenantId),
        eq(tasks.objectId, objectRow.id),
        sql`${tasks.state} in ('draft', 'active', 'waiting', 'approval_required', 'blocked')`,
      ),
    )
    .limit(1);
  const [providedTask] = input.taskId
    ? await input.tx
        .select({ id: tasks.id, objectId: tasks.objectId, outcome: tasks.outcome })
        .from(tasks)
        .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, input.taskId)))
        .limit(1)
    : [];
  if (input.taskId && providedTask?.objectId && providedTask.objectId !== objectRow.id) {
    throw new PlatformUnavailableError(
      "core_task_object_mismatch",
      "config.taskId is already linked to a different object.",
      409,
    );
  }
  const taskState = input.proposal.blockers.length > 0 ? "blocked" : "active";
  const taskEvidence = {
    command: "obligation.scan",
    obligationId: obligationRow.id,
    objectId: objectRow.id,
    rulePackId: input.proposal.rulePackId,
    filingRequirementId: input.proposal.filingRequirementId,
    legalEntityId: input.proposal.legalEntityId,
    blockers: input.proposal.blockers,
    sourceRefs: input.proposal.sourceRefs,
    workflowRunId: input.workflowRunId ?? null,
    externalExecution: "blocked",
  } satisfies JsonObject;
  const taskRow = input.taskId
    ? (
        await input.tx
          .update(tasks)
          .set({
            objectId: providedTask?.objectId ?? objectRow.id,
            title: `Review obligation: ${input.proposal.name}`,
            state: taskState,
            priority: input.proposal.blockers.length > 0 ? "high" : "normal",
            dueAt: input.proposal.dueAt,
            evidence: taskEvidence,
            outcome: {
              ...objectValue(providedTask?.outcome),
              externalExecution: "blocked",
              obligationState: input.proposal.state,
            },
            updatedAt: input.now,
          })
          .where(and(eq(tasks.tenantId, input.operator.tenantId), eq(tasks.id, input.taskId)))
          .returning({ id: tasks.id })
      )[0]
    : existingTask
      ? (
          await input.tx
            .update(tasks)
            .set({
              title: `Review obligation: ${input.proposal.name}`,
              state: taskState,
              priority: input.proposal.blockers.length > 0 ? "high" : "normal",
              dueAt: input.proposal.dueAt,
              evidence: taskEvidence,
              outcome: {
                ...objectValue(existingTask.outcome),
                externalExecution: "blocked",
                obligationState: input.proposal.state,
              },
              updatedAt: input.now,
            })
            .where(eq(tasks.id, existingTask.id))
            .returning({ id: tasks.id })
        )[0]
      : (
          await input.tx
            .insert(tasks)
            .values({
              tenantId: input.operator.tenantId,
              objectId: objectRow.id,
              title: `Review obligation: ${input.proposal.name}`,
              state: taskState,
              priority: input.proposal.blockers.length > 0 ? "high" : "normal",
              ownerType: "user",
              ownerId: input.operator.userId,
              ownerRef: input.operator.actorRef,
              dueAt: input.proposal.dueAt,
              evidence: taskEvidence,
              outcome: {
                externalExecution: "blocked",
                obligationState: input.proposal.state,
              },
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning({ id: tasks.id })
        )[0];

  return {
    obligationId: obligationRow.id,
    objectId: objectRow.id,
    taskId: taskRow.id,
    rulePackId: input.proposal.rulePackId,
    filingRequirementId: input.proposal.filingRequirementId,
    legalEntityId: input.proposal.legalEntityId,
    kind: input.proposal.kind,
    state: input.proposal.state,
    name: input.proposal.name,
    dueAt: input.proposal.dueAt?.toISOString() ?? null,
    blockers: input.proposal.blockers,
    sourceRefs: input.proposal.sourceRefs,
    externalExecution: "blocked",
  };
}

export type CoreObligationScanForOperatorInput = Omit<
  CoreObligationScanInput,
  "operatorEmail" | "tenantSlug" | "db"
>;

export async function scanObligations(input: CoreObligationScanInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction((tx) => scanObligationsForOperator(tx, operator, input));
}

export async function scanObligationsForOperator(
  tx: Transaction,
  operator: OperatorContext,
  input: CoreObligationScanForOperatorInput,
) {
  const scope = objectValue(input.scope);
  const facts = objectValue(input.facts);
  const scanData = objectValue(input.data);
  const jurisdiction = optionalString(input.jurisdiction) ?? optionalString(scope.jurisdiction);
  const domain = optionalString(scope.domain);
  const asOf = optionalDate(input.asOf, "config.asOf") ?? new Date();
  const dueAt = optionalDate(input.dueAt, "config.dueAt");
  const rulePackId = optionalUuid(input.rulePackId, "config.rulePackId");
  const filingRequirementId = optionalUuid(input.filingRequirementId, "config.filingRequirementId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const idempotency = coreIdempotencyFingerprint("obligation.scan", {
    scope,
    jurisdiction: jurisdiction ?? null,
    domain: domain ?? null,
    asOf: asOf.toISOString(),
    dueAt: dueAt?.toISOString() ?? null,
    rulePackId: rulePackId ?? null,
    filingRequirementId: filingRequirementId ?? null,
    workflowRunId: workflowRunId ?? null,
    taskId: taskId ?? null,
    facts,
    data: scanData,
    externalExecution: "blocked",
  });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
  );

  const [existingAudit] = await tx
      .select({ id: auditEvents.id, eventId: auditEvents.eventId, targetId: auditEvents.targetId, data: auditEvents.data })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:obligation_scanned`),
          eq(auditEvents.targetType, "obligation_scan"),
        ),
      )
      .limit(1);

  if (existingAudit) {
    assertCoreIdempotencyReplay({
      command: "obligation.scan",
      fingerprint: idempotency,
      storedData: existingAudit.data,
    });

    const result = objectValue(existingAudit.data.result);

    return {
      ...result,
      created: false,
      eventId: existingAudit.eventId,
      auditEventId: existingAudit.id,
      evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.id),
    };
  }

  await Promise.all([
    assertTask(tx, operator.tenantId, taskId),
    assertWorkflowRun(tx, operator.tenantId, workflowRunId),
  ]);

  const { ruleRows, filingRows } = await loadSources({
    tx,
    operator,
    rulePackId,
    filingRequirementId,
    jurisdiction,
    domain,
    asOf,
  });
  const proposals = proposalsFor({
    operator,
    rules: ruleRows,
    filings: filingRows,
    facts,
    scanData,
    asOf,
    dueAt,
  });
  if (taskId && proposals.length !== 1) {
    throw new PlatformUnavailableError(
      "core_obligation_scan_task_scope_ambiguous",
      "config.taskId can only be attached when obligation.scan produces exactly one obligation.",
      400,
    );
  }
  const now = new Date();
  const written = [];

  for (const proposal of proposals) {
    written.push(
      await writeProposal({
        tx,
        operator,
        proposal,
        taskId,
        workflowRunId,
        asOf,
        now,
      }),
    );
  }

  const primaryObjectId = written.length === 1 ? (written[0]?.objectId ?? null) : null;
  const primaryTaskId = written.length === 1 ? (taskId ?? written[0]?.taskId ?? null) : null;
  const result = {
    created: true,
    scannedAt: now.toISOString(),
    asOf: asOf.toISOString(),
    jurisdiction: jurisdiction ?? null,
    domain: domain ?? null,
    rulePackIds: ruleRows.map((rule) => rule.id),
    filingRequirementIds: filingRows.map((filing) => filing.id),
    obligationIds: written.map((item) => item.obligationId),
    objectIds: written.map((item) => item.objectId),
    taskIds: [...new Set(written.map((item) => item.taskId))],
    obligations: written,
    blockers: [...new Set(written.flatMap((item) => item.blockers))].sort(),
    workflowRunId: workflowRunId ?? null,
    externalExecution: "blocked",
  } satisfies JsonObject;
  const [event] = await tx
    .insert(events)
    .values({
      tenantId: operator.tenantId,
      type: "core.obligations.scanned",
      source,
      actorType: "user",
      actorId: operator.userId,
      actorRef: operator.actorRef,
      objectId: primaryObjectId,
      taskId: primaryTaskId,
      idempotencyKey: `${input.idempotencyKey}:obligation_scanned`,
      data: {
        ...result,
        idempotency,
      },
      occurredAt: now,
      createdAt: now,
    })
    .returning({ id: events.id });
  const [audit] = await tx
    .insert(auditEvents)
    .values({
      tenantId: operator.tenantId,
      type: "core.obligations.scanned",
      source,
      actorType: "user",
      actorId: operator.userId,
      actorRef: operator.actorRef,
      targetType: "obligation_scan",
      targetId: written.length === 1 ? (written[0]?.obligationId ?? null) : null,
      taskId: primaryTaskId,
      eventId: event.id,
      objectId: primaryObjectId,
      risk: result.blockers.length > 0 ? "high" : "medium",
      idempotencyKey: `${input.idempotencyKey}:obligation_scanned`,
      data: {
        result,
        idempotency,
      },
    })
    .returning({ id: auditEvents.id });
  const [proof] = await tx
    .insert(evidence)
    .values({
      tenantId: operator.tenantId,
      kind: "trace",
      name: "Core obligation scan trace",
      objectId: primaryObjectId,
      taskId: primaryTaskId,
      eventId: event.id,
      actorType: "user",
      actorId: operator.userId,
      hash: `${source}:${input.idempotencyKey}:${idempotency.inputHash}`,
      data: {
        ...result,
        auditEventId: audit.id,
        eventId: event.id,
        idempotency,
      },
      createdAt: now,
    })
    .returning({ id: evidence.id });

  return {
    ...result,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
  };
}
