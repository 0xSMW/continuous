import { count, eq, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  adapters,
  bankAccounts,
  budgetAccounts,
  capabilities,
  compensationAgreements,
  customers,
  decisions,
  documents,
  employments,
  evidence,
  evaluations,
  events,
  filingDrafts,
  filingRequirements,
  generatedViews,
  invoices,
  jobs,
  legalEntities,
  leads,
  obligations,
  paySchedules,
  paymentInstructions,
  payments,
  payrollRuns,
  people,
  quotes,
  rulePacks,
  tasks,
  tenants,
  usageEvents,
  workflowDefinitions,
  workflowRuns,
  workers,
} from "../db/schema";

type Database = typeof import("../db/client")["db"];

export type CoreSummary = {
  tenantName: string | null;
  counts: {
    tenants: number;
    legalEntities: number;
    people: number;
    employments: number;
    compensationAgreements: number;
    paySchedules: number;
    payrollRuns: number;
    rulePacks: number;
    obligations: number;
    filingRequirements: number;
    filingDrafts: number;
    bankAccounts: number;
    paymentInstructions: number;
    workflowDefinitions: number;
    workflowRuns: number;
    documents: number;
    decisions: number;
    evaluations: number;
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
    legalEntityCount,
    peopleCount,
    employmentCount,
    compensationCount,
    payScheduleCount,
    payrollRunCount,
    rulePackCount,
    obligationCount,
    filingRequirementCount,
    filingDraftCount,
    bankAccountCount,
    paymentInstructionCount,
    workflowDefinitionCount,
    workflowRunCount,
    documentCount,
    decisionCount,
    evaluationCount,
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
    tableCount(db, legalEntities),
    tableCount(db, people),
    tableCount(db, employments),
    tableCount(db, compensationAgreements),
    tableCount(db, paySchedules),
    tableCount(db, payrollRuns),
    tableCount(db, rulePacks),
    tableCount(db, obligations),
    tableCount(db, filingRequirements),
    tableCount(db, filingDrafts),
    tableCount(db, bankAccounts),
    tableCount(db, paymentInstructions),
    tableCount(db, workflowDefinitions),
    tableCount(db, workflowRuns),
    tableCount(db, documents),
    tableCount(db, decisions),
    tableCount(db, evaluations),
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
      legalEntities: legalEntityCount,
      people: peopleCount,
      employments: employmentCount,
      compensationAgreements: compensationCount,
      paySchedules: payScheduleCount,
      payrollRuns: payrollRunCount,
      rulePacks: rulePackCount,
      obligations: obligationCount,
      filingRequirements: filingRequirementCount,
      filingDrafts: filingDraftCount,
      bankAccounts: bankAccountCount,
      paymentInstructions: paymentInstructionCount,
      workflowDefinitions: workflowDefinitionCount,
      workflowRuns: workflowRunCount,
      documents: documentCount,
      decisions: decisionCount,
      evaluations: evaluationCount,
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
          legalEntities: 0,
          people: 0,
          employments: 0,
          compensationAgreements: 0,
          paySchedules: 0,
          payrollRuns: 0,
          rulePacks: 0,
          obligations: 0,
          filingRequirements: 0,
          filingDrafts: 0,
          bankAccounts: 0,
          paymentInstructions: 0,
          workflowDefinitions: 0,
          workflowRuns: 0,
          documents: 0,
          decisions: 0,
          evaluations: 0,
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
    hasEntity: summary.counts.legalEntities > 0 && summary.counts.bankAccounts > 0,
    hasWorkforce: summary.counts.people > 0 && summary.counts.employments > 0,
    hasPayroll: summary.counts.paySchedules > 0 && summary.counts.payrollRuns > 0,
    hasCompliance: summary.counts.rulePacks > 0 && summary.counts.obligations > 0,
    hasFilings: summary.counts.filingRequirements > 0 && summary.counts.filingDrafts > 0,
    hasWorkflows: summary.counts.workflowDefinitions > 0 && summary.counts.workflowRuns > 0,
    hasDocuments: summary.counts.documents > 0,
    hasEvaluations: summary.counts.evaluations > 0,
  };
}
