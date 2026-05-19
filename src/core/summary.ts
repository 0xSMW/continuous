import { count, eq, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  adapters,
  budgetAccounts,
  capabilities,
  customers,
  evidence,
  events,
  generatedViews,
  invoices,
  jobs,
  leads,
  payments,
  quotes,
  tasks,
  tenants,
  usageEvents,
  workers,
} from "../db/schema";

type Database = typeof import("../db/client")["db"];

export type CoreSummary = {
  tenantName: string | null;
  counts: {
    tenants: number;
    customers: number;
    leads: number;
    quotes: number;
    jobs: number;
    invoices: number;
    payments: number;
    tasks: number;
    evidence: number;
    events: number;
    capabilities: number;
    workers: number;
    budgetAccounts: number;
    usageEvents: number;
    generatedViews: number;
    adapters: number;
  };
  activeTasks: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    ownerRef: string;
  }>;
  recentEvents: Array<{
    id: string;
    type: string;
    source: string;
    actorRef: string;
    occurredAt: string;
  }>;
};

async function getDb(): Promise<Database> {
  const client = await import("../db/client");
  return client.db;
}

async function tableCount(db: Database, table: AnyPgTable) {
  const rows = await db.select({ value: count() }).from(table);
  return rows[0]?.value ?? 0;
}

export async function getCoreSummary(): Promise<CoreSummary> {
  const db = await getDb();
  const [
    tenantRows,
    tenantCount,
    customerCount,
    leadCount,
    quoteCount,
    jobCount,
    invoiceCount,
    paymentCount,
    taskCount,
    evidenceCount,
    eventCount,
    capabilityCount,
    workerCount,
    budgetCount,
    usageCount,
    viewCount,
    adapterCount,
    activeTasks,
    recentEvents,
  ] = await Promise.all([
    db.select({ name: tenants.name }).from(tenants).limit(1),
    tableCount(db, tenants),
    tableCount(db, customers),
    tableCount(db, leads),
    tableCount(db, quotes),
    tableCount(db, jobs),
    tableCount(db, invoices),
    tableCount(db, payments),
    tableCount(db, tasks),
    tableCount(db, evidence),
    tableCount(db, events),
    tableCount(db, capabilities),
    tableCount(db, workers),
    tableCount(db, budgetAccounts),
    tableCount(db, usageEvents),
    tableCount(db, generatedViews),
    tableCount(db, adapters),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
        ownerRef: tasks.ownerRef,
      })
      .from(tasks)
      .where(eq(tasks.state, "active"))
      .orderBy(sql`${tasks.createdAt} desc`)
      .limit(5),
    db
      .select({
        id: events.id,
        type: events.type,
        source: events.source,
        actorRef: events.actorRef,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .orderBy(sql`${events.occurredAt} desc`)
      .limit(5),
  ]);

  return {
    tenantName: tenantRows[0]?.name ?? null,
    counts: {
      tenants: tenantCount,
      customers: customerCount,
      leads: leadCount,
      quotes: quoteCount,
      jobs: jobCount,
      invoices: invoiceCount,
      payments: paymentCount,
      tasks: taskCount,
      evidence: evidenceCount,
      events: eventCount,
      capabilities: capabilityCount,
      workers: workerCount,
      budgetAccounts: budgetCount,
      usageEvents: usageCount,
      generatedViews: viewCount,
      adapters: adapterCount,
    },
    activeTasks: activeTasks.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      priority: task.priority,
      ownerRef: task.ownerRef,
    })),
    recentEvents: recentEvents.map((event) => ({
      id: event.id,
      type: event.type,
      source: event.source,
      actorRef: event.actorRef,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}

export async function getCoreSummarySafe(): Promise<
  | { ok: true; summary: CoreSummary; error: null }
  | { ok: false; summary: CoreSummary; error: string }
> {
  try {
    return { ok: true, summary: await getCoreSummary(), error: null };
  } catch (error) {
    return {
      ok: false,
      summary: {
        tenantName: null,
        counts: {
          tenants: 0,
          customers: 0,
          leads: 0,
          quotes: 0,
          jobs: 0,
          invoices: 0,
          payments: 0,
          tasks: 0,
          evidence: 0,
          events: 0,
          capabilities: 0,
          workers: 0,
          budgetAccounts: 0,
          usageEvents: 0,
          generatedViews: 0,
          adapters: 0,
        },
        activeTasks: [],
        recentEvents: [],
      },
      error: error instanceof Error ? error.message : "Unknown database error",
    };
  }
}

export function summarizeCoreReadiness(summary: CoreSummary) {
  const persistedObjects =
    summary.counts.customers +
    summary.counts.leads +
    summary.counts.quotes +
    summary.counts.jobs +
    summary.counts.invoices +
    summary.counts.payments;

  return {
    hasTenant: summary.counts.tenants > 0,
    hasGraph: persistedObjects > 0,
    hasTaskLedger: summary.counts.tasks > 0,
    hasCapabilities: summary.counts.capabilities > 0,
    hasEvidence: summary.counts.evidence > 0,
    hasBudgets: summary.counts.budgetAccounts > 0,
  };
}
