import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { env } from "../env";

type Journal = {
  entries: Array<{
    idx: number;
    when: number;
    tag: string;
  }>;
};

const migrationLockKey: [number, number] = [20260521, 1];

async function readJournal() {
  const journalPath = path.join(process.cwd(), "drizzle", "meta", "_journal.json");
  const raw = await readFile(journalPath, "utf8");
  return JSON.parse(raw) as Journal;
}

function statementsFrom(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function createdTablesFrom(sql: string) {
  return [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]);
}

async function migrate() {
  const journal = await readJournal();
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  let locked = false;

  try {
    await client.query("select pg_advisory_lock($1, $2)", migrationLockKey);
    locked = true;

    await client.query("create schema if not exists drizzle");
    await client.query(`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);

    const applied = await client.query<{ created_at: string }>(
      "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1",
    );
    let lastApplied = applied.rows[0] ? Number(applied.rows[0].created_at) : 0;

    if (lastApplied === 0) {
      const migrationFiles = await Promise.all(
        journal.entries.map(async (entry) => {
          const file = path.join(process.cwd(), "drizzle", `${entry.tag}.sql`);
          const sql = await readFile(file, "utf8");
          const hash = createHash("sha256").update(sql).digest("hex");

          return { entry, hash, sql };
        }),
      );
      const tableNames = [...new Set(migrationFiles.flatMap(({ sql }) => createdTablesFrom(sql)))];
      const existingTables =
        tableNames.length === 0
          ? new Set<string>()
          : new Set(
              (
                await client.query<{ table_name: string }>(
                  `
                    select table_name
                    from information_schema.tables
                    where table_schema = 'public'
                      and table_name = any($1::text[])
                  `,
                  [tableNames],
                )
              ).rows.map((row) => row.table_name),
            );

      if (existingTables.size > 0 && existingTables.size !== tableNames.length) {
        throw new Error(
          `Database has partial schema without migration history (${existingTables.size}/${tableNames.length} tables). Restore from backup or rebuild before migrating.`,
        );
      }

      if (tableNames.length > 0 && existingTables.size === tableNames.length) {
        for (const { entry, hash } of migrationFiles) {
          await client.query(
            'insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)',
            [hash, entry.when],
          );
          lastApplied = Math.max(lastApplied, entry.when);
        }

        console.log("Existing database schema was baselined into migration history.");
      }
    }

    for (const entry of journal.entries) {
      if (entry.when <= lastApplied) {
        continue;
      }

      const file = path.join(process.cwd(), "drizzle", `${entry.tag}.sql`);
      const sql = await readFile(file, "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const statements = statementsFrom(sql);

      await client.query("begin");
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          'insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)',
          [hash, entry.when],
        );
        await client.query("commit");
        console.log(`Applied migration ${entry.tag}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    console.log("Database migrations are current.");
  } finally {
    try {
      if (locked) {
        await client.query("select pg_advisory_unlock($1, $2)", migrationLockKey);
      }
    } finally {
      await client.end();
    }
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
