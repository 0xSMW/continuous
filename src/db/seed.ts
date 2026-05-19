import { db, pool } from "./client";
import {
  adapters,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetPools,
  capabilities,
  capabilityGrants,
  connections,
  customers,
  evidence,
  events,
  generatedViews,
  invoices,
  jobs,
  leads,
  modelProviders,
  modelRoutes,
  objectLinks,
  objectVersions,
  objects,
  offers,
  payments,
  quotes,
  tasks,
  tenants,
  usageEvents,
  users,
  workers,
} from "./schema";

const ids = {
  tenant: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  worker: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  adapter: "56565656-5656-4565-8565-565656565656",
  connection: "78787878-7878-4787-8787-787878787878",
  provider: "91919191-9191-4919-8919-919191919191",
  route: "92929292-9292-4929-8929-929292929292",
  budgetPolicy: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
  budgetPool: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
  budgetAccount: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
  budgetAllocation: "bbbbbbbb-bbbb-4bbb-8bbb-000000000004",
  customerObject: "33333333-3333-4333-8333-000000000001",
  leadObject: "33333333-3333-4333-8333-000000000002",
  offerObject: "33333333-3333-4333-8333-000000000003",
  quoteObject: "33333333-3333-4333-8333-000000000004",
  jobObject: "33333333-3333-4333-8333-000000000005",
  invoiceObject: "33333333-3333-4333-8333-000000000006",
  paymentObject: "33333333-3333-4333-8333-000000000007",
  customer: "44444444-4444-4444-8444-000000000001",
  lead: "44444444-4444-4444-8444-000000000002",
  offer: "44444444-4444-4444-8444-000000000003",
  quote: "44444444-4444-4444-8444-000000000004",
  job: "44444444-4444-4444-8444-000000000005",
  invoice: "44444444-4444-4444-8444-000000000006",
  payment: "44444444-4444-4444-8444-000000000007",
  eventLead: "cccccccc-cccc-4ccc-8ccc-000000000001",
  eventQuote: "cccccccc-cccc-4ccc-8ccc-000000000002",
  taskQuote: "dddddddd-dddd-4ddd-8ddd-000000000001",
  taskInvoice: "dddddddd-dddd-4ddd-8ddd-000000000002",
  evidenceLead: "eeeeeeee-eeee-4eee-8eee-000000000001",
  evidenceQuote: "eeeeeeee-eeee-4eee-8eee-000000000002",
  usage: "12121212-1212-4121-8121-121212121212",
  view: "34343434-3434-4343-8343-343434343434",
};

const capIds = {
  leadRead: "10000000-0000-4000-8000-000000000001",
  leadClassify: "10000000-0000-4000-8000-000000000002",
  responseDraft: "10000000-0000-4000-8000-000000000003",
  quotePrepare: "10000000-0000-4000-8000-000000000004",
  schedulePropose: "10000000-0000-4000-8000-000000000005",
  invoicePrepare: "10000000-0000-4000-8000-000000000006",
  paymentLinkPrepare: "10000000-0000-4000-8000-000000000007",
  ownerBriefGenerate: "10000000-0000-4000-8000-000000000008",
};

async function seed() {
  await db
    .insert(tenants)
    .values({
      id: ids.tenant,
      slug: "continuous-demo",
      name: "Continuous Demo Company",
      state: "active",
      timezone: "America/New_York",
      settings: { vertical: "service_smb", domain: "continuoushq.com" },
    })
    .onConflictDoNothing();

  await db
    .insert(users)
    .values({
      id: ids.owner,
      tenantId: ids.tenant,
      email: "owner@continuoushq.com",
      name: "Owner",
      role: "owner",
      state: "active",
    })
    .onConflictDoNothing();

  await db
    .insert(workers)
    .values({
      id: ids.worker,
      tenantId: ids.tenant,
      managerUserId: ids.owner,
      kind: "agent",
      state: "training",
      name: "Revenue Operations Worker",
      role: "revenue_operations",
      mission:
        "Convert inbound demand into quoted, scheduled, invoiced, collected revenue while keeping the owner in control.",
      autonomyLevel: 2,
      scope: { flows: ["lead_to_cash", "quote_to_cash"], systems: ["website_form"] },
      memory: { customer_memory: "scoped", no_memory_zones: ["payment_credentials"] },
      policy: { money_movement: "approval_required", external_send: "approval_required" },
      kpis: { leads_answered: 0, quotes_prepared: 1, owner_hours_saved: 0.3 },
    })
    .onConflictDoNothing();

  await db
    .insert(capabilities)
    .values([
      {
        id: capIds.leadRead,
        key: "lead.read",
        name: "Read lead",
        class: "read",
        risk: "low",
        sideEffect: "none",
        description: "Read scoped lead messages and source metadata.",
        evidence: { required: ["source_message_snapshot"] },
      },
      {
        id: capIds.leadClassify,
        key: "lead.classify",
        name: "Classify lead",
        class: "classify",
        risk: "low",
        sideEffect: "internal",
        description: "Classify customer intent, urgency, service fit, and missing facts.",
        evidence: { required: ["source_message_snapshot", "classification_reason"] },
      },
      {
        id: capIds.responseDraft,
        key: "response.draft",
        name: "Draft response",
        class: "draft",
        risk: "low",
        sideEffect: "internal",
        description: "Draft a customer response using approved business context and templates.",
        evidence: { required: ["source_message_snapshot", "drafted_response"] },
      },
      {
        id: capIds.quotePrepare,
        key: "quote.prepare",
        name: "Prepare quote",
        class: "draft",
        risk: "medium",
        sideEffect: "internal",
        description: "Prepare a quote from offer, scope, pricing rules, and prior work.",
        evidence: { required: ["customer_request", "offer_version", "price_rule_version", "quote_draft"] },
      },
      {
        id: capIds.schedulePropose,
        key: "schedule.propose",
        name: "Propose schedule",
        class: "draft",
        risk: "medium",
        sideEffect: "internal",
        description: "Propose available appointment windows without committing external calendars.",
        evidence: { required: ["availability_snapshot", "proposal_message"] },
      },
      {
        id: capIds.invoicePrepare,
        key: "invoice.prepare",
        name: "Prepare invoice",
        class: "task",
        risk: "medium",
        sideEffect: "internal",
        description: "Prepare invoice details for approved or completed work.",
        evidence: { required: ["job_closeout", "invoice_draft"] },
      },
      {
        id: capIds.paymentLinkPrepare,
        key: "payment_link.prepare",
        name: "Prepare payment link",
        class: "money",
        risk: "high",
        sideEffect: "financial",
        description: "Prepare payment collection details without moving money autonomously.",
        rules: { approval_required: true },
        evidence: { required: ["invoice_draft", "manager_approval"] },
      },
      {
        id: capIds.ownerBriefGenerate,
        key: "owner_brief.generate",
        name: "Generate owner brief",
        class: "draft",
        risk: "low",
        sideEffect: "internal",
        description: "Summarize leads, quote progress, cash, exceptions, and decisions.",
        evidence: { required: ["task_rollup", "kpi_snapshot"] },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(capabilityGrants)
    .values(Object.values(capIds).map((capabilityId) => ({
      tenantId: ids.tenant,
      capabilityId,
      actorType: "worker" as const,
      actorId: ids.worker,
      scope: { tenant_id: ids.tenant },
      policy: { mode: "simulation", autonomy_level: 2 },
    })))
    .onConflictDoNothing();

  await db
    .insert(adapters)
    .values({
      id: ids.adapter,
      key: "website_form",
      name: "Website form",
      kind: "lead_source",
      auth: "none",
      capabilities: { read: ["lead.read"] },
    })
    .onConflictDoNothing();

  await db
    .insert(connections)
    .values({
      id: ids.connection,
      tenantId: ids.tenant,
      adapterId: ids.adapter,
      name: "Continuous website form",
      state: "active",
      externalAccountId: "continuoushq.com",
      createdByUserId: ids.owner,
      scopes: { reads: ["lead"] },
      config: { executable: false, reason: "bootstrap connection only" },
    })
    .onConflictDoNothing();

  await db
    .insert(modelProviders)
    .values({
      id: ids.provider,
      key: "bootstrap",
      name: "Bootstrap provider",
      kind: "simulation",
      config: { executable: false },
    })
    .onConflictDoNothing();

  await db
    .insert(modelRoutes)
    .values({
      id: ids.route,
      tenantId: ids.tenant,
      providerId: ids.provider,
      key: "low_cost_fast",
      name: "Low cost fast",
      model: "simulation",
      purpose: "routine_revenue_work",
      rules: { mode: "seed" },
    })
    .onConflictDoNothing();

  await db
    .insert(budgetPolicies)
    .values({
      id: ids.budgetPolicy,
      tenantId: ids.tenant,
      key: "revenue_worker.standard",
      target: "worker",
      monthlyUnits: 10000000,
      perTaskUnits: 250000,
      softLimit: 80,
      hardLimit: 100,
      overage: "manager_approval",
      rules: { routine_messages: "low_cost_fast", sensitive_data: "private_route_only" },
    })
    .onConflictDoNothing();

  const now = new Date();
  const nextMonth = new Date(now);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  await db
    .insert(budgetPools)
    .values({
      id: ids.budgetPool,
      tenantId: ids.tenant,
      name: "May 2026 intelligence pool",
      period: "month",
      units: 10000000,
      startsAt: now,
      endsAt: nextMonth,
    })
    .onConflictDoNothing();

  await db
    .insert(budgetAccounts)
    .values({
      id: ids.budgetAccount,
      tenantId: ids.tenant,
      policyId: ids.budgetPolicy,
      name: "Revenue Worker monthly intelligence budget",
      target: "worker",
      targetId: ids.worker,
    })
    .onConflictDoNothing();

  await db
    .insert(budgetAllocations)
    .values({
      id: ids.budgetAllocation,
      tenantId: ids.tenant,
      poolId: ids.budgetPool,
      accountId: ids.budgetAccount,
      units: 10000000,
      startsAt: now,
      endsAt: nextMonth,
    })
    .onConflictDoNothing();

  await db
    .insert(objects)
    .values([
      {
        id: ids.customerObject,
        tenantId: ids.tenant,
        type: "customer",
        name: "Acme Roof Repair",
        externalId: "seed-customer",
        data: { email: "ops@example.com", phone: "+1-555-0100" },
      },
      {
        id: ids.leadObject,
        tenantId: ids.tenant,
        type: "lead",
        name: "Roof leak inspection request",
        state: "qualified",
        externalId: "seed-lead",
        data: { channel: "web", urgency: "urgent" },
      },
      {
        id: ids.offerObject,
        tenantId: ids.tenant,
        type: "offer",
        name: "Roof leak inspection",
        externalId: "seed-offer",
        data: { base_price_cents: 24900, margin_floor_percent: 35 },
      },
      {
        id: ids.quoteObject,
        tenantId: ids.tenant,
        type: "quote",
        name: "Quote for roof leak inspection",
        state: "approval_required",
        externalId: "seed-quote",
        data: { total_cents: 24900, currency: "USD" },
      },
      {
        id: ids.jobObject,
        tenantId: ids.tenant,
        type: "job",
        name: "Roof leak inspection",
        state: "scheduled",
        externalId: "seed-job",
        data: { proposed_window: "next_business_day" },
      },
      {
        id: ids.invoiceObject,
        tenantId: ids.tenant,
        type: "invoice",
        name: "Inspection invoice",
        state: "draft",
        externalId: "seed-invoice",
        data: { total_cents: 24900, currency: "USD" },
      },
      {
        id: ids.paymentObject,
        tenantId: ids.tenant,
        type: "payment",
        name: "Inspection deposit",
        state: "prepared",
        externalId: "seed-payment",
        data: { amount_cents: 6225, currency: "USD", provider: "stripe" },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(customers)
    .values({
      id: ids.customer,
      tenantId: ids.tenant,
      objectId: ids.customerObject,
      state: "active",
      externalId: "seed-customer",
      data: { segment: "local_field_service" },
    })
    .onConflictDoNothing();

  await db
    .insert(leads)
    .values({
      id: ids.lead,
      tenantId: ids.tenant,
      objectId: ids.leadObject,
      state: "qualified",
      externalId: "seed-lead",
      data: { missing_facts: ["photos", "preferred_time"] },
    })
    .onConflictDoNothing();

  await db
    .insert(offers)
    .values({
      id: ids.offer,
      tenantId: ids.tenant,
      objectId: ids.offerObject,
      state: "active",
      externalId: "seed-offer",
      data: { deposit_percent: 25 },
    })
    .onConflictDoNothing();

  await db
    .insert(quotes)
    .values({
      id: ids.quote,
      tenantId: ids.tenant,
      objectId: ids.quoteObject,
      state: "approval_required",
      externalId: "seed-quote",
      data: { terms: "Inspection fee credited toward approved repair work." },
    })
    .onConflictDoNothing();

  await db
    .insert(jobs)
    .values({
      id: ids.job,
      tenantId: ids.tenant,
      objectId: ids.jobObject,
      state: "scheduled",
      externalId: "seed-job",
      data: { proposed_window: "next_business_day" },
    })
    .onConflictDoNothing();

  await db
    .insert(invoices)
    .values({
      id: ids.invoice,
      tenantId: ids.tenant,
      objectId: ids.invoiceObject,
      state: "draft",
      externalId: "seed-invoice",
      data: { total_cents: 24900 },
    })
    .onConflictDoNothing();

  await db
    .insert(payments)
    .values({
      id: ids.payment,
      tenantId: ids.tenant,
      objectId: ids.paymentObject,
      state: "pending",
      externalId: "seed-payment",
      data: { reason: "deposit_link_prepared" },
    })
    .onConflictDoNothing();

  await db
    .insert(objectLinks)
    .values([
      { tenantId: ids.tenant, fromId: ids.leadObject, toId: ids.customerObject, type: "for_customer" },
      { tenantId: ids.tenant, fromId: ids.quoteObject, toId: ids.leadObject, type: "from_lead" },
      { tenantId: ids.tenant, fromId: ids.jobObject, toId: ids.quoteObject, type: "from_quote" },
      { tenantId: ids.tenant, fromId: ids.invoiceObject, toId: ids.jobObject, type: "for_job" },
      { tenantId: ids.tenant, fromId: ids.paymentObject, toId: ids.invoiceObject, type: "for_invoice" },
    ])
    .onConflictDoNothing();

  await db
    .insert(objectVersions)
    .values({
      tenantId: ids.tenant,
      objectId: ids.quoteObject,
      version: 1,
      data: { total_cents: 24900, state: "approval_required" },
      changedByType: "worker",
      changedById: ids.worker,
      reason: "bootstrap quote draft",
    })
    .onConflictDoNothing();

  await db
    .insert(events)
    .values([
      {
        id: ids.eventLead,
        tenantId: ids.tenant,
        type: "lead.received",
        source: "website_form",
        actorType: "adapter",
        actorId: ids.connection,
        actorRef: `connection:${ids.connection}`,
        objectId: ids.leadObject,
        adapterId: ids.adapter,
        connectionId: ids.connection,
        idempotencyKey: "seed-lead-received",
        data: { summary: "Roof leak inspection request received" },
      },
      {
        id: ids.eventQuote,
        tenantId: ids.tenant,
        type: "quote.prepared",
        source: "continuous",
        actorType: "worker",
        actorId: ids.worker,
        actorRef: `worker:${ids.worker}`,
        objectId: ids.quoteObject,
        capabilityId: capIds.quotePrepare,
        idempotencyKey: "seed-quote-prepared",
        data: { state: "approval_required" },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(tasks)
    .values([
      {
        id: ids.taskQuote,
        tenantId: ids.tenant,
        objectId: ids.quoteObject,
        capabilityId: capIds.quotePrepare,
        triggerEventId: ids.eventLead,
        title: "Prepare roof inspection quote",
        state: "active",
        priority: "urgent",
        ownerType: "worker",
        ownerId: ids.worker,
        ownerRef: `worker:${ids.worker}`,
        reviewerUserId: ids.owner,
        evidence: { required: ["customer_request", "offer_version", "price_rule_version", "quote_draft"] },
        outcome: { status: "owner_approval_needed" },
        cost: { units: 32000 },
        kpi: { quote_to_booking: "pending", owner_time_saved_minutes: 18 },
      },
      {
        id: ids.taskInvoice,
        tenantId: ids.tenant,
        objectId: ids.invoiceObject,
        capabilityId: capIds.invoicePrepare,
        triggerEventId: ids.eventQuote,
        title: "Prepare invoice after closeout",
        state: "active",
        priority: "high",
        ownerType: "worker",
        ownerId: ids.worker,
        ownerRef: `worker:${ids.worker}`,
        evidence: { required: ["job_closeout", "invoice_draft"] },
        outcome: { status: "waiting_for_closeout" },
        cost: { units: 18000 },
        kpi: { invoices_prepared: 1 },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(evidence)
    .values([
      {
        id: ids.evidenceLead,
        tenantId: ids.tenant,
        kind: "snapshot",
        name: "Source lead message",
        objectId: ids.leadObject,
        taskId: ids.taskQuote,
        eventId: ids.eventLead,
        capabilityId: capIds.leadRead,
        actorType: "adapter",
        actorId: ids.connection,
        hash: "bootstrap-lead",
        data: { channel: "web", body: "We have a roof leak and need someone tomorrow if possible." },
      },
      {
        id: ids.evidenceQuote,
        tenantId: ids.tenant,
        kind: "draft",
        name: "Quote draft",
        objectId: ids.quoteObject,
        taskId: ids.taskQuote,
        eventId: ids.eventQuote,
        capabilityId: capIds.quotePrepare,
        actorType: "worker",
        actorId: ids.worker,
        hash: "bootstrap-quote",
        data: { total_cents: 24900, approval_required: true },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(usageEvents)
    .values({
      id: ids.usage,
      tenantId: ids.tenant,
      accountId: ids.budgetAccount,
      taskId: ids.taskQuote,
      capabilityId: capIds.quotePrepare,
      actorType: "worker",
      actorId: ids.worker,
      units: 50000,
      costUsd: "0.000000",
      data: { provider: "bootstrap", model: "simulation", route: "low_cost_fast" },
    })
    .onConflictDoNothing();

  await db
    .insert(generatedViews)
    .values({
      id: ids.view,
      tenantId: ids.tenant,
      capabilityId: capIds.quotePrepare,
      key: "quote.approval.review",
      name: "Quote approval review",
      purpose: "Let an owner approve, revise, or escalate a prepared quote.",
      surface: "web",
      objectType: "quote",
      taskState: "approval_required",
      contract: {
        sections: ["CustomerSummary", "ScopeSummary", "PriceAndMargin", "DraftMessage", "EvidenceTimeline", "ActionBar"],
      },
      actions: { valid: ["approve_and_send", "request_revision", "edit_price"] },
      mask: { sensitive_payment_fields: true },
    })
    .onConflictDoNothing();
}

seed()
  .then(async () => {
    console.log("Seeded Continuous Core bootstrap records.");
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
