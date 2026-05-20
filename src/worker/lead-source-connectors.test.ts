import { describe, expect, it } from "vitest";

import { pollLeadSourceConnection, type LeadSourceFetch } from "./lead-source-connectors";

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("lead source connectors", () => {
  it("polls Gmail read-only message metadata without exposing token material", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchFn: LeadSourceFetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      expect(init?.headers).toMatchObject({ authorization: "Bearer google-token" });

      if (url.pathname === "/gmail/v1/users/me/messages") {
        expect(url.searchParams.get("maxResults")).toBe("1");
        expect(url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
        return jsonResponse({
          messages: [{ id: "gmail-message-001", threadId: "thread-001" }],
        });
      }

      if (url.pathname === "/gmail/v1/users/me/messages/gmail-message-001") {
        expect(url.searchParams.get("format")).toBe("metadata");
        return jsonResponse({
          id: "gmail-message-001",
          threadId: "thread-001",
          internalDate: String(Date.parse("2026-05-19T04:00:00.000Z")),
          snippet: "Need roof leak inspection after storm.",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "Buyer One <buyer@example.com>" },
              { name: "Subject", value: "Roof leak inspection" },
              { name: "Date", value: "Tue, 19 May 2026 04:00:00 GMT" },
            ],
          },
        });
      }

      throw new Error(`unexpected URL ${url.toString()}`);
    };

    const result = await pollLeadSourceConnection({
      connectionId: "connection-001",
      connectionConfig: {
        polling: {
          enabled: true,
          provider: "google_workspace",
          endpointBase: "https://gmail.example.test/gmail/v1",
          credentialRef: "env:GOOGLE_TOKEN",
          maxResults: 1,
        },
      },
      sourceReader: {
        kind: "inbox",
        source: "google_workspace_inbox",
        provider: "google_workspace",
        cursor: null,
      },
      env: { GOOGLE_TOKEN: "google-token" },
      fetchFn,
    });

    expect(calls).toHaveLength(2);
    expect(result?.records).toEqual([
      expect.objectContaining({
        sourceEventId: "gmail-message-001",
        sourceCursor: "gmail-message-001",
        messageId: "gmail-message-001",
        threadId: "thread-001",
        from: "Buyer One <buyer@example.com>",
        subject: "Roof leak inspection",
        receivedAt: "2026-05-19T04:00:00.000Z",
      }),
    ]);
    expect(result?.receipt).toMatchObject({
      provider: "google_workspace",
      api: "gmail",
      mode: "api_poll",
      credentialRef: "env:GOOGLE_TOKEN",
      returned: 1,
      externalExecution: "blocked",
      externalSend: false,
    });
    expect(JSON.stringify(result)).not.toContain("google-token");
  });

  it("polls HubSpot search with cursor-derived modified-date filtering", async () => {
    let searchBody = {};
    const fetchFn: LeadSourceFetch = async (input, init) => {
      const url = new URL(String(input));

      expect(url.pathname).toBe("/crm/v3/objects/deals/search");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: "Bearer hubspot-token" });
      searchBody = JSON.parse(String(init?.body ?? "{}"));

      return jsonResponse({
        results: [
          {
            id: "deal-001",
            properties: {
              hs_object_id: "deal-001",
              dealname: "Window replacement quote",
              dealstage: "qualified",
              hs_lastmodifieddate: "2026-05-20T01:00:00.000Z",
            },
          },
        ],
        paging: { next: { after: "after-001" } },
      });
    };

    const result = await pollLeadSourceConnection({
      connectionId: "connection-002",
      connectionConfig: {
        polling: {
          enabled: true,
          provider: "hubspot",
          endpointBase: "https://hubspot.example.test",
          credentialRef: "env:HUBSPOT_TOKEN",
          objectType: "deals",
          maxResults: 2,
        },
        lastLeadRead: {
          cursor: "2026-05-19T00:00:00.000Z",
        },
      },
      sourceReader: {
        kind: "crm",
        source: "hubspot_crm",
        provider: "hubspot",
        cursor: null,
      },
      env: { HUBSPOT_TOKEN: "hubspot-token" },
      fetchFn,
    });

    expect(searchBody).toMatchObject({
      limit: 2,
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_lastmodifieddate",
              operator: "GT",
              value: String(Date.parse("2026-05-19T00:00:00.000Z")),
            },
          ],
        },
      ],
    });
    expect(result?.records).toEqual([
      expect.objectContaining({
        sourceEventId: "hubspot:deals:deal-001",
        sourceCursor: "2026-05-20T01:00:00.000Z",
        dealName: "Window replacement quote",
        stage: "qualified",
      }),
    ]);
    expect(result?.receipt).toMatchObject({
      provider: "hubspot",
      api: "crm.search",
      nextAfter: "after-001",
      credentialRef: "env:HUBSPOT_TOKEN",
      externalSend: false,
    });
    expect(JSON.stringify(result)).not.toContain("hubspot-token");
  });

  it("returns null when polling is disabled and requires environment-backed credentials when enabled", async () => {
    await expect(
      pollLeadSourceConnection({
        connectionId: "connection-003",
        connectionConfig: {},
        sourceReader: {
          kind: "inbox",
          source: "google_workspace_inbox",
          provider: "google_workspace",
          cursor: null,
        },
      }),
    ).resolves.toBeNull();

    await expect(
      pollLeadSourceConnection({
        connectionId: "connection-004",
        connectionConfig: {
          polling: {
            enabled: true,
            provider: "google_workspace",
            credentialRef: "env:MISSING_GOOGLE_TOKEN",
          },
        },
        sourceReader: {
          kind: "inbox",
          source: "google_workspace_inbox",
          provider: "google_workspace",
          cursor: null,
        },
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "worker_lead_read_live_credential_missing",
      status: 409,
    });

    await expect(
      pollLeadSourceConnection({
        connectionId: "connection-005",
        connectionConfig: {
          polling: {
            enabled: true,
            provider: "salesforce",
            credentialRef: "env:SALESFORCE_TOKEN",
          },
        },
        sourceReader: {
          kind: "crm",
          source: "salesforce_crm",
          provider: "salesforce",
          cursor: null,
        },
        env: { SALESFORCE_TOKEN: "salesforce-token" },
      }),
    ).rejects.toMatchObject({
      code: "worker_lead_read_live_provider_unsupported",
      status: 400,
    });
  });
});
