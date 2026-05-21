import { Client } from "pg";

function expectedMajor() {
  const raw = process.env.EXPECTED_POSTGRES_MAJOR ?? "17";
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 99) {
    throw new Error("EXPECTED_POSTGRES_MAJOR must be a two-digit Postgres major version.");
  }

  return parsed;
}

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.DIRECT_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL, POSTGRES_URL, or DIRECT_URL is required.");
}

const expected = expectedMajor();
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const result = await client.query<{
    version_num: string;
    version_text: string;
  }>("select current_setting('server_version_num') as version_num, version() as version_text");
  const row = result.rows[0];
  const versionNum = Number.parseInt(requiredEnvFromRow(row?.version_num, "server_version_num"), 10);
  const actual = Math.floor(versionNum / 10000);

  if (actual !== expected) {
    throw new Error(`Expected Postgres ${expected}, got ${row?.version_text ?? versionNum}.`);
  }

  console.log(`Postgres major check passed: ${actual}`);
} finally {
  await client.end();
}

function requiredEnvFromRow(value: string | undefined, name: string) {
  if (!value || !value.trim()) {
    throw new Error(`${name} query returned no value.`);
  }

  return value;
}
