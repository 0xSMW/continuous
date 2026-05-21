import { and, eq } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import { tenants, users } from "../db/schema";
import { PlatformUnavailableError } from "./errors";

type Database = typeof defaultDb;

export type OperatorContext = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  email: string;
  name: string;
  actorRef: string;
};

export async function loadOperatorContext(input: {
  operatorEmail: string;
  tenantSlug?: string;
  db?: Database;
}): Promise<OperatorContext> {
  const db = input.db ?? defaultDb;
  const email = input.operatorEmail.trim().toLowerCase();
  const conditions = [eq(users.email, email), eq(users.state, "active")];

  if (input.tenantSlug) {
    conditions.push(eq(tenants.slug, input.tenantSlug));
  }

  const rows = await db
    .select({
      tenantId: users.tenantId,
      tenantSlug: tenants.slug,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(...conditions))
    .orderBy(users.createdAt)
    .limit(2);

  if (rows.length === 0) {
    throw new PlatformUnavailableError(
      "operator_not_found",
      "Operator access requires an active user for the configured email.",
      403,
    );
  }

  if (rows.length > 1 && !input.tenantSlug) {
    throw new PlatformUnavailableError(
      "operator_tenant_ambiguous",
      "Multiple tenant memberships match this operator email. Provide a tenantSlug.",
      409,
    );
  }

  const operator = rows[0];

  return {
    tenantId: operator.tenantId,
    tenantSlug: operator.tenantSlug,
    userId: operator.userId,
    email: operator.email,
    name: operator.name,
    actorRef: `user:${operator.userId}`,
  };
}
