import { pool } from "../db/client";
import type { JsonObject } from "../db/schema";
import {
  appServerWorkerToolManifest,
  executeAppServerWorkerDynamicToolCall,
  executeAppServerWorkerTool,
  type AppServerDynamicToolCallParams,
  type AppServerWorkerTransportContext,
} from "./app-server-tools";

function argValue(name: string) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg?.slice(prefix.length).trim();
}

async function readStdin() {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function transportContextFromArgs(): AppServerWorkerTransportContext | undefined {
  const inlineContext = argValue("context");
  const envContext = process.env.APP_SERVER_WORKER_TRANSPORT_CONTEXT_JSON?.trim();
  const contextSource = inlineContext ?? envContext;

  if (!contextSource) {
    return undefined;
  }

  const context = JSON.parse(contextSource) as AppServerWorkerTransportContext;

  if (context.source === "control_plane") {
    throw new Error(
      "Control-plane app-server transport context must come from an authenticated bridge, not the local CLI runner.",
    );
  }

  return context;
}

async function main() {
  const name = process.argv[2];
  const context = transportContextFromArgs();

  if (name === "dynamic-call" || name === "--dynamic-call") {
    const inlinePayload = argValue("payload");
    const stdinPayload = inlinePayload ? "" : await readStdin();
    const payloadSource = inlinePayload ?? (stdinPayload || "{}");
    const payload = JSON.parse(payloadSource) as AppServerDynamicToolCallParams;
    const result = await executeAppServerWorkerDynamicToolCall(payload, context);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!name || name === "manifest" || name === "--manifest") {
    console.log(JSON.stringify(appServerWorkerToolManifest, null, 2));
    return;
  }

  const inlinePayload = argValue("payload");
  const stdinPayload = inlinePayload ? "" : await readStdin();
  const payloadSource = inlinePayload ?? (stdinPayload || "{}");
  const payload = JSON.parse(payloadSource) as JsonObject;
  const result = await executeAppServerWorkerTool(name, payload, context);
  console.log(JSON.stringify({ ok: true, tool: name, data: result, error: null }, null, 2));
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown app-server worker tool error",
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
