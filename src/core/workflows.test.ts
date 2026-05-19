import { describe, expect, it } from "vitest";

import {
  allowedWorkflowTransitions,
  canTransitionWorkflow,
  isKnownWorkflowState,
  shouldRequestWorkflowApproval,
  workflowApprovalRequirements,
  workflowStateOrder,
} from "./workflows";

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
