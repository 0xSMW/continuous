import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  bankAccounts,
  documents,
  employments,
  events,
  evidence,
  evidencePackets,
  filingDrafts,
  filingRequirements,
  obligations,
  objects,
  paymentInstructions,
  paySchedules,
  payrollLiabilities,
  payrollLines,
  payrollRuns,
  payrollStatements,
  payrollTraces,
  people,
  type JsonObject,
  users,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type QueryClient = Pick<Database, "select">;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const payrollSource = "continuous.core.payroll";

export type PayrollPreviewStatementInput = {
  employmentId?: string;
  personId?: string;
  objectId?: string;
  externalId?: string;
  state?: string;
  grossCents?: unknown;
  netCents?: unknown;
  taxCents?: unknown;
  deductionCents?: unknown;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  checkDate?: string;
  data?: JsonObject;
};

export type PayrollPreviewRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  payrollRunId: string;
  statement?: PayrollPreviewStatementInput;
  lines?: unknown;
  liabilities?: unknown;
  trace?: unknown;
  db?: Database;
};

export type PayrollPreviewPacketInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  payrollRunId: string;
  objectId?: string;
  reviewerUserId?: string;
  dueAt?: string;
  variance?: unknown;
  data?: unknown;
  db?: Database;
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("core_field_required", `${field} is required.`, 400);
  }

  return output;
}

function requiredUuid(value: unknown, field: string) {
  const uuid = requiredString(value, field);

  if (!uuidPattern.test(uuid)) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return uuid;
}

function optionalUuid(value: unknown, field: string) {
  const uuid = cleanString(value);

  if (!uuid) {
    return undefined;
  }

  if (!uuidPattern.test(uuid)) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return uuid;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function objectValue(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return {};
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new PlatformUnavailableError("core_field_invalid", `${field} must be an object.`, 400);
}

function requiredInteger(value: unknown, field: string, fallback?: number) {
  const candidate = value === undefined || value === null ? fallback : value;

  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    throw new PlatformUnavailableError("core_amount_invalid", `${field} must be an integer number of cents.`, 400);
  }

  return candidate;
}

function optionalDate(value: unknown, field: string) {
  const input = cleanString(value);

  if (!input) {
    return undefined;
  }

  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("core_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function currencyCode(value: unknown, field: string) {
  const currency = cleanString(value) ?? "USD";

  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw new PlatformUnavailableError("core_currency_invalid", `${field} must be a 3-letter currency code.`, 400);
  }

  return currency.toUpperCase();
}

function arrayValue(value: unknown, field: string, required = false) {
  if (value === undefined || value === null) {
    if (required) {
      throw new PlatformUnavailableError("core_field_required", `${field} is required.`, 400);
    }

    return [];
  }

  if (!Array.isArray(value)) {
    throw new PlatformUnavailableError("core_field_invalid", `${field} must be an array.`, 400);
  }

  if (required && value.length === 0) {
    throw new PlatformUnavailableError("core_field_required", `${field} must include at least one item.`, 400);
  }

  return value.map((item, index) => objectValue(item, `${field}[${index}]`));
}

async function assertEmployment(tx: QueryClient, tenantId: string, employmentId?: string) {
  if (!employmentId) {
    return null;
  }

  const [employment] = await tx
    .select({ id: employments.id, personId: employments.personId })
    .from(employments)
    .where(and(eq(employments.tenantId, tenantId), eq(employments.id, employmentId)))
    .limit(1);

  if (!employment) {
    throw new PlatformUnavailableError(
      "core_employment_not_found",
      "config.statement.employmentId does not match an employment in this tenant.",
      404,
    );
  }

  return employment;
}

async function assertPerson(tx: QueryClient, tenantId: string, personId?: string) {
  if (!personId) {
    return;
  }

  const [person] = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.tenantId, tenantId), eq(people.id, personId)))
    .limit(1);

  if (!person) {
    throw new PlatformUnavailableError(
      "core_person_not_found",
      "config.statement.personId does not match a person in this tenant.",
      404,
    );
  }
}

async function assertObject(tx: QueryClient, tenantId: string, objectId?: string) {
  if (!objectId) {
    return;
  }

  const [object] = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, objectId)))
    .limit(1);

  if (!object) {
    throw new PlatformUnavailableError(
      "core_object_not_found",
      "config.statement.objectId does not match an object in this tenant.",
      404,
    );
  }
}

async function evidenceForAudit(tx: QueryClient, tenantId: string, auditEventId: string) {
  const [item] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.data}->>'auditEventId' = ${auditEventId}`))
    .limit(1);

  return item?.id ?? null;
}

function centsTotal<T>(items: T[], selector: (item: T) => number | null | undefined) {
  return items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
}

function stringsFromData(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectFromData(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export async function recordPayrollPreview(input: PayrollPreviewRecordInput) {
  const db = input.db ?? defaultDb;
  const payrollRunId = requiredUuid(input.payrollRunId, "config.payrollRunId");
  const statementInput = objectValue(input.statement, "config.statement");
  const lineInputs = arrayValue(input.lines, "config.lines", true);
  const liabilityInputs = arrayValue(input.liabilities, "config.liabilities");
  const traceInput = objectValue(input.trace, "config.trace");

  if (Object.keys(traceInput).length === 0) {
    throw new PlatformUnavailableError("core_field_required", "config.trace is required.", 400);
  }

  const employmentId = optionalUuid(statementInput.employmentId, "config.statement.employmentId");
  const requestedPersonId = optionalUuid(statementInput.personId, "config.statement.personId");
  const objectId = optionalUuid(statementInput.objectId, "config.statement.objectId");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${payrollSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        eventId: auditEvents.eventId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, payrollSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:payroll_preview_recorded`),
          eq(auditEvents.targetType, "payroll_statement"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [statement] = await tx
        .select({ id: payrollStatements.id, payrollRunId: payrollStatements.payrollRunId })
        .from(payrollStatements)
        .where(
          and(
            eq(payrollStatements.tenantId, operator.tenantId),
            eq(payrollStatements.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (statement) {
        const [lines, liabilities, traces] = await Promise.all([
          tx
            .select({ id: payrollLines.id })
            .from(payrollLines)
            .where(eq(payrollLines.statementId, statement.id)),
          tx
            .select({ id: payrollLiabilities.id })
            .from(payrollLiabilities)
            .where(eq(payrollLiabilities.statementId, statement.id)),
          tx
            .select({ id: payrollTraces.id })
            .from(payrollTraces)
            .where(eq(payrollTraces.statementId, statement.id)),
        ]);

        return {
          recorded: false,
          payrollRunId: statement.payrollRunId,
          statementId: statement.id,
          lineIds: lines.map((line) => line.id),
          liabilityIds: liabilities.map((liability) => liability.id),
          traceId: traces[0]?.id ?? null,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        };
      }
    }

    const [payrollRun] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRunId)))
      .limit(1);

    if (!payrollRun) {
      throw new PlatformUnavailableError(
        "core_payroll_run_not_found",
        "config.payrollRunId does not match a payroll run in this tenant.",
        404,
      );
    }

    const employment = await assertEmployment(tx, operator.tenantId, employmentId);
    const personId = requestedPersonId ?? employment?.personId ?? undefined;

    if (requestedPersonId && employment?.personId && requestedPersonId !== employment.personId) {
      throw new PlatformUnavailableError(
        "core_payroll_identity_conflict",
        "config.statement.personId must match config.statement.employmentId when both are provided.",
        409,
      );
    }

    await Promise.all([
      assertPerson(tx, operator.tenantId, personId),
      assertObject(tx, operator.tenantId, objectId),
    ]);

    const now = new Date();
    const statementCurrency = currencyCode(statementInput.currency, "config.statement.currency");
    const [statement] = await tx
      .insert(payrollStatements)
      .values({
        tenantId: operator.tenantId,
        payrollRunId,
        employmentId,
        personId,
        objectId,
        externalId: cleanString(statementInput.externalId),
        state: cleanString(statementInput.state) ?? "draft",
        grossCents: requiredInteger(statementInput.grossCents, "config.statement.grossCents", 0),
        netCents: requiredInteger(statementInput.netCents, "config.statement.netCents", 0),
        taxCents: requiredInteger(statementInput.taxCents, "config.statement.taxCents", 0),
        deductionCents: requiredInteger(statementInput.deductionCents, "config.statement.deductionCents", 0),
        currency: statementCurrency,
        periodStart: optionalDate(statementInput.periodStart, "config.statement.periodStart") ?? payrollRun.periodStart,
        periodEnd: optionalDate(statementInput.periodEnd, "config.statement.periodEnd") ?? payrollRun.periodEnd,
        checkDate: optionalDate(statementInput.checkDate, "config.statement.checkDate") ?? payrollRun.checkDate,
        data: jsonObject(statementInput.data),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payrollStatements.id });

    const insertedLines = await tx
      .insert(payrollLines)
      .values(
        lineInputs.map((line, index) => ({
          tenantId: operator.tenantId,
          payrollRunId,
          statementId: statement.id,
          employmentId,
          kind: requiredString(line.kind, `config.lines[${index}].kind`),
          code: cleanString(line.code),
          description: cleanString(line.description),
          amountCents: requiredInteger(line.amountCents, `config.lines[${index}].amountCents`),
          currency: currencyCode(line.currency, `config.lines[${index}].currency`),
          taxable: typeof line.taxable === "boolean" ? line.taxable : false,
          data: jsonObject(line.data),
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: payrollLines.id });

    const insertedLiabilities =
      liabilityInputs.length > 0
        ? await tx
            .insert(payrollLiabilities)
            .values(
              liabilityInputs.map((liability, index) => ({
                tenantId: operator.tenantId,
                payrollRunId,
                statementId: statement.id,
                kind: requiredString(liability.kind, `config.liabilities[${index}].kind`),
                payee: cleanString(liability.payee),
                jurisdiction: cleanString(liability.jurisdiction),
                amountCents: requiredInteger(liability.amountCents, `config.liabilities[${index}].amountCents`),
                currency: currencyCode(liability.currency, `config.liabilities[${index}].currency`),
                state: cleanString(liability.state) ?? "draft",
                dueAt: optionalDate(liability.dueAt, `config.liabilities[${index}].dueAt`),
                data: jsonObject(liability.data),
                createdAt: now,
                updatedAt: now,
              })),
            )
            .returning({ id: payrollLiabilities.id })
        : [];

    const [trace] = await tx
      .insert(payrollTraces)
      .values({
        tenantId: operator.tenantId,
        payrollRunId,
        statementId: statement.id,
        kind: cleanString(traceInput.kind) ?? "calculation",
        sourceRefs: jsonObject(traceInput.sourceRefs),
        inputs: jsonObject(traceInput.inputs),
        outputs: jsonObject(traceInput.outputs),
        rules: jsonObject(traceInput.rules),
        hash: cleanString(traceInput.hash),
        data: jsonObject(traceInput.data),
        createdAt: now,
      })
      .returning({ id: payrollTraces.id });

    const [totals] = await tx
      .select({
        grossCents: sql<number>`coalesce(sum(${payrollStatements.grossCents}), 0)`,
        netCents: sql<number>`coalesce(sum(${payrollStatements.netCents}), 0)`,
        taxCents: sql<number>`coalesce(sum(${payrollStatements.taxCents}), 0)`,
        statementCount: sql<number>`count(*)`,
      })
      .from(payrollStatements)
      .where(and(eq(payrollStatements.tenantId, operator.tenantId), eq(payrollStatements.payrollRunId, payrollRunId)));

    await tx
      .update(payrollRuns)
      .set({
        grossCents: Number(totals?.grossCents ?? 0),
        netCents: Number(totals?.netCents ?? 0),
        taxCents: Number(totals?.taxCents ?? 0),
        data: {
          ...payrollRun.data,
          preview: {
            statementCount: Number(totals?.statementCount ?? 0),
            lastStatementId: statement.id,
            traceId: trace.id,
            externalExecution: "blocked",
          },
        },
        updatedAt: now,
      })
      .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRunId)));

    const lineIds = insertedLines.map((line) => line.id);
    const liabilityIds = insertedLiabilities.map((liability) => liability.id);
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "payroll.preview.recorded",
        source: payrollSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId,
        idempotencyKey: `${input.idempotencyKey}:payroll_preview_recorded`,
        data: {
          payrollRunId,
          statementId: statement.id,
          lineIds,
          liabilityIds,
          traceId: trace.id,
          totals: {
            grossCents: Number(totals?.grossCents ?? 0),
            netCents: Number(totals?.netCents ?? 0),
            taxCents: Number(totals?.taxCents ?? 0),
          },
          externalExecution: "blocked",
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "payroll.preview.recorded",
        source: payrollSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "payroll_statement",
        targetId: statement.id,
        eventId: event.id,
        objectId,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:payroll_preview_recorded`,
        data: {
          payrollRunId,
          statementId: statement.id,
          lineCount: lineIds.length,
          liabilityCount: liabilityIds.length,
          traceId: trace.id,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [evidenceItem] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: "Payroll preview calculation trace",
        objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: cleanString(traceInput.hash),
        data: {
          auditEventId: audit.id,
          payrollRunId,
          statementId: statement.id,
          lineIds,
          liabilityIds,
          traceId: trace.id,
          sourceRefs: jsonObject(traceInput.sourceRefs),
          externalExecution: "blocked",
        },
      })
      .returning({ id: evidence.id });

    return {
      recorded: true,
      payrollRunId,
      statementId: statement.id,
      lineIds,
      liabilityIds,
      traceId: trace.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: evidenceItem.id,
    };
  });
}

export async function preparePayrollPreviewPacket(input: PayrollPreviewPacketInput) {
  const db = input.db ?? defaultDb;
  const payrollRunId = requiredUuid(input.payrollRunId, "config.payrollRunId");
  const requestedObjectId = optionalUuid(input.objectId, "config.objectId");
  const requestedReviewerUserId = optionalUuid(input.reviewerUserId, "config.reviewerUserId");
  const dueAt = optionalDate(input.dueAt, "config.dueAt");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${payrollSource}:${input.idempotencyKey}:packet`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        eventId: auditEvents.eventId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, payrollSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:payroll_preview_packet_prepared`),
          eq(auditEvents.targetType, "evidence_packet"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [packet] = await tx
        .select({ id: evidencePackets.id, documentId: evidencePackets.documentId, data: evidencePackets.data })
        .from(evidencePackets)
        .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, existingAudit.targetId)))
        .limit(1);

      if (packet) {
        const packetData = objectFromData(packet.data);

        return {
          prepared: false,
          payrollRunId: cleanString(packetData.payrollRunId) ?? payrollRunId,
          packetId: packet.id,
          packetDocumentId: packet.documentId,
          varianceDocumentId: cleanString(packetData.varianceDocumentId) ?? null,
          payStatementDocumentIds: stringsFromData(packetData.payStatementDocumentIds),
          paymentInstructionIds: stringsFromData(packetData.paymentInstructionIds),
          filingDraftId: cleanString(packetData.filingDraftId) ?? null,
          approvalRequestId: cleanString(packetData.approvalRequestId) ?? null,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
          totals: objectFromData(packetData.totals),
          externalExecution: "blocked",
        };
      }
    }

    const [payrollRun] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.tenantId, operator.tenantId), eq(payrollRuns.id, payrollRunId)))
      .limit(1);

    if (!payrollRun) {
      throw new PlatformUnavailableError(
        "core_payroll_run_not_found",
        "config.payrollRunId does not match a payroll run in this tenant.",
        404,
      );
    }

    const statements = await tx
      .select()
      .from(payrollStatements)
      .where(and(eq(payrollStatements.tenantId, operator.tenantId), eq(payrollStatements.payrollRunId, payrollRunId)));

    if (statements.length === 0) {
      throw new PlatformUnavailableError(
        "core_payroll_preview_missing",
        "config.payrollRunId has no persisted payroll statements to packetize.",
        409,
      );
    }

    const [paySchedule] = await tx
      .select()
      .from(paySchedules)
      .where(and(eq(paySchedules.tenantId, operator.tenantId), eq(paySchedules.id, payrollRun.payScheduleId)))
      .limit(1);

    if (!paySchedule) {
      throw new PlatformUnavailableError(
        "core_pay_schedule_not_found",
        "The payroll run pay schedule is missing.",
        404,
      );
    }

    const statementIds = statements.map((statement) => statement.id);
    const [lines, liabilities, traces, sourceEvidence] = await Promise.all([
      tx
        .select()
        .from(payrollLines)
        .where(and(eq(payrollLines.tenantId, operator.tenantId), eq(payrollLines.payrollRunId, payrollRunId))),
      tx
        .select()
        .from(payrollLiabilities)
        .where(and(eq(payrollLiabilities.tenantId, operator.tenantId), eq(payrollLiabilities.payrollRunId, payrollRunId))),
      tx
        .select()
        .from(payrollTraces)
        .where(and(eq(payrollTraces.tenantId, operator.tenantId), eq(payrollTraces.payrollRunId, payrollRunId))),
      tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.tenantId, operator.tenantId), sql`${evidence.data}->>'payrollRunId' = ${payrollRunId}`)),
    ]);

    const objectId = requestedObjectId ?? statements.find((statement) => statement.objectId)?.objectId ?? undefined;
    await assertObject(tx, operator.tenantId, objectId);

    const [reviewer] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenantId, operator.tenantId),
          eq(users.id, requestedReviewerUserId ?? operator.userId),
          eq(users.state, "active"),
        ),
      )
      .limit(1);

    if (!reviewer) {
      throw new PlatformUnavailableError(
        "core_payroll_reviewer_not_found",
        "config.reviewerUserId does not match an active user in this tenant.",
        404,
      );
    }

    const [bankAccount] = paySchedule.legalEntityId
      ? await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.tenantId, operator.tenantId),
              eq(bankAccounts.legalEntityId, paySchedule.legalEntityId),
              eq(bankAccounts.state, "verified"),
            ),
          )
          .limit(1)
      : await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.tenantId, operator.tenantId), eq(bankAccounts.state, "verified")))
          .limit(1);

    if (!bankAccount) {
      throw new PlatformUnavailableError(
        "core_payroll_bank_account_missing",
        "A verified bank account is required before preparing payroll funding drafts.",
        409,
      );
    }

    const [filingRequirement] = await tx
      .select({ id: filingRequirements.id })
      .from(filingRequirements)
      .where(
        and(
          eq(filingRequirements.tenantId, operator.tenantId),
          eq(filingRequirements.form, "941"),
          eq(filingRequirements.agency, "IRS"),
          eq(filingRequirements.state, "active"),
        ),
      )
      .limit(1);

    if (!filingRequirement) {
      throw new PlatformUnavailableError(
        "core_payroll_filing_requirement_missing",
        "An active IRS Form 941 filing requirement is required before preparing payroll tax drafts.",
        409,
      );
    }

    const [payrollObligation] = await tx
      .select({ id: obligations.id })
      .from(obligations)
      .where(
        and(
          eq(obligations.tenantId, operator.tenantId),
          eq(obligations.kind, "payroll_tax_filing"),
          eq(obligations.state, "open"),
        ),
      )
      .limit(1);

    const grossCents = centsTotal(statements, (statement) => statement.grossCents);
    const netCents = centsTotal(statements, (statement) => statement.netCents);
    const taxCents = centsTotal(statements, (statement) => statement.taxCents);
    const deductionCents = centsTotal(statements, (statement) => statement.deductionCents);
    const liabilityCents = centsTotal(liabilities, (liability) => liability.amountCents);
    const runTotals = {
      grossCents: payrollRun.grossCents,
      netCents: payrollRun.netCents,
      taxCents: payrollRun.taxCents,
    };
    const totals = {
      statementCount: statements.length,
      lineCount: lines.length,
      liabilityCount: liabilities.length,
      traceCount: traces.length,
      grossCents,
      netCents,
      taxCents,
      deductionCents,
      liabilityCents,
      variance: {
        grossCents: grossCents - payrollRun.grossCents,
        netCents: netCents - payrollRun.netCents,
        taxCents: taxCents - payrollRun.taxCents,
        liabilityCents: liabilityCents - taxCents,
        ...jsonObject(input.variance),
      },
    };
    const period = {
      start: payrollRun.periodStart.toISOString(),
      end: payrollRun.periodEnd.toISOString(),
      checkDate: payrollRun.checkDate.toISOString(),
    };
    const now = new Date();
    const currency = statements[0]?.currency ?? "USD";

    const [varianceDocument] = await tx
      .insert(documents)
      .values({
        tenantId: operator.tenantId,
        objectId,
        kind: "payroll_variance_report",
        name: "Payroll preview variance report",
        state: "review_ready",
        sensitivity: "high",
        hash: `${payrollSource}:${payrollRunId}:${input.idempotencyKey}:variance`,
        data: {
          payrollRunId,
          period,
          runTotals,
          totals,
          statementIds,
          lineIds: lines.map((line) => line.id),
          liabilityIds: liabilities.map((liability) => liability.id),
          traceIds: traces.map((trace) => trace.id),
          blockers: ["approval_required", "funding_not_submitted", "tax_not_submitted"],
          externalExecution: "blocked",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const payStatementDocuments = await tx
      .insert(documents)
      .values(
        statements.map((statement, index) => ({
          tenantId: operator.tenantId,
          objectId: statement.objectId ?? objectId,
          kind: "pay_statement",
          name: `Pay statement preview ${index + 1}`,
          state: "draft",
          sensitivity: "high" as const,
          hash: `${payrollSource}:${statement.id}:${input.idempotencyKey}:pay_statement`,
          data: {
            payrollRunId,
            statementId: statement.id,
            employmentId: statement.employmentId,
            personId: statement.personId,
            period,
            grossCents: statement.grossCents,
            netCents: statement.netCents,
            taxCents: statement.taxCents,
            deductionCents: statement.deductionCents,
            currency: statement.currency,
            lineIds: lines.filter((line) => line.statementId === statement.id).map((line) => line.id),
            liabilityIds: liabilities
              .filter((liability) => liability.statementId === statement.id)
              .map((liability) => liability.id),
            traceIds: traces.filter((trace) => trace.statementId === statement.id).map((trace) => trace.id),
            externalExecution: "blocked",
          },
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: documents.id });

    const paymentDrafts = await tx
      .insert(paymentInstructions)
      .values([
        {
          tenantId: operator.tenantId,
          bankAccountId: bankAccount.id,
          objectId,
          kind: "payroll_net_pay_funding",
          state: "approval_required",
          amountCents: netCents,
          currency,
          data: {
            payrollRunId,
            period,
            statementIds,
            externalExecution: "blocked",
            moneyMovement: "blocked",
          },
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: operator.tenantId,
          bankAccountId: bankAccount.id,
          objectId,
          kind: "payroll_tax_deposit",
          state: "approval_required",
          amountCents: liabilityCents,
          currency,
          data: {
            payrollRunId,
            period,
            liabilityIds: liabilities.map((liability) => liability.id),
            externalExecution: "blocked",
            moneyMovement: "blocked",
          },
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: paymentInstructions.id });

    const [filingDraft] = await tx
      .insert(filingDrafts)
      .values({
        tenantId: operator.tenantId,
        requirementId: filingRequirement.id,
        obligationId: payrollObligation?.id,
        state: "source_review",
        periodStart: payrollRun.periodStart,
        periodEnd: payrollRun.periodEnd,
        data: {
          payrollRunId,
          period,
          statementIds,
          liabilityIds: liabilities.map((liability) => liability.id),
          source: "payroll.preview.packet.prepare",
          validation: "not_submittable",
          externalExecution: "blocked",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: filingDrafts.id });

    const payStatementDocumentIds = payStatementDocuments.map((document) => document.id);
    const paymentInstructionIds = paymentDrafts.map((draft) => draft.id);
    const sourceEvidenceIds = sourceEvidence.map((item) => item.id);
    const packetDocumentIds = [varianceDocument.id, ...payStatementDocumentIds];
    const packetData: JsonObject = {
      ...jsonObject(input.data),
      payrollRunId,
      period,
      totals,
      varianceDocumentId: varianceDocument.id,
      payStatementDocumentIds,
      paymentInstructionIds,
      filingDraftId: filingDraft.id,
      statementIds,
      lineIds: lines.map((line) => line.id),
      liabilityIds: liabilities.map((liability) => liability.id),
      traceIds: traces.map((trace) => trace.id),
      sourceEvidenceIds,
      sections: {
        order: ["summary", "variance", "pay_statements", "funding", "tax_drafts", "approval"],
      },
      externalExecution: "blocked",
      moneyMovement: "blocked",
      submission: "blocked",
    };
    const [packetDocument] = await tx
      .insert(documents)
      .values({
        tenantId: operator.tenantId,
        objectId,
        kind: "payroll_packet",
        name: "Payroll preview approval packet",
        state: "approval_required",
        sensitivity: "high",
        hash: `${payrollSource}:${payrollRunId}:${input.idempotencyKey}:packet_document`,
        data: packetData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: operator.tenantId,
        documentId: packetDocument.id,
        objectId,
        kind: "payroll_packet",
        name: "Payroll preview approval packet",
        state: "approval_required",
        sensitivity: "high",
        evidenceIds: { ids: sourceEvidenceIds },
        documentIds: { ids: packetDocumentIds },
        data: packetData,
        hash: `${payrollSource}:${payrollRunId}:${input.idempotencyKey}:packet`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "payroll.preview.packet.prepared",
        source: payrollSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId,
        idempotencyKey: `${input.idempotencyKey}:payroll_preview_packet_prepared`,
        data: {
          ...packetData,
          packetId: packet.id,
          packetDocumentId: packetDocument.id,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "payroll.preview.packet.prepared",
        source: payrollSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "evidence_packet",
        targetId: packet.id,
        eventId: event.id,
        objectId,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:payroll_preview_packet_prepared`,
        data: {
          packetId: packet.id,
          packetDocumentId: packetDocument.id,
          ...packetData,
        },
      })
      .returning({ id: auditEvents.id });
    const [packetEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: "Payroll preview packet trace",
        objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${payrollSource}:${packet.id}:packet:${now.toISOString()}`,
        data: {
          packetId: packet.id,
          packetDocumentId: packetDocument.id,
          auditEventId: audit.id,
          ...packetData,
        },
      })
      .returning({ id: evidence.id });
    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: operator.tenantId,
        eventId: event.id,
        objectId,
        requesterType: "user",
        requesterId: operator.userId,
        requesterRef: operator.actorRef,
        reviewerUserId: reviewer.id,
        kind: "payroll_preview_approval",
        state: "pending",
        priority: "high",
        risk: "high",
        title: "Approve payroll preview packet",
        summary: "Review payroll preview, funding draft, tax deposit draft, and filing handoff before any external execution.",
        requestedAction: {
          action: "approve_payroll_preview",
          payrollRunId,
          packetId: packet.id,
          paymentInstructionIds,
          filingDraftId: filingDraft.id,
          externalExecution: "blocked",
          moneyMovement: "blocked",
        },
        evidence: {
          packetId: packet.id,
          packetEvidenceId: packetEvidence.id,
          documentIds: packetDocumentIds,
          paymentInstructionIds,
          filingDraftId: filingDraft.id,
          eventId: event.id,
        },
        policy: {
          approvalRequired: true,
          dualControl: true,
          externalExecution: "blocked",
          moneyMovement: "blocked",
          submission: "blocked",
        },
        data: {
          payrollRunId,
          packetId: packet.id,
          totals,
          externalExecution: "blocked",
        },
        dueAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });
    const [approvalAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "approval.requested",
        source: payrollSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "approval_request",
        targetId: approval.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:payroll_preview_approval_requested`,
        data: {
          approvalRequestId: approval.id,
          packetId: packet.id,
          payrollRunId,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [approvalEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "approval",
        name: "Payroll preview approval requested",
        objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${payrollSource}:${approval.id}:approval:${now.toISOString()}`,
        data: {
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
          packetId: packet.id,
          payrollRunId,
          externalExecution: "blocked",
        },
      })
      .returning({ id: evidence.id });

    const completedPacketData: JsonObject = {
      ...packetData,
      packetId: packet.id,
      packetDocumentId: packetDocument.id,
      approvalRequestId: approval.id,
      approvalEvidenceId: approvalEvidence.id,
      packetEvidenceId: packetEvidence.id,
    };
    const completedEvidenceIds = [...sourceEvidenceIds, packetEvidence.id, approvalEvidence.id];

    await Promise.all([
      tx
        .update(evidencePackets)
        .set({
          data: completedPacketData,
          evidenceIds: { ids: completedEvidenceIds },
          updatedAt: now,
        })
        .where(eq(evidencePackets.id, packet.id)),
      tx
        .update(documents)
        .set({ data: completedPacketData, updatedAt: now })
        .where(eq(documents.id, packetDocument.id)),
      tx
        .update(approvalRequests)
        .set({
          evidence: {
            packetId: packet.id,
            packetEvidenceId: packetEvidence.id,
            approvalEvidenceId: approvalEvidence.id,
            auditEventId: approvalAudit.id,
            documentIds: packetDocumentIds,
            paymentInstructionIds,
            filingDraftId: filingDraft.id,
            eventId: event.id,
          },
          updatedAt: now,
        })
        .where(eq(approvalRequests.id, approval.id)),
    ]);

    return {
      prepared: true,
      payrollRunId,
      packetId: packet.id,
      packetDocumentId: packetDocument.id,
      varianceDocumentId: varianceDocument.id,
      payStatementDocumentIds,
      paymentInstructionIds,
      filingDraftId: filingDraft.id,
      approvalRequestId: approval.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: packetEvidence.id,
      totals,
      externalExecution: "blocked",
    };
  });
}
