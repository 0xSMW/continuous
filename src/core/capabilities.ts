import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  capabilities,
  capabilityGrants,
  events,
  evidence,
  users,
  workers,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type ActorType = "user" | "worker";

const source = "continuous.core.capabilities";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorTypes = new Set<ActorType>(["user", "worker"]);
const protectedCapabilityClasses = new Set(["money", "reveal"]);
const protectedSideEffects = new Set(["financial", "regulated"]);
const protectedRisks = new Set(["high", "critical"]);

export type CapabilityGrantInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  capabilityId?: string;
  capabilityKey?: string;
  capabilityVersion?: string;
  actor?: JsonObject;
  scope?: JsonObject;
  policy?: JsonObject;
  active?: boolean;
  startsAt?: string;
  endsAt?: string;
  approvalRequestId?: string;
  reason?: string;
  db?: Database;
};

export type CapabilityGrantResult = {
  granted: boolean;
  created: boolean;
  updated: boolean;
  capabilityGrantId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  grant: {
    id: string;
    capabilityId: string;
    capabilityKey: string;
    actor: {
      type: ActorType;
      id: string;
      ref: string;
    };
    active: boolean;
    startsAt: string | null;
    endsAt: string | null;
  };
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("capability_field_required", `${field} is required.`, 400);
  }

  return output;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError(
      "capability_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return value;
}

function jsonObject(value: JsonObject | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalDate(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("capability_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function actorFrom(value: JsonObject | undefined) {
  const actor = jsonObject(value);
  const type = requiredString(actor.type, "config.actor.type");
  const id = optionalUuid(requiredString(actor.id, "config.actor.id"), "config.actor.id");

  if (!actorTypes.has(type as ActorType)) {
    throw new PlatformUnavailableError(
      "capability_actor_type_invalid",
      "config.actor.type must be user or worker.",
      400,
    );
  }

  return {
    type: type as ActorType,
    id,
    ref: cleanString(actor.ref) ?? `${type}:${id}`,
  };
}

function grantView(
  grant: typeof capabilityGrants.$inferSelect,
  capabilityKey: string,
  actor: { type: ActorType; id: string; ref: string },
) {
  return {
    id: grant.id,
    capabilityId: grant.capabilityId,
    capabilityKey,
    actor,
    active: grant.active,
    startsAt: grant.startsAt?.toISOString() ?? null,
    endsAt: grant.endsAt?.toISOString() ?? null,
  };
}

function requiresApprovedRequest(capability: typeof capabilities.$inferSelect) {
  return (
    protectedRisks.has(capability.risk) ||
    protectedCapabilityClasses.has(capability.class) ||
    protectedSideEffects.has(capability.sideEffect)
  );
}

async function assertActor(
  tx: Pick<Database, "select">,
  tenantId: string,
  actor: { type: ActorType; id: string },
) {
  if (actor.type === "user") {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, actor.id), eq(users.state, "active")))
      .limit(1);

    if (!user) {
      throw new PlatformUnavailableError(
        "capability_actor_not_found",
        "config.actor.id does not match an active user in this tenant.",
        404,
      );
    }
  }

  if (actor.type === "worker") {
    const [worker] = await tx
      .select({ id: workers.id })
      .from(workers)
      .where(
        and(
          eq(workers.tenantId, tenantId),
          eq(workers.id, actor.id),
          sql`${workers.state} in ('training', 'active', 'paused')`,
        ),
      )
      .limit(1);

    if (!worker) {
      throw new PlatformUnavailableError(
        "capability_actor_not_found",
        "config.actor.id does not match a grantable worker in this tenant.",
        404,
      );
    }
  }

}

async function assertApprovedRequest(input: {
  tx: Pick<Database, "select">;
  tenantId: string;
  approvalRequestId?: string;
  capabilityId: string;
}) {
  const approvalRequestId = optionalUuid(input.approvalRequestId, "config.approvalRequestId");

  if (!approvalRequestId) {
    throw new PlatformUnavailableError(
      "capability_approval_required",
      "High-risk capability grants require config.approvalRequestId for an approved approval request.",
      403,
    );
  }

  const [approval] = await input.tx
    .select({
      id: approvalRequests.id,
      state: approvalRequests.state,
      capabilityId: approvalRequests.capabilityId,
    })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, input.tenantId), eq(approvalRequests.id, approvalRequestId)))
    .limit(1);

  if (!approval || approval.state !== "approved") {
    throw new PlatformUnavailableError(
      "capability_approval_missing",
      "config.approvalRequestId must reference an approved approval request in this tenant.",
      403,
    );
  }

  if (approval.capabilityId && approval.capabilityId !== input.capabilityId) {
    throw new PlatformUnavailableError(
      "capability_approval_mismatch",
      "config.approvalRequestId references a different capability.",
      409,
    );
  }
}

export async function grantCapability(input: CapabilityGrantInput): Promise<CapabilityGrantResult> {
  const db = input.db ?? defaultDb;
  const requestedCapabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const capabilityKey = cleanString(input.capabilityKey);
  const capabilityVersion = cleanString(input.capabilityVersion) ?? "1.0.0";
  const actor = actorFrom(input.actor);
  const active = input.active ?? true;
  const startsAt = optionalDate(cleanString(input.startsAt), "config.startsAt");
  const endsAt = optionalDate(cleanString(input.endsAt), "config.endsAt");
  const reason = requiredString(input.reason, "config.reason");

  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new PlatformUnavailableError(
      "capability_window_invalid",
      "config.startsAt must be before config.endsAt.",
      400,
    );
  }

  if (!requestedCapabilityId && !capabilityKey) {
    throw new PlatformUnavailableError(
      "capability_reference_required",
      "config.capabilityId or config.capabilityKey is required.",
      400,
    );
  }

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
        eventId: auditEvents.eventId,
        targetId: auditEvents.targetId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:capability_granted`),
          eq(auditEvents.targetType, "capability_grant"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [grant] = await tx
        .select({ grant: capabilityGrants, capabilityKey: capabilities.key })
        .from(capabilityGrants)
        .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
        .where(and(eq(capabilityGrants.tenantId, operator.tenantId), eq(capabilityGrants.id, existingAudit.targetId)))
        .limit(1);
      const [grantEvidence] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.tenantId, operator.tenantId),
            sql`${evidence.data}->>'auditEventId' = ${existingAudit.auditEventId}`,
          ),
        )
        .limit(1);

      if (grant) {
        return {
          granted: false,
          created: false,
          updated: false,
          capabilityGrantId: grant.grant.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: grantEvidence?.id ?? null,
          grant: grantView(grant.grant, grant.capabilityKey, actor),
        };
      }
    }

    const capabilityConditions = requestedCapabilityId
      ? [eq(capabilities.id, requestedCapabilityId)]
      : [eq(capabilities.key, capabilityKey ?? ""), eq(capabilities.version, capabilityVersion)];
    const [capability] = await tx
      .select()
      .from(capabilities)
      .where(and(...capabilityConditions, eq(capabilities.active, true)))
      .limit(1);

    if (!capability) {
      throw new PlatformUnavailableError(
        "capability_not_found",
        "config.capabilityId or config.capabilityKey does not match an active capability.",
        404,
      );
    }

    await assertActor(tx, operator.tenantId, actor);

    if (active && requiresApprovedRequest(capability)) {
      await assertApprovedRequest({
        tx,
        tenantId: operator.tenantId,
        approvalRequestId: cleanString(input.approvalRequestId),
        capabilityId: capability.id,
      });
    }

    const [existingGrant] = await tx
      .select()
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.tenantId, operator.tenantId),
          eq(capabilityGrants.actorType, actor.type),
          eq(capabilityGrants.actorId, actor.id),
          eq(capabilityGrants.capabilityId, capability.id),
        ),
      )
      .limit(1);
    const now = new Date();
    const values = {
      scope: jsonObject(input.scope),
      policy: jsonObject(input.policy),
      active,
      startsAt,
      endsAt,
      updatedAt: now,
    };
    const [grant] = existingGrant
      ? await tx
          .update(capabilityGrants)
          .set(values)
          .where(eq(capabilityGrants.id, existingGrant.id))
          .returning()
      : await tx
          .insert(capabilityGrants)
          .values({
            tenantId: operator.tenantId,
            capabilityId: capability.id,
            actorType: actor.type,
            actorId: actor.id,
            ...values,
            createdAt: now,
          })
          .returning();
    const grantData = {
      capabilityGrantId: grant.id,
      capabilityId: capability.id,
      capabilityKey: capability.key,
      actor,
      active,
      startsAt: startsAt?.toISOString() ?? null,
      endsAt: endsAt?.toISOString() ?? null,
      reason,
      approvalRequestId: cleanString(input.approvalRequestId) ?? null,
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingGrant ? "capability.grant.updated" : "capability.granted",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        capabilityId: capability.id,
        idempotencyKey: `${input.idempotencyKey}:capability_granted`,
        data: grantData,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingGrant ? "capability.grant.updated" : "capability.granted",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "capability_grant",
        targetId: grant.id,
        eventId: event.id,
        capabilityId: capability.id,
        risk: capability.risk,
        idempotencyKey: `${input.idempotencyKey}:capability_granted`,
        data: grantData,
      })
      .returning({ id: auditEvents.id });
    const [grantEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Capability grant ${capability.key} to ${actor.ref}`,
        eventId: event.id,
        capabilityId: capability.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${grant.id}:${now.toISOString()}`,
        data: {
          ...grantData,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });

    return {
      granted: true,
      created: !existingGrant,
      updated: Boolean(existingGrant),
      capabilityGrantId: grant.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: grantEvidence.id,
      grant: grantView(grant, capability.key, actor),
    };
  });
}
