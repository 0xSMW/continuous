import type { JsonObject } from "../db/schema";

export type LeadSourceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

type LeadSourceReader = {
  kind: string;
  source: string;
  provider: string;
  cursor: string | null;
};

type PollInput = {
  connectionId: string;
  connectionConfig: JsonObject;
  sourceReader: LeadSourceReader;
  limit?: number;
  fetchFn?: LeadSourceFetch;
  env?: Record<string, string | undefined>;
};

export type LeadSourcePollResult = {
  records: JsonObject[];
  receipt: JsonObject;
};

export class LeadSourceConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    const output = stringValue(value);

    if (output) {
      return output;
    }
  }

  return "";
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown) {
  return value === true || value === "true";
}

function boundedLimit(value: unknown, fallback = 10) {
  return Math.max(1, Math.min(25, Math.trunc(numberValue(value, fallback))));
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function sourcePollingConfig(connectionConfig: JsonObject) {
  return objectValue(connectionConfig.polling ?? connectionConfig.liveRead ?? connectionConfig.apiRead);
}

function credentialRefFor(connectionConfig: JsonObject, pollingConfig: JsonObject) {
  const auth = objectValue(connectionConfig.auth);

  return firstStringValue(
    pollingConfig.credentialRef,
    pollingConfig.accessTokenRef,
    auth.credentialRef,
    auth.accessTokenRef,
    connectionConfig.credentialRef,
    connectionConfig.accessTokenRef,
  );
}

function accessTokenFor(input: {
  credentialRef: string;
  env: Record<string, string | undefined>;
}) {
  const envMatch = input.credentialRef.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);

  if (!envMatch) {
    return null;
  }

  return stringValue(input.env[envMatch[1]]);
}

function requireAccessToken(params: {
  connectionConfig: JsonObject;
  pollingConfig: JsonObject;
  env: Record<string, string | undefined>;
}) {
  const credentialRef = credentialRefFor(params.connectionConfig, params.pollingConfig);
  const accessToken = credentialRef
    ? accessTokenFor({ credentialRef, env: params.env })
    : null;

  if (!credentialRef || !accessToken) {
    throw new LeadSourceConnectorError(
      "worker_lead_read_live_credential_missing",
      "Connection polling requires a credentialRef that resolves to an environment token reference.",
      409,
    );
  }

  return { credentialRef, accessToken };
}

async function fetchJson(
  fetchFn: LeadSourceFetch,
  url: URL,
  init: RequestInit,
  errorCode: string,
) {
  const response = await fetchFn(url, init);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new LeadSourceConnectorError(
      errorCode,
      `Lead source connector request failed with HTTP ${response.status}.`,
      response.status >= 400 && response.status < 500 ? 400 : 502,
    );
  }

  return objectValue(parsed);
}

function headerValue(message: JsonObject, name: string) {
  const headers = Array.isArray(objectValue(message.payload).headers)
    ? (objectValue(message.payload).headers as unknown[])
    : [];
  const lowerName = name.toLowerCase();
  const header = headers
    .map((item) => objectValue(item))
    .find((item) => stringValue(item.name).toLowerCase() === lowerName);

  return stringValue(header?.value);
}

function isoDateFrom(value: unknown) {
  const raw = stringValue(value);

  if (!raw) {
    return "";
  }

  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(raw);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function pollGmail(input: PollInput, pollingConfig: JsonObject) {
  const fetchFn = input.fetchFn ?? fetch;
  const env = input.env ?? process.env;
  const { credentialRef, accessToken } = requireAccessToken({
    connectionConfig: input.connectionConfig,
    pollingConfig,
    env,
  });
  const endpointBase = trimTrailingSlash(
    firstStringValue(pollingConfig.endpointBase, "https://gmail.googleapis.com/gmail/v1"),
  );
  const userId = firstStringValue(pollingConfig.userId, "me");
  const maxResults = boundedLimit(pollingConfig.maxResults ?? input.limit);
  const labelIds = stringList(pollingConfig.labelIds).length > 0
    ? stringList(pollingConfig.labelIds)
    : ["INBOX"];
  const listUrl = new URL(`${endpointBase}/users/${encodeURIComponent(userId)}/messages`);
  const query = firstStringValue(pollingConfig.query, pollingConfig.q);
  const pageToken = firstStringValue(pollingConfig.pageToken, objectValue(input.connectionConfig.lastLeadRead).apiCursor);

  listUrl.searchParams.set("maxResults", String(maxResults));
  for (const labelId of labelIds) {
    listUrl.searchParams.append("labelIds", labelId);
  }
  if (query) {
    listUrl.searchParams.set("q", query);
  }
  if (pageToken) {
    listUrl.searchParams.set("pageToken", pageToken);
  }
  if (booleanValue(pollingConfig.includeSpamTrash)) {
    listUrl.searchParams.set("includeSpamTrash", "true");
  }

  const list = await fetchJson(
    fetchFn,
    listUrl,
    { headers: { authorization: `Bearer ${accessToken}` } },
    "worker_lead_read_gmail_poll_failed",
  );
  const messages = Array.isArray(list.messages) ? list.messages.map((item) => objectValue(item)) : [];
  const records: JsonObject[] = [];

  for (const messageRef of messages.slice(0, maxResults)) {
    const messageId = stringValue(messageRef.id);

    if (!messageId) {
      continue;
    }

    const messageUrl = new URL(
      `${endpointBase}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}`,
    );
    messageUrl.searchParams.set("format", "metadata");
    for (const header of ["From", "Subject", "Date", "Message-ID"]) {
      messageUrl.searchParams.append("metadataHeaders", header);
    }

    const message = await fetchJson(
      fetchFn,
      messageUrl,
      { headers: { authorization: `Bearer ${accessToken}` } },
      "worker_lead_read_gmail_message_failed",
    );
    const receivedAt = isoDateFrom(message.internalDate) || isoDateFrom(headerValue(message, "Date"));

    records.push({
      sourceEventId: messageId,
      sourceCursor: messageId,
      messageId,
      threadId: firstStringValue(message.threadId, messageRef.threadId),
      from: headerValue(message, "From"),
      subject: headerValue(message, "Subject"),
      snippet: stringValue(message.snippet).replace(/\s+/g, " ").trim(),
      receivedAt,
      payload: {
        provider: "google_workspace",
        api: "gmail",
        messageId,
        threadId: firstStringValue(message.threadId, messageRef.threadId),
        labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
        internalDate: stringValue(message.internalDate),
        headers: objectValue(message.payload).headers ?? [],
      },
    });
  }

  return {
    records,
    receipt: {
      provider: "google_workspace",
      api: "gmail",
      mode: "api_poll",
      connectionId: input.connectionId,
      credentialRef,
      endpoint: new URL(endpointBase).origin,
      userId,
      requested: maxResults,
      returned: records.length,
      nextPageToken: stringValue(list.nextPageToken) || null,
      externalExecution: "blocked",
      externalSend: false,
    },
  };
}

function hubspotSearchPath(pollingConfig: JsonObject) {
  const objectType = firstStringValue(pollingConfig.objectType, "deals");
  const configuredPath = firstStringValue(pollingConfig.path, pollingConfig.searchPath);

  if (configuredPath) {
    return configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`;
  }

  const apiVersion = firstStringValue(pollingConfig.apiVersion, "v3");

  if (apiVersion === "v3") {
    return `/crm/v3/objects/${encodeURIComponent(objectType)}/search`;
  }

  return `/crm/objects/${encodeURIComponent(apiVersion)}/${encodeURIComponent(objectType)}/search`;
}

function hubspotUpdatedAt(properties: JsonObject, fallback: unknown) {
  return (
    isoDateFrom(properties.hs_lastmodifieddate) ||
    isoDateFrom(properties.updatedAt) ||
    isoDateFrom(fallback)
  );
}

async function pollHubSpot(input: PollInput, pollingConfig: JsonObject) {
  const fetchFn = input.fetchFn ?? fetch;
  const env = input.env ?? process.env;
  const { credentialRef, accessToken } = requireAccessToken({
    connectionConfig: input.connectionConfig,
    pollingConfig,
    env,
  });
  const endpointBase = trimTrailingSlash(
    firstStringValue(pollingConfig.endpointBase, "https://api.hubapi.com"),
  );
  const maxResults = boundedLimit(pollingConfig.maxResults ?? input.limit);
  const objectType = firstStringValue(pollingConfig.objectType, "deals");
  const properties = stringList(pollingConfig.properties).length > 0
    ? stringList(pollingConfig.properties)
    : [
        "dealname",
        "amount",
        "closedate",
        "pipeline",
        "dealstage",
        "createdate",
        "hs_lastmodifieddate",
        "hs_object_id",
      ];
  const searchUrl = new URL(`${endpointBase}${hubspotSearchPath(pollingConfig)}`);
  const previousCursor = firstStringValue(input.sourceReader.cursor, objectValue(input.connectionConfig.lastLeadRead).cursor);
  const previousCursorDate = isoDateFrom(previousCursor);
  const body: JsonObject = {
    limit: maxResults,
    properties,
    sorts: Array.isArray(pollingConfig.sorts)
      ? pollingConfig.sorts
      : [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
  };

  if (Array.isArray(pollingConfig.filterGroups)) {
    body.filterGroups = pollingConfig.filterGroups;
  } else if (previousCursorDate) {
    body.filterGroups = [
      {
        filters: [
          {
            propertyName: "hs_lastmodifieddate",
            operator: "GT",
            value: String(Date.parse(previousCursorDate)),
          },
        ],
      },
    ];
  }
  if (stringValue(pollingConfig.query)) {
    body.query = stringValue(pollingConfig.query);
  }
  if (stringValue(pollingConfig.after)) {
    body.after = stringValue(pollingConfig.after);
  }

  const response = await fetchJson(
    fetchFn,
    searchUrl,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    "worker_lead_read_hubspot_poll_failed",
  );
  const results = Array.isArray(response.results) ? response.results.map((item) => objectValue(item)) : [];
  const records = results.slice(0, maxResults).map((result): JsonObject => {
    const props = objectValue(result.properties);
    const id = firstStringValue(result.id, props.hs_object_id);
    const updatedAt = hubspotUpdatedAt(props, result.updatedAt);

    return {
      sourceEventId: id ? `hubspot:${objectType}:${id}` : "",
      sourceCursor: updatedAt || id,
      externalId: id ? `hubspot:${objectType}:${id}` : "",
      dealId: id,
      companyName: firstStringValue(props.company, props.companyName, props.associatedcompanyid),
      contactName: firstStringValue(props.contactName, props.firstname, props.lastname),
      dealName: firstStringValue(props.dealname, props.name),
      stage: firstStringValue(props.dealstage, props.stage),
      pipelineStage: firstStringValue(props.dealstage, props.stage),
      updatedAt,
      payload: {
        provider: "hubspot",
        api: "crm.search",
        objectType,
        id,
        properties: props,
        createdAt: firstStringValue(props.createdate, result.createdAt),
        updatedAt,
        archived: result.archived === true,
      },
    };
  }).filter((record) => stringValue(record.sourceEventId));
  const paging = objectValue(response.paging);
  const next = objectValue(paging.next);

  return {
    records,
    receipt: {
      provider: "hubspot",
      api: "crm.search",
      mode: "api_poll",
      connectionId: input.connectionId,
      credentialRef,
      endpoint: new URL(endpointBase).origin,
      objectType,
      requested: maxResults,
      returned: records.length,
      nextAfter: stringValue(next.after) || null,
      externalExecution: "blocked",
      externalSend: false,
    },
  };
}

export async function pollLeadSourceConnection(input: PollInput): Promise<LeadSourcePollResult | null> {
  const pollingConfig = sourcePollingConfig(input.connectionConfig);

  if (pollingConfig.enabled !== true) {
    return null;
  }

  const provider = firstStringValue(pollingConfig.provider, input.sourceReader.provider).toLowerCase();

  if (provider.includes("google") || provider.includes("gmail")) {
    return pollGmail(input, pollingConfig);
  }

  if (provider.includes("hubspot")) {
    return pollHubSpot(input, pollingConfig);
  }

  throw new LeadSourceConnectorError(
    "worker_lead_read_live_provider_unsupported",
    "Connection polling is not supported for this lead source provider yet.",
    400,
  );
}
