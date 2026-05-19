import { ArrowLeft, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { ApprovalConsole } from "./ApprovalConsole";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="label">Continuous Approvals</p>
          <h1>Operator inbox</h1>
          <p className="lede">
            Shared approval requests across Core, workflows, and workers.
          </p>
        </div>
        <nav className="api-links" aria-label="Approval navigation">
          <Link href="/">
            <ArrowLeft aria-hidden="true" size={14} />
            Core
          </Link>
          <a href="/approval?view=inbox&tenantSlug=continuous-demo">
            <ShieldCheck aria-hidden="true" size={14} />
            API
          </a>
        </nav>
      </header>
      <ApprovalConsole />
    </main>
  );
}
