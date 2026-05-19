import { pool } from "../db/client";
import { normalizeIdempotencyKey } from "./security";
import { runRevenueWorker } from "./revenue";

function argValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]?.trim();
}

const keyInput =
  process.env.IDEMPOTENCY_KEY ??
  argValue("idempotency-key") ??
  `cli:${new Date().toISOString()}`;
const tenantSlug = process.env.TENANT_SLUG ?? argValue("tenant-slug");
const workerId = process.env.WORKER_ID ?? argValue("worker-id");
const operatorEmail =
  process.env.WORKER_OPERATOR_EMAIL ??
  process.env.REVENUE_WORKER_OPERATOR_EMAIL ??
  process.env.OPERATOR_EMAIL ??
  argValue("operator-email") ??
  "owner@continuoushq.com";

const key = normalizeIdempotencyKey(keyInput);

if (!key.ok) {
  console.error(key.message);
  process.exit(1);
}

runRevenueWorker({
  idempotencyKey: key.key,
  tenantSlug: tenantSlug || undefined,
  workerId: workerId || undefined,
  operatorEmail,
})
  .then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
