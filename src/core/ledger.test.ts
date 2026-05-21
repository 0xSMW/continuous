import { afterEach, describe, expect, it } from "vitest";

import {
  coreLedgerCollectionNames,
  coreLedgerOptionsFromConfig,
  getCoreLedgerHealth,
  type CoreLedger,
} from "./ledger";

const originalAppEnv = process.env.APP_ENV;

afterEach(() => {
  if (originalAppEnv === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = originalAppEnv;
  }
});

function ledgerFixture(): CoreLedger {
  return {
    schemaVersion: "continuous.core_ledger.v1",
    tenantName: "Continuous Demo",
    tenantSlug: "continuous-demo",
    limit: 2,
    availableCollections: [...coreLedgerCollectionNames],
    counts: {
      objects: 3,
      tasks: 2,
    },
    collections: {
      objects: {
        count: 3,
        items: [],
      },
      tasks: {
        count: 2,
        items: [],
      },
    },
  };
}

describe("Core ledger helpers", () => {
  it("keeps ledger view filters under config and clamps the read window", () => {
    expect(
      coreLedgerOptionsFromConfig("continuous-demo", {
        collections: ["objects", "tasks", "objects"],
        limit: 250,
      }),
    ).toEqual({
      tenantSlug: "continuous-demo",
      collections: ["objects", "tasks"],
      limit: 50,
    });
  });

  it("accepts comma-separated collection filters for app-server payloads", () => {
    expect(
      coreLedgerOptionsFromConfig("continuous-demo", {
        collections: "objects, tasks",
        limit: 2,
      }),
    ).toEqual({
      tenantSlug: "continuous-demo",
      collections: ["objects", "tasks"],
      limit: 2,
    });
  });

  it("rejects unsupported ledger collections and invalid limits", () => {
    expect(() =>
      coreLedgerOptionsFromConfig("continuous-demo", {
        collections: ["objects", "tokens"],
      }),
    ).toThrow("Unsupported Core ledger collection. Supported collections:");

    expect(() =>
      coreLedgerOptionsFromConfig("continuous-demo", {
        limit: 0,
      }),
    ).toThrow("config.limit must be a positive integer.");
  });

  it("returns ledger-specific health without pretending to be full Core readiness", () => {
    process.env.APP_ENV = "test";

    expect(
      getCoreLedgerHealth({
        ok: true,
        ledger: ledgerFixture(),
      }),
    ).toEqual(
      expect.objectContaining({
        service: "Continuous Core Ledger",
        status: "ok",
        mode: "test",
        summary: {
          collections: 2,
          records: 5,
          limit: 2,
        },
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "core_ledger",
            state: "pass",
          }),
        ]),
      }),
    );
  });
});
