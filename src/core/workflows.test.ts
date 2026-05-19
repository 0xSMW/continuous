import { describe, expect, it } from "vitest";

import {
  allowedWorkflowTransitions,
  canTransitionWorkflow,
  isKnownWorkflowState,
  shouldRequestWorkflowApproval,
  workflowApprovalRequirements,
  workflowStateOrder,
} from "./workflows";
import { extendedWorkflowCatalog } from "../db/workflow-catalog";

const definition = {
  states: { order: ["draft", "preview_ready", "awaiting_approval", "approved"] },
  transitions: {
    draft: ["preview_ready"],
    preview_ready: ["awaiting_approval", "blocked"],
    awaiting_approval: ["approved"],
  },
  approvals: { required: ["payroll_approval"] },
};

describe("workflow transition helpers", () => {
  it("reads declared state order", () => {
    expect(workflowStateOrder(definition)).toEqual([
      "draft",
      "preview_ready",
      "awaiting_approval",
      "approved",
    ]);
  });

  it("validates declared transitions", () => {
    expect(allowedWorkflowTransitions(definition, "preview_ready")).toEqual([
      "awaiting_approval",
      "blocked",
    ]);
    expect(canTransitionWorkflow(definition, "preview_ready", "awaiting_approval")).toBe(true);
    expect(canTransitionWorkflow(definition, "preview_ready", "approved")).toBe(false);
  });

  it("accepts states declared in either states or transition map", () => {
    expect(isKnownWorkflowState(definition, "approved")).toBe(true);
    expect(isKnownWorkflowState(definition, "blocked")).toBe(true);
    expect(isKnownWorkflowState(definition, "unknown")).toBe(false);
  });

  it("detects approval transitions from definition policy", () => {
    expect(workflowApprovalRequirements(definition, "awaiting_approval")).toEqual([
      "payroll_approval",
    ]);
    expect(shouldRequestWorkflowApproval(definition, "awaiting_approval")).toBe(true);
    expect(shouldRequestWorkflowApproval(definition, "approved")).toBe(false);
  });
});

describe("extended workflow catalog", () => {
  it("covers the documented operating workflow expansion keys", () => {
    expect(extendedWorkflowCatalog.map((workflow) => workflow.key).sort()).toEqual([
      "agency_notice",
      "benefits_renewal",
      "compensation_change",
      "filing_draft",
      "injury_incident",
      "leave",
      "location_change",
      "off_cycle_payroll",
      "open_new_state",
      "quarter_close",
      "run_payroll",
      "year_end",
    ]);
  });

  it("has a valid seeded state and packet for every expansion workflow", () => {
    for (const workflow of extendedWorkflowCatalog) {
      expect(isKnownWorkflowState(workflow, workflow.runState)).toBe(true);
      expect(workflow.evidence.packet).toMatch(/packet$/);
      expect(workflow.blockers.length).toBeGreaterThan(0);
    }
  });
});
