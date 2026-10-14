import { describe, expect, test } from "bun:test";
import type { NetcupFetch } from "./auth";
import { unwrapCcp } from "./ccp-http";
import {
  NetcupCcpClient,
  NetcupClient,
  NetcupAuthError,
  NetcupError,
  type CcpComponents,
  type CcpDnsChangeSet,
  type CcpDnsRecordInput,
  type CcpPaths,
  type paths,
} from "./index";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope<T>(result: T, meta: unknown = null) {
  return { success: true as const, errors: [], messages: [], meta, result };
}

function mockFetch(
  handler: (request: Request) => Response | Promise<Response>,
) {
  const requests: Request[] = [];
  const fetch: NetcupFetch = async (request) => {
    requests.push(request.clone());
    return handler(request);
  };
  return { fetch, requests };
}

const domainId = 123;
const revisionId = "6ad043e1-1c84-46db-94a6-7962a373bc66";
const recordId = "1a54e58a-ef40-44d9-84a5-583f56b09c5e";
const scope = "@";
const value = "a".repeat(43);
const record: CcpDnsRecordInput = {
  name: "@",
  type: "MX",
  rdata: "10 mail.example.com.",
  ttl: 300,
};
const changes: CcpDnsChangeSet = {
  autoCommit: false,
  strict: true,
  create: [record],
  delete: [{ ...record, ttl: 600 }],
};
const domainQuery = {
  domainId,
  fqdn: "example.com",
  field: "fqdn" as const,
  direction: "desc" as const,
  page: 2,
  perPage: 5,
};
const revisionQuery = {
  field: "modifiedAt",
  direction: "asc" as const,
  page: 3,
  perPage: 10,
};
const revisionPath = `/v1/domain/${domainId}/dns/revision/${revisionId}`;
const challengePath = `/v1/domain/${domainId}/acme/challenge`;

interface Operation {
  name: string;
  call(client: NetcupCcpClient): Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number>;
  response: unknown;
  status?: number;
  public?: boolean;
}

const operations: Operation[] = [
  {
    name: "recordTypes",
    call: (client) => client.dns.recordTypes(),
    method: "GET",
    path: "/v1/dns/recordType",
    response: envelope({ type: ["A", "TXT"] }),
    public: true,
  },
  {
    name: "list domains",
    call: (client) => client.domains.list(domainQuery),
    method: "GET",
    path: `/v1/domain`,
    query: domainQuery,
    response: envelope([{}], { pagination: { page: 2, nextPage: 3 } }),
  },
  {
    name: "listAcmeChallenges",
    call: (client) => client.domains.listAcmeChallenges(domainId),
    method: "GET",
    path: challengePath,
    response: envelope([{}]),
  },
  {
    name: "createAcmeChallenge",
    call: (client) =>
      client.domains.createAcmeChallenge(domainId, { scope, value }),
    method: "POST",
    path: challengePath,
    body: { scope, value },
    response: envelope([{ scope, value }]),
    status: 201,
  },
  {
    name: "getAcmeChallenge",
    call: (client) => client.domains.getAcmeChallenge(domainId, scope, value),
    method: "GET",
    path: `${challengePath}/%40/${value}`,
    response: envelope([{}]),
  },
  {
    name: "deleteAcmeChallenge",
    call: (client) =>
      client.domains.deleteAcmeChallenge(domainId, scope, value),
    method: "DELETE",
    path: `${challengePath}/%40/${value}`,
    response: undefined,
    status: 204,
  },
  {
    name: "applyChanges",
    call: (client) => client.dns.applyChanges(domainId, changes),
    method: "POST",
    path: `/v1/domain/${domainId}/changeset`,
    body: changes,
    response: envelope({}),
  },
  {
    name: "listRevisions",
    call: (client) => client.dns.listRevisions(domainId, revisionQuery),
    method: "GET",
    path: `/v1/domain/${domainId}/dns/revision`,
    query: revisionQuery,
    response: envelope([{}], { pagination: { page: 3, lastPage: 4 } }),
  },
  {
    name: "createRevision",
    call: (client) => client.dns.createRevision(domainId),
    method: "POST",
    path: `/v1/domain/${domainId}/dns/revision`,
    response: envelope({}),
  },
  {
    name: "getRevision",
    call: (client) => client.dns.getRevision(domainId, revisionId),
    method: "GET",
    path: revisionPath,
    response: envelope({}),
  },
  {
    name: "deleteRevision",
    call: (client) => client.dns.deleteRevision(domainId, revisionId),
    method: "DELETE",
    path: revisionPath,
    response: envelope(null),
  },
  {
    name: "applyRevisionChanges",
    call: (client) =>
      client.dns.applyRevisionChanges(domainId, revisionId, {
        autoCommit: false,
        strict: true,
        create: [],
        delete: null,
      }),
    method: "POST",
    path: `${revisionPath}/changeset`,
    body: { autoCommit: false, strict: true, create: [], delete: null },
    response: envelope({}),
  },
  {
    name: "commitRevision",
    call: (client) => client.dns.commitRevision(domainId, revisionId),
    method: "POST",
    path: `${revisionPath}/commit`,
    response: envelope({}),
  },
  {
    name: "listRecords",
    call: (client) => client.dns.listRecords(domainId, revisionId),
    method: "GET",
    path: `${revisionPath}/record`,
    response: envelope([{}], {}),
  },
  {
    name: "createRecord",
    call: (client) => client.dns.createRecord(domainId, revisionId, record),
    method: "POST",
    path: `${revisionPath}/record`,
    body: record,
    response: envelope({}),
  },
  {
    name: "getRecord",
    call: (client) => client.dns.getRecord(domainId, revisionId, recordId),
    method: "GET",
    path: `${revisionPath}/record/${recordId}`,
    response: envelope({}),
  },
  {
    name: "deleteRecord",
    call: (client) => client.dns.deleteRecord(domainId, revisionId, recordId),
    method: "DELETE",
    path: `${revisionPath}/record/${recordId}`,
    response: envelope(null),
  },
];

describe("CCP operations", () => {
  test("covers all 17 operations", () => {
    expect(operations).toHaveLength(17);
    expect(
      new Set(operations.map(({ method, path }) => `${method} ${path}`)).size,
    ).toBe(17);
  });

  for (const operation of operations) {
    test(`${operation.name} preserves its method, parameters, body and envelope`, async () => {
      const mock = mockFetch(() =>
        operation.status === 204
          ? new Response(null, { status: 204 })
          : json(operation.response, operation.status),
      );
      const client = new NetcupCcpClient({
        apiKey: "ccp-key",
        fetch: mock.fetch,
      });
      expect(await operation.call(client)).toEqual(operation.response);
      expect(mock.requests).toHaveLength(1);
      const request = mock.requests[0];
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.netcup.com");
      expect(url.pathname).toBe(operation.path);
      expect(request.method).toBe(operation.method);
      expect(request.headers.get("Accept")).toBe("application/json");
      expect(request.headers.get("Authorization")).toBe(
        operation.public ? null : "Bearer ccp-key",
      );
      expect(Object.fromEntries(url.searchParams)).toEqual(
        Object.fromEntries(
          Object.entries(operation.query ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      );
      if (operation.body === undefined) {
        expect(request.body).toBeNull();
        expect(await request.text()).toBe("");
        expect(request.headers.has("Content-Type")).toBe(false);
      } else {
        expect(request.headers.get("Content-Type")).toBe("application/json");
        expect(await request.json()).toEqual(operation.body);
      }
    });
  }

  test("encodes path strings without adding undocumented parameters", async () => {
    const mock = mockFetch(() => json(envelope([])));
    const client = new NetcupCcpClient({ apiKey: "key", fetch: mock.fetch });
    await client.domains.getAcmeChallenge(domainId, "sub/label", "a+b?c");
    expect(new URL(mock.requests[0].url).pathname).toBe(
      `${challengePath}/sub%2Flabel/a%2Bb%3Fc`,
    );
    expect(new URL(mock.requests[0].url).search).toBe("");
  });

  test("keeps warnings, pagination, optional DTO fields and HTTP metadata", async () => {
    const body: CcpPaths["/v1/domain"]["get"]["responses"][200]["content"]["application/json"] =
      {
        success: true,
        errors: [],
        messages: [{ code: "warning", message: "Check this warning" }],
        meta: {
          sort: { field: "fqdn", direction: "asc" },
          pagination: { page: 1, perPage: 2, totalEntries: 3, nextPage: 2 },
        },
        result: [{}, { id: domainId }],
      };
    const mock = mockFetch(() => {
      const response = json(body);
      response.headers.set("X-Request-Id", "request-123");
      return response;
    });
    const client = new NetcupCcpClient({ apiKey: "key", fetch: mock.fetch });
    const named: CcpPaths["/v1/domain"]["get"]["responses"][200]["content"]["application/json"] =
      await client.domains.list();
    expect(named).toEqual(body);
    expect(named.result[0].fqdn).toBeUndefined();
    expect(named.meta.pagination?.nextPage).toBe(2);
    const raw = await client.api.GET("/v1/domain");
    expect(raw.response.headers.get("X-Request-Id")).toBe("request-123");
    if (!raw.data) throw new Error("Expected a successful raw response");
    expect(await unwrapCcp(Promise.resolve(raw))).toBe(raw.data);

    const partialRevision: CcpComponents["schemas"]["DomainDnsRevision"] = {};
    const partialRecord: CcpComponents["schemas"]["DomainDnsRecord"] = {};
    expect(partialRevision.identifier).toBeUndefined();
    expect(partialRecord.ttl).toBeUndefined();
  });
});

describe("CCP authentication separation", () => {
  test("does not require or send keys for the public record types endpoint", async () => {
    for (const apiKey of [undefined, "key", "invalid key"]) {
      const mock = mockFetch(() => json(envelope({})));
      const client = new NetcupCcpClient({ apiKey, fetch: mock.fetch });
      expect(await client.dns.recordTypes()).toEqual(envelope({}));
      await client.api.GET("/v1/dns/recordType", {
        headers: { Authorization: "Bearer must-not-be-sent" },
      });
      expect(mock.requests).toHaveLength(2);
      for (const request of mock.requests) {
        expect(request.headers.has("Authorization")).toBe(false);
      }
    }
  });

  test("requires a key before every protected operation sends a request", async () => {
    const mock = mockFetch(() => {
      throw new Error("Protected calls must fail before fetch");
    });
    const client = new NetcupCcpClient({ fetch: mock.fetch });
    for (const operation of operations.filter(
      (operation) => !operation.public,
    )) {
      await expect(operation.call(client)).rejects.toBeInstanceOf(
        NetcupAuthError,
      );
    }
    expect(mock.requests).toHaveLength(0);
  });

  test("rejects empty, whitespace, control and non-printable keys before fetch", async () => {
    const mock = mockFetch(() => json(envelope([])));
    for (const apiKey of [
      "",
      " ",
      "key with space",
      "key\t",
      "key\n",
      "key\u007f",
      "keyé",
    ]) {
      const client = new NetcupCcpClient({ apiKey, fetch: mock.fetch });
      await expect(client.domains.list()).rejects.toThrow("CCP API key");
    }
    expect(mock.requests).toHaveLength(0);
  });

  test("uses a string constructor argument as the CCP key", async () => {
    const mock = mockFetch(() => json(envelope([])));
    const client = new NetcupCcpClient("string-key");
    await client.api.GET("/v1/domain", { fetch: mock.fetch });
    expect(mock.requests[0].headers.get("Authorization")).toBe(
      "Bearer string-key",
    );
  });

  test("keeps SCP and CCP keys, hosts and fetch functions separate", async () => {
    const scp = mockFetch(() => json([]));
    const ccp = mockFetch(() => json(envelope([])));
    const client = new NetcupClient({
      accessToken: "scp-token",
      baseUrl: "https://scp.example.com/root/",
      authUrl: "https://auth.example.com",
      fetch: scp.fetch,
      ccp: {
        apiKey: "ccp-key",
        baseUrl: "https://ccp.example.com/root///",
        fetch: ccp.fetch,
      },
    });
    await client.servers.list();
    await client.ccp.domains.list();
    expect(scp.requests).toHaveLength(1);
    expect(ccp.requests).toHaveLength(1);
    expect(scp.requests[0].url).toBe(
      "https://scp.example.com/root/api/v1/servers",
    );
    expect(ccp.requests[0].url).toBe("https://ccp.example.com/root/v1/domain");
    expect(scp.requests[0].headers.get("Authorization")).toBe(
      "Bearer scp-token",
    );
    expect(ccp.requests[0].headers.get("Authorization")).toBe("Bearer ccp-key");
  });

  test("does not inherit an SCP access token, host or fetch for CCP", async () => {
    const scp = mockFetch(() => {
      throw new Error("CCP must not call the SCP fetch function");
    });
    const ccp = mockFetch(() => json(envelope([])));
    const client = new NetcupClient({
      accessToken: "scp-only",
      baseUrl: "https://scp.example.com",
      fetch: scp.fetch,
      ccp: {},
    });
    await expect(client.ccp.domains.list()).rejects.toThrow("CCP API key");
    await client.ccp.api.GET("/v1/dns/recordType", { fetch: ccp.fetch });
    expect(ccp.requests[0].url).toBe(
      "https://api.netcup.com/v1/dns/recordType",
    );
    expect(ccp.requests[0].headers.has("Authorization")).toBe(false);
    expect(scp.requests).toHaveLength(0);
  });

  test("requires explicit root CCP configuration without breaking SCP", async () => {
    const mock = mockFetch(() => json([]));
    const client = new NetcupClient({ accessToken: "scp", fetch: mock.fetch });
    expect(() => client.ccp).toThrow("ccp: { apiKey }");
    expect(mock.requests).toHaveLength(0);
    const servers:
      | paths["/api/v1/servers"]["get"]["responses"][200]["content"]["application/hal+json"]
      | undefined = await client.servers.list();
    expect(servers).toEqual([]);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("CCP response handling", () => {
  test("rejects HTTP 200 application failures with their original body", async () => {
    const body = {
      success: false,
      errors: [
        { code: "invalid", message: "Record was rejected" },
        { message: "Check its TTL" },
      ],
      messages: [],
      meta: null,
      result: null,
    };
    const client = new NetcupCcpClient({
      apiKey: "key",
      fetch: async () => json(body),
    });
    try {
      await client.dns.applyChanges(domainId, changes);
      throw new Error("Expected an API error");
    } catch (error) {
      expect(error).toBeInstanceOf(NetcupError);
      if (!(error instanceof NetcupError)) throw error;
      expect(error.status).toBe(200);
      expect(error.message).toBe("Record was rejected; Check its TTL");
      expect(error.body).toEqual(body);
    }
  });

  test("rejects missing required envelope fields and malformed envelopes", async () => {
    const complete = envelope([]);
    const missingFields = Object.keys(complete).map((missing) =>
      Object.fromEntries(
        Object.entries(complete).filter(([key]) => key !== missing),
      ),
    );
    for (const body of [
      ...missingFields,
      null,
      [],
      true,
      "not an envelope",
      { ...complete, success: "true" },
      { ...complete, errors: null },
      { ...complete, messages: {} },
      { ...complete, meta: [] },
      { ...complete, meta: "invalid" },
    ]) {
      const client = new NetcupCcpClient({
        apiKey: "key",
        fetch: async () => json(body),
      });
      await expect(client.domains.list()).rejects.toThrow(
        "invalid CCP response",
      );
    }
    for (const status of [200, 204]) {
      const client = new NetcupCcpClient({
        apiKey: "key",
        fetch: async () => new Response(null, { status }),
      });
      await expect(client.domains.list()).rejects.toThrow(
        "invalid CCP response",
      );
    }
  });

  test("does not accept an inherited result or leak malformed response messages", async () => {
    const body = {
      success: true,
      errors: [],
      messages: [],
      meta: null,
      message: "This must not replace the safe invalid-response message",
    };
    Object.setPrototypeOf(body, { result: [] });
    try {
      await unwrapCcp(
        Promise.resolve({ data: body, response: new Response() }),
      );
      throw new Error("Expected an invalid response error");
    } catch (error) {
      if (!(error instanceof NetcupError)) throw error;
      expect(error.message).toContain("invalid CCP response");
      expect(error.body).toBe(body);
    }
  });

  test("preserves structured, non-JSON and empty HTTP error bodies", async () => {
    const cases = [
      {
        response: json(
          { errors: [null, { message: 42 }, { message: "Domain not found" }] },
          404,
        ),
        body: {
          errors: [null, { message: 42 }, { message: "Domain not found" }],
        },
        message: "Domain not found",
      },
      {
        response: new Response("Gateway failed", { status: 502 }),
        body: "Gateway failed",
      },
      { response: new Response(null, { status: 403 }), body: "" },
      { response: json({ errors: [] }, 422), body: { errors: [] } },
    ];
    for (const entry of cases) {
      const client = new NetcupCcpClient({
        apiKey: "key",
        fetch: async () => entry.response,
      });
      try {
        await client.domains.list();
        throw new Error("Expected an API error");
      } catch (error) {
        if (!(error instanceof NetcupError)) throw error;
        expect(error.status).toBe(entry.response.status);
        expect(error.body).toEqual(entry.body);
        if (entry.message) expect(error.message).toBe(entry.message);
        else {
          expect(error.message).toContain("credentials");
          expect(error.message).not.toContain("access token");
        }
      }
    }
  });

  test("still reads existing SCP error messages", () => {
    expect(new NetcupError(400, [{ message: "Server is busy" }]).message).toBe(
      "Server is busy",
    );
    expect(new NetcupError(400, { message: "Invalid request" }).message).toBe(
      "Invalid request",
    );
  });

  test("never retries failed writes", async () => {
    const mock = mockFetch(() =>
      json({ errors: [{ message: "Try later" }] }, 503),
    );
    const client = new NetcupCcpClient({ apiKey: "key", fetch: mock.fetch });
    await expect(
      client.dns.commitRevision(domainId, revisionId),
    ).rejects.toThrow("Try later");
    expect(mock.requests).toHaveLength(1);
    const disconnected = mockFetch(() => {
      throw new Error("Connection closed");
    });
    const offline = new NetcupCcpClient({
      apiKey: "key",
      fetch: disconnected.fetch,
    });
    await expect(
      offline.dns.createRecord(domainId, revisionId, record),
    ).rejects.toThrow("Connection closed");
    expect(disconnected.requests).toHaveLength(1);
  });
});
