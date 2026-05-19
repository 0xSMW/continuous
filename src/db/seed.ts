import { db, pool } from "./client";
import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetPools,
  capabilities,
  capabilityGrants,
  connections,
  customers,
  bankAccounts,
  compensationAgreements,
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
  users,
  workflowDefinitions,
  workflowRuns,
  workerRuns,
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
  legalEntityObject: "33333333-3333-4333-8333-000000000101",
  workLocationObject: "33333333-3333-4333-8333-000000000102",
  personObject: "33333333-3333-4333-8333-000000000103",
  employmentObject: "33333333-3333-4333-8333-000000000104",
  payrollObject: "33333333-3333-4333-8333-000000000105",
  filingObject: "33333333-3333-4333-8333-000000000106",
  bankObject: "33333333-3333-4333-8333-000000000107",
  obligationObject: "33333333-3333-4333-8333-000000000108",
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
  workerRunSeed: "dddddddd-dddd-4ddd-8ddd-000000000003",
  evidenceLead: "eeeeeeee-eeee-4eee-8eee-000000000001",
  evidenceQuote: "eeeeeeee-eeee-4eee-8eee-000000000002",
  evidenceAdapterReceipt: "eeeeeeee-eeee-4eee-8eee-000000000003",
  adapterRunSeed: "abababab-abab-4aba-8aba-000000000001",
  adapterActionSeed: "abababab-abab-4aba-8aba-000000000002",
  usage: "12121212-1212-4121-8121-121212121212",
  view: "34343434-3434-4343-8343-343434343434",
  legalEntity: "55555555-5555-4555-8555-000000000001",
  entityIdentifier: "55555555-5555-4555-8555-000000000002",
  person: "55555555-5555-4555-8555-000000000003",
  employment: "55555555-5555-4555-8555-000000000004",
  compensationAgreement: "55555555-5555-4555-8555-000000000005",
  paySchedule: "55555555-5555-4555-8555-000000000006",
  payrollRun: "55555555-5555-4555-8555-000000000007",
  rulePack: "55555555-5555-4555-8555-000000000008",
  obligation: "55555555-5555-4555-8555-000000000009",
  filingRequirement: "55555555-5555-4555-8555-000000000010",
  filingDraft: "55555555-5555-4555-8555-000000000011",
  bankAccount: "55555555-5555-4555-8555-000000000012",
  paymentInstruction: "55555555-5555-4555-8555-000000000013",
  workflowEntitySetup: "66666666-6666-4666-8666-000000000001",
  workflowHireEmployee: "66666666-6666-4666-8666-000000000002",
  workflowPayrollPreview: "66666666-6666-4666-8666-000000000003",
  workflowAiBudget: "66666666-6666-4666-8666-000000000004",
  workflowSyntheticWorker: "66666666-6666-4666-8666-000000000005",
  runEntitySetup: "77777777-7777-4777-8777-000000000001",
  runPayrollPreview: "77777777-7777-4777-8777-000000000002",
  runSyntheticWorker: "77777777-7777-4777-8777-000000000003",
  documentNewHire: "88888888-8888-4888-8888-000000000001",
  documentPayroll: "88888888-8888-4888-8888-000000000002",
  decisionQuote: "99999999-9999-4999-8999-000000000001",
  evaluationSeed: "99999999-9999-4999-8999-000000000002",
  approvalQuote: "99999999-9999-4999-8999-000000000003",
  auditApprovalRequested: "99999999-9999-4999-8999-000000000004",
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
  approvalRequest: "10000000-0000-4000-8000-000000000009",
  documentPacketPrepare: "10000000-0000-4000-8000-000000000010",
  payrollPreviewPrepare: "10000000-0000-4000-8000-000000000011",
  filingPrepare: "10000000-0000-4000-8000-000000000012",
  sensitiveReveal: "10000000-0000-4000-8000-000000000013",
  achDraftPrepare: "10000000-0000-4000-8000-000000000014",
  workerRead: "10000000-0000-4000-8000-000000000015",
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
      {
        id: capIds.approvalRequest,
        key: "approval.request",
        name: "Request approval",
        class: "task",
        risk: "medium",
        sideEffect: "internal",
        description: "Create a human approval task with the required evidence packet.",
        evidence: { required: ["approval_context", "recommended_decision"] },
      },
      {
        id: capIds.documentPacketPrepare,
        key: "document_packet.prepare",
        name: "Prepare document packet",
        class: "draft",
        risk: "medium",
        sideEffect: "internal",
        description: "Prepare renderer-neutral document packets for hiring, payroll, filings, or evidence export.",
        evidence: { required: ["template_versions", "source_facts"] },
      },
      {
        id: capIds.payrollPreviewPrepare,
        key: "payroll_preview.prepare",
        name: "Prepare payroll preview",
        class: "draft",
        risk: "high",
        sideEffect: "regulated",
        description: "Prepare deterministic payroll preview records without submitting payroll or moving funds.",
        rules: { external_submission: "blocked", money_movement: "approval_required" },
        evidence: { required: ["source_data_lock", "calculation_trace", "variance_summary"] },
      },
      {
        id: capIds.filingPrepare,
        key: "filing.prepare",
        name: "Prepare filing",
        class: "draft",
        risk: "high",
        sideEffect: "regulated",
        description: "Prepare filing drafts and validation packets without submitting to agencies.",
        rules: { external_submission: "approval_required" },
        evidence: { required: ["form_version", "source_facts", "validation_report"] },
      },
      {
        id: capIds.sensitiveReveal,
        key: "sensitive_data.reveal",
        name: "Reveal sensitive data",
        class: "reveal",
        risk: "critical",
        sideEffect: "regulated",
        description: "Reveal restricted payroll, bank, identity, or filing data only with policy-backed audit.",
        rules: { approval_required: true, reason_required: true },
        evidence: { required: ["request_reason", "policy_check", "access_receipt"] },
      },
      {
        id: capIds.achDraftPrepare,
        key: "ach_draft.prepare",
        name: "Prepare ACH draft",
        class: "money",
        risk: "critical",
        sideEffect: "financial",
        description: "Prepare ACH or tax payment drafts without executing money movement.",
        rules: { dual_control: true, execution_blocked: true },
        evidence: { required: ["payment_instruction", "approval_packet"] },
      },
      {
        id: capIds.workerRead,
        key: "worker.read",
        name: "Read worker",
        class: "read",
        risk: "medium",
        sideEffect: "none",
        description: "Read scoped human or synthetic worker records for workflow execution.",
        evidence: { required: ["scope_check"] },
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
        id: ids.legalEntityObject,
        tenantId: ids.tenant,
        type: "legal_entity",
        name: "Continuous Demo LLC",
        externalId: "seed-legal-entity",
        data: { entity_type: "llc", jurisdiction: "DE", tax_classification: "partnership" },
      },
      {
        id: ids.workLocationObject,
        tenantId: ids.tenant,
        type: "work_location",
        name: "Continuous Demo Headquarters",
        externalId: "seed-work-location",
        data: { state: "NY", country: "US", remote_allowed: true },
      },
      {
        id: ids.personObject,
        tenantId: ids.tenant,
        type: "person",
        name: "Jordan Field",
        externalId: "seed-person",
        data: { role: "field_operations_lead", pii_masked: true },
      },
      {
        id: ids.employmentObject,
        tenantId: ids.tenant,
        type: "employment",
        name: "Jordan Field employment",
        state: "onboarding",
        externalId: "seed-employment",
        data: { classification: "employee", flsa_status: "non_exempt" },
      },
      {
        id: ids.payrollObject,
        tenantId: ids.tenant,
        type: "payroll_run",
        name: "May 2026 payroll preview",
        state: "preview_ready",
        externalId: "seed-payroll-preview",
        data: { deterministic: true, money_movement: "blocked" },
      },
      {
        id: ids.filingObject,
        tenantId: ids.tenant,
        type: "filing_draft",
        name: "Federal quarterly payroll filing draft",
        state: "draft",
        externalId: "seed-filing-draft",
        data: { form: "941", agency: "IRS", submission: "blocked" },
      },
      {
        id: ids.bankObject,
        tenantId: ids.tenant,
        type: "bank_account",
        name: "Operating account",
        state: "verified",
        externalId: "seed-bank-account",
        data: { account_mask: "6789", purpose: "operating" },
      },
      {
        id: ids.obligationObject,
        tenantId: ids.tenant,
        type: "obligation",
        name: "Quarterly payroll filing obligation",
        state: "open",
        externalId: "seed-obligation",
        data: { domain: "payroll_tax", due: "quarterly" },
      },
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
    .insert(legalEntities)
    .values({
      id: ids.legalEntity,
      tenantId: ids.tenant,
      objectId: ids.legalEntityObject,
      legalName: "Continuous Demo LLC",
      entityType: "llc",
      jurisdiction: "DE",
      state: "active",
      data: { tax_classification: "partnership", responsible_party: ids.owner },
      effectiveAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(entityIdentifiers)
    .values({
      id: ids.entityIdentifier,
      tenantId: ids.tenant,
      legalEntityId: ids.legalEntity,
      kind: "ein",
      value: "XX-XXX6789",
      issuer: "IRS",
      data: { masked: true },
      effectiveAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(people)
    .values({
      id: ids.person,
      tenantId: ids.tenant,
      objectId: ids.personObject,
      name: "Jordan Field",
      role: "field_operations_lead",
      state: "active",
      data: { contact: "masked", work_location_object_id: ids.workLocationObject },
    })
    .onConflictDoNothing();

  await db
    .insert(employments)
    .values({
      id: ids.employment,
      tenantId: ids.tenant,
      personId: ids.person,
      legalEntityId: ids.legalEntity,
      kind: "employee",
      title: "Field Operations Lead",
      state: "onboarding",
      managerRef: `user:${ids.owner}`,
      data: { flsa_status: "non_exempt", payroll_ready: false },
      startsAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(compensationAgreements)
    .values({
      id: ids.compensationAgreement,
      tenantId: ids.tenant,
      employmentId: ids.employment,
      kind: "hourly",
      amountCents: 4200,
      period: "hour",
      state: "approved",
      data: { overtime: "eligible", source: "bootstrap" },
      effectiveAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(paySchedules)
    .values({
      id: ids.paySchedule,
      tenantId: ids.tenant,
      legalEntityId: ids.legalEntity,
      name: "Biweekly payroll",
      frequency: "biweekly",
      timezone: "America/New_York",
      state: "active",
      data: { approval_required: true },
    })
    .onConflictDoNothing();

  await db
    .insert(payrollRuns)
    .values({
      id: ids.payrollRun,
      tenantId: ids.tenant,
      payScheduleId: ids.paySchedule,
      state: "preview_ready",
      periodStart: now,
      periodEnd: nextMonth,
      checkDate: nextMonth,
      grossCents: 336000,
      netCents: 248640,
      taxCents: 87360,
      data: {
        calculation: "deterministic_preview",
        blockers: ["manager_approval_required", "funding_not_submitted"],
      },
    })
    .onConflictDoNothing();

  await db
    .insert(rulePacks)
    .values({
      id: ids.rulePack,
      key: "us.payroll.federal.bootstrap",
      name: "US payroll federal bootstrap",
      domain: "payroll",
      jurisdiction: "US",
      version: "0.1.0",
      sourceRefs: { placeholder: "authoritative_sources_required_before_execution" },
      rules: { filing_941: "draft_only", deposits: "prepare_only" },
      effectiveAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(obligations)
    .values({
      id: ids.obligation,
      tenantId: ids.tenant,
      objectId: ids.obligationObject,
      rulePackId: ids.rulePack,
      kind: "payroll_tax_filing",
      state: "open",
      name: "Quarterly federal payroll filing",
      dueAt: nextMonth,
      data: { form: "941", mode: "draft_only" },
    })
    .onConflictDoNothing();

  await db
    .insert(filingRequirements)
    .values({
      id: ids.filingRequirement,
      tenantId: ids.tenant,
      legalEntityId: ids.legalEntity,
      rulePackId: ids.rulePack,
      form: "941",
      cadence: "quarterly",
      agency: "IRS",
      state: "active",
      data: { execution: "human_approval_required" },
    })
    .onConflictDoNothing();

  await db
    .insert(filingDrafts)
    .values({
      id: ids.filingDraft,
      tenantId: ids.tenant,
      requirementId: ids.filingRequirement,
      obligationId: ids.obligation,
      state: "draft",
      periodStart: now,
      periodEnd: nextMonth,
      data: { validation: "not_submittable", reason: "bootstrap_draft" },
    })
    .onConflictDoNothing();

  await db
    .insert(bankAccounts)
    .values({
      id: ids.bankAccount,
      tenantId: ids.tenant,
      legalEntityId: ids.legalEntity,
      name: "Operating account",
      purpose: "operating",
      state: "verified",
      data: { account_mask: "6789", money_movement: "dual_control_required" },
    })
    .onConflictDoNothing();

  await db
    .insert(paymentInstructions)
    .values({
      id: ids.paymentInstruction,
      tenantId: ids.tenant,
      bankAccountId: ids.bankAccount,
      objectId: ids.payrollObject,
      kind: "payroll_funding",
      state: "draft",
      amountCents: 336000,
      data: { execution: "blocked_until_approval", rail: "ach" },
    })
    .onConflictDoNothing();

  await db
    .insert(workflowDefinitions)
    .values([
      {
        id: ids.workflowEntitySetup,
        key: "entity_setup",
        name: "Entity setup",
        purpose: "Make a business entity operationally legible before workers act.",
        domain: "entity",
        states: { order: ["draft", "facts_required", "review_ready", "approved", "evidence_complete"] },
        transitions: { draft: ["facts_required"], facts_required: ["review_ready"], review_ready: ["approved"] },
        objects: { required: ["legal_entity", "entity_identifier", "work_location", "bank_account"] },
        approvals: { required: ["owner_entity_fact_confirmation"] },
        evidence: { packet: "entity_setup_packet" },
        tests: { required: ["entity_facts_present", "bank_ref_masked"] },
      },
      {
        id: ids.workflowHireEmployee,
        key: "hire_employee",
        name: "Hire employee",
        purpose: "Turn an accepted offer into a payroll-ready employee with auditable documents.",
        domain: "workforce",
        states: { order: ["offer_accepted", "classification_review", "onboarding_packet_prepared", "payroll_readiness_check", "payroll_ready"] },
        transitions: { classification_review: ["onboarding_packet_prepared"], payroll_readiness_check: ["payroll_ready", "blocked"] },
        objects: { required: ["person", "employment", "compensation_agreement", "pay_schedule"] },
        approvals: { required: ["classification", "payroll_readiness"] },
        evidence: { packet: "new_hire_packet" },
        tests: { required: ["classification_reason", "document_packet_complete"] },
      },
      {
        id: ids.workflowPayrollPreview,
        key: "payroll_preview",
        name: "Payroll preview",
        purpose: "Preview payroll deterministically before any money movement.",
        domain: "payroll",
        states: { order: ["draft", "source_data_locked", "preview_ready", "awaiting_approval", "approved"] },
        transitions: { preview_ready: ["awaiting_approval", "blocked"], awaiting_approval: ["approved"] },
        objects: { required: ["pay_schedule", "payroll_run", "payment_instruction"] },
        approvals: { required: ["payroll_approval", "dual_control_for_funding"] },
        evidence: { packet: "payroll_packet" },
        tests: { required: ["calculation_trace", "variance_report"] },
      },
      {
        id: ids.workflowAiBudget,
        key: "ai_budget_cycle",
        name: "AI budget cycle",
        purpose: "Allocate, reserve, use, and close intelligence budgets.",
        domain: "ai_operations",
        states: { order: ["allocated", "active", "usage_review", "closed"] },
        transitions: { allocated: ["active"], active: ["usage_review"], usage_review: ["closed"] },
        objects: { required: ["budget_pool", "budget_account", "budget_allocation", "usage_event"] },
        approvals: { required: ["overage_approval"] },
        evidence: { packet: "budget_close_packet" },
        tests: { required: ["usage_attribution", "overage_policy"] },
      },
      {
        id: ids.workflowSyntheticWorker,
        key: "synthetic_worker_lifecycle",
        name: "Synthetic worker lifecycle",
        purpose: "Create, govern, evaluate, suspend, and retire agentic workers.",
        domain: "ai_operations",
        states: { order: ["draft", "scoped", "simulating", "approved", "active", "suspended", "retired"] },
        transitions: { draft: ["scoped"], scoped: ["simulating"], simulating: ["approved"], approved: ["active"] },
        objects: { required: ["worker", "capability_grant", "budget_account", "model_route"] },
        approvals: { required: ["manager_launch_approval", "sensitive_capability_approval"] },
        evidence: { packet: "synthetic_worker_packet" },
        tests: { required: ["scope_check", "budget_check", "eval_baseline"] },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(workflowRuns)
    .values([
      {
        id: ids.runEntitySetup,
        tenantId: ids.tenant,
        definitionId: ids.workflowEntitySetup,
        objectId: ids.legalEntityObject,
        state: "review_ready",
        idempotencyKey: "seed-entity-setup",
        data: { facts: ["legal_entity", "ein_masked", "work_location", "bank_account"] },
        blockers: { open: [] },
        metrics: { completeness: 0.86 },
      },
      {
        id: ids.runPayrollPreview,
        tenantId: ids.tenant,
        definitionId: ids.workflowPayrollPreview,
        objectId: ids.payrollObject,
        state: "preview_ready",
        idempotencyKey: "seed-payroll-preview",
        data: { payrollRunId: ids.payrollRun, paymentInstructionId: ids.paymentInstruction },
        blockers: { open: ["manager_approval_required", "funding_not_submitted"] },
        metrics: { gross_cents: 336000, net_cents: 248640 },
      },
      {
        id: ids.runSyntheticWorker,
        tenantId: ids.tenant,
        definitionId: ids.workflowSyntheticWorker,
        workerId: ids.worker,
        state: "simulating",
        idempotencyKey: "seed-synthetic-worker-lifecycle",
        data: { workerId: ids.worker, autonomyLevel: 2 },
        blockers: { open: ["external_execution_disabled"] },
        metrics: { grants: Object.values(capIds).length },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(documents)
    .values([
      {
        id: ids.documentNewHire,
        tenantId: ids.tenant,
        objectId: ids.employmentObject,
        workflowRunId: ids.runEntitySetup,
        kind: "new_hire_packet",
        name: "New-hire packet draft",
        state: "draft",
        sensitivity: "high",
        hash: "bootstrap-new-hire-packet",
        data: { restricted: true, required: ["w4", "i9", "direct_deposit", "policy_acknowledgement"] },
      },
      {
        id: ids.documentPayroll,
        tenantId: ids.tenant,
        objectId: ids.payrollObject,
        workflowRunId: ids.runPayrollPreview,
        kind: "payroll_packet",
        name: "Payroll preview packet",
        state: "review_ready",
        sensitivity: "critical",
        hash: "bootstrap-payroll-packet",
        data: { deterministic: true, money_movement: "blocked", approval_required: true },
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
        data: {
          state: "approval_required",
          approvalRequestId: ids.approvalQuote,
          auditEventId: ids.auditApprovalRequested,
        },
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
    .insert(workerRuns)
    .values({
      id: ids.workerRunSeed,
      tenantId: ids.tenant,
      workerId: ids.worker,
      taskId: ids.taskQuote,
      eventId: ids.eventQuote,
      capabilityId: capIds.quotePrepare,
      connectionId: ids.connection,
      budgetAccountId: ids.budgetAccount,
      source: "continuous.revenue_worker",
      idempotencyKey: "seed-revenue-worker-run",
      state: "done",
      mode: "simulation",
      data: {
        input: {
          trigger: "seed",
          taskId: ids.taskQuote,
          capabilityId: capIds.quotePrepare,
        },
        output: {
          eventId: ids.eventQuote,
          taskId: ids.taskQuote,
          evidenceId: ids.evidenceQuote,
          adapterRunId: ids.adapterRunSeed,
          adapterActionId: ids.adapterActionSeed,
          adapterReceiptEvidenceId: ids.evidenceAdapterReceipt,
          approvalRequestId: ids.approvalQuote,
          auditEventId: ids.auditApprovalRequested,
          classification: "quote_ready_for_owner_approval",
          externalExecution: "blocked",
          requiresApproval: true,
        },
      },
      endedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(adapterRuns)
    .values({
      id: ids.adapterRunSeed,
      tenantId: ids.tenant,
      connectionId: ids.connection,
      workerRunId: ids.workerRunSeed,
      eventId: ids.eventQuote,
      mode: "dry_run",
      operation: "draft_customer_response",
      idempotencyKey: "seed-revenue-worker-run:adapter_run",
      state: "done",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "matched",
      cursor: "seed-revenue-worker-run",
      readCount: 1,
      writeCount: 0,
      receipt: {
        mode: "dry_run",
        receiptEvidenceId: ids.evidenceAdapterReceipt,
        adapterActionId: ids.adapterActionSeed,
        externalMutation: false,
        reconciliationState: "matched",
      },
      data: {
        workerRunId: ids.workerRunSeed,
        dryRun: true,
        externalMutation: false,
      },
      startedAt: now,
      endedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(adapterActions)
    .values({
      id: ids.adapterActionSeed,
      tenantId: ids.tenant,
      connectionId: ids.connection,
      adapterRunId: ids.adapterRunSeed,
      capabilityId: capIds.quotePrepare,
      taskId: ids.taskQuote,
      eventId: ids.eventQuote,
      idempotencyKey: "seed-revenue-worker-run",
      state: "done",
      mode: "dry_run",
      operation: "draft_customer_response",
      attempt: 1,
      maxAttempts: 3,
      reconciliationState: "matched",
      request: {
        action: "draft_customer_response",
        workerRunId: ids.workerRunSeed,
        externalSend: false,
        dryRun: true,
      },
      response: {
        status: "prepared",
        nextStep: "owner_approval",
        reconciliation: "matched",
      },
      receipt: {
        mode: "dry_run",
        receiptId: "bootstrap-adapter-receipt",
        adapterRunId: ids.adapterRunSeed,
        receiptEvidenceId: ids.evidenceAdapterReceipt,
        workerRunId: ids.workerRunSeed,
        externalMutation: false,
        reconciliationState: "matched",
      },
    })
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
        data: {
          total_cents: 24900,
          approval_required: true,
          approvalRequestId: ids.approvalQuote,
          auditEventId: ids.auditApprovalRequested,
        },
      },
      {
        id: ids.evidenceAdapterReceipt,
        tenantId: ids.tenant,
        kind: "receipt",
        name: "Adapter dry-run receipt",
        objectId: ids.quoteObject,
        taskId: ids.taskQuote,
        eventId: ids.eventQuote,
        capabilityId: capIds.quotePrepare,
        actorType: "adapter",
        actorId: ids.connection,
        hash: "bootstrap-adapter-receipt",
        data: {
          mode: "dry_run",
          workerRunId: ids.workerRunSeed,
          adapterRunId: ids.adapterRunSeed,
          adapterActionId: ids.adapterActionSeed,
          operation: "draft_customer_response",
          externalMutation: false,
          reconciliationState: "matched",
        },
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(approvalRequests)
    .values({
      id: ids.approvalQuote,
      tenantId: ids.tenant,
      taskId: ids.taskQuote,
      workerRunId: ids.workerRunSeed,
      eventId: ids.eventQuote,
      objectId: ids.quoteObject,
      capabilityId: capIds.quotePrepare,
      requesterType: "worker",
      requesterId: ids.worker,
      requesterRef: `worker:${ids.worker}`,
      reviewerUserId: ids.owner,
      kind: "quote_approval",
      state: "pending",
      priority: "urgent",
      risk: "medium",
      title: "Approve prepared roof inspection quote",
      summary: "Seeded Revenue Worker quote draft is ready for owner approval; external send is blocked.",
      requestedAction: {
        action: "approve_and_send",
        adapterActionId: ids.adapterActionSeed,
        externalSend: false,
        currentMode: "dry_run",
      },
      evidence: {
        eventId: ids.eventQuote,
        evidenceId: ids.evidenceQuote,
        adapterRunId: ids.adapterRunSeed,
        adapterActionId: ids.adapterActionSeed,
        adapterReceiptEvidenceId: ids.evidenceAdapterReceipt,
      },
      policy: {
        externalSend: "approval_required",
        moneyMovement: "blocked",
      },
      data: {
        classification: "quote_ready_for_owner_approval",
        workerRunId: ids.workerRunSeed,
        adapterRunId: ids.adapterRunSeed,
        adapterActionId: ids.adapterActionSeed,
      },
    })
    .onConflictDoNothing();

  await db
    .insert(auditEvents)
    .values({
      id: ids.auditApprovalRequested,
      tenantId: ids.tenant,
      type: "approval.requested",
      source: "continuous.revenue_worker",
      actorType: "worker",
      actorId: ids.worker,
      actorRef: `worker:${ids.worker}`,
      targetType: "approval_request",
      targetId: ids.approvalQuote,
      taskId: ids.taskQuote,
      workerRunId: ids.workerRunSeed,
      approvalRequestId: ids.approvalQuote,
      eventId: ids.eventQuote,
      objectId: ids.quoteObject,
      capabilityId: capIds.quotePrepare,
      risk: "medium",
      idempotencyKey: "seed-approval-requested",
      data: {
        reviewerUserId: ids.owner,
        externalExecution: "blocked",
      },
    })
    .onConflictDoNothing();

  await db
    .insert(decisions)
    .values({
      id: ids.decisionQuote,
      tenantId: ids.tenant,
      taskId: ids.taskQuote,
      eventId: ids.eventQuote,
      workflowRunId: ids.runSyntheticWorker,
      capabilityId: capIds.quotePrepare,
      actorType: "worker",
      actorId: ids.worker,
      kind: "approval_recommendation",
      state: "proposed",
      decision: "request_owner_approval",
      rationale: "Prepared quote is within standard price policy but external send still requires owner approval.",
      data: {
        autonomy_level: 2,
        external_send: "approval_required",
        approvalRequestId: ids.approvalQuote,
        auditEventId: ids.auditApprovalRequested,
      },
    })
    .onConflictDoNothing();

  await db
    .insert(evaluations)
    .values({
      id: ids.evaluationSeed,
      tenantId: ids.tenant,
      workerId: ids.worker,
      taskId: ids.taskQuote,
      eventId: ids.eventQuote,
      kind: "bootstrap_quality",
      score: "0.820",
      data: {
        dimensions: {
          evidence_complete: true,
          within_budget: true,
          external_execution_blocked: true,
          human_approval_requested: true,
        },
      },
    })
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
