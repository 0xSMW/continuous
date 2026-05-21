export const workerCommandEnvelopeFields = ["command", "worker", "idempotencyKey", "config"] as const;
export const workerViewEnvelopeFields = ["view", "worker", "config"] as const;
export const workerTargetEnvelopeFields = ["role", "id", "tenantSlug"] as const;
export const workerRolePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const workerOperationPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;
const reservedWorkerRoleSegments = new Set([
  "api",
  "app_server",
  "approval",
  "core",
  "worker",
  "workers",
  "workflow",
]);
const reservedWorkerOperationSegments = new Set(["api", "app_server", "worker", "workers"]);
export const workerRoleDescription =
  "worker.role must be a lower_snake_case role identifier such as revenue_operations; do not use route names, family-worker names, or URL fragments.";
export const workerOperationDescription =
  "Worker command and view names must be registered lower_snake_case or dotted operation identifiers such as lead.read or quote.prepare; do not use URL paths, route names, family-worker names, or query strings.";

export function isWorkerRoleIdentifier(value: string) {
  const role = value.trim();

  return (
    workerRolePattern.test(role) &&
    !role.endsWith("_worker") &&
    !reservedWorkerRoleSegments.has(role)
  );
}

export function isWorkerOperationIdentifier(value: string) {
  const operation = value.trim();

  return (
    workerOperationPattern.test(operation) &&
    !operation.includes("_worker") &&
    operation.split(".").every((segment) => !reservedWorkerOperationSegments.has(segment))
  );
}

export const workerCommandEnvelopeFieldSet = new Set<string>(workerCommandEnvelopeFields);
export const workerViewEnvelopeFieldSet = new Set<string>(workerViewEnvelopeFields);
export const workerTargetEnvelopeFieldSet = new Set<string>(workerTargetEnvelopeFields);

export const workerCommandEnvelopeDescription = describeEnvelopeFields(workerCommandEnvelopeFields);
export const workerViewEnvelopeDescription = describeEnvelopeFields(workerViewEnvelopeFields);
export const workerTargetEnvelopeDescription = describeEnvelopeFields(workerTargetEnvelopeFields);

function describeEnvelopeFields(fields: readonly string[]) {
  if (fields.length === 1) {
    return fields[0] ?? "";
  }

  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

export function unexpectedEnvelopeFields(
  payload: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
) {
  return Object.keys(payload).filter((field) => !allowedFields.has(field));
}

export function workerEnvelopeFieldError(subject: string, allowedDescription: string, unexpectedFields: string[]) {
  return `${subject} fields must be ${allowedDescription}. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`;
}

export function validateWorkerTargetEnvelope(value: unknown):
  | { ok: true }
  | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return {
      ok: false,
      message: "worker must be an object with role, id, and tenantSlug selectors.",
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: "worker must be an object with role, id, and tenantSlug selectors.",
    };
  }

  const unexpectedFields = unexpectedEnvelopeFields(
    value as Record<string, unknown>,
    workerTargetEnvelopeFieldSet,
  );

  if (unexpectedFields.length > 0) {
    return {
      ok: false,
      message: workerEnvelopeFieldError(
        "worker target",
        workerTargetEnvelopeDescription,
        unexpectedFields,
      ),
    };
  }

  const target = value as Record<string, unknown>;
  const role = target.role;

  if (typeof role !== "string" || !role.trim()) {
    return {
      ok: false,
      message: "worker.role is required.",
    };
  }

  if (!isWorkerRoleIdentifier(role)) {
    return {
      ok: false,
      message: workerRoleDescription,
    };
  }

  for (const field of ["id", "tenantSlug"]) {
    if (
      Object.prototype.hasOwnProperty.call(target, field) &&
      (typeof target[field] !== "string" || !target[field].trim())
    ) {
      return {
        ok: false,
        message: `worker.${field} must be a non-empty string when supplied.`,
      };
    }
  }

  return { ok: true };
}

export function validateWorkerConfigEnvelope(value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }

  return {
    ok: false,
    message: "config is required and must be an object.",
  };
}
