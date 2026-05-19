import { count, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  adapterActions,
  adapterRuns,
  adapters,
  bankAccounts,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetPools,
  budgetReservations,
  capabilities,
  capabilityGrants,
  compensationAgreements,
  connections,
  customers,
  decisions,
  documents,
  employments,
  entityIdentifiers,
  evidence,
  evaluations,
  events,
  filingDrafts,
  filingRequirements,
  generatedViews,
  inferences,
  invoices,
  jobs,
  legalEntities,
  leads,
  modelProviders,
  modelRoutes,
  objectLinks,
  objectVersions,
  objects,
  obligations,
  offers,
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
  workerRuns,
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
    workerRuns: number;
    objects: number;
    objectLinks: number;
    objectVersions: number;
    documents: number;
    decisions: number;
    evaluations: number;
    entityIdentifiers: number;
    customers: number;
    leads: number;
    offers: number;
    quotes: number;
    jobs: number;
    invoices: number;
    payments: number;
    tasks: number;
    evidence: number;
    events: number;
    capabilities: number;
    capabilityGrants: number;
    workers: number;
    modelProviders: number;
    modelRoutes: number;
    budgetPolicies: number;
    budgetPools: number;
    budgetAccounts: number;
    budgetAllocations: number;
    budgetReservations: number;
    usageEvents: number;
    generatedViews: number;
    adapters: number;
    connections: number;
    adapterRuns: number;
    adapterActions: number;
    inferences: number;
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
    workerRunCount,
    objectCount,
    objectLinkCount,
    objectVersionCount,
    documentCount,
    decisionCount,
    evaluationCount,
    entityIdentifierCount,
    customerCount,
    leadCount,
    offerCount,
    quoteCount,
    jobCount,
    invoiceCount,
    paymentCount,
    taskCount,
    evidenceCount,
    eventCount,
    capabilityCount,
    capabilityGrantCount,
    workerCount,
    modelProviderCount,
    modelRouteCount,
    budgetPolicyCount,
    budgetPoolCount,
    budgetCount,
    budgetAllocationCount,
    budgetReservationCount,
    usageCount,
    viewCount,
    adapterCount,
    connectionCount,
    adapterRunCount,
    adapterActionCount,
    inferenceCount,
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
    tableCount(db, workerRuns),
    tableCount(db, objects),
    tableCount(db, objectLinks),
    tableCount(db, objectVersions),
    tableCount(db, documents),
    tableCount(db, decisions),
    tableCount(db, evaluations),
    tableCount(db, entityIdentifiers),
    tableCount(db, customers),
    tableCount(db, leads),
    tableCount(db, offers),
    tableCount(db, quotes),
    tableCount(db, jobs),
    tableCount(db, invoices),
    tableCount(db, payments),
    tableCount(db, tasks),
    tableCount(db, evidence),
    tableCount(db, events),
    tableCount(db, capabilities),
    tableCount(db, capabilityGrants),
    tableCount(db, workers),
    tableCount(db, modelProviders),
    tableCount(db, modelRoutes),
    tableCount(db, budgetPolicies),
    tableCount(db, budgetPools),
    tableCount(db, budgetAccounts),
    tableCount(db, budgetAllocations),
    tableCount(db, budgetReservations),
    tableCount(db, usageEvents),
    tableCount(db, generatedViews),
    tableCount(db, adapters),
    tableCount(db, connections),
    tableCount(db, adapterRuns),
    tableCount(db, adapterActions),
    tableCount(db, inferences),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
        ownerRef: tasks.ownerRef,
      })
      .from(tasks)
      .where(sql`${tasks.state} in ('active', 'waiting', 'approval_required', 'blocked')`)
      .orderBy(sql`${tasks.updatedAt} desc`)
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
      workerRuns: workerRunCount,
      objects: objectCount,
      objectLinks: objectLinkCount,
      objectVersions: objectVersionCount,
      documents: documentCount,
      decisions: decisionCount,
      evaluations: evaluationCount,
      entityIdentifiers: entityIdentifierCount,
      customers: customerCount,
      leads: leadCount,
      offers: offerCount,
      quotes: quoteCount,
      jobs: jobCount,
      invoices: invoiceCount,
      payments: paymentCount,
      tasks: taskCount,
      evidence: evidenceCount,
      events: eventCount,
      capabilities: capabilityCount,
      capabilityGrants: capabilityGrantCount,
      workers: workerCount,
      modelProviders: modelProviderCount,
      modelRoutes: modelRouteCount,
      budgetPolicies: budgetPolicyCount,
      budgetPools: budgetPoolCount,
      budgetAccounts: budgetCount,
      budgetAllocations: budgetAllocationCount,
      budgetReservations: budgetReservationCount,
      usageEvents: usageCount,
      generatedViews: viewCount,
      adapters: adapterCount,
      connections: connectionCount,
      adapterRuns: adapterRunCount,
      adapterActions: adapterActionCount,
      inferences: inferenceCount,
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
          workerRuns: 0,
          objects: 0,
          objectLinks: 0,
          objectVersions: 0,
          documents: 0,
          decisions: 0,
          evaluations: 0,
          entityIdentifiers: 0,
          customers: 0,
          leads: 0,
          offers: 0,
          quotes: 0,
          jobs: 0,
          invoices: 0,
          payments: 0,
          tasks: 0,
          evidence: 0,
          events: 0,
          capabilities: 0,
          capabilityGrants: 0,
          workers: 0,
          modelProviders: 0,
          modelRoutes: 0,
          budgetPolicies: 0,
          budgetPools: 0,
          budgetAccounts: 0,
          budgetAllocations: 0,
          budgetReservations: 0,
          usageEvents: 0,
          generatedViews: 0,
          adapters: 0,
          connections: 0,
          adapterRuns: 0,
          adapterActions: 0,
          inferences: 0,
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
    summary.counts.objects +
    summary.counts.customers +
    summary.counts.leads +
    summary.counts.offers +
    summary.counts.quotes +
    summary.counts.jobs +
    summary.counts.invoices +
    summary.counts.payments;

  return {
    hasTenant: summary.counts.tenants > 0,
    hasGraph: persistedObjects > 0,
    hasObjectSpine: summary.counts.objects > 0 && summary.counts.objectVersions > 0,
    hasTaskLedger: summary.counts.tasks > 0,
    hasCapabilities: summary.counts.capabilities > 0,
    hasEvidence: summary.counts.evidence > 0,
    hasBudgets:
      summary.counts.budgetPolicies > 0 &&
      summary.counts.budgetAllocations > 0 &&
      summary.counts.budgetAccounts > 0,
    hasAiGateway:
      summary.counts.modelProviders > 0 &&
      summary.counts.modelRoutes > 0 &&
      summary.counts.budgetAccounts > 0,
    hasAdapterLedger: summary.counts.adapters > 0 && summary.counts.connections > 0,
    hasEntity: summary.counts.legalEntities > 0 && summary.counts.bankAccounts > 0,
    hasWorkforce: summary.counts.people > 0 && summary.counts.employments > 0,
    hasPayroll: summary.counts.paySchedules > 0 && summary.counts.payrollRuns > 0,
    hasCompliance: summary.counts.rulePacks > 0 && summary.counts.obligations > 0,
    hasFilings: summary.counts.filingRequirements > 0 && summary.counts.filingDrafts > 0,
    hasWorkflows: summary.counts.workflowDefinitions > 0 && summary.counts.workflowRuns > 0,
    hasWorkerRuns: summary.counts.workerRuns > 0,
    hasDocuments: summary.counts.documents > 0,
    hasEvaluations: summary.counts.evaluations > 0,
  };
}
