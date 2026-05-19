import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  employments,
  events,
  evidence,
  objects,
  payrollLiabilities,
  payrollLines,
  payrollRuns,
  payrollStatements,
  payrollTraces,
  people,
  type JsonObject,
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
