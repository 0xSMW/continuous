"use client";

import { Check, RefreshCw, RotateCcw, X } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

type ApprovalSubject = "all" | "worker" | "workflow" | "task";
type ApprovalAction = "approved" | "rejected" | "revision_requested";

type ApprovalRecord = {
  id: string;
  state: string;
  kind: string;
  priority: string;
  risk: string;
  title: string;
  summary: string;
  subject: {
    type: string;
    id: string;
  };
  taskId: string | null;
  workerRunId: string | null;
  workflowRunId: string | null;
  eventId: string | null;
  objectId: string | null;
  requestedAction: Record<string, unknown>;
  evidence: Record<string, unknown>;
  evidenceRefs: Array<{
    type: string;
    label: string;
    id: string;
  }>;
  continuation: {
    decisionSurface: "/approval";
    decisionCommand: "approval.decide";
    description: string;
    postDecisionSurface: "/worker" | "/approval" | null;
    postDecisionCommand: string | null;
    config: Record<string, unknown>;
    externalExecution: "blocked";
  };
  createdAt: string;
};

type ApprovalInboxResponse = {
  api: string;
  data: {
    approvals: {
      approvals: ApprovalRecord[];
      subject: ApprovalSubject;
      filters: {
        state: string;
        priority: string;
        risk: string;
        kind: string;
      };
    };
  } | null;
  error: {
    code: string;
    message: string;
  } | null;
};

const actionLabels: Record<ApprovalAction, string> = {
  approved: "Approve",
  rejected: "Reject",
  revision_requested: "Revise",
};

function compactJson(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, item]) => item !== null && item !== undefined);

  if (entries.length === 0) {
    return "None";
  }

  return entries
    .slice(0, 4)
    .map(([key, item]) => `${key}: ${typeof item === "object" ? "object" : String(item)}`)
    .join(" · ");
}

function approvalRefs(approval: ApprovalRecord) {
  return [
    ["Task", approval.taskId],
    ["Worker run", approval.workerRunId],
    ["Workflow run", approval.workflowRunId],
    ["Object", approval.objectId],
    ["Event", approval.eventId],
  ].flatMap(([label, value]) =>
    typeof label === "string" && typeof value === "string" && value.length > 0
      ? [{ label, value }]
      : [],
  );
}

function evidenceRefs(approval: ApprovalRecord) {
  return approval.evidenceRefs.length > 0
    ? approval.evidenceRefs
    : approvalRefs(approval).map(({ label, value }) => ({
        type: label.toLowerCase().replaceAll(" ", "_"),
        label,
        id: value,
      }));
}

export function ApprovalConsole() {
  const [token, setToken] = useState("");
  const [tenantSlug, setTenantSlug] = useState("continuous-demo");
  const [subject, setSubject] = useState<ApprovalSubject>("all");
  const [state, setState] = useState("pending");
  const [priority, setPriority] = useState("all");
  const [risk, setRisk] = useState("all");
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [message, setMessage] = useState("No approvals loaded.");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const canSubmit = useMemo(() => token.trim().length > 0 && tenantSlug.trim().length > 0, [token, tenantSlug]);

  async function loadApprovals() {
    if (!canSubmit) {
      setError("Operator token and tenant are required.");
      return;
    }

    setError(null);
    const params = new URLSearchParams({
      view: "inbox",
      tenantSlug,
      state,
      subject,
      priority,
      risk,
    });
    const trimmedKind = kind.trim();

    if (trimmedKind) {
      params.set("kind", trimmedKind);
    }

    const response = await fetch(`/approval?${params.toString()}`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    const body = (await response.json()) as ApprovalInboxResponse;

    if (!response.ok || body.error) {
      setApprovals([]);
      setError(body.error?.message ?? "Approval inbox failed.");
      return;
    }

    const items = body.data?.approvals.approvals ?? [];
    setApprovals(items);
    setMessage(items.length === 0 ? "No matching approvals." : `${items.length} approvals loaded.`);
  }

  function refresh() {
    startTransition(() => {
      void loadApprovals();
    });
  }

  function decide(approval: ApprovalRecord, action: ApprovalAction) {
    if (!canSubmit) {
      setError("Operator token and tenant are required.");
      return;
    }

    startTransition(() => {
      void (async () => {
        setError(null);
        const response = await fetch("/approval", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            command: "approval.decide",
            approval: {
              id: approval.id,
              tenantSlug,
              subject,
            },
            config: {
              action,
              note,
            },
          }),
        });
        const body = (await response.json()) as ApprovalInboxResponse;

        if (!response.ok || body.error) {
          setError(body.error?.message ?? "Approval decision failed.");
          return;
        }

        await loadApprovals();
      })();
    });
  }

  return (
    <section className="approval-console" aria-label="Approval inbox">
      <div className="approval-toolbar">
        <label>
          <span>Operator token</span>
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            type="password"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Tenant</span>
          <input value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} />
        </label>
        <label>
          <span>Subject</span>
          <select value={subject} onChange={(event) => setSubject(event.target.value as ApprovalSubject)}>
            <option value="all">All</option>
            <option value="worker">Worker</option>
            <option value="workflow">Workflow</option>
            <option value="task">Task</option>
          </select>
        </label>
        <label>
          <span>State</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="revision_requested">Revision</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="all">All</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          <span>Risk</span>
          <select value={risk} onChange={(event) => setRisk(event.target.value)}>
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          <span>Kind</span>
          <input value={kind} onChange={(event) => setKind(event.target.value)} placeholder="Any" />
        </label>
        <button type="button" onClick={refresh} disabled={isPending}>
          <RefreshCw aria-hidden="true" size={16} />
          Load
        </button>
      </div>

      <label className="approval-note">
        <span>Decision note</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>

      {error ? <p className="approval-error">{error}</p> : <p className="approval-message">{message}</p>}

      <div className="approval-list">
        {approvals.map((approval) => (
          <article key={approval.id} className="approval-item">
            <div className="approval-main">
              <div className="approval-meta">
                <span className={`pill ${approval.priority}`}>{approval.priority}</span>
                <span className={`pill risk-${approval.risk}`}>{approval.risk}</span>
                <span className="pill">{approval.kind}</span>
              </div>
              <h2>{approval.title}</h2>
              <p>{approval.summary || "No summary recorded."}</p>
              <dl className="approval-details">
                <div>
                  <dt>Subject</dt>
                  <dd>{approval.subject.type}</dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>{new Date(approval.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{compactJson(approval.requestedAction)}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{compactJson(approval.evidence)}</dd>
                </div>
                <div>
                  <dt>Continuation</dt>
                  <dd>{approval.continuation.description}</dd>
                </div>
              </dl>
              <div className="approval-refs">
                {evidenceRefs(approval).map((ref) => (
                  <span key={`${ref.type}:${ref.id}`}>
                    {ref.label}: {ref.id}
                  </span>
                ))}
              </div>
            </div>
            {approval.state === "pending" ? (
              <div className="approval-actions">
                <button type="button" onClick={() => decide(approval, "approved")} disabled={isPending}>
                  <Check aria-hidden="true" size={16} />
                  {actionLabels.approved}
                </button>
                <button type="button" onClick={() => decide(approval, "revision_requested")} disabled={isPending}>
                  <RotateCcw aria-hidden="true" size={16} />
                  {actionLabels.revision_requested}
                </button>
                <button type="button" onClick={() => decide(approval, "rejected")} disabled={isPending}>
                  <X aria-hidden="true" size={16} />
                  {actionLabels.rejected}
                </button>
              </div>
            ) : (
              <span className="approval-state">{approval.state}</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
