import { z } from "zod";

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgres://localhost:5432/continuous"),
  WORKER_RUN_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WORKER_RUN_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  WORKER_OPERATOR_EMAIL: z
    .preprocess((value) => (value === "" ? undefined : value), z.string().email().optional())
    .default("owner@continuoushq.com"),
});

export const env = envSchema.parse({
  APP_ENV: process.env.APP_ENV,
  APP_URL: process.env.APP_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_RUN_ENABLED: process.env.WORKER_RUN_ENABLED ?? process.env.REVENUE_WORKER_RUN_ENABLED,
  WORKER_RUN_TOKEN: process.env.WORKER_RUN_TOKEN ?? process.env.REVENUE_WORKER_RUN_TOKEN,
  WORKER_OPERATOR_EMAIL:
    process.env.WORKER_OPERATOR_EMAIL ?? process.env.REVENUE_WORKER_OPERATOR_EMAIL,
});
