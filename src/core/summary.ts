import { count, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
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
  customerSignals,
  decisions,
  documents,
  employments,
  entityIdentifiers,
  evidence,
  evidencePackets,
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
  payrollLiabilities,
  payrollLines,
  payrollRuns,
  payrollStatements,
  payrollTraces,
  people,
  quotes,
  rulePacks,
  tasks,
  tenants,
  usageEvents,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
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
    payrollStatements: number;
    payrollLines: number;
    payrollLiabilities: number;
    payrollTraces: number;
    rulePacks: number;
    obligations: number;
    filingRequirements: number;
    filingDrafts: number;
    bankAccounts: number;
    paymentInstructions: number;
    workflowDefinitions: number;
    workflowRuns: number;
    workflowSteps: number;
    workerRuns: number;
    approvalRequests: number;
    auditEvents: number;
    objects: number;
    objectLinks: number;
    objectVersions: number;
    documents: number;
    decisions: number;
    evaluations: number;
    entityIdentifiers: number;
    customers: number;
    customerSignals: number;
    leads: number;
    offers: number;
    quotes: number;
    jobs: number;
    invoices: number;
    payments: number;
    tasks: number;
    evidence: number;
    evidencePackets: number;
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

async function tableCountWhere(db: Database, table: AnyPgTable, condition: SQL) {
  const rows = await db.select({ value: count() }).from(table).where(condition);
  return rows[0]?.value ?? 0;
}

function tenantCondition(table: AnyPgTable, tenantId: string) {
  return sql`${table}.tenant_id = ${tenantId}`;
}

async function tenantTableCount(db: Database, table: AnyPgTable, tenantId: string | null) {
  return tenantId ? tableCountWhere(db, table, tenantCondition(table, tenantId)) : tableCount(db, table);
}

export async function getCoreSummary(options: { tenantSlug?: string } = {}): Promise<CoreSummary> {
  const db = await getDb();
  const tenantRows = options.tenantSlug
    ? await db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.slug, options.tenantSlug))
        .limit(1)
    : await db.select({ id: tenants.id, name: tenants.name }).from(tenants).limit(1);

  if (options.tenantSlug && !tenantRows[0]) {
    throw new Error(`Tenant ${options.tenantSlug} was not found.`);
  }

  const tenantId = options.tenantSlug ? (tenantRows[0]?.id ?? null) : null;
  const tenantCount = tenantId ? 1 : await tableCount(db, tenants);
  const [
    legalEntityCount,
    peopleCount,
    employmentCount,
    compensationCount,
    payScheduleCount,
    payrollRunCount,
    payrollStatementCount,
    payrollLineCount,
    payrollLiabilityCount,
    payrollTraceCount,
    rulePackCount,
    obligationCount,
    filingRequirementCount,
    filingDraftCount,
    bankAccountCount,
    paymentInstructionCount,
    workflowDefinitionCount,
    workflowRunCount,
    workflowStepCount,
    workerRunCount,
    approvalRequestCount,
    auditEventCount,
    objectCount,
    objectLinkCount,
    objectVersionCount,
    documentCount,
    decisionCount,
    evaluationCount,
    entityIdentifierCount,
    customerCount,
    customerSignalCount,
    leadCount,
    offerCount,
    quoteCount,
    jobCount,
    invoiceCount,
    paymentCount,
    taskCount,
    evidenceCount,
    evidencePacketCount,
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
    tenantTableCount(db, legalEntities, tenantId),
    tenantTableCount(db, people, tenantId),
    tenantTableCount(db, employments, tenantId),
    tenantTableCount(db, compensationAgreements, tenantId),
    tenantTableCount(db, paySchedules, tenantId),
    tenantTableCount(db, payrollRuns, tenantId),
    tenantTableCount(db, payrollStatements, tenantId),
    tenantTableCount(db, payrollLines, tenantId),
    tenantTableCount(db, payrollLiabilities, tenantId),
    tenantTableCount(db, payrollTraces, tenantId),
    tableCount(db, rulePacks),
    tenantTableCount(db, obligations, tenantId),
    tenantTableCount(db, filingRequirements, tenantId),
    tenantTableCount(db, filingDrafts, tenantId),
    tenantTableCount(db, bankAccounts, tenantId),
    tenantTableCount(db, paymentInstructions, tenantId),
    tableCount(db, workflowDefinitions),
    tenantTableCount(db, workflowRuns, tenantId),
    tenantTableCount(db, workflowSteps, tenantId),
    tenantTableCount(db, workerRuns, tenantId),
    tenantTableCount(db, approvalRequests, tenantId),
    tenantTableCount(db, auditEvents, tenantId),
    tenantTableCount(db, objects, tenantId),
    tenantTableCount(db, objectLinks, tenantId),
    tenantTableCount(db, objectVersions, tenantId),
    tenantTableCount(db, documents, tenantId),
    tenantTableCount(db, decisions, tenantId),
    tenantTableCount(db, evaluations, tenantId),
    tenantTableCount(db, entityIdentifiers, tenantId),
    tenantTableCount(db, customers, tenantId),
    tenantTableCount(db, customerSignals, tenantId),
    tenantTableCount(db, leads, tenantId),
    tenantTableCount(db, offers, tenantId),
    tenantTableCount(db, quotes, tenantId),
    tenantTableCount(db, jobs, tenantId),
    tenantTableCount(db, invoices, tenantId),
    tenantTableCount(db, payments, tenantId),
    tenantTableCount(db, tasks, tenantId),
    tenantTableCount(db, evidence, tenantId),
    tenantTableCount(db, evidencePackets, tenantId),
    tenantTableCount(db, events, tenantId),
    tableCount(db, capabilities),
    tenantTableCount(db, capabilityGrants, tenantId),
    tenantTableCount(db, workers, tenantId),
    tableCount(db, modelProviders),
    tenantTableCount(db, modelRoutes, tenantId),
    tenantTableCount(db, budgetPolicies, tenantId),
    tenantTableCount(db, budgetPools, tenantId),
    tenantTableCount(db, budgetAccounts, tenantId),
    tenantTableCount(db, budgetAllocations, tenantId),
    tenantTableCount(db, budgetReservations, tenantId),
    tenantTableCount(db, usageEvents, tenantId),
    tenantTableCount(db, generatedViews, tenantId),
    tableCount(db, adapters),
    tenantTableCount(db, connections, tenantId),
    tenantTableCount(db, adapterRuns, tenantId),
    tenantTableCount(db, adapterActions, tenantId),
    tenantTableCount(db, inferences, tenantId),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
        ownerRef: tasks.ownerRef,
      })
      .from(tasks)
      .where(
        tenantId
          ? sql`${tasks.tenantId} = ${tenantId} and ${tasks.state} in ('active', 'waiting', 'approval_required', 'blocked')`
          : sql`${tasks.state} in ('active', 'waiting', 'approval_required', 'blocked')`,
      )
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
      .where(tenantId ? sql`${events.tenantId} = ${tenantId}` : sql`true`)
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
      payrollStatements: payrollStatementCount,
      payrollLines: payrollLineCount,
      payrollLiabilities: payrollLiabilityCount,
      payrollTraces: payrollTraceCount,
      rulePacks: rulePackCount,
      obligations: obligationCount,
      filingRequirements: filingRequirementCount,
      filingDrafts: filingDraftCount,
      bankAccounts: bankAccountCount,
      paymentInstructions: paymentInstructionCount,
      workflowDefinitions: workflowDefinitionCount,
      workflowRuns: workflowRunCount,
      workflowSteps: workflowStepCount,
      workerRuns: workerRunCount,
      approvalRequests: approvalRequestCount,
      auditEvents: auditEventCount,
      objects: objectCount,
      objectLinks: objectLinkCount,
      objectVersions: objectVersionCount,
      documents: documentCount,
      decisions: decisionCount,
      evaluations: evaluationCount,
      entityIdentifiers: entityIdentifierCount,
      customers: customerCount,
      customerSignals: customerSignalCount,
      leads: leadCount,
      offers: offerCount,
      quotes: quoteCount,
      jobs: jobCount,
      invoices: invoiceCount,
      payments: paymentCount,
      tasks: taskCount,
      evidence: evidenceCount,
      evidencePackets: evidencePacketCount,
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

export async function getCoreSummarySafe(options: { tenantSlug?: string } = {}): Promise<
  | { ok: true; summary: CoreSummary; error: null }
  | { ok: false; summary: CoreSummary; error: string }
> {
  try {
    return { ok: true, summary: await getCoreSummary(options), error: null };
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
          payrollStatements: 0,
          payrollLines: 0,
          payrollLiabilities: 0,
          payrollTraces: 0,
          rulePacks: 0,
          obligations: 0,
          filingRequirements: 0,
          filingDrafts: 0,
          bankAccounts: 0,
          paymentInstructions: 0,
          workflowDefinitions: 0,
          workflowRuns: 0,
          workflowSteps: 0,
          workerRuns: 0,
          approvalRequests: 0,
          auditEvents: 0,
          objects: 0,
          objectLinks: 0,
          objectVersions: 0,
          documents: 0,
          decisions: 0,
          evaluations: 0,
          entityIdentifiers: 0,
          customers: 0,
          customerSignals: 0,
          leads: 0,
          offers: 0,
          quotes: 0,
          jobs: 0,
          invoices: 0,
          payments: 0,
          tasks: 0,
          evidence: 0,
          evidencePackets: 0,
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
    summary.counts.customerSignals +
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
      summary.counts.budgetAccounts > 0 &&
      summary.counts.budgetReservations > 0,
    hasAiGateway:
      summary.counts.modelProviders > 0 &&
      summary.counts.modelRoutes > 0 &&
      summary.counts.inferences > 0 &&
      summary.counts.usageEvents > 0,
    hasAdapterLedger: summary.counts.adapters > 0 && summary.counts.connections > 0,
    hasEntity: summary.counts.legalEntities > 0 && summary.counts.bankAccounts > 0,
    hasCustomerSignals: summary.counts.customerSignals > 0,
    hasWorkforce: summary.counts.people > 0 && summary.counts.employments > 0,
    hasPayroll:
      summary.counts.paySchedules > 0 &&
      summary.counts.payrollRuns > 0 &&
      summary.counts.payrollStatements > 0 &&
      summary.counts.payrollLines > 0 &&
      summary.counts.payrollLiabilities > 0 &&
      summary.counts.payrollTraces > 0,
    hasCompliance: summary.counts.rulePacks > 0 && summary.counts.obligations > 0,
    hasFilings: summary.counts.filingRequirements > 0 && summary.counts.filingDrafts > 0,
    hasWorkflows:
      summary.counts.workflowDefinitions > 0 &&
      summary.counts.workflowRuns > 0 &&
      summary.counts.workflowSteps > 0,
    hasWorkflowSteps: summary.counts.workflowSteps > 0,
    hasWorkerRuns: summary.counts.workerRuns > 0,
    hasAuthority: summary.counts.approvalRequests > 0 && summary.counts.auditEvents > 0,
    hasDocuments: summary.counts.documents > 0,
    hasEvaluations: summary.counts.evaluations > 0,
  };
}
