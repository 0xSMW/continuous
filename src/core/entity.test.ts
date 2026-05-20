import { describe, expect, it } from "vitest";

import { recordEntitySetup } from "./entity";

describe("Core entity setup", () => {
  it("rejects raw bank account material before touching persistence", async () => {
    await expect(
      recordEntitySetup({
        operatorEmail: "operator@example.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: "entity-setup-secret-test-001",
        legalEntity: {
          legalName: "Continuous Demo LLC",
          entityType: "llc",
          jurisdiction: "DE",
        },
        bankAccount: {
          name: "Operating account",
          accountNumber: "example-raw-account-material",
        },
      }),
    ).rejects.toMatchObject({
      code: "entity_setup_secret_material_rejected",
      status: 400,
    });
  });

  it("requires setup facts to stay under config-shaped arrays", async () => {
    await expect(
      recordEntitySetup({
        operatorEmail: "operator@example.com",
        tenantSlug: "continuous-demo",
        idempotencyKey: "entity-setup-shape-test-001",
        legalEntity: {
          legalName: "Continuous Demo LLC",
          entityType: "llc",
          jurisdiction: "DE",
        },
        locations: "Continuous HQ",
      }),
    ).rejects.toMatchObject({
      code: "entity_setup_field_invalid",
      status: 400,
    });
  });
});
