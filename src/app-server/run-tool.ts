import { pool } from "../db/client";
import type { JsonObject } from "../db/schema";
import {
  appServerCoreToolManifest,
  executeAppServerCoreDynamicToolCall,
  executeAppServerCoreTool,
  type AppServerCoreTransportContext,
} from "../core/app-server-tools";
import {
  appServerControlToolManifest,
  executeAppServerControlDynamicToolCall,
  executeAppServerControlTool,
  type AppServerControlTransportContext,
} from "../core/app-server-control-tools";
import {
  appServerWorkerToolManifest,
  executeAppServerWorkerDynamicToolCall,
  executeAppServerWorkerTool,
  type AppServerDynamicToolCallParams,
  type AppServerWorkerTransportContext,
} from "../worker/app-server-tools";

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

type AppServerTransportContext =
  | AppServerWorkerTransportContext
  | AppServerCoreTransportContext
  | AppServerControlTransportContext;

function transportContextFromArgs(): AppServerTransportContext | undefined {
  const inlineContext = argValue("context");
  const envContext = process.env.APP_SERVER_TRANSPORT_CONTEXT_JSON?.trim();
  const contextSource = inlineContext ?? envContext;

  if (!contextSource) {
    return undefined;
  }

  const context = JSON.parse(contextSource) as AppServerTransportContext;

  if (context.source === "control_plane") {
    throw new Error(
      "Control-plane app-server transport context must come from an authenticated bridge, not the local CLI runner.",
    );
  }

  return context;
}

async function runDynamicCall(
  payload: AppServerDynamicToolCallParams,
  context?: AppServerTransportContext,
) {
  if (payload.tool.startsWith("continuous.core.")) {
    return executeAppServerCoreDynamicToolCall(
      payload,
      context as AppServerCoreTransportContext | undefined,
    );
  }

  if (payload.tool.startsWith("continuous.workflow.") || payload.tool.startsWith("continuous.approval.")) {
    return executeAppServerControlDynamicToolCall(
      payload,
      context as AppServerControlTransportContext | undefined,
    );
  }

  return executeAppServerWorkerDynamicToolCall(
    payload,
    context as AppServerWorkerTransportContext | undefined,
  );
}

async function runNamedTool(
  name: string,
  payload: JsonObject,
  context?: AppServerTransportContext,
) {
  if (name.startsWith("continuous.core.")) {
    return executeAppServerCoreTool(
      name,
      payload,
      context as AppServerCoreTransportContext | undefined,
    );
  }

  if (name.startsWith("continuous.workflow.") || name.startsWith("continuous.approval.")) {
    return executeAppServerControlTool(
      name,
      payload,
      context as AppServerControlTransportContext | undefined,
    );
  }

  return executeAppServerWorkerTool(
    name,
    payload,
    context as AppServerWorkerTransportContext | undefined,
  );
}

async function main() {
  const name = process.argv[2];
  const context = transportContextFromArgs();

  if (name === "dynamic-call" || name === "--dynamic-call") {
    const inlinePayload = argValue("payload");
    const stdinPayload = inlinePayload ? "" : await readStdin();
    const payloadSource = inlinePayload ?? (stdinPayload || "{}");
    const payload = JSON.parse(payloadSource) as AppServerDynamicToolCallParams;
    const result = await runDynamicCall(payload, context);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!name || name === "manifest" || name === "--manifest") {
    console.log(
      JSON.stringify(
        {
          protocol: "codex.app-server.dynamic_tools",
          mode: "continuous_app_server_control",
          owner: "continuous",
          tools: [
            ...appServerCoreToolManifest.tools,
            ...appServerWorkerToolManifest.tools,
            ...appServerControlToolManifest.tools,
          ],
          core: appServerCoreToolManifest,
          worker: appServerWorkerToolManifest,
          control: appServerControlToolManifest,
        },
        null,
        2,
      ),
    );
    return;
  }

  const inlinePayload = argValue("payload");
  const stdinPayload = inlinePayload ? "" : await readStdin();
  const payloadSource = inlinePayload ?? (stdinPayload || "{}");
  const payload = JSON.parse(payloadSource) as JsonObject;
  const result = await runNamedTool(name, payload, context);
  console.log(JSON.stringify({ ok: true, tool: name, data: result, error: null }, null, 2));
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown app-server tool error",
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
