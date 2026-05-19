import type { JsonObject } from "../db/schema";
import {
  appServerWorkerToolManifest,
  executeAppServerWorkerTool,
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

async function main() {
  const name = process.argv[2];

  if (!name || name === "manifest" || name === "--manifest") {
    console.log(JSON.stringify(appServerWorkerToolManifest, null, 2));
    return;
  }

  const inlinePayload = argValue("payload");
  const stdinPayload = inlinePayload ? "" : await readStdin();
  const payloadSource = inlinePayload ?? (stdinPayload || "{}");
  const payload = JSON.parse(payloadSource) as JsonObject;
  const result = executeAppServerWorkerTool(name, payload);
  console.log(JSON.stringify({ ok: true, tool: name, data: result, error: null }, null, 2));
}

main().catch((error) => {
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
});
