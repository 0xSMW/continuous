import { env } from "../../src/env";
import type { WorkerTargetInput } from "../../src/worker/registry";
import {
  executeWorkerCommand,
  executeWorkerView,
  workerApiVersion,
  workerErrorStatus,
} from "../../src/worker/registry";
import { authorizeWorkerRead, authorizeWorkerRun } from "../../src/worker/security";

export const dynamic = "force-dynamic";

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const workerCommandEnvelopeFields = new Set(["command", "worker", "idempotencyKey", "config"]);

async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  try {
    return bodyObject(await request.json());
  } catch {
    return {};
  }
}

function targetFrom(value: unknown): WorkerTargetInput {
  const target = bodyObject(value);
  return {
    role: optionalString(target.role),
    id: optionalString(target.id),
    tenantSlug: optionalString(target.tenantSlug),
  };
}

function idempotencyKeyFrom(body: Record<string, unknown>, request: Request) {
  if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey")) {
    return body.idempotencyKey;
  }

  return request.headers.get("idempotency-key") ?? undefined;
}

function unexpectedWorkerPayloadFields(body: Record<string, unknown>) {
  return Object.keys(body).filter((field) => !workerCommandEnvelopeFields.has(field));
}

function targetFromUrl(request: Request): WorkerTargetInput {
  const url = new URL(request.url);
  return {
    role: optionalString(url.searchParams.get("role")),
    id: optionalString(url.searchParams.get("id")),
    tenantSlug: optionalString(url.searchParams.get("tenantSlug")),
  };
}

function errorResponse(error: { code: string; message: string }, status: number) {
  return Response.json(
    {
      api: workerApiVersion,
      data: null,
      error,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function workerErrorResponse(error: unknown, fallbackCode: string) {
  const workerError = workerErrorStatus(error, fallbackCode);

  return errorResponse(
    {
      code: workerError.code,
      message: workerError.message,
    },
    workerError.status,
  );
}

export async function GET(request: Request) {
  const auth = authorizeWorkerRead({
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
  }

  const url = new URL(request.url);

  try {
    const result = await executeWorkerView({
      operatorEmail: auth.operatorEmail,
      target: targetFromUrl(request),
      view: optionalString(url.searchParams.get("view")),
      state: optionalString(url.searchParams.get("state")),
    });

    return Response.json(
      {
        api: workerApiVersion,
        data: result.data,
        error: result.error,
      },
      {
        status: result.status ?? 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_view_failed");
  }
}

export async function POST(request: Request) {
  const auth = authorizeWorkerRun({
    enabled: env.WORKER_RUN_ENABLED,
    appEnv: env.APP_ENV,
    expectedToken: env.WORKER_RUN_TOKEN,
    operatorEmail: env.WORKER_OPERATOR_EMAIL,
    authorization: request.headers.get("authorization"),
    headerToken: request.headers.get("x-worker-run-token"),
  });

  if (!auth.ok) {
    return errorResponse(auth, auth.status);
  }

  const body = await readBody(request);
  const unexpectedFields = unexpectedWorkerPayloadFields(body);

  if (unexpectedFields.length > 0) {
    return errorResponse(
      {
        code: "invalid_worker_command_envelope",
        message: `Worker command payload fields must be command, worker, idempotencyKey, and config. Move operation inputs into config. Unexpected fields: ${unexpectedFields.join(", ")}.`,
      },
      400,
    );
  }

  try {
    const result = await executeWorkerCommand({
      command: optionalString(body.command),
      target: targetFrom(body.worker),
      config: body.config,
      idempotencyKey: idempotencyKeyFrom(body, request),
      operatorEmail: auth.operatorEmail,
    });

    return Response.json(
      {
        api: workerApiVersion,
        data: result,
        error: null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return workerErrorResponse(error, "worker_command_failed");
  }
}
