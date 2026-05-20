import { createHash } from "node:crypto";

import type { JsonObject } from "../db/schema";
import { PlatformUnavailableError } from "./errors";

export type CoreIdempotencyFingerprint = {
  command: string;
  inputHash: string;
  hashVersion: 1;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

export function coreIdempotencyFingerprint(
  command: string,
  input: JsonObject,
): CoreIdempotencyFingerprint {
  return {
    command,
    hashVersion: 1,
    inputHash: createHash("sha256")
      .update(JSON.stringify(stableValue({ command, input })))
      .digest("hex"),
  };
}

export function assertCoreIdempotencyReplay(input: {
  command: string;
  fingerprint: CoreIdempotencyFingerprint;
  storedData: unknown;
}) {
  const data = isJsonObject(input.storedData) ? input.storedData : {};
  const idempotency = isJsonObject(data.idempotency) ? data.idempotency : {};
  const storedCommand = stringValue(idempotency.command);
  const storedHash = stringValue(idempotency.inputHash);

  if (
    (storedCommand && storedCommand !== input.command) ||
    (storedHash && storedHash !== input.fingerprint.inputHash)
  ) {
    throw new PlatformUnavailableError(
      "core_command_idempotency_conflict",
      `A ${input.command} command already exists for this idempotency key with different input.`,
      409,
    );
  }
}
