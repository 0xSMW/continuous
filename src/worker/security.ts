export type RunAuthInput = {
  enabled: boolean;
  appEnv: string;
  expectedToken?: string;
  operatorEmail: string;
  authorization?: string | null;
  headerToken?: string | null;
};

export type RunAuthResult =
  | { ok: true; operatorEmail: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export function authorizeRevenueWorkerRun(input: RunAuthInput): RunAuthResult {
  if (!input.enabled) {
    return {
      ok: false,
      status: 403,
      code: "worker_run_disabled",
      message: "Revenue Worker runs are disabled.",
    };
  }

  if (!input.expectedToken) {
    return {
      ok: false,
      status: 403,
      code: "worker_run_token_missing",
      message: "Enabled worker runs require REVENUE_WORKER_RUN_TOKEN.",
    };
  }

  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? input.headerToken ?? "";

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_run_unauthorized",
      message: "Revenue Worker run token is invalid.",
    };
  }

  return { ok: true, operatorEmail: input.operatorEmail };
}

export function authorizeRevenueWorkerRead(input: Omit<RunAuthInput, "enabled">): RunAuthResult {
  if (!input.expectedToken) {
    return {
      ok: false,
      status: 403,
      code: "worker_read_token_missing",
      message: "Revenue Worker reads require REVENUE_WORKER_RUN_TOKEN.",
    };
  }

  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? input.headerToken ?? "";

  if (supplied !== input.expectedToken) {
    return {
      ok: false,
      status: 401,
      code: "worker_read_unauthorized",
      message: "Revenue Worker read token is invalid.",
    };
  }

  return { ok: true, operatorEmail: input.operatorEmail };
}

export type IdempotencyResult =
  | { ok: true; key: string }
  | { ok: false; message: string };

export function normalizeIdempotencyKey(value: unknown): IdempotencyResult {
  if (typeof value !== "string") {
    return { ok: false, message: "A string idempotency key is required." };
  }

  const key = value.trim();

  if (key.length < 8 || key.length > 160) {
    return {
      ok: false,
      message: "Idempotency key must be between 8 and 160 characters.",
    };
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    return {
      ok: false,
      message: "Idempotency key may only contain letters, numbers, dot, underscore, colon, or dash.",
    };
  }

  return { ok: true, key };
}
