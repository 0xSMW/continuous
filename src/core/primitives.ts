import { and, eq, inArray, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapters,
  adapterActions,
  adapterRuns,
  auditEvents,
  capabilities,
  connections,
  customers,
  customerSignals,
  decisions,
  documents,
  events,
  evidence,
  evidencePackets,
  objects,
  objectLinks,
  objectVersions,
  rulePacks,
  tasks,
  uiContracts,
  workflowRuns,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext, type OperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryClient = Pick<Database, "execute" | "select">;
type ActorType = "user" | "worker" | "adapter" | "system";
type EvidenceKind = "snapshot" | "draft" | "approval" | "receipt" | "trace" | "export" | "note";
type RiskLevel = "low" | "medium" | "high" | "critical";
type CoreTaskState = "draft" | "active" | "waiting" | "approval_required" | "blocked" | "done" | "canceled";
type AdapterAuthMode = "none" | "oauth" | "oauth2" | "api_key" | "basic" | "bearer" | "managed_ref" | "custom";
type AdapterConnectionState = "draft" | "active" | "paused" | "error" | "archived";
type ConnectionHealthStatus = "ready" | "needs_configuration" | "paused" | "error" | "archived";
type ConnectionHealthCheckStatus = "pass" | "warn" | "fail" | "not_applicable";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorTypes = new Set<ActorType>(["user", "worker", "adapter", "system"]);
const evidenceKinds = new Set<EvidenceKind>([
  "snapshot",
  "draft",
  "approval",
  "receipt",
  "trace",
  "export",
  "note",
]);
const riskLevels = new Set<RiskLevel>(["low", "medium", "high", "critical"]);

const objectSource = "continuous.core.objects";
const eventSource = "continuous.core.events";
const evidenceSource = "continuous.core.evidence";
const documentSource = "continuous.core.documents";
const packetSource = "continuous.core.packets";
const decisionSource = "continuous.core.decisions";
const objectLinkSource = "continuous.core.object_links";
const customerSignalSource = "continuous.core.customer_signals";
const viewSource = "continuous.core.views";
const adapterIntentSource = "continuous.core.adapter_intents";
const ruleChangeSource = "continuous.core.rule_changes";
const adapterSource = "continuous.core.adapters";
const connectionSource = "continuous.core.connections";
const connectionHealthSource = "continuous.core.connection_health";
const customerSignalTypes = new Set([
  "satisfaction_signal",
  "feedback_item",
  "complaint",
  "testimonial",
  "review",
]);
const adapterConnectionStates = new Set<AdapterConnectionState>([
  "draft",
  "active",
  "paused",
  "error",
  "archived",
]);
const adapterAuthModes = new Set<AdapterAuthMode>([
  "none",
  "oauth",
  "oauth2",
  "api_key",
  "basic",
  "bearer",
  "managed_ref",
  "custom",
]);
const credentialRefKeys = new Set([
  "credentialref",
  "secretref",
  "tokenref",
  "vaultref",
  "accesstokenref",
  "refreshtokenref",
]);
const credentialRefPrefixes = [
  "env:",
  "vault:",
  "secret:",
  "ssm:",
  "doppler:",
  "op:",
  "onepassword:",
  "1password:",
  "aws-sm:",
  "gcp-sm:",
];

export type ActorInput = {
  type?: string;
  id?: string;
  ref?: string;
};

export type CoreObjectUpsertInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  objectId?: string;
  type: string;
  name: string;
  state?: string;
  source?: string;
  externalId?: string;
  data?: JsonObject;
  effectiveAt?: string;
  archivedAt?: string;
  reason?: string;
  version?: JsonObject;
  db?: Database;
};

export type CoreEventIngestInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  type: string;
  source?: string;
  actor?: ActorInput;
  objectId?: string;
  taskId?: string;
  capabilityId?: string;
  adapterId?: string;
  connectionId?: string;
  data?: JsonObject;
  occurredAt?: string;
  db?: Database;
};

export type CoreEvidenceAttachInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  actor?: ActorInput;
  objectId?: string;
  taskId?: string;
  eventId?: string;
  capabilityId?: string;
  uri?: string;
  hash?: string;
  data?: JsonObject;
  redaction?: JsonObject;
  retainedUntil?: string;
  db?: Database;
};

export type CoreDocumentCreateInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  state?: string;
  sensitivity?: string;
  objectId?: string;
  workflowRunId?: string;
  hash?: string;
  data?: JsonObject;
  retainedUntil?: string;
  db?: Database;
};

export type CorePacketPrepareInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  state?: string;
  sensitivity?: string;
  objectId?: string;
  taskId?: string;
  workflowRunId?: string;
  eventId?: string;
  capabilityId?: string;
  evidenceIds?: unknown;
  documentIds?: unknown;
  sections?: JsonObject;
  data?: JsonObject;
  hash?: string;
  retainedUntil?: string;
  db?: Database;
};

type CorePacketPrepareForOperatorInput = Omit<
  CorePacketPrepareInput,
  "operatorEmail" | "tenantSlug" | "db"
>;

export type CorePacketPrepareResult = {
  prepared: boolean;
  packetId: string;
  documentId: string | null;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
};

export type CoreDecisionRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  decision: string;
  rationale?: string;
  state?: string;
  actor?: ActorInput;
  taskId?: string;
  eventId?: string;
  workflowRunId?: string;
  capabilityId?: string;
  data?: JsonObject;
  db?: Database;
};

export type CoreObjectLinkInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  fromObjectId: string;
  toObjectId: string;
  type: string;
  data?: JsonObject;
  effectiveAt?: string;
  endedAt?: string;
  db?: Database;
};

export type CoreCustomerSignalRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  type: string;
  name: string;
  state?: string;
  source?: string;
  externalId?: string;
  customerObjectId?: string;
  relatedObjectId?: string;
  taskId?: string;
  eventId?: string;
  data?: JsonObject;
  occurredAt?: string;
  db?: Database;
};

export type CoreViewPublishInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  key: string;
  name: string;
  purpose: string;
  version?: string;
  surface?: string;
  capabilityId?: string;
  objectType?: string;
  taskState?: string;
  contract?: JsonObject;
  actions?: JsonObject;
  data?: JsonObject;
  mask?: JsonObject;
  active?: boolean;
  db?: Database;
};

export type CoreAdapterUpsertInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  adapterId?: string;
  key: string;
  name: string;
  kind: string;
  auth?: string;
  configSchema?: JsonObject;
  eventSchema?: JsonObject;
  capabilities?: JsonObject;
  active?: boolean;
  db?: Database;
};

export type CoreConnectionUpsertInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  connectionId?: string;
  adapterId?: string;
  adapterKey?: string;
  name: string;
  state?: string;
  externalAccountId?: string;
  scopes?: JsonObject;
  config?: JsonObject;
  lastSyncAt?: string;
  db?: Database;
};

export type CoreConnectionHealthRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  connectionId: string;
  checks?: unknown;
  observedAt?: string;
  db?: Database;
  env?: Record<string, string | undefined>;
};

export type CoreAdapterIntentRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  connectionId: string;
  operation: string;
  mode?: string;
  taskId?: string;
  eventId?: string;
  capabilityId?: string;
  request?: JsonObject;
  data?: JsonObject;
  maxAttempts?: unknown;
  db?: Database;
};

export type CoreRuleChangeRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  rulePackId?: string;
  ruleKey: string;
  changeType: string;
  title: string;
  summary?: string;
  state?: string;
  decision?: string;
  rationale?: string;
  taskId?: string;
  workflowRunId?: string;
  capabilityId?: string;
  sourceRefs?: JsonObject;
  before?: JsonObject;
  after?: JsonObject;
  impact?: JsonObject;
  data?: JsonObject;
  effectiveAt?: string;
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

function requiredStringMax(value: unknown, field: string, max: number) {
  const output = requiredString(value, field);

  if (output.length > max) {
    throw new PlatformUnavailableError(
      "core_field_too_long",
      `${field} must be ${max} characters or fewer.`,
      400,
    );
  }

  return output;
}

function optionalStringMax(value: unknown, field: string, max: number) {
  const output = cleanString(value);

  if (output && output.length > max) {
    throw new PlatformUnavailableError(
      "core_field_too_long",
      `${field} must be ${max} characters or fewer.`,
      400,
    );
  }

  return output;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError(
      "core_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return value;
}

function requiredUuid(value: unknown, field: string) {
  const uuid = optionalUuid(requiredString(value, field), field);

  if (!uuid) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return uuid;
}

function uuidList(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be an array of UUIDs.`, 400);
  }

  return value.map((item, index) => requiredUuid(item, `${field}[${index}]`));
}

function optionalDate(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("core_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function parseActor(actor: ActorInput | undefined, operator: OperatorContext) {
  const requestedType = cleanString(actor?.type);
  const type = requestedType && actorTypes.has(requestedType as ActorType)
    ? (requestedType as ActorType)
    : "user";

  if (requestedType && !actorTypes.has(requestedType as ActorType)) {
    throw new PlatformUnavailableError(
      "core_actor_type_invalid",
      "config.actor.type must be user, worker, adapter, or system.",
      400,
    );
  }

  const id =
    optionalUuid(cleanString(actor?.id), "config.actor.id") ??
    (type === "user" ? operator.userId : undefined);
  const ref = cleanString(actor?.ref) ?? (type === "user" ? operator.actorRef : type);

  return {
    type,
    id: type === "system" ? undefined : id,
    ref,
  };
}

function parseEvidenceKind(value: string) {
  if (evidenceKinds.has(value as EvidenceKind)) {
    return value as EvidenceKind;
  }

  throw new PlatformUnavailableError(
    "core_evidence_kind_invalid",
    "config.kind must be snapshot, draft, approval, receipt, trace, export, or note.",
    400,
  );
}

function parseRisk(value: string | undefined) {
  if (!value) {
    return "medium" as const;
  }

  if (riskLevels.has(value as RiskLevel)) {
    return value as RiskLevel;
  }

  throw new PlatformUnavailableError(
    "core_risk_invalid",
    "config.sensitivity must be low, medium, high, or critical.",
    400,
  );
}

function boundedInteger(value: unknown, field: string, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue < min || numericValue > max) {
    throw new PlatformUnavailableError(
      "core_integer_invalid",
      `${field} must be an integer between ${min} and ${max}.`,
      400,
    );
  }

  return numericValue;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    const output = cleanString(value);

    if (output) {
      return output;
    }
  }

  return undefined;
}

function parseAdapterConnectionState(value: string | undefined) {
  if (!value) {
    return "draft" as const;
  }

  if (adapterConnectionStates.has(value as AdapterConnectionState)) {
    return value as AdapterConnectionState;
  }

  throw new PlatformUnavailableError(
    "core_connection_state_invalid",
    "config.state must be draft, active, paused, error, or archived.",
    400,
  );
}

function parseAdapterAuthMode(value: unknown) {
  const raw = requiredStringMax(value, "config.auth", 80).toLowerCase();

  if (
    raw.includes(":") ||
    credentialRefLooksManaged(raw) ||
    !/^[a-z][a-z0-9_]*$/.test(raw) ||
    !adapterAuthModes.has(raw as AdapterAuthMode)
  ) {
    throw new PlatformUnavailableError(
      "core_adapter_auth_mode_invalid",
      "config.auth must be a non-secret adapter auth mode such as none, oauth, api_key, basic, bearer, or managed_ref. Store credentials on connection records with managed credential refs.",
      400,
    );
  }

  return raw as AdapterAuthMode;
}

function adapterAuthModeForOutput(value: string) {
  const mode = value.toLowerCase();

  return adapterAuthModes.has(mode as AdapterAuthMode) ? (mode as AdapterAuthMode) : "custom";
}

function isCredentialRefKey(key: string) {
  return credentialRefKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function credentialRefLooksManaged(value: string) {
  const normalized = value.toLowerCase();

  return credentialRefPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function assertManagedCredentialRef(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || !credentialRefLooksManaged(value.trim())) {
    throw new PlatformUnavailableError(
      "core_credential_reference_invalid",
      `${field} must reference a managed secret such as env:NAME, vault:NAME, or secret:NAME.`,
      400,
    );
  }
}

function assertNoInlineSecretMaterial(value: unknown, path = "config") {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecretMaterial(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const rawSecretKeys = new Set([
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "bearertoken",
    "authorization",
    "password",
    "secret",
    "clientsecret",
    "apikey",
    "privatekey",
    "token",
  ]);

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nestedPath = `${path}.${key}`;

    if (isCredentialRefKey(key)) {
      assertManagedCredentialRef(nestedValue, nestedPath);
      continue;
    }

    if (rawSecretKeys.has(normalizedKey)) {
      throw new PlatformUnavailableError(
        "core_inline_secret_blocked",
        `${nestedPath} must not contain credential material. Store secrets outside Continuous and pass a managed credential reference instead.`,
        400,
      );
    }

    assertNoInlineSecretMaterial(nestedValue, nestedPath);
  }
}

function pollConfigForConnection(config: JsonObject) {
  return jsonObject(config.polling ?? config.liveRead ?? config.apiRead);
}

function connectionUsesBufferedPolling(config: JsonObject) {
  const polling = pollConfigForConnection(config);
  const mode = firstStringValue(
    polling.mode,
    polling.sourceMode,
    polling.strategy,
  )?.toLowerCase();

  return mode === "buffer" || mode === "buffered" || mode === "connection_buffer";
}

function credentialRefForConnection(config: JsonObject) {
  const polling = pollConfigForConnection(config);
  const auth = jsonObject(config.auth);

  return firstStringValue(
    polling.credentialRef,
    polling.accessTokenRef,
    auth.credentialRef,
    auth.accessTokenRef,
    config.credentialRef,
    config.accessTokenRef,
  );
}

function credentialRefKind(value: string | undefined) {
  if (!value) {
    return null;
  }

  const separator = value.indexOf(":");

  if (separator <= 0) {
    return "unknown";
  }

  return value.slice(0, separator).toLowerCase();
}

function credentialRefEnvName(value: string | undefined) {
  const match = value?.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);

  return match?.[1] ?? null;
}

function envCredentialResolved(value: string | undefined, env: Record<string, string | undefined>) {
  const envName = credentialRefEnvName(value);

  if (!envName) {
    return null;
  }

  return Boolean(env[envName]);
}

function configuredSource(config: JsonObject) {
  const polling = pollConfigForConnection(config);

  return firstStringValue(polling.source, stringList(config.sources)[0], config.source);
}

function configuredProvider(config: JsonObject) {
  const polling = pollConfigForConnection(config);

  return firstStringValue(polling.provider, stringList(config.providers)[0], config.provider);
}

function readScopes(scopes: JsonObject) {
  return Array.from(
    new Set([
      ...stringList(scopes.read),
      ...stringList(scopes.reads),
      ...stringList(scopes.lead),
      ...stringList(scopes.leads),
    ]),
  );
}

function assertConnectionSafety(input: {
  state: AdapterConnectionState;
  scopes: JsonObject;
  config: JsonObject;
}) {
  assertNoInlineSecretMaterial(input.scopes, "config.scopes");
  assertNoInlineSecretMaterial(input.config, "config.config");

  if (input.config.executable === true || input.config.externalExecution === "enabled") {
    throw new PlatformUnavailableError(
      "core_connection_external_execution_blocked",
      "connection.upsert cannot enable external execution. Use blocked read-only connections until a live execution gate exists.",
      400,
    );
  }

  const polling = pollConfigForConnection(input.config);

  if (polling.enabled !== true || input.state !== "active") {
    return;
  }

  const credentialRef = credentialRefForConnection(input.config);

  if (
    !connectionUsesBufferedPolling(input.config) &&
    (!credentialRef || !credentialRef.toLowerCase().startsWith("env:"))
  ) {
    throw new PlatformUnavailableError(
      "core_connection_polling_credential_required",
      "Active pollable connections require an environment-backed credential reference such as config.config.polling.credentialRef=env:NAME.",
      400,
    );
  }

  if (!configuredSource(input.config) || !configuredProvider(input.config)) {
    throw new PlatformUnavailableError(
      "core_connection_polling_source_required",
      "Active pollable connections require source and provider metadata under config.config or config.config.polling.",
      400,
    );
  }

  if (readScopes(input.scopes).length === 0) {
    throw new PlatformUnavailableError(
      "core_connection_read_scope_required",
      "Active pollable connections require at least one read scope under config.scopes.",
      400,
    );
  }
}

const defaultConnectionHealthChecks = [
  "state",
  "adapter",
  "external_execution",
  "credential_ref",
  "source_metadata",
  "scopes",
  "polling",
  "scheduler",
] as const;
const connectionHealthCheckKeys = new Set(defaultConnectionHealthChecks);

function connectionHealthChecks(value: unknown) {
  if (value === undefined || value === null) {
    return [...defaultConnectionHealthChecks];
  }

  const checks = stringList(value);

  if (checks.length === 0) {
    throw new PlatformUnavailableError(
      "core_connection_health_checks_invalid",
      "config.checks must be a non-empty string array when provided.",
      400,
    );
  }

  const unsupported = checks.filter((check) =>
    !connectionHealthCheckKeys.has(check as (typeof defaultConnectionHealthChecks)[number])
  );

  if (unsupported.length > 0) {
    throw new PlatformUnavailableError(
      "core_connection_health_checks_invalid",
      `config.checks contains unsupported checks: ${unsupported.join(", ")}.`,
      400,
    );
  }

  return checks as (typeof defaultConnectionHealthChecks)[number][];
}

function connectionHealthCheck(
  key: string,
  status: ConnectionHealthCheckStatus,
  summary: string,
  data: JsonObject = {},
) {
  return { key, status, summary, data };
}

function connectionHealthStatus(input: {
  state: AdapterConnectionState;
  checks: Array<{ status: ConnectionHealthCheckStatus }>;
}): ConnectionHealthStatus {
  if (input.state === "archived") {
    return "archived";
  }

  if (input.state === "paused") {
    return "paused";
  }

  if (input.state === "error") {
    return "error";
  }

  const hasFailure = input.checks.some((check) => check.status === "fail");
  const hasWarning = input.checks.some((check) => check.status === "warn");

  if (hasFailure || hasWarning || input.state !== "active") {
    return "needs_configuration";
  }

  return "ready";
}

function buildConnectionHealthReport(input: {
  connection: typeof connections.$inferSelect;
  adapter: typeof adapters.$inferSelect;
  requestedChecks: string[];
  observedAt: Date;
  env: Record<string, string | undefined>;
}) {
  const config = jsonObject(input.connection.config);
  const scopes = jsonObject(input.connection.scopes);
  const polling = pollConfigForConnection(config);
  const pollingEnabled = polling.enabled === true;
  const credentialRef = credentialRefForConnection(config);
  const credentialKind = credentialRefKind(credentialRef);
  const envConfigured = envCredentialResolved(credentialRef, input.env);
  const bufferedPolling = connectionUsesBufferedPolling(config);
  const readScopeValues = readScopes(scopes);
  const source = configuredSource(config);
  const provider = configuredProvider(config);
  const checks = input.requestedChecks.map((check) => {
    if (check === "state") {
      const state = input.connection.state as AdapterConnectionState;

      if (state === "active") {
        return connectionHealthCheck("state", "pass", "Connection is active.", {
          state,
        });
      }

      return connectionHealthCheck(
        "state",
        state === "draft" || state === "paused" ? "warn" : "fail",
        state === "draft"
          ? "Connection is draft and will not be polled by the scheduler."
          : `Connection state is ${state}.`,
        { state },
      );
    }

    if (check === "adapter") {
      return connectionHealthCheck(
        "adapter",
        input.adapter.active ? "pass" : "warn",
        input.adapter.active ? "Adapter is active." : "Adapter is not active.",
        {
          adapterId: input.adapter.id,
          adapterKey: input.adapter.key,
          adapterKind: input.adapter.kind,
          active: input.adapter.active,
        },
      );
    }

    if (check === "external_execution") {
      const enabled = config.executable === true || config.externalExecution === "enabled";

      return connectionHealthCheck(
        "external_execution",
        enabled ? "fail" : "pass",
        enabled
          ? "External execution is enabled; this is blocked until the live execution gate exists."
          : "External execution is blocked.",
        {
          externalExecution: enabled ? "enabled" : "blocked",
        },
      );
    }

    if (check === "credential_ref") {
      if (bufferedPolling) {
        return connectionHealthCheck(
          "credential_ref",
          "not_applicable",
          "Buffered scheduler polling does not require a runtime credential.",
          {
            credentialRefState: credentialRef ? "managed_ref_present" : "not_required",
            credentialRefKind: credentialKind,
            envConfigured: null,
            pollingMode: "connection_buffer",
          },
        );
      }

      if (!credentialRef) {
        return connectionHealthCheck(
          "credential_ref",
          pollingEnabled ? "fail" : "warn",
          pollingEnabled
            ? "Polling is enabled but no managed credential reference is configured."
            : "No managed credential reference is configured.",
          {
            credentialRefState: "not_configured",
            credentialRefKind: null,
            envConfigured: null,
          },
        );
      }

      const isEnvRef = credentialKind === "env";
      const envState = isEnvRef ? envConfigured === true : null;

      return connectionHealthCheck(
        "credential_ref",
        pollingEnabled && isEnvRef && !envState ? "fail" : "pass",
        pollingEnabled && isEnvRef && !envState
          ? "Managed environment credential reference is configured but not present in the runtime environment."
          : "Managed credential reference is configured.",
        {
          credentialRefState: "managed_ref_present",
          credentialRefKind: credentialKind,
          envConfigured: envState,
        },
      );
    }

    if (check === "source_metadata") {
      const ready = Boolean(source && provider);

      return connectionHealthCheck(
        "source_metadata",
        ready ? "pass" : "fail",
        ready
          ? "Connection source and provider metadata are configured."
          : "Connection source and provider metadata are required for source polling.",
        {
          source: source ?? null,
          provider: provider ?? null,
        },
      );
    }

    if (check === "scopes") {
      return connectionHealthCheck(
        "scopes",
        readScopeValues.length > 0 ? "pass" : "fail",
        readScopeValues.length > 0
          ? "Connection has read scopes."
          : "Connection needs at least one read scope before polling.",
        {
          readScopes: readScopeValues,
        },
      );
    }

    if (check === "polling") {
      if (!pollingEnabled) {
        return connectionHealthCheck("polling", "not_applicable", "Polling is not enabled.", {
          pollingEnabled: false,
        });
      }

      return connectionHealthCheck(
        "polling",
        input.connection.state === "active" ? "pass" : "warn",
        input.connection.state === "active"
          ? "Polling is enabled for an active connection."
          : "Polling is enabled but the connection is not active.",
        {
          pollingEnabled: true,
          mode: bufferedPolling ? "connection_buffer" : cleanString(polling.mode) ?? null,
          intervalMs: typeof polling.intervalMs === "number" ? polling.intervalMs : null,
          maxResults: typeof polling.maxResults === "number" ? polling.maxResults : null,
        },
      );
    }

    const lastLeadRead = jsonObject(config.lastLeadRead);
    const readAt = cleanString(lastLeadRead.readAt);
    const hasSchedulerCoverage = Boolean(input.connection.lastSyncAt || readAt);

    if (!pollingEnabled || input.connection.state !== "active") {
      return connectionHealthCheck(
        "scheduler",
        "not_applicable",
        "Scheduler coverage starts after polling is enabled on an active connection.",
        {
          pollingEnabled,
          state: input.connection.state,
        },
      );
    }

    return connectionHealthCheck(
      "scheduler",
      hasSchedulerCoverage ? "pass" : "warn",
      hasSchedulerCoverage
        ? "Connection has scheduler lead-read cursor proof."
        : "Connection is ready for polling but has no scheduler lead-read proof yet.",
      {
        lastSyncAt: input.connection.lastSyncAt?.toISOString() ?? null,
        lastLeadReadAt: readAt ?? null,
      },
    );
  });
  const status = connectionHealthStatus({
    state: input.connection.state as AdapterConnectionState,
    checks,
  });

  return {
    status,
    observedAt: input.observedAt.toISOString(),
    connectionId: input.connection.id,
    adapterId: input.connection.adapterId,
    adapterKey: input.adapter.key,
    pollingEnabled,
    externalExecution: "blocked",
    checks,
  };
}

function parseTaskState(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const taskStates = new Set<CoreTaskState>([
    "draft",
    "active",
    "waiting",
    "approval_required",
    "blocked",
    "done",
    "canceled",
  ]);

  if (taskStates.has(value as CoreTaskState)) {
    return value as CoreTaskState;
  }

  throw new PlatformUnavailableError(
    "core_task_state_invalid",
    "config.taskState must be draft, active, waiting, approval_required, blocked, done, or canceled.",
    400,
  );
}

function parseCustomerSignalType(value: string) {
  if (customerSignalTypes.has(value)) {
    return value;
  }

  throw new PlatformUnavailableError(
    "core_customer_signal_type_invalid",
    "config.type must be satisfaction_signal, feedback_item, complaint, testimonial, or review.",
    400,
  );
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
      "config.objectId does not match an object in this tenant.",
      404,
    );
  }
}

async function assertTask(tx: QueryClient, tenantId: string, taskId?: string) {
  if (!taskId) {
    return;
  }

  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
    .limit(1);

  if (!task) {
    throw new PlatformUnavailableError(
      "core_task_not_found",
      "config.taskId does not match a task in this tenant.",
      404,
    );
  }
}

async function assertEvent(tx: QueryClient, tenantId: string, eventId?: string) {
  if (!eventId) {
    return;
  }

  const [event] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .limit(1);

  if (!event) {
    throw new PlatformUnavailableError(
      "core_event_not_found",
      "config.eventId does not match an event in this tenant.",
      404,
    );
  }
}

async function assertCapability(tx: QueryClient, capabilityId?: string) {
  if (!capabilityId) {
    return;
  }

  const [capability] = await tx
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.id, capabilityId), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "core_capability_not_found",
      "config.capabilityId does not match an active capability.",
      404,
    );
  }
}

async function assertAdapter(tx: QueryClient, adapterId?: string) {
  if (!adapterId) {
    return;
  }

  const [adapter] = await tx
    .select({ id: adapters.id })
    .from(adapters)
    .where(eq(adapters.id, adapterId))
    .limit(1);

  if (!adapter) {
    throw new PlatformUnavailableError(
      "core_adapter_not_found",
      "config.adapterId does not match an adapter.",
      404,
    );
  }
}

async function assertConnection(tx: QueryClient, tenantId: string, connectionId?: string) {
  if (!connectionId) {
    return;
  }

  const [connection] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "core_connection_not_found",
      "config.connectionId does not match a connection in this tenant.",
      404,
    );
  }
}

async function loadConnection(tx: QueryClient, tenantId: string, connectionId: string) {
  const [connection] = await tx
    .select({
      id: connections.id,
      adapterId: connections.adapterId,
      name: connections.name,
    })
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "core_connection_not_found",
      "config.connectionId does not match a connection in this tenant.",
      404,
    );
  }

  return connection;
}

async function assertRulePack(tx: QueryClient, rulePackId?: string) {
  if (!rulePackId) {
    return;
  }

  const [rulePack] = await tx
    .select({ id: rulePacks.id })
    .from(rulePacks)
    .where(eq(rulePacks.id, rulePackId))
    .limit(1);

  if (!rulePack) {
    throw new PlatformUnavailableError(
      "core_rule_pack_not_found",
      "config.rulePackId does not match a rule pack.",
      404,
    );
  }
}

async function assertWorkflowRun(tx: QueryClient, tenantId: string, workflowRunId?: string) {
  if (!workflowRunId) {
    return;
  }

  const [run] = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, workflowRunId)))
    .limit(1);

  if (!run) {
    throw new PlatformUnavailableError(
      "core_workflow_run_not_found",
      "config.workflowRunId does not match a workflow run in this tenant.",
      404,
    );
  }
}

async function assertEvidenceItems(tx: QueryClient, tenantId: string, evidenceIds: string[]) {
  if (evidenceIds.length === 0) {
    return;
  }

  const rows = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), inArray(evidence.id, evidenceIds)));

  if (rows.length !== evidenceIds.length) {
    throw new PlatformUnavailableError(
      "core_evidence_not_found",
      "config.evidenceIds must reference evidence rows in this tenant.",
      404,
    );
  }
}

async function assertDocuments(tx: QueryClient, tenantId: string, documentIds: string[]) {
  if (documentIds.length === 0) {
    return;
  }

  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, documentIds)));

  if (rows.length !== documentIds.length) {
    throw new PlatformUnavailableError(
      "core_document_not_found",
      "config.documentIds must reference document rows in this tenant.",
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

async function nextObjectVersion(tx: QueryClient, objectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('object_version'), hashtext(${objectId}))`);

  const [version] = await tx
    .select({
      value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
    })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId));

  return Number(version?.value ?? 1);
}

export async function upsertCoreObject(input: CoreObjectUpsertInput) {
  const db = input.db ?? defaultDb;
  const type = requiredString(input.type, "config.type");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "active";
  const objectRecordSource = cleanString(input.source) ?? "continuous";
  const externalId = cleanString(input.externalId);
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const effectiveAt = optionalDate(input.effectiveAt, "config.effectiveAt");
  const archivedAt = optionalDate(input.archivedAt, "config.archivedAt");
  const objectData = jsonObject(input.data);
  const version = jsonObject(input.version);
  const versionData = jsonObject(version.data ?? objectData);
  const reason = cleanString(input.reason) ?? cleanString(version.reason) ?? "Core object upsert";
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("object.upsert", {
    objectId: objectId ?? null,
    type,
    name,
    state,
    source: objectRecordSource,
    externalId: externalId ?? null,
    data: objectData,
    effectiveAt: effectiveAt?.toISOString() ?? null,
    archivedAt: archivedAt?.toISOString() ?? null,
    reason,
    versionData,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${objectSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, objectSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:object_upserted`),
          eq(auditEvents.targetType, "object"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "object.upsert",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [object] = await tx
        .select()
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, existingAudit.targetId)))
        .limit(1);
      const [latestVersion] = await tx
        .select({ version: sql<number>`coalesce(max(${objectVersions.version}), 0)` })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, existingAudit.targetId));

      if (object) {
        return {
          created: false,
          updated: false,
          objectId: object.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          version: Number(latestVersion?.version ?? 0),
          object: {
            id: object.id,
            type: object.type,
            name: object.name,
            state: object.state,
            source: object.source,
            externalId: object.externalId,
          },
        };
      }
    }

    let existingObject = null as typeof objects.$inferSelect | null;

    if (objectId) {
      const [object] = await tx
        .select()
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
        .limit(1);
      existingObject = object ?? null;

      if (!existingObject) {
        throw new PlatformUnavailableError(
          "core_object_not_found",
          "config.objectId does not match an object in this tenant.",
          404,
        );
      }
    }

    if (externalId) {
      const [object] = await tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.tenantId, operator.tenantId),
            eq(objects.source, objectRecordSource),
            eq(objects.externalId, externalId),
          ),
        )
        .limit(1);

      if (object && existingObject && object.id !== existingObject.id) {
        throw new PlatformUnavailableError(
          "core_object_identity_conflict",
          "config.objectId and config.externalId refer to different objects.",
          409,
        );
      }

      existingObject = existingObject ?? object ?? null;
    }

    const now = new Date();
    const [object] = existingObject
      ? await tx
          .update(objects)
          .set({
            type,
            name,
            state,
            source: objectRecordSource,
            externalId,
            data: objectData,
            effectiveAt,
            archivedAt,
            updatedAt: now,
          })
          .where(eq(objects.id, existingObject.id))
          .returning()
      : await tx
          .insert(objects)
          .values({
            tenantId: operator.tenantId,
            type,
            name,
            state,
            source: objectRecordSource,
            externalId,
            data: objectData,
            createdByUserId: operator.userId,
            effectiveAt,
            archivedAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const versionNumber = await nextObjectVersion(tx, object.id);
    const [objectVersion] = await tx
      .insert(objectVersions)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        version: versionNumber,
        data: versionData,
        changedByType: "user",
        changedById: operator.userId,
        reason,
      })
      .returning({ id: objectVersions.id, version: objectVersions.version });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingObject ? "object.updated" : "object.created",
        source: objectSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        idempotencyKey: `${input.idempotencyKey}:object_upserted`,
        data: {
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
          type,
          name,
          state,
          source: objectRecordSource,
          externalId: externalId ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingObject ? "object.updated" : "object.created",
        source: objectSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "object",
        targetId: object.id,
        eventId: event.id,
        objectId: object.id,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:object_upserted`,
        data: {
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingObject,
      updated: Boolean(existingObject),
      objectId: object.id,
      objectVersionId: objectVersion.id,
      version: objectVersion.version,
      eventId: event.id,
      auditEventId: audit.id,
      object: {
        id: object.id,
        type: object.type,
        name: object.name,
        state: object.state,
        source: object.source,
        externalId: object.externalId,
      },
    };
  });
}

export async function upsertCoreAdapter(input: CoreAdapterUpsertInput) {
  const db = input.db ?? defaultDb;
  const adapterId = optionalUuid(input.adapterId, "config.adapterId");
  const key = requiredStringMax(input.key, "config.key", 120);
  const name = requiredString(input.name, "config.name");
  const kind = requiredStringMax(input.kind, "config.kind", 120);
  const authMode = parseAdapterAuthMode(input.auth);
  const configSchema = jsonObject(input.configSchema);
  const eventSchema = jsonObject(input.eventSchema);
  const adapterCapabilities = jsonObject(input.capabilities);
  const active = input.active ?? true;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("adapter.upsert", {
    adapterId: adapterId ?? null,
    key,
    name,
    kind,
    authMode,
    configSchema,
    eventSchema,
    capabilities: adapterCapabilities,
    active,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${adapterSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, adapterSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:adapter_upserted`),
          eq(auditEvents.targetType, "adapter"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "adapter.upsert",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [adapter] = await tx.select().from(adapters).where(eq(adapters.id, existingAudit.targetId)).limit(1);

      if (adapter) {
        return {
          created: false,
          updated: false,
          adapterId: adapter.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          adapter: {
            id: adapter.id,
            key: adapter.key,
            name: adapter.name,
            kind: adapter.kind,
            authMode: adapterAuthModeForOutput(adapter.auth),
            active: adapter.active,
          },
        };
      }
    }

    let existingAdapter = null as typeof adapters.$inferSelect | null;

    if (adapterId) {
      const [adapter] = await tx.select().from(adapters).where(eq(adapters.id, adapterId)).limit(1);
      existingAdapter = adapter ?? null;

      if (!existingAdapter) {
        throw new PlatformUnavailableError(
          "core_adapter_not_found",
          "config.adapterId does not match an adapter.",
          404,
        );
      }
    }

    const [adapterForKey] = await tx.select().from(adapters).where(eq(adapters.key, key)).limit(1);

    if (adapterForKey && existingAdapter && adapterForKey.id !== existingAdapter.id) {
      throw new PlatformUnavailableError(
        "core_adapter_identity_conflict",
        "config.adapterId and config.key refer to different adapters.",
        409,
      );
    }

    existingAdapter = existingAdapter ?? adapterForKey ?? null;

    const now = new Date();
    const [adapter] = existingAdapter
      ? await tx
          .update(adapters)
          .set({
            key,
            name,
            kind,
            auth: authMode,
            configSchema,
            eventSchema,
            capabilities: adapterCapabilities,
            active,
            updatedAt: now,
          })
          .where(eq(adapters.id, existingAdapter.id))
          .returning()
      : await tx
          .insert(adapters)
          .values({
            key,
            name,
            kind,
            auth: authMode,
            configSchema,
            eventSchema,
            capabilities: adapterCapabilities,
            active,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingAdapter ? "adapter.updated" : "adapter.created",
        source: adapterSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        adapterId: adapter.id,
        idempotencyKey: `${input.idempotencyKey}:adapter_upserted`,
        data: {
          adapterId: adapter.id,
          key,
          kind,
          authMode,
          active,
          externalExecution: "blocked",
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingAdapter ? "adapter.updated" : "adapter.created",
        source: adapterSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "adapter",
        targetId: adapter.id,
        eventId: event.id,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:adapter_upserted`,
        data: {
          adapterId: adapter.id,
          key,
          kind,
          authMode,
          active,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingAdapter,
      updated: Boolean(existingAdapter),
      adapterId: adapter.id,
      eventId: event.id,
      auditEventId: audit.id,
      adapter: {
        id: adapter.id,
        key: adapter.key,
        name: adapter.name,
        kind: adapter.kind,
        authMode: adapterAuthModeForOutput(adapter.auth),
        active: adapter.active,
      },
    };
  });
}

export async function upsertCoreConnection(input: CoreConnectionUpsertInput) {
  const db = input.db ?? defaultDb;
  const connectionId = optionalUuid(input.connectionId, "config.connectionId");
  const adapterId = optionalUuid(input.adapterId, "config.adapterId");
  const adapterKey = cleanString(input.adapterKey);
  const name = requiredString(input.name, "config.name");
  const state = parseAdapterConnectionState(cleanString(input.state));
  const externalAccountId = cleanString(input.externalAccountId);
  const scopes = jsonObject(input.scopes);
  const connectionConfig = jsonObject(input.config);
  const lastSyncAt = optionalDate(input.lastSyncAt, "config.lastSyncAt");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  assertConnectionSafety({ state, scopes, config: connectionConfig });
  const idempotency = coreIdempotencyFingerprint("connection.upsert", {
    connectionId: connectionId ?? null,
    adapterId: adapterId ?? null,
    adapterKey: adapterKey ?? null,
    name,
    state,
    externalAccountId: externalAccountId ?? null,
    scopes,
    config: connectionConfig,
    lastSyncAt: lastSyncAt?.toISOString() ?? null,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${connectionSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, connectionSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:connection_upserted`),
          eq(auditEvents.targetType, "connection"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "connection.upsert",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [connection] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.tenantId, operator.tenantId), eq(connections.id, existingAudit.targetId)))
        .limit(1);

      if (connection) {
        return {
          created: false,
          updated: false,
          connectionId: connection.id,
          adapterId: connection.adapterId,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          externalExecution: "blocked",
          pollingEnabled: pollConfigForConnection(jsonObject(connection.config)).enabled === true,
          connection: {
            id: connection.id,
            name: connection.name,
            state: connection.state,
            externalAccountId: connection.externalAccountId,
          },
        };
      }
    }

    let selectedAdapter = null as typeof adapters.$inferSelect | null;

    if (adapterId) {
      const [adapter] = await tx.select().from(adapters).where(eq(adapters.id, adapterId)).limit(1);
      selectedAdapter = adapter ?? null;

      if (!selectedAdapter) {
        throw new PlatformUnavailableError(
          "core_adapter_not_found",
          "config.adapterId does not match an adapter.",
          404,
        );
      }
    }

    if (adapterKey) {
      const [adapter] = await tx.select().from(adapters).where(eq(adapters.key, adapterKey)).limit(1);

      if (!adapter) {
        throw new PlatformUnavailableError(
          "core_adapter_not_found",
          "config.adapterKey does not match an adapter.",
          404,
        );
      }

      if (selectedAdapter && selectedAdapter.id !== adapter.id) {
        throw new PlatformUnavailableError(
          "core_adapter_identity_conflict",
          "config.adapterId and config.adapterKey refer to different adapters.",
          409,
        );
      }

      selectedAdapter = selectedAdapter ?? adapter;
    }

    if (!selectedAdapter) {
      throw new PlatformUnavailableError(
        "core_adapter_required",
        "config.adapterId or config.adapterKey is required for connection.upsert.",
        400,
      );
    }

    let existingConnection = null as typeof connections.$inferSelect | null;

    if (connectionId) {
      const [connection] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.tenantId, operator.tenantId), eq(connections.id, connectionId)))
        .limit(1);
      existingConnection = connection ?? null;

      if (!existingConnection) {
        throw new PlatformUnavailableError(
          "core_connection_not_found",
          "config.connectionId does not match a connection in this tenant.",
          404,
        );
      }
    }

    if (externalAccountId) {
      const [connection] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.tenantId, operator.tenantId),
            eq(connections.adapterId, selectedAdapter.id),
            eq(connections.externalAccountId, externalAccountId),
          ),
        )
        .limit(1);

      if (connection && existingConnection && connection.id !== existingConnection.id) {
        throw new PlatformUnavailableError(
          "core_connection_identity_conflict",
          "config.connectionId and config.externalAccountId refer to different connections.",
          409,
        );
      }

      existingConnection = existingConnection ?? connection ?? null;
    }

    if (existingConnection && existingConnection.adapterId !== selectedAdapter.id) {
      throw new PlatformUnavailableError(
        "core_connection_adapter_conflict",
        "Existing connections cannot be moved to a different adapter.",
        409,
      );
    }

    const now = new Date();
    const [connection] = existingConnection
      ? await tx
          .update(connections)
          .set({
            name,
            state,
            externalAccountId,
            scopes,
            config: connectionConfig,
            lastSyncAt,
            updatedAt: now,
          })
          .where(eq(connections.id, existingConnection.id))
          .returning()
      : await tx
          .insert(connections)
          .values({
            tenantId: operator.tenantId,
            adapterId: selectedAdapter.id,
            name,
            state,
            externalAccountId,
            scopes,
            config: connectionConfig,
            lastSyncAt,
            createdByUserId: operator.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const pollingEnabled = pollConfigForConnection(connectionConfig).enabled === true;
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingConnection ? "connection.updated" : "connection.created",
        source: connectionSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        adapterId: selectedAdapter.id,
        connectionId: connection.id,
        idempotencyKey: `${input.idempotencyKey}:connection_upserted`,
        data: {
          connectionId: connection.id,
          adapterId: selectedAdapter.id,
          adapterKey: selectedAdapter.key,
          state,
          externalAccountId: externalAccountId ?? null,
          pollingEnabled,
          externalExecution: "blocked",
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingConnection ? "connection.updated" : "connection.created",
        source: connectionSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "connection",
        targetId: connection.id,
        eventId: event.id,
        risk: pollingEnabled ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:connection_upserted`,
        data: {
          connectionId: connection.id,
          adapterId: selectedAdapter.id,
          adapterKey: selectedAdapter.key,
          state,
          externalAccountId: externalAccountId ?? null,
          pollingEnabled,
          credentialRefState: credentialRefForConnection(connectionConfig) ? "managed_ref_present" : "not_configured",
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingConnection,
      updated: Boolean(existingConnection),
      connectionId: connection.id,
      adapterId: selectedAdapter.id,
      eventId: event.id,
      auditEventId: audit.id,
      externalExecution: "blocked",
      pollingEnabled,
      connection: {
        id: connection.id,
        name: connection.name,
        state: connection.state,
        externalAccountId: connection.externalAccountId,
      },
    };
  });
}

function connectionHealthRisk(status: ConnectionHealthStatus): RiskLevel {
  if (status === "ready") {
    return "low";
  }

  if (status === "needs_configuration" || status === "paused") {
    return "medium";
  }

  return "high";
}

export async function recordCoreConnectionHealth(input: CoreConnectionHealthRecordInput) {
  const db = input.db ?? defaultDb;
  const connectionId = requiredUuid(input.connectionId, "config.connectionId");
  const requestedChecks = connectionHealthChecks(input.checks);
  const observedAt = optionalDate(input.observedAt, "config.observedAt") ?? new Date();
  const observedAtInput = cleanString(input.observedAt) ? observedAt.toISOString() : null;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("connection.health.record", {
    connectionId,
    checks: requestedChecks,
    observedAt: observedAtInput,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${connectionHealthSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, connectionHealthSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:connection_health_recorded`),
          eq(auditEvents.targetType, "connection"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "connection.health.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const report = jsonObject(jsonObject(existingAudit.data).report);

      return {
        created: false,
        connectionId: existingAudit.targetId,
        adapterId: cleanString(report.adapterId) ?? null,
        eventId: existingAudit.eventId,
        evidenceId: cleanString(jsonObject(existingAudit.data).evidenceId) ?? null,
        auditEventId: existingAudit.auditEventId,
        status: cleanString(report.status) ?? "needs_configuration",
        checks: Array.isArray(report.checks) ? report.checks : [],
        report,
        externalExecution: "blocked",
      };
    }

    const [connection] = await tx
      .select({
        connection: connections,
        adapter: adapters,
      })
      .from(connections)
      .innerJoin(adapters, eq(connections.adapterId, adapters.id))
      .where(and(eq(connections.tenantId, operator.tenantId), eq(connections.id, connectionId)))
      .limit(1);

    if (!connection) {
      throw new PlatformUnavailableError(
        "core_connection_not_found",
        "config.connectionId does not match a connection in this tenant.",
        404,
      );
    }

    const report = buildConnectionHealthReport({
      connection: connection.connection,
      adapter: connection.adapter,
      requestedChecks,
      observedAt,
      env: input.env ?? process.env,
    });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "connection.health.recorded",
        source: connectionHealthSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        adapterId: connection.adapter.id,
        connectionId: connection.connection.id,
        idempotencyKey: `${input.idempotencyKey}:connection_health_recorded`,
        data: {
          report,
          externalExecution: "blocked",
        },
        occurredAt: observedAt,
      })
      .returning({ id: events.id });
    const [snapshot] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "snapshot",
        name: "Connection health snapshot",
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${connectionHealthSource}:${connection.connection.id}:${observedAt.toISOString()}`,
        data: {
          report,
          externalExecution: "blocked",
        },
        redaction: {
          credentialValues: "omitted",
          credentialRefs: "kind_only",
          externalExecution: "blocked",
        },
        createdAt: observedAt,
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "connection.health.recorded",
        source: connectionHealthSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "connection",
        targetId: connection.connection.id,
        eventId: event.id,
        risk: connectionHealthRisk(report.status),
        idempotencyKey: `${input.idempotencyKey}:connection_health_recorded`,
        data: {
          report,
          evidenceId: snapshot.id,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      connectionId: connection.connection.id,
      adapterId: connection.adapter.id,
      eventId: event.id,
      evidenceId: snapshot.id,
      auditEventId: audit.id,
      status: report.status,
      checks: report.checks,
      report,
      externalExecution: "blocked",
    };
  });
}

export async function ingestCoreEvent(input: CoreEventIngestInput) {
  const db = input.db ?? defaultDb;
  const type = requiredString(input.type, "config.type");
  const source = cleanString(input.source) ?? eventSource;
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const adapterId = optionalUuid(input.adapterId, "config.adapterId");
  const connectionId = optionalUuid(input.connectionId, "config.connectionId");
  const occurredAt = optionalDate(input.occurredAt, "config.occurredAt") ?? new Date();
  const occurredAtInput = cleanString(input.occurredAt) ? occurredAt.toISOString() : null;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);
  const idempotency = coreIdempotencyFingerprint("event.ingest", {
    type,
    source,
    actor: {
      type: actor.type,
      id: actor.id ?? null,
      ref: actor.ref,
    },
    objectId: objectId ?? null,
    taskId: taskId ?? null,
    capabilityId: capabilityId ?? null,
    adapterId: adapterId ?? null,
    connectionId: connectionId ?? null,
    data: jsonObject(input.data),
    occurredAt: occurredAtInput,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingEvent] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.tenantId, operator.tenantId),
          eq(events.source, source),
          eq(events.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingEvent) {
      const [existingAudit] = await tx
        .select({ id: auditEvents.id, data: auditEvents.data })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, operator.tenantId),
            eq(auditEvents.source, eventSource),
            eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:event_ingested`),
          ),
        )
        .limit(1);

      assertCoreIdempotencyReplay({
        command: "event.ingest",
        fingerprint: idempotency,
        storedData: existingAudit?.data,
      });

      return {
        created: false,
        eventId: existingEvent.id,
        auditEventId: existingAudit?.id ?? null,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertTask(tx, operator.tenantId, taskId),
      assertCapability(tx, capabilityId),
      assertAdapter(tx, adapterId),
      assertConnection(tx, operator.tenantId, connectionId),
    ]);

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type,
        source,
        actorType: actor.type,
        actorId: actor.id,
        actorRef: actor.ref,
        objectId,
        taskId,
        capabilityId,
        adapterId,
        connectionId,
        idempotencyKey: input.idempotencyKey,
        data: jsonObject(input.data),
        occurredAt,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "event.ingested",
        source: eventSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "event",
        targetId: event.id,
        eventId: event.id,
        objectId,
        taskId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:event_ingested`,
        data: {
          eventType: type,
          eventSource: source,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function attachCoreEvidence(input: CoreEvidenceAttachInput) {
  const db = input.db ?? defaultDb;
  const kind = parseEvidenceKind(requiredString(input.kind, "config.kind"));
  const name = requiredString(input.name, "config.name");
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);
  const idempotency = coreIdempotencyFingerprint("evidence.attach", {
    kind,
    name,
    actor: {
      type: actor.type,
      id: actor.id ?? null,
      ref: actor.ref,
    },
    objectId: objectId ?? null,
    taskId: taskId ?? null,
    eventId: eventId ?? null,
    capabilityId: capabilityId ?? null,
    uri: cleanString(input.uri) ?? null,
    hash: cleanString(input.hash) ?? null,
    data: jsonObject(input.data),
    redaction: jsonObject(input.redaction),
    retainedUntil: retainedUntil?.toISOString() ?? null,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${evidenceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        data: auditEvents.data,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, evidenceSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:evidence_attached`),
          eq(auditEvents.targetType, "evidence"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "evidence.attach",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        evidenceId: existingAudit.targetId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
      assertCapability(tx, capabilityId),
    ]);

    const [item] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind,
        name,
        objectId,
        taskId,
        eventId,
        capabilityId,
        actorType: actor.type,
        actorId: actor.id,
        uri: cleanString(input.uri),
        hash: cleanString(input.hash),
        data: jsonObject(input.data),
        redaction: jsonObject(input.redaction),
        retainedUntil,
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "evidence.attached",
        source: evidenceSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "evidence",
        targetId: item.id,
        taskId,
        eventId,
        objectId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:evidence_attached`,
        data: {
          evidenceKind: kind,
          evidenceName: name,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      evidenceId: item.id,
      auditEventId: audit.id,
    };
  });
}

export async function createCoreDocument(input: CoreDocumentCreateInput) {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "draft";
  const sensitivity = parseRisk(cleanString(input.sensitivity));
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("document.create", {
    kind,
    name,
    state,
    sensitivity,
    objectId: objectId ?? null,
    workflowRunId: workflowRunId ?? null,
    hash: cleanString(input.hash) ?? null,
    data: jsonObject(input.data),
    retainedUntil: retainedUntil?.toISOString() ?? null,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${documentSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, documentSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:document_created`),
          eq(auditEvents.targetType, "document"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "document.create",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        documentId: existingAudit.targetId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
    ]);

    const now = new Date();
    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: operator.tenantId,
        objectId,
        workflowRunId,
        kind,
        name,
        state,
        sensitivity,
        hash: cleanString(input.hash),
        data: jsonObject(input.data),
        retainedUntil,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "document.created",
        source: documentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId,
        idempotencyKey: `${input.idempotencyKey}:document_created`,
        data: {
          documentId: document.id,
          workflowRunId: workflowRunId ?? null,
          kind,
          name,
          state,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "document.created",
        source: documentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "document",
        targetId: document.id,
        eventId: event.id,
        objectId,
        risk: sensitivity,
        idempotencyKey: `${input.idempotencyKey}:document_created`,
        data: {
          documentId: document.id,
          workflowRunId: workflowRunId ?? null,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      documentId: document.id,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function prepareCorePacketForOperator(
  tx: Transaction,
  operator: OperatorContext,
  input: CorePacketPrepareForOperatorInput,
): Promise<CorePacketPrepareResult> {
  const kind = requiredString(input.kind, "config.kind");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "prepared";
  const sensitivity = parseRisk(cleanString(input.sensitivity));
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const evidenceIds = uuidList(input.evidenceIds, "config.evidenceIds");
  const documentIds = uuidList(input.documentIds, "config.documentIds");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const idempotency = coreIdempotencyFingerprint("packet.prepare", {
    kind,
    name,
    state,
    sensitivity,
    objectId: objectId ?? null,
    taskId: taskId ?? null,
    workflowRunId: workflowRunId ?? null,
    eventId: eventId ?? null,
    capabilityId: capabilityId ?? null,
    evidenceIds,
    documentIds,
    sections: jsonObject(input.sections),
    data: jsonObject(input.data),
    hash: cleanString(input.hash) ?? null,
    retainedUntil: retainedUntil?.toISOString() ?? null,
  });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${packetSource}:${input.idempotencyKey}`}))`,
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
        eq(auditEvents.source, packetSource),
        eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:packet_prepared`),
        eq(auditEvents.targetType, "evidence_packet"),
      ),
    )
    .limit(1);

  if (existingAudit?.targetId) {
    assertCoreIdempotencyReplay({
      command: "packet.prepare",
      fingerprint: idempotency,
      storedData: existingAudit.data,
    });

    const [packet] = await tx
      .select()
      .from(evidencePackets)
      .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, existingAudit.targetId)))
      .limit(1);

    if (packet) {
      return {
        prepared: false,
        packetId: packet.id,
        documentId: packet.documentId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
      };
    }
  }

  await Promise.all([
    assertObject(tx, operator.tenantId, objectId),
    assertTask(tx, operator.tenantId, taskId),
    assertWorkflowRun(tx, operator.tenantId, workflowRunId),
    assertEvent(tx, operator.tenantId, eventId),
    assertCapability(tx, capabilityId),
    assertEvidenceItems(tx, operator.tenantId, evidenceIds),
    assertDocuments(tx, operator.tenantId, documentIds),
  ]);

  const now = new Date();
  const packetData = {
    ...jsonObject(input.data),
    sections: jsonObject(input.sections),
    evidenceIds,
    documentIds,
    externalExecution: "blocked",
  };
  const [document] = await tx
    .insert(documents)
    .values({
      tenantId: operator.tenantId,
      objectId,
      workflowRunId,
      kind,
      name,
      state,
      sensitivity,
      hash: cleanString(input.hash),
      data: packetData,
      retainedUntil,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: documents.id });
  const [packet] = await tx
    .insert(evidencePackets)
    .values({
      tenantId: operator.tenantId,
      documentId: document.id,
      objectId,
      taskId,
      workflowRunId,
      eventId,
      capabilityId,
      kind,
      name,
      state,
      sensitivity,
      evidenceIds: { ids: evidenceIds },
      documentIds: { ids: documentIds },
      data: packetData,
      hash: cleanString(input.hash),
      retainedUntil,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: evidencePackets.id });
  const [event] = await tx
    .insert(events)
    .values({
      tenantId: operator.tenantId,
      type: "packet.prepared",
      source: packetSource,
      actorType: "user",
      actorId: operator.userId,
      actorRef: operator.actorRef,
      objectId,
      taskId,
      capabilityId,
      idempotencyKey: `${input.idempotencyKey}:packet_prepared`,
      data: {
        packetId: packet.id,
        documentId: document.id,
        workflowRunId: workflowRunId ?? null,
        evidenceCount: evidenceIds.length,
        documentCount: documentIds.length,
        kind,
        name,
        state,
      },
      occurredAt: now,
    })
    .returning({ id: events.id });
  const [audit] = await tx
    .insert(auditEvents)
    .values({
      tenantId: operator.tenantId,
      type: "packet.prepared",
      source: packetSource,
      actorType: "user",
      actorId: operator.userId,
      actorRef: operator.actorRef,
      targetType: "evidence_packet",
      targetId: packet.id,
      taskId,
      eventId: event.id,
      objectId,
      capabilityId,
      risk: sensitivity,
      idempotencyKey: `${input.idempotencyKey}:packet_prepared`,
      data: {
        packetId: packet.id,
        documentId: document.id,
        evidenceIds,
        documentIds,
        idempotency,
        externalExecution: "blocked",
      },
    })
    .returning({ id: auditEvents.id });
  const [proof] = await tx
    .insert(evidence)
    .values({
      tenantId: operator.tenantId,
      kind: "trace",
      name: `Packet prepared: ${name}`,
      objectId,
      taskId,
      eventId: event.id,
      capabilityId,
      actorType: "user",
      actorId: operator.userId,
      hash: `${packetSource}:${packet.id}:${now.toISOString()}`,
      data: {
        packetId: packet.id,
        documentId: document.id,
        auditEventId: audit.id,
        evidenceIds,
        documentIds,
        idempotency,
        externalExecution: "blocked",
      },
      retainedUntil,
    })
    .returning({ id: evidence.id });

  return {
    prepared: true,
    packetId: packet.id,
    documentId: document.id,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
  };
}

export async function prepareCorePacket(input: CorePacketPrepareInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    return prepareCorePacketForOperator(tx, operator, input);
  });
}

export async function recordCoreDecision(input: CoreDecisionRecordInput) {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const decisionValue = requiredString(input.decision, "config.decision");
  const rationale = cleanString(input.rationale) ?? "";
  const state = cleanString(input.state) ?? "proposed";
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);
  const idempotency = coreIdempotencyFingerprint("decision.record", {
    kind,
    decision: decisionValue,
    rationale,
    state,
    actor: {
      type: actor.type,
      id: actor.id ?? null,
      ref: actor.ref,
    },
    taskId: taskId ?? null,
    eventId: eventId ?? null,
    workflowRunId: workflowRunId ?? null,
    capabilityId: capabilityId ?? null,
    data: jsonObject(input.data),
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${decisionSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, decisionSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:decision_recorded`),
          eq(auditEvents.targetType, "decision"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "decision.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        decisionId: existingAudit.targetId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
      assertCapability(tx, capabilityId),
    ]);

    const [decision] = await tx
      .insert(decisions)
      .values({
        tenantId: operator.tenantId,
        taskId,
        eventId,
        workflowRunId,
        capabilityId,
        actorType: actor.type,
        actorId: actor.id,
        kind,
        state,
        decision: decisionValue,
        rationale,
        data: jsonObject(input.data),
      })
      .returning({ id: decisions.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "decision.recorded",
        source: decisionSource,
        actorType: actor.type,
        actorId: actor.id,
        actorRef: actor.ref,
        taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:decision_recorded`,
        data: {
          decisionId: decision.id,
          kind,
          state,
          decision: decisionValue,
          workflowRunId: workflowRunId ?? null,
        },
        occurredAt: new Date(),
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "decision.recorded",
        source: decisionSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "decision",
        targetId: decision.id,
        taskId,
        eventId: event.id,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:decision_recorded`,
        data: {
          decisionId: decision.id,
          originalEventId: eventId ?? null,
          workflowRunId: workflowRunId ?? null,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      decisionId: decision.id,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function recordAdapterIntentForOperator(
  tx: Transaction,
  operator: OperatorContext,
  input: Omit<CoreAdapterIntentRecordInput, "operatorEmail" | "tenantSlug" | "db">,
) {
  const connectionId = requiredUuid(input.connectionId, "config.connectionId");
  const operation = requiredStringMax(input.operation, "config.operation", 140);
  const mode = cleanString(input.mode) ?? "dry_run";
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const maxAttempts = boundedInteger(input.maxAttempts, "config.maxAttempts", 1, 1, 10);

  if (mode !== "dry_run") {
    throw new PlatformUnavailableError(
      "core_adapter_intent_mode_blocked",
      "Adapter intents must use config.mode=dry_run until external execution is enabled.",
      400,
    );
  }

  const request = {
    ...jsonObject(input.request),
    operation,
    mode,
    dryRun: true,
    externalExecution: "blocked",
    externalMutation: false,
  };
  const data = jsonObject(input.data);
  const idempotency = coreIdempotencyFingerprint("adapter.intent.record", {
    connectionId,
    operation,
    mode,
    taskId: taskId ?? null,
    eventId: eventId ?? null,
    capabilityId: capabilityId ?? null,
    request,
    data,
    maxAttempts,
  });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${adapterIntentSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, adapterIntentSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:adapter_intent_recorded`),
          eq(auditEvents.targetType, "adapter_action"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "adapter.intent.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        adapterRunId: cleanString(existingAudit.data.adapterRunId) ?? null,
        adapterActionId: existingAudit.targetId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        externalExecution: "blocked",
      };
    }

    await Promise.all([
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
      assertCapability(tx, capabilityId),
    ]);

    const connection = await loadConnection(tx, operator.tenantId, connectionId);
    const now = new Date();
    const intentData = {
      ...data,
      connectionId,
      adapterId: connection.adapterId,
      operation,
      mode,
      taskId: taskId ?? null,
      eventId: eventId ?? null,
      capabilityId: capabilityId ?? null,
      requestedByUserId: operator.userId,
      externalExecution: "blocked",
    };
    const [intentEvent] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "adapter.intent.recorded",
        source: adapterIntentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        taskId,
        capabilityId,
        adapterId: connection.adapterId,
        connectionId,
        idempotencyKey: `${input.idempotencyKey}:adapter_intent_recorded`,
        data: {
          ...intentData,
          request,
          originalEventId: eventId ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [adapterRun] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: operator.tenantId,
        connectionId,
        eventId: intentEvent.id,
        mode,
        operation,
        idempotencyKey: input.idempotencyKey,
        state: "queued",
        attempt: 1,
        maxAttempts,
        reconciliationState: "pending",
        readCount: 0,
        writeCount: 0,
        receipt: {
          mode,
          externalExecution: "blocked",
          externalMutation: false,
        },
        data: intentData,
      })
      .returning({ id: adapterRuns.id });
    const [adapterAction] = await tx
      .insert(adapterActions)
      .values({
        tenantId: operator.tenantId,
        connectionId,
        adapterRunId: adapterRun.id,
        capabilityId,
        taskId,
        eventId: intentEvent.id,
        idempotencyKey: input.idempotencyKey,
        state: "queued",
        mode,
        operation,
        attempt: 1,
        maxAttempts,
        reconciliationState: "pending",
        request,
        response: {
          status: "not_executed",
          externalExecution: "blocked",
        },
        receipt: {
          mode,
          adapterRunId: adapterRun.id,
          externalExecution: "blocked",
          externalMutation: false,
        },
      })
      .returning({ id: adapterActions.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "adapter.intent.recorded",
        source: adapterIntentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "adapter_action",
        targetId: adapterAction.id,
        taskId,
        eventId: intentEvent.id,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:adapter_intent_recorded`,
        data: {
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          connectionId,
          adapterId: connection.adapterId,
          operation,
          mode,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [intentEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Adapter intent recorded: ${operation}`,
        taskId,
        eventId: intentEvent.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${adapterIntentSource}:${adapterAction.id}:recorded:${now.toISOString()}`,
        data: {
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          auditEventId: audit.id,
          connectionId,
          adapterId: connection.adapterId,
          request,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: evidence.id });

  return {
    created: true,
    adapterRunId: adapterRun.id,
    adapterActionId: adapterAction.id,
    eventId: intentEvent.id,
    auditEventId: audit.id,
    evidenceId: intentEvidence.id,
    externalExecution: "blocked",
  };
}

export async function recordAdapterIntent(input: CoreAdapterIntentRecordInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => recordAdapterIntentForOperator(tx, operator, input));
}

export async function recordRuleChangeForOperator(
  tx: Transaction,
  operator: OperatorContext,
  input: Omit<CoreRuleChangeRecordInput, "operatorEmail" | "tenantSlug" | "db">,
) {
  const rulePackId = optionalUuid(input.rulePackId, "config.rulePackId");
  const ruleKey = requiredStringMax(input.ruleKey, "config.ruleKey", 180);
  const changeType = requiredStringMax(input.changeType, "config.changeType", 80);
  const title = requiredString(input.title, "config.title");
  const state = cleanString(input.state) ?? "proposed";
  const decisionValue = cleanString(input.decision) ?? "rule_change_proposed";
  const summary = cleanString(input.summary) ?? "";
  const rationale = cleanString(input.rationale) ?? "";
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const effectiveAt = optionalDate(input.effectiveAt, "config.effectiveAt");
  const sourceRefs = jsonObject(input.sourceRefs);
  const before = jsonObject(input.before);
  const after = jsonObject(input.after);
  const impact = jsonObject(input.impact);
  const data = jsonObject(input.data);
  const idempotency = coreIdempotencyFingerprint("rule.change.record", {
    rulePackId: rulePackId ?? null,
    ruleKey,
    changeType,
    title,
    summary,
    state,
    decision: decisionValue,
    rationale,
    taskId: taskId ?? null,
    workflowRunId: workflowRunId ?? null,
    capabilityId: capabilityId ?? null,
    sourceRefs,
    before,
    after,
    impact,
    data,
    effectiveAt: effectiveAt?.toISOString() ?? null,
  });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${ruleChangeSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, ruleChangeSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:rule_change_recorded`),
          eq(auditEvents.targetType, "object"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "rule.change.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        objectId: existingAudit.targetId,
        objectVersionId: cleanString(existingAudit.data.objectVersionId) ?? null,
        version: typeof existingAudit.data.version === "number" ? existingAudit.data.version : null,
        decisionId: cleanString(existingAudit.data.decisionId) ?? null,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        externalExecution: "blocked",
      };
    }

    await Promise.all([
      assertRulePack(tx, rulePackId),
      assertTask(tx, operator.tenantId, taskId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
      assertCapability(tx, capabilityId),
    ]);

    const now = new Date();
    const changeData = {
      ...data,
      rulePackId: rulePackId ?? null,
      ruleKey,
      changeType,
      title,
      summary,
      state,
      sourceRefs,
      before,
      after,
      impact,
      taskId: taskId ?? null,
      workflowRunId: workflowRunId ?? null,
      capabilityId: capabilityId ?? null,
      effectiveAt: effectiveAt?.toISOString() ?? null,
      externalExecution: "blocked",
    };
    const [object] = await tx
      .insert(objects)
      .values({
        tenantId: operator.tenantId,
        type: "rule_change",
        name: title,
        state,
        source: ruleChangeSource,
        externalId: `${rulePackId ?? "unscoped"}:${ruleKey}:${changeType}:${input.idempotencyKey}`,
        data: changeData,
        createdByUserId: operator.userId,
        effectiveAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const versionNumber = await nextObjectVersion(tx, object.id);
    const [objectVersion] = await tx
      .insert(objectVersions)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        version: versionNumber,
        data: changeData,
        changedByType: "user",
        changedById: operator.userId,
        reason: rationale || "Rule change recorded",
      })
      .returning({ id: objectVersions.id, version: objectVersions.version });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "rule.change.recorded",
        source: ruleChangeSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:rule_change_recorded`,
        data: {
          ...changeData,
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [decision] = await tx
      .insert(decisions)
      .values({
        tenantId: operator.tenantId,
        taskId,
        eventId: event.id,
        workflowRunId,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        kind: "rule_change",
        state,
        decision: decisionValue,
        rationale,
        data: {
          ...changeData,
          objectId: object.id,
          objectVersionId: objectVersion.id,
        },
      })
      .returning({ id: decisions.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "rule.change.recorded",
        source: ruleChangeSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "object",
        targetId: object.id,
        taskId,
        eventId: event.id,
        objectId: object.id,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:rule_change_recorded`,
        data: {
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
          decisionId: decision.id,
          rulePackId: rulePackId ?? null,
          ruleKey,
          changeType,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [ruleEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Rule change recorded: ${title}`,
        objectId: object.id,
        taskId,
        eventId: event.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${ruleChangeSource}:${object.id}:recorded:${now.toISOString()}`,
        data: {
          auditEventId: audit.id,
          objectId: object.id,
          objectVersionId: objectVersion.id,
          decisionId: decision.id,
          rulePackId: rulePackId ?? null,
          ruleKey,
          changeType,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: evidence.id });

  return {
    created: true,
    objectId: object.id,
    objectVersionId: objectVersion.id,
    version: objectVersion.version,
    decisionId: decision.id,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: ruleEvidence.id,
    externalExecution: "blocked",
  };
}

export async function recordRuleChange(input: CoreRuleChangeRecordInput) {
  const db = input.db ?? defaultDb;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => recordRuleChangeForOperator(tx, operator, input));
}

export async function linkCoreObjects(input: CoreObjectLinkInput) {
  const db = input.db ?? defaultDb;
  const fromObjectId = requiredUuid(input.fromObjectId, "config.fromObjectId");
  const toObjectId = requiredUuid(input.toObjectId, "config.toObjectId");
  const type = requiredStringMax(input.type, "config.type", 80);
  const effectiveAt = optionalDate(input.effectiveAt, "config.effectiveAt");
  const endedAt = optionalDate(input.endedAt, "config.endedAt");
  const data = jsonObject(input.data);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("object.link", {
    fromObjectId,
    toObjectId,
    type,
    data,
    effectiveAt: effectiveAt?.toISOString() ?? null,
    endedAt: endedAt?.toISOString() ?? null,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${objectLinkSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, objectLinkSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:object_linked`),
          eq(auditEvents.targetType, "object_link"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "object.link",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [link] = await tx
        .select()
        .from(objectLinks)
        .where(
          and(
            eq(objectLinks.tenantId, operator.tenantId),
            eq(objectLinks.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (link) {
        return {
          created: false,
          updated: false,
          objectLinkId: link.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          link: {
            id: link.id,
            fromObjectId: link.fromId,
            toObjectId: link.toId,
            type: link.type,
          },
        };
      }
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, fromObjectId),
      assertObject(tx, operator.tenantId, toObjectId),
    ]);

    const [existingLink] = await tx
      .select()
      .from(objectLinks)
      .where(
        and(
          eq(objectLinks.tenantId, operator.tenantId),
          eq(objectLinks.fromId, fromObjectId),
          eq(objectLinks.toId, toObjectId),
          eq(objectLinks.type, type),
        ),
      )
      .limit(1);
    const [link] = existingLink
      ? await tx
          .update(objectLinks)
          .set({
            data,
            effectiveAt,
            endedAt,
          })
          .where(eq(objectLinks.id, existingLink.id))
          .returning()
      : await tx
          .insert(objectLinks)
          .values({
            tenantId: operator.tenantId,
            fromId: fromObjectId,
            toId: toObjectId,
            type,
            data,
            effectiveAt,
            endedAt,
          })
          .returning();
    const now = new Date();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingLink ? "object_link.updated" : "object_link.created",
        source: objectLinkSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: fromObjectId,
        idempotencyKey: `${input.idempotencyKey}:object_linked`,
        data: {
          objectLinkId: link.id,
          fromObjectId,
          toObjectId,
          type,
          endedAt: endedAt?.toISOString() ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingLink ? "object_link.updated" : "object_link.created",
        source: objectLinkSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "object_link",
        targetId: link.id,
        eventId: event.id,
        objectId: fromObjectId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:object_linked`,
        data: {
          objectLinkId: link.id,
          fromObjectId,
          toObjectId,
          type,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingLink,
      updated: Boolean(existingLink),
      objectLinkId: link.id,
      eventId: event.id,
      auditEventId: audit.id,
      link: {
        id: link.id,
        fromObjectId: link.fromId,
        toObjectId: link.toId,
        type: link.type,
      },
    };
  });
}

export async function recordCustomerSignal(input: CoreCustomerSignalRecordInput) {
  const db = input.db ?? defaultDb;
  const type = parseCustomerSignalType(requiredStringMax(input.type, "config.type", 80));
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "captured";
  const source = cleanString(input.source) ?? "operator_payload";
  const externalId = cleanString(input.externalId);
  const customerObjectId = optionalUuid(input.customerObjectId, "config.customerObjectId");
  const relatedObjectId = optionalUuid(input.relatedObjectId, "config.relatedObjectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const occurredAt = optionalDate(input.occurredAt, "config.occurredAt");
  const data = jsonObject(input.data);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("customer_signal.record", {
    type,
    name,
    state,
    source,
    externalId: externalId ?? null,
    customerObjectId: customerObjectId ?? null,
    relatedObjectId: relatedObjectId ?? null,
    taskId: taskId ?? null,
    eventId: eventId ?? null,
    data,
    occurredAt: occurredAt?.toISOString() ?? null,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${customerSignalSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, customerSignalSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:customer_signal_recorded`),
          eq(auditEvents.targetType, "customer_signal"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "customer_signal.record",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [signal] = await tx
        .select()
        .from(customerSignals)
        .where(
          and(
            eq(customerSignals.tenantId, operator.tenantId),
            eq(customerSignals.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (signal) {
        return {
          created: false,
          signalId: signal.id,
          objectId: signal.objectId,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          signal: {
            id: signal.id,
            type: signal.type,
            state: signal.state,
            objectId: signal.objectId,
            customerId: signal.customerId,
          },
        };
      }
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, customerObjectId),
      assertObject(tx, operator.tenantId, relatedObjectId),
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
    ]);

    const [customer] = customerObjectId
      ? await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, operator.tenantId),
              eq(customers.objectId, customerObjectId),
            ),
          )
          .limit(1)
      : [];

    if (customerObjectId && !customer) {
      throw new PlatformUnavailableError(
        "core_customer_not_found",
        "config.customerObjectId does not match a customer in this tenant.",
        404,
      );
    }

    const [object] = await tx
      .insert(objects)
      .values({
        tenantId: operator.tenantId,
        type,
        name,
        state,
        source,
        externalId,
        data,
        createdByUserId: operator.userId,
        effectiveAt: occurredAt,
      })
      .returning({ id: objects.id });

    const [signal] = await tx
      .insert(customerSignals)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        customerId: customer?.id,
        type,
        state,
        source,
        externalId,
        data,
        occurredAt,
      })
      .returning({ id: customerSignals.id });

    const linkValues = [
      ...(customerObjectId
        ? [
            {
              tenantId: operator.tenantId,
              fromId: object.id,
              toId: customerObjectId,
              type: "about_customer",
              data: { signalType: type },
            },
          ]
        : []),
      ...(relatedObjectId
        ? [
            {
              tenantId: operator.tenantId,
              fromId: object.id,
              toId: relatedObjectId,
              type: "about_work_item",
              data: { signalType: type },
            },
          ]
        : []),
    ];

    if (linkValues.length > 0) {
      await tx.insert(objectLinks).values(linkValues).onConflictDoNothing();
    }

    const now = new Date();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "customer_signal.recorded",
        source: customerSignalSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        taskId,
        idempotencyKey: `${input.idempotencyKey}:customer_signal_recorded`,
        data: {
          signalId: signal.id,
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          externalExecution: "blocked",
        },
        occurredAt: occurredAt ?? now,
      })
      .returning({ id: events.id });

    const [note] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "note",
        name: `Customer ${type.replaceAll("_", " ")}`,
        objectId: object.id,
        taskId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        data: {
          signalId: signal.id,
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          data,
        },
      })
      .returning({ id: evidence.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "customer_signal.recorded",
        source: customerSignalSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "customer_signal",
        targetId: signal.id,
        taskId,
        eventId: event.id,
        objectId: object.id,
        risk: type === "complaint" ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:customer_signal_recorded`,
        data: {
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          evidenceId: note.id,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      signalId: signal.id,
      objectId: object.id,
      eventId: event.id,
      evidenceId: note.id,
      auditEventId: audit.id,
      signal: {
        id: signal.id,
        type,
        state,
        objectId: object.id,
        customerId: customer?.id ?? null,
      },
    };
  });
}

export async function publishCoreView(input: CoreViewPublishInput) {
  const db = input.db ?? defaultDb;
  const key = requiredStringMax(input.key, "config.key", 140);
  const name = requiredString(input.name, "config.name");
  const purpose = requiredString(input.purpose, "config.purpose");
  const version = optionalStringMax(input.version, "config.version", 40) ?? "1.0.0";
  const surface = cleanString(input.surface) ?? "web";
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const objectType = optionalStringMax(input.objectType, "config.objectType", 80);
  const taskState = parseTaskState(cleanString(input.taskState));
  const active = input.active ?? true;
  const contract = jsonObject(input.contract);
  const actions = jsonObject(input.actions);
  const data = jsonObject(input.data);
  const mask = jsonObject(input.mask);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("view.publish", {
    key,
    name,
    purpose,
    version,
    surface,
    capabilityId: capabilityId ?? null,
    objectType: objectType ?? null,
    taskState: taskState ?? null,
    contract,
    actions,
    data,
    mask,
    active,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${viewSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, viewSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:view_published`),
          eq(auditEvents.targetType, "ui_contract"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      assertCoreIdempotencyReplay({
        command: "view.publish",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [view] = await tx
        .select()
        .from(uiContracts)
        .where(
          and(
            eq(uiContracts.tenantId, operator.tenantId),
            eq(uiContracts.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (view) {
        return {
          created: false,
          updated: false,
          viewId: view.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          view: {
            id: view.id,
            key: view.key,
            version: view.version,
            name: view.name,
            active: view.active,
          },
        };
      }
    }

    await assertCapability(tx, capabilityId);

    const [existingView] = await tx
      .select()
      .from(uiContracts)
      .where(
        and(
          eq(uiContracts.tenantId, operator.tenantId),
          eq(uiContracts.key, key),
          eq(uiContracts.version, version),
        ),
      )
      .limit(1);
    const now = new Date();
    const values = {
      capabilityId,
      key,
      version,
      name,
      purpose,
      surface,
      objectType,
      taskState,
      contract,
      actions,
      data,
      mask,
      active,
      updatedAt: now,
    };
    const [view] = existingView
      ? await tx.update(uiContracts).set(values).where(eq(uiContracts.id, existingView.id)).returning()
      : await tx
          .insert(uiContracts)
          .values({
            tenantId: operator.tenantId,
            ...values,
            createdAt: now,
          })
          .returning();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingView ? "view.updated" : "view.published",
        source: viewSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:view_published`,
        data: {
          viewId: view.id,
          key,
          version,
          name,
          purpose,
          surface,
          objectType: objectType ?? null,
          taskState: taskState ?? null,
          active,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingView ? "view.updated" : "view.published",
        source: viewSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "ui_contract",
        targetId: view.id,
        eventId: event.id,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:view_published`,
        data: {
          viewId: view.id,
          key,
          version,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingView,
      updated: Boolean(existingView),
      viewId: view.id,
      eventId: event.id,
      auditEventId: audit.id,
      view: {
        id: view.id,
        key: view.key,
        version: view.version,
        name: view.name,
        active: view.active,
      },
    };
  });
}
