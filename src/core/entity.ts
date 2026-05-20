import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  bankAccounts,
  documents,
  entityIdentifiers,
  events,
  evidence,
  evidencePackets,
  legalEntities,
  locations,
  objects,
  paymentInstructions,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext, type OperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type EntitySetupObjectInput = {
  id?: string;
  objectId?: string;
  externalId?: string;
  name: string;
  type: string;
  state: string;
  data: JsonObject;
  effectiveAt?: Date;
  endedAt?: Date;
};

type ParsedLegalEntity = {
  id?: string;
  objectId?: string;
  externalId?: string;
  legalName: string;
  entityType: string;
  jurisdiction: string;
  state: string;
  data: JsonObject;
  effectiveAt?: Date;
};

type ParsedIdentifier = {
  kind: string;
  value: string;
  issuer?: string;
  jurisdiction?: string;
  status?: string;
  data: JsonObject;
  effectiveAt?: Date;
  endedAt?: Date;
};

type ParsedLocation = {
  id?: string;
  objectId?: string;
  externalId?: string;
  kind: string;
  name: string;
  state: string;
  jurisdiction?: string;
  country: string;
  data: JsonObject;
  effectiveAt?: Date;
  endedAt?: Date;
};

type ParsedBankAccount = {
  id?: string;
  name: string;
  purpose: string;
  state: string;
  data: JsonObject;
};

type ParsedPaymentInstruction = {
  bankAccountId?: string;
  objectId?: string;
  kind: string;
  state: string;
  amountCents?: number;
  currency: string;
  data: JsonObject;
};

export type CoreEntitySetupRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  legalEntity?: unknown;
  identifiers?: unknown;
  locations?: unknown;
  bankAccount?: unknown;
  bankAccounts?: unknown;
  paymentInstruction?: unknown;
  paymentInstructions?: unknown;
  workflow?: unknown;
  packet?: unknown;
  db?: Database;
};

export type CoreEntitySetupRecordResult = {
  created: boolean;
  legalEntityId: string;
  objectId: string;
  identifierIds: string[];
  locationIds: string[];
  bankAccountIds: string[];
  paymentInstructionIds: string[];
  workflowRunId: string;
  workflowStepId: string;
  documentId: string;
  packetId: string;
  eventId: string;
  evidenceId: string;
  auditEventId: string;
  state: string;
  completeness: number;
  externalExecution: "blocked";
  moneyMovement: "blocked";
};

const source = "continuous.core.entity_setup";
const credentialRefKeys = new Set([
  "credentialref",
  "secretref",
  "tokenref",
  "vaultref",
  "managedref",
  "accountref",
]);
const rawSecretKeys = new Set([
  "password",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "clientsecret",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "accountnumber",
  "routingnumber",
  "wireroutingnumber",
  "cardnumber",
  "pan",
  "iban",
  "swift",
  "sortcode",
]);
const riskLevels = new Set(["low", "medium", "high", "critical"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const string = cleanString(value);

  if (!string) {
    throw new PlatformUnavailableError(
      "entity_setup_field_required",
      `${field} is required.`,
      400,
    );
  }

  return string;
}

function optionalUuid(value: unknown, field: string) {
  const string = cleanString(value);

  if (!string) {
    return undefined;
  }

  if (!uuidPattern.test(string)) {
    throw new PlatformUnavailableError(
      "entity_setup_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return string;
}

function optionalDate(value: unknown, field: string) {
  const string = cleanString(value);

  if (!string) {
    return undefined;
  }

  const date = new Date(string);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError(
      "entity_setup_date_invalid",
      `${field} must be an ISO date string.`,
      400,
    );
  }

  return date;
}

function normalizedKey(key: string) {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

function assertNoRawSecretFields(value: unknown, field: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSecretFields(item, `${field}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = normalizedKey(key);

    if (!credentialRefKeys.has(safeKey) && rawSecretKeys.has(safeKey)) {
      throw new PlatformUnavailableError(
        "entity_setup_secret_material_rejected",
        `${field}.${key} must be stored as a managed credential reference or masked value, not raw secret material.`,
        400,
      );
    }

    assertNoRawSecretFields(nested, `${field}.${key}`);
  }
}

function objectArray(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return [] as Record<string, unknown>[];
  }

  if (!Array.isArray(value)) {
    throw new PlatformUnavailableError(
      "entity_setup_field_invalid",
      `${field} must be an array when provided.`,
      400,
    );
  }

  return value.map((item, index) => {
    const object = objectValue(item);

    if (Object.keys(object).length === 0) {
      throw new PlatformUnavailableError(
        "entity_setup_field_invalid",
        `${field}[${index}] must be an object.`,
        400,
      );
    }

    return object;
  });
}

function optionalObjectArray(single: unknown, list: unknown, field: string) {
  const items = objectArray(list, `${field}s`);
  const singleObject = objectValue(single);

  if (Object.keys(singleObject).length > 0) {
    return [singleObject, ...items];
  }

  return items;
}

function currencyCode(value: unknown) {
  const string = cleanString(value) ?? "USD";
  const currency = string.toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PlatformUnavailableError(
      "entity_setup_currency_invalid",
      "config.paymentInstruction.currency must be a 3-letter currency code.",
      400,
    );
  }

  return currency;
}

function optionalAmountCents(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PlatformUnavailableError(
      "entity_setup_amount_invalid",
      "config.paymentInstruction.amountCents must be a non-negative integer when provided.",
      400,
    );
  }

  return value;
}

function riskValue(value: unknown, field: string) {
  const risk = cleanString(value) ?? "medium";

  if (!riskLevels.has(risk)) {
    throw new PlatformUnavailableError(
      "entity_setup_risk_invalid",
      `${field} must be low, medium, high, or critical.`,
      400,
    );
  }

  return risk as "low" | "medium" | "high" | "critical";
}

function parseLegalEntity(value: unknown): ParsedLegalEntity {
  const entity = objectValue(value);

  if (Object.keys(entity).length === 0) {
    throw new PlatformUnavailableError(
      "entity_setup_legal_entity_required",
      "config.legalEntity is required.",
      400,
    );
  }

  return {
    id: optionalUuid(entity.id ?? entity.legalEntityId, "config.legalEntity.id"),
    objectId: optionalUuid(entity.objectId, "config.legalEntity.objectId"),
    externalId: cleanString(entity.externalId),
    legalName: requiredString(entity.legalName ?? entity.name, "config.legalEntity.legalName"),
    entityType: requiredString(entity.entityType ?? entity.type ?? entity.kind, "config.legalEntity.entityType"),
    jurisdiction: requiredString(entity.jurisdiction, "config.legalEntity.jurisdiction"),
    state: cleanString(entity.state ?? entity.status) ?? "active",
    data: jsonObject(entity.data),
    effectiveAt: optionalDate(entity.effectiveAt ?? entity.formationDate, "config.legalEntity.effectiveAt"),
  };
}

function parseIdentifier(value: Record<string, unknown>, index: number): ParsedIdentifier {
  return {
    kind: requiredString(value.kind ?? value.type, `config.identifiers[${index}].kind`),
    value: requiredString(value.value, `config.identifiers[${index}].value`),
    issuer: cleanString(value.issuer),
    jurisdiction: cleanString(value.jurisdiction),
    status: cleanString(value.state ?? value.status),
    data: jsonObject(value.data),
    effectiveAt: optionalDate(value.effectiveAt, `config.identifiers[${index}].effectiveAt`),
    endedAt: optionalDate(value.endedAt, `config.identifiers[${index}].endedAt`),
  };
}

function parseLocation(value: Record<string, unknown>, index: number): ParsedLocation {
  const kind = cleanString(value.kind ?? value.type) ?? "work";
  const country = (cleanString(value.country) ?? "US").toUpperCase();

  if (!/^[A-Z]{2}$/.test(country)) {
    throw new PlatformUnavailableError(
      "entity_setup_country_invalid",
      `config.locations[${index}].country must be a 2-letter country code.`,
      400,
    );
  }

  return {
    id: optionalUuid(value.id ?? value.locationId, `config.locations[${index}].id`),
    objectId: optionalUuid(value.objectId, `config.locations[${index}].objectId`),
    externalId: cleanString(value.externalId),
    kind,
    name: requiredString(value.name, `config.locations[${index}].name`),
    state: cleanString(value.state ?? value.status) ?? "active",
    jurisdiction: cleanString(value.jurisdiction ?? value.region ?? value.stateCode),
    country,
    data: jsonObject(value.data),
    effectiveAt: optionalDate(value.effectiveAt, `config.locations[${index}].effectiveAt`),
    endedAt: optionalDate(value.endedAt, `config.locations[${index}].endedAt`),
  };
}

function parseBankAccount(value: Record<string, unknown>, index: number): ParsedBankAccount {
  assertNoRawSecretFields(value, index === 0 ? "config.bankAccount" : `config.bankAccounts[${index}]`);

  return {
    id: optionalUuid(value.id ?? value.bankAccountId, `config.bankAccounts[${index}].id`),
    name: requiredString(value.name, `config.bankAccounts[${index}].name`),
    purpose: cleanString(value.purpose ?? value.type ?? value.kind) ?? "operating",
    state: cleanString(value.state ?? value.status) ?? "draft",
    data: jsonObject(value.data),
  };
}

function parsePaymentInstruction(
  value: Record<string, unknown>,
  index: number,
): ParsedPaymentInstruction {
  assertNoRawSecretFields(
    value,
    index === 0 ? "config.paymentInstruction" : `config.paymentInstructions[${index}]`,
  );

  return {
    bankAccountId: optionalUuid(value.bankAccountId, `config.paymentInstructions[${index}].bankAccountId`),
    objectId: optionalUuid(value.objectId, `config.paymentInstructions[${index}].objectId`),
    kind: requiredString(value.kind ?? value.type ?? value.method, `config.paymentInstructions[${index}].kind`),
    state: cleanString(value.state ?? value.status) ?? "draft",
    amountCents: optionalAmountCents(value.amountCents),
    currency: currencyCode(value.currency),
    data: jsonObject(value.data),
  };
}

function toIso(value?: Date) {
  return value?.toISOString() ?? null;
}

function normalizedLegalEntity(entity: ParsedLegalEntity): JsonObject {
  return {
    id: entity.id ?? null,
    objectId: entity.objectId ?? null,
    externalId: entity.externalId ?? null,
    legalName: entity.legalName,
    entityType: entity.entityType,
    jurisdiction: entity.jurisdiction,
    state: entity.state,
    data: entity.data,
    effectiveAt: toIso(entity.effectiveAt),
  };
}

function normalizedIdentifier(identifier: ParsedIdentifier): JsonObject {
  return {
    kind: identifier.kind,
    value: identifier.value,
    issuer: identifier.issuer ?? null,
    jurisdiction: identifier.jurisdiction ?? null,
    status: identifier.status ?? null,
    data: identifier.data,
    effectiveAt: toIso(identifier.effectiveAt),
    endedAt: toIso(identifier.endedAt),
  };
}

function normalizedLocation(location: ParsedLocation): JsonObject {
  return {
    id: location.id ?? null,
    objectId: location.objectId ?? null,
    externalId: location.externalId ?? null,
    kind: location.kind,
    name: location.name,
    state: location.state,
    jurisdiction: location.jurisdiction ?? null,
    country: location.country,
    data: location.data,
    effectiveAt: toIso(location.effectiveAt),
    endedAt: toIso(location.endedAt),
  };
}

function normalizedBankAccount(bankAccount: ParsedBankAccount): JsonObject {
  return {
    id: bankAccount.id ?? null,
    name: bankAccount.name,
    purpose: bankAccount.purpose,
    state: bankAccount.state,
    data: bankAccount.data,
  };
}

function normalizedPaymentInstruction(paymentInstruction: ParsedPaymentInstruction): JsonObject {
  return {
    bankAccountId: paymentInstruction.bankAccountId ?? null,
    objectId: paymentInstruction.objectId ?? null,
    kind: paymentInstruction.kind,
    state: paymentInstruction.state,
    amountCents: paymentInstruction.amountCents ?? null,
    currency: paymentInstruction.currency,
    data: paymentInstruction.data,
  };
}

function locationObjectType(kind: string) {
  return kind.includes("work") ? "work_location" : "location";
}

async function upsertSetupObject(
  tx: Transaction,
  operator: OperatorContext,
  input: EntitySetupObjectInput,
) {
  const objectId = optionalUuid(input.objectId, "config.objectId");
  let existing = null as typeof objects.$inferSelect | null;

  if (objectId) {
    const [row] = await tx
      .select()
      .from(objects)
      .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
      .limit(1);
    existing = row ?? null;

    if (!existing) {
      throw new PlatformUnavailableError(
        "entity_setup_object_not_found",
        "Referenced object does not exist in this tenant.",
        404,
      );
    }
  }

  if (input.externalId) {
    const [row] = await tx
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, operator.tenantId),
          eq(objects.source, source),
          eq(objects.externalId, input.externalId),
        ),
      )
      .limit(1);

    if (row && existing && row.id !== existing.id) {
      throw new PlatformUnavailableError(
        "entity_setup_object_conflict",
        "objectId and externalId refer to different Core objects.",
        409,
      );
    }

    existing = existing ?? row ?? null;
  }

  const now = new Date();
  const data = {
    ...input.data,
    entitySetup: true,
    externalExecution: "blocked",
  };
  const [row] = existing
    ? await tx
        .update(objects)
        .set({
          type: input.type,
          name: input.name,
          state: input.state,
          source,
          externalId: input.externalId,
          data,
          effectiveAt: input.effectiveAt,
          archivedAt: input.endedAt,
          updatedAt: now,
        })
        .where(eq(objects.id, existing.id))
        .returning()
    : await tx
        .insert(objects)
        .values({
          tenantId: operator.tenantId,
          type: input.type,
          name: input.name,
          state: input.state,
          source,
          externalId: input.externalId,
          data,
          createdByUserId: operator.userId,
          effectiveAt: input.effectiveAt,
          archivedAt: input.endedAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

  return row;
}

async function upsertLegalEntity(
  tx: Transaction,
  operator: OperatorContext,
  input: ParsedLegalEntity,
) {
  const object = await upsertSetupObject(tx, operator, {
    objectId: input.objectId,
    externalId: input.externalId,
    type: "legal_entity",
    name: input.legalName,
    state: input.state,
    data: {
      ...input.data,
      entityType: input.entityType,
      jurisdiction: input.jurisdiction,
    },
    effectiveAt: input.effectiveAt,
  });
  let existing = null as typeof legalEntities.$inferSelect | null;

  if (input.id) {
    const [row] = await tx
      .select()
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, operator.tenantId), eq(legalEntities.id, input.id)))
      .limit(1);
    existing = row ?? null;

    if (!existing) {
      throw new PlatformUnavailableError(
        "entity_setup_legal_entity_not_found",
        "config.legalEntity.id does not match a legal entity in this tenant.",
        404,
      );
    }
  }

  const [objectEntity] = await tx
    .select()
    .from(legalEntities)
    .where(and(eq(legalEntities.tenantId, operator.tenantId), eq(legalEntities.objectId, object.id)))
    .limit(1);

  if (objectEntity && existing && objectEntity.id !== existing.id) {
    throw new PlatformUnavailableError(
      "entity_setup_legal_entity_conflict",
      "config.legalEntity.id and objectId refer to different legal entities.",
      409,
    );
  }

  existing = existing ?? objectEntity ?? null;

  const now = new Date();
  const [entity] = existing
    ? await tx
        .update(legalEntities)
        .set({
          objectId: object.id,
          legalName: input.legalName,
          entityType: input.entityType,
          jurisdiction: input.jurisdiction,
          state: input.state,
          data: input.data,
          effectiveAt: input.effectiveAt,
          updatedAt: now,
        })
        .where(eq(legalEntities.id, existing.id))
        .returning()
    : await tx
        .insert(legalEntities)
        .values({
          tenantId: operator.tenantId,
          objectId: object.id,
          legalName: input.legalName,
          entityType: input.entityType,
          jurisdiction: input.jurisdiction,
          state: input.state,
          data: input.data,
          effectiveAt: input.effectiveAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

  return { entity, object };
}

async function upsertIdentifier(
  tx: Transaction,
  operator: OperatorContext,
  legalEntityId: string,
  input: ParsedIdentifier,
) {
  const [existing] = await tx
    .select()
    .from(entityIdentifiers)
    .where(
      and(
        eq(entityIdentifiers.tenantId, operator.tenantId),
        eq(entityIdentifiers.legalEntityId, legalEntityId),
        eq(entityIdentifiers.kind, input.kind),
        eq(entityIdentifiers.value, input.value),
      ),
    )
    .limit(1);

  if (existing) {
    return existing.id;
  }

  const [identifier] = await tx
    .insert(entityIdentifiers)
    .values({
      tenantId: operator.tenantId,
      legalEntityId,
      kind: input.kind,
      value: input.value,
      issuer: input.issuer,
      data: {
        ...input.data,
        jurisdiction: input.jurisdiction ?? null,
        status: input.status ?? null,
      },
      effectiveAt: input.effectiveAt,
      endedAt: input.endedAt,
    })
    .returning({ id: entityIdentifiers.id });

  return identifier.id;
}

async function upsertLocation(
  tx: Transaction,
  operator: OperatorContext,
  legalEntityId: string,
  input: ParsedLocation,
) {
  const object = await upsertSetupObject(tx, operator, {
    objectId: input.objectId,
    externalId: input.externalId,
    type: locationObjectType(input.kind),
    name: input.name,
    state: input.state,
    data: {
      ...input.data,
      kind: input.kind,
      jurisdiction: input.jurisdiction ?? null,
      country: input.country,
    },
    effectiveAt: input.effectiveAt,
    endedAt: input.endedAt,
  });
  let existing = null as typeof locations.$inferSelect | null;

  if (input.id) {
    const [row] = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, operator.tenantId), eq(locations.id, input.id)))
      .limit(1);
    existing = row ?? null;

    if (!existing) {
      throw new PlatformUnavailableError(
        "entity_setup_location_not_found",
        "config.locations[].id does not match a location in this tenant.",
        404,
      );
    }
  }

  const [objectLocation] = await tx
    .select()
    .from(locations)
    .where(and(eq(locations.tenantId, operator.tenantId), eq(locations.objectId, object.id)))
    .limit(1);

  if (objectLocation && existing && objectLocation.id !== existing.id) {
    throw new PlatformUnavailableError(
      "entity_setup_location_conflict",
      "config.locations[].id and objectId refer to different locations.",
      409,
    );
  }

  existing = existing ?? objectLocation ?? null;

  const now = new Date();
  const [location] = existing
    ? await tx
        .update(locations)
        .set({
          legalEntityId,
          objectId: object.id,
          kind: input.kind,
          name: input.name,
          state: input.state,
          jurisdiction: input.jurisdiction,
          country: input.country,
          data: input.data,
          effectiveAt: input.effectiveAt,
          endedAt: input.endedAt,
          updatedAt: now,
        })
        .where(eq(locations.id, existing.id))
        .returning()
    : await tx
        .insert(locations)
        .values({
          tenantId: operator.tenantId,
          legalEntityId,
          objectId: object.id,
          kind: input.kind,
          name: input.name,
          state: input.state,
          jurisdiction: input.jurisdiction,
          country: input.country,
          data: input.data,
          effectiveAt: input.effectiveAt,
          endedAt: input.endedAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

  return location.id;
}

async function upsertBankAccount(
  tx: Transaction,
  operator: OperatorContext,
  legalEntityId: string,
  input: ParsedBankAccount,
) {
  let existing = null as typeof bankAccounts.$inferSelect | null;

  if (input.id) {
    const [row] = await tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.tenantId, operator.tenantId), eq(bankAccounts.id, input.id)))
      .limit(1);
    existing = row ?? null;

    if (!existing) {
      throw new PlatformUnavailableError(
        "entity_setup_bank_account_not_found",
        "config.bankAccounts[].id does not match a bank account in this tenant.",
        404,
      );
    }
  }

  const [named] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, operator.tenantId), eq(bankAccounts.name, input.name)))
    .limit(1);

  if (named && existing && named.id !== existing.id) {
    throw new PlatformUnavailableError(
      "entity_setup_bank_account_conflict",
      "config.bankAccounts[].id and name refer to different bank accounts.",
      409,
    );
  }

  existing = existing ?? named ?? null;

  if (existing?.legalEntityId && existing.legalEntityId !== legalEntityId) {
    throw new PlatformUnavailableError(
      "entity_setup_bank_account_conflict",
      "Bank account belongs to a different legal entity.",
      409,
    );
  }

  const now = new Date();
  const data = {
    ...input.data,
    externalExecution: "blocked",
    moneyMovement: "blocked",
  };
  const [bankAccount] = existing
    ? await tx
        .update(bankAccounts)
        .set({
          legalEntityId,
          name: input.name,
          purpose: input.purpose,
          state: input.state,
          data,
          updatedAt: now,
        })
        .where(eq(bankAccounts.id, existing.id))
        .returning({ id: bankAccounts.id })
    : await tx
        .insert(bankAccounts)
        .values({
          tenantId: operator.tenantId,
          legalEntityId,
          name: input.name,
          purpose: input.purpose,
          state: input.state,
          data,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: bankAccounts.id });

  return bankAccount.id;
}

async function insertPaymentInstruction(
  tx: Transaction,
  operator: OperatorContext,
  fallbackBankAccountId: string | undefined,
  fallbackObjectId: string,
  input: ParsedPaymentInstruction,
) {
  const bankAccountId = input.bankAccountId ?? fallbackBankAccountId;

  if (!bankAccountId) {
    throw new PlatformUnavailableError(
      "entity_setup_bank_account_required",
      "config.paymentInstruction requires a bankAccountId or a bankAccount in the same command.",
      400,
    );
  }

  const [bankAccount] = await tx
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, operator.tenantId), eq(bankAccounts.id, bankAccountId)))
    .limit(1);

  if (!bankAccount) {
    throw new PlatformUnavailableError(
      "entity_setup_bank_account_not_found",
      "config.paymentInstruction.bankAccountId does not match a bank account in this tenant.",
      404,
    );
  }

  const objectId = input.objectId ?? fallbackObjectId;
  const [object] = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
    .limit(1);

  if (!object) {
    throw new PlatformUnavailableError(
      "entity_setup_object_not_found",
      "config.paymentInstruction.objectId does not match an object in this tenant.",
      404,
    );
  }

  const now = new Date();
  const [paymentInstruction] = await tx
    .insert(paymentInstructions)
    .values({
      tenantId: operator.tenantId,
      bankAccountId,
      objectId,
      kind: input.kind,
      state: input.state,
      amountCents: input.amountCents,
      currency: input.currency,
      data: {
        ...input.data,
        externalExecution: "blocked",
        moneyMovement: "blocked",
      },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: paymentInstructions.id });

  return paymentInstruction.id;
}

function workflowState(input: {
  requestedState?: string;
  identifiers: ParsedIdentifier[];
  locations: ParsedLocation[];
  bankAccounts: ParsedBankAccount[];
}) {
  if (input.requestedState) {
    return input.requestedState;
  }

  return input.identifiers.length > 0 && input.locations.length > 0 && input.bankAccounts.length > 0
    ? "review_ready"
    : "facts_required";
}

function setupCompleteness(input: {
  identifiers: ParsedIdentifier[];
  locations: ParsedLocation[];
  bankAccounts: ParsedBankAccount[];
}) {
  const checks = [true, input.identifiers.length > 0, input.locations.length > 0, input.bankAccounts.length > 0];
  return checks.filter(Boolean).length / checks.length;
}

function knownWorkflowState(definition: typeof workflowDefinitions.$inferSelect, state: string) {
  const states = objectValue(definition.states);
  const order = Array.isArray(states.order) ? states.order.filter((item) => typeof item === "string") : [];
  const transitions = objectValue(definition.transitions);
  const transitionStates = new Set<string>();

  for (const [from, value] of Object.entries(transitions)) {
    transitionStates.add(from);
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string") {
          transitionStates.add(item);
        }
      });
    }
  }

  return order.includes(state) || transitionStates.has(state);
}

function stringListFromAudit(data: JsonObject, key: string) {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringFromAudit(data: JsonObject, key: string) {
  return typeof data[key] === "string" ? data[key] : "";
}

export async function recordEntitySetup(
  input: CoreEntitySetupRecordInput,
): Promise<CoreEntitySetupRecordResult> {
  const db = input.db ?? defaultDb;
  const legalEntityInput = parseLegalEntity(input.legalEntity);
  const identifierInputs = objectArray(input.identifiers, "config.identifiers").map(parseIdentifier);
  const locationInputs = objectArray(input.locations, "config.locations").map(parseLocation);
  const bankAccountInputs = optionalObjectArray(input.bankAccount, input.bankAccounts, "config.bankAccount").map(
    parseBankAccount,
  );
  const paymentInstructionInputs = optionalObjectArray(
    input.paymentInstruction,
    input.paymentInstructions,
    "config.paymentInstruction",
  ).map(parsePaymentInstruction);
  const workflow = objectValue(input.workflow);
  const packet = objectValue(input.packet);
  const workflowKey = cleanString(workflow.key) ?? "entity_setup";

  if (workflowKey !== "entity_setup") {
    throw new PlatformUnavailableError(
      "entity_setup_workflow_invalid",
      "config.workflow.key must be entity_setup when provided.",
      400,
    );
  }

  const state = workflowState({
    requestedState: cleanString(workflow.state),
    identifiers: identifierInputs,
    locations: locationInputs,
    bankAccounts: bankAccountInputs,
  });
  const completeness = setupCompleteness({
    identifiers: identifierInputs,
    locations: locationInputs,
    bankAccounts: bankAccountInputs,
  });
  const packetKind = cleanString(packet.kind) ?? "entity_setup_packet";
  const packetName = cleanString(packet.name) ?? `${legalEntityInput.legalName} setup packet`;
  const packetState = cleanString(packet.state) ?? "prepared";
  const packetSensitivity = riskValue(packet.sensitivity, "config.packet.sensitivity");
  const idempotency = coreIdempotencyFingerprint("entity.setup.record", {
    legalEntity: normalizedLegalEntity(legalEntityInput),
    identifiers: identifierInputs.map(normalizedIdentifier),
    locations: locationInputs.map(normalizedLocation),
    bankAccounts: bankAccountInputs.map(normalizedBankAccount),
    paymentInstructions: paymentInstructionInputs.map(normalizedPaymentInstruction),
    workflow: {
      key: workflowKey,
      state,
      data: jsonObject(workflow.data),
      blockers: jsonObject(workflow.blockers),
      metrics: jsonObject(workflow.metrics),
    },
    packet: {
      kind: packetKind,
      name: packetName,
      state: packetState,
      sensitivity: packetSensitivity,
      data: jsonObject(packet.data),
    },
  });
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        eventId: auditEvents.eventId,
        data: auditEvents.data,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:entity_setup_recorded`),
          eq(auditEvents.targetType, "legal_entity"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "entity.setup.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const data = jsonObject(existingAudit.data);

      return {
        created: false,
        legalEntityId: existingAudit.targetId,
        objectId: stringFromAudit(data, "objectId"),
        identifierIds: stringListFromAudit(data, "identifierIds"),
        locationIds: stringListFromAudit(data, "locationIds"),
        bankAccountIds: stringListFromAudit(data, "bankAccountIds"),
        paymentInstructionIds: stringListFromAudit(data, "paymentInstructionIds"),
        workflowRunId: stringFromAudit(data, "workflowRunId"),
        workflowStepId: stringFromAudit(data, "workflowStepId"),
        documentId: stringFromAudit(data, "documentId"),
        packetId: stringFromAudit(data, "packetId"),
        eventId: existingAudit.eventId ?? "",
        evidenceId: stringFromAudit(data, "evidenceId"),
        auditEventId: existingAudit.auditEventId,
        state: stringFromAudit(data, "state") || state,
        completeness:
          typeof data.completeness === "number" ? data.completeness : Number(completeness.toFixed(2)),
        externalExecution: "blocked",
        moneyMovement: "blocked",
      };
    }

    const [definition] = await tx
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, workflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(workflowDefinitions.version)
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "entity_setup_workflow_not_found",
        "No active entity_setup workflow definition exists.",
        404,
      );
    }

    if (!knownWorkflowState(definition, state)) {
      throw new PlatformUnavailableError(
        "entity_setup_workflow_state_unknown",
        `Workflow definition entity_setup does not define state ${state}.`,
        400,
      );
    }

    const { entity, object } = await upsertLegalEntity(tx, operator, legalEntityInput);
    const identifierIds = [] as string[];
    const locationIds = [] as string[];
    const bankAccountIds = [] as string[];
    const paymentInstructionIds = [] as string[];

    for (const identifier of identifierInputs) {
      identifierIds.push(await upsertIdentifier(tx, operator, entity.id, identifier));
    }

    for (const location of locationInputs) {
      locationIds.push(await upsertLocation(tx, operator, entity.id, location));
    }

    for (const bankAccount of bankAccountInputs) {
      bankAccountIds.push(await upsertBankAccount(tx, operator, entity.id, bankAccount));
    }

    for (const paymentInstruction of paymentInstructionInputs) {
      paymentInstructionIds.push(
        await insertPaymentInstruction(tx, operator, bankAccountIds[0], object.id, paymentInstruction),
      );
    }

    const now = new Date();
    const runData = {
      ...jsonObject(workflow.data),
      legalEntityId: entity.id,
      objectId: object.id,
      identifierIds,
      locationIds,
      bankAccountIds,
      paymentInstructionIds,
      setupCompleteness: Number(completeness.toFixed(2)),
      facts: {
        legalEntity: true,
        identifiers: identifierIds.length,
        locations: locationIds.length,
        bankAccounts: bankAccountIds.length,
        paymentInstructions: paymentInstructionIds.length,
      },
      externalExecution: "blocked",
      moneyMovement: "blocked",
    };
    const [run] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: operator.tenantId,
        definitionId: definition.id,
        objectId: object.id,
        state,
        idempotencyKey: `${input.idempotencyKey}:entity_setup`,
        data: runData,
        blockers: jsonObject(workflow.blockers),
        metrics: {
          ...jsonObject(workflow.metrics),
          completeness: Number(completeness.toFixed(2)),
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "entity.setup.recorded",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        idempotencyKey: `${input.idempotencyKey}:entity_setup_recorded`,
        data: {
          legalEntityId: entity.id,
          objectId: object.id,
          workflowRunId: run.id,
          identifierIds,
          locationIds,
          bankAccountIds,
          paymentInstructionIds,
          state,
          completeness: Number(completeness.toFixed(2)),
          externalExecution: "blocked",
          moneyMovement: "blocked",
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const packetData = {
      ...jsonObject(packet.data),
      legalEntityId: entity.id,
      objectId: object.id,
      workflowRunId: run.id,
      identifierIds,
      locationIds,
      bankAccountIds,
      paymentInstructionIds,
      state,
      completeness: Number(completeness.toFixed(2)),
      sections: {
        legalEntity: normalizedLegalEntity(legalEntityInput),
        identifiers: identifierInputs.map(normalizedIdentifier),
        locations: locationInputs.map(normalizedLocation),
        bankAccounts: bankAccountInputs.map((account) => ({
          name: account.name,
          purpose: account.purpose,
          state: account.state,
        })),
        paymentInstructions: paymentInstructionInputs.map((instruction) => ({
          kind: instruction.kind,
          state: instruction.state,
          amountCents: instruction.amountCents ?? null,
          currency: instruction.currency,
        })),
      },
      externalExecution: "blocked",
      moneyMovement: "blocked",
    };
    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        workflowRunId: run.id,
        kind: packetKind,
        name: packetName,
        state: packetState,
        sensitivity: packetSensitivity,
        data: packetData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [packetRow] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: operator.tenantId,
        documentId: document.id,
        objectId: object.id,
        workflowRunId: run.id,
        eventId: event.id,
        kind: packetKind,
        name: packetName,
        state: packetState,
        sensitivity: packetSensitivity,
        evidenceIds: { ids: [] },
        documentIds: { ids: [document.id] },
        data: packetData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
    const [step] = await tx
      .insert(workflowSteps)
      .values({
        tenantId: operator.tenantId,
        definitionId: definition.id,
        workflowRunId: run.id,
        eventId: event.id,
        objectId: object.id,
        kind: "entity_setup_record",
        name: "Entity setup facts recorded",
        state: "done",
        priority: "normal",
        risk: bankAccountIds.length > 0 || paymentInstructionIds.length > 0 ? "high" : "medium",
        toState: state,
        attempt: 1,
        maxAttempts: 3,
        leaseOwner: operator.actorRef,
        leasedUntil: now,
        idempotencyKey: `${input.idempotencyKey}:entity_setup_recorded`,
        input: {
          legalEntity: normalizedLegalEntity(legalEntityInput),
          identifiers: identifierInputs.map(normalizedIdentifier),
          locations: locationInputs.map(normalizedLocation),
        },
        output: {
          legalEntityId: entity.id,
          objectId: object.id,
          identifierIds,
          locationIds,
          bankAccountIds,
          paymentInstructionIds,
          documentId: document.id,
          packetId: packetRow.id,
          state,
          completeness: Number(completeness.toFixed(2)),
        },
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });
    const [trace] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Entity setup recorded: ${legalEntityInput.legalName}`,
        objectId: object.id,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${entity.id}:${now.toISOString()}`,
        data: {
          legalEntityId: entity.id,
          objectId: object.id,
          workflowRunId: run.id,
          workflowStepId: step.id,
          documentId: document.id,
          packetId: packetRow.id,
          identifierIds,
          locationIds,
          bankAccountIds,
          paymentInstructionIds,
          idempotency,
          externalExecution: "blocked",
          moneyMovement: "blocked",
        },
        redaction: {
          bankAccountValues: "masked_or_managed_refs_only",
          rawCredentialValues: "rejected",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const auditData = {
      legalEntityId: entity.id,
      objectId: object.id,
      identifierIds,
      locationIds,
      bankAccountIds,
      paymentInstructionIds,
      workflowRunId: run.id,
      workflowStepId: step.id,
      documentId: document.id,
      packetId: packetRow.id,
      evidenceId: trace.id,
      state,
      completeness: Number(completeness.toFixed(2)),
      idempotency,
      externalExecution: "blocked",
      moneyMovement: "blocked",
    };
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "entity.setup.recorded",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "legal_entity",
        targetId: entity.id,
        eventId: event.id,
        objectId: object.id,
        risk: bankAccountIds.length > 0 || paymentInstructionIds.length > 0 ? "high" : "medium",
        idempotencyKey: `${input.idempotencyKey}:entity_setup_recorded`,
        data: auditData,
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      legalEntityId: entity.id,
      objectId: object.id,
      identifierIds,
      locationIds,
      bankAccountIds,
      paymentInstructionIds,
      workflowRunId: run.id,
      workflowStepId: step.id,
      documentId: document.id,
      packetId: packetRow.id,
      eventId: event.id,
      evidenceId: trace.id,
      auditEventId: audit.id,
      state,
      completeness: Number(completeness.toFixed(2)),
      externalExecution: "blocked",
      moneyMovement: "blocked",
    };
  });
}
