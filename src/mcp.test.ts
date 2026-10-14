import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NetcupFetch } from "./auth";
import { CredentialStore } from "./credentials";
import { isRecord } from "./errors";
import { createMcpRuntime, type McpOptions } from "./mcp";

const toolNames = [
  "scp_servers_list",
  "scp_servers_get",
  "scp_tasks_list",
  "scp_tasks_get",
  "ccp_domains_list",
  "ccp_dns_record_types_list",
  "ccp_dns_revisions_list",
  "ccp_dns_revisions_get",
  "ccp_dns_records_list",
];
const revisionId = "2ec5bc64-5460-4ae4-9b13-522e5bb9f350";
const recordId = "7ef6775d-a687-4f80-a0e8-c3cd41f0f20b";
const tokens = {
  access_token: "fixture-mcp-access-secret",
  refresh_token: "fixture-mcp-rotated-secret",
  token_type: "Bearer",
  expires_in: 300,
  refresh_expires_in: 0,
};
const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
let buildRoot: string;
let cliRunner: string;

type Env = Record<string, string | undefined>;

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The test operation did not finish in time")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function envelope(result: unknown, meta: unknown = null) {
  return { success: true, errors: [], messages: [], meta, result };
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value;
}

function output(result: CallToolResult, error = false) {
  expect(Boolean(result.isError)).toBe(error);
  const structured = object(result.structuredContent);
  expect(result.content).toHaveLength(1);
  const text = result.content[0];
  if (text.type !== "text") throw new Error("Expected JSON text content");
  expect(JSON.parse(text.text)).toEqual(structured);
  return structured;
}

async function failure(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  let result: CallToolResult;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
  expect(result.isError).toBe(true);
  return JSON.stringify(result);
}

async function setup(
  handler?: (request: Request) => Response | Promise<Response>,
  extra: Env = {},
  options: Pick<McpOptions, "signal"> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "netcup-mcp-test-"));
  roots.push(root);
  const env: Env = {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    APPDATA: root,
    ...extra,
  };
  const requests: Request[] = [];
  const errors: string[] = [];
  const fetch: NetcupFetch = async (request) => {
    requests.push(request.clone());
    if (!handler) throw new Error("Unexpected network request");
    return handler(request);
  };
  const runtime = createMcpRuntime({
    env,
    fetch,
    ...options,
    stderr: (text) => errors.push(text),
  });
  cleanups.push(() => runtime.close());
  const connect = async (modern = false) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const messages: JSONRPCMessage[] = [];
    const replies = new Map<
      string | number,
      ReturnType<typeof deferred<JSONRPCMessage>>
    >();
    const send = serverSide.send.bind(serverSide);
    serverSide.send = async (message, ...args) => {
      messages.push(message);
      if ("id" in message && message.id !== undefined && message.id !== null) {
        replies.get(message.id)?.resolve(message);
      }
      return send(message, ...args);
    };
    const handle = serveStdio(runtime.createServer, { transport: serverSide });
    const client = new Client(
      { name: "netcup-test", version: "1.0.0" },
      modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
    );
    cleanups.push(async () => {
      await client.close();
      await handle.close();
    });
    await client.connect(clientSide);
    return {
      client,
      messages,
      async raw(id: string, name: string, args: Record<string, unknown>) {
        const response = deferred<JSONRPCMessage>();
        replies.set(id, response);
        try {
          await clientSide.send({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          });
          return await within(response.promise);
        } finally {
          replies.delete(id);
        }
      },
    };
  };
  return {
    root,
    env,
    requests,
    errors,
    runtime,
    connect,
    store: new CredentialStore(env),
    ccpStore: new CredentialStore(env, "ccp"),
  };
}

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "netcup-mcp-build-"));
  const build = await Bun.build({
    entrypoints: [resolve("src/cli.ts")],
    outdir: join(buildRoot, "build"),
    target: "node",
    format: "cjs",
    external: [
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/server/*",
      "zod",
      "zod/*",
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "CLI build failed");
  await symlink(
    resolve("node_modules"),
    join(buildRoot, "node_modules"),
    "dir",
  );
  cliRunner = join(buildRoot, "runner.cjs");
  await writeFile(
    cliRunner,
    `require(${JSON.stringify(build.outputs[0].path)}).main();\n`,
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

describe("MCP read-only contracts", () => {
  for (const modern of [false, true]) {
    test(`${modern ? "modern discovery" : "legacy initialization"} exposes exactly nine safe tools without credentials`, async () => {
      const fixture = await setup();
      const { client } = await fixture.connect(modern);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...toolNames].sort(),
      );
      for (const tool of tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        });
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.description?.length).toBeGreaterThan(20);
      }
      expect(fixture.requests).toHaveLength(0);
      expect(await readdir(fixture.root)).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  }

  test("unknown writes, raw requests, file tools and extra arguments fail before IO", async () => {
    const fixture = await setup();
    const { client } = await fixture.connect();
    for (const name of [
      "scp_servers_stop",
      "scp_servers_reboot",
      "scp_servers_update",
      "scp_snapshots_create",
      "scp_tasks_cancel",
      "ccp_dns_records_create",
      "ccp_dns_revisions_commit",
      "raw",
      "request",
      "read_file",
      "login",
      "constructor",
      "__proto__",
    ]) {
      await failure(client, name, {
        file: "/not-a-real-credentials-file",
        method: "POST",
      });
    }
    for (const [name, args] of [
      ["scp_servers_list", { file: "/not-a-real-file" }],
      ["scp_servers_get", { serverId: 1, raw: true }],
      ["scp_tasks_get", { uuid: "task", method: "PUT" }],
      ["ccp_dns_record_types_list", { apiKey: "override" }],
      ["ccp_domains_list", { baseUrl: "https://not-the-api.example" }],
      ["ccp_dns_records_list", { domainId: 1, revisionId, page: 1 }],
      ["ccp_dns_records_list", { domainId: 1, revisionId, perPage: 10 }],
    ] as const)
      await failure(client, name, args);
    expect(fixture.requests).toHaveLength(0);
    expect(await readdir(fixture.root)).toEqual([]);
  });

  test("numeric bounds, exact revisions and task states reject invalid values before auth", async () => {
    const fixture = await setup(undefined, {
      NETCUP_ACCESS_TOKEN: "fixture-scp",
      NETCUP_CCP_API_KEY: "fixture-ccp",
    });
    const { client } = await fixture.connect();
    for (const serverId of [0, -1, 1.5, 2_147_483_648, "1", null]) {
      await failure(client, "scp_servers_get", { serverId });
      await failure(client, "scp_tasks_list", { serverId });
      await failure(client, "scp_servers_list", { firewallPolicyId: serverId });
    }
    for (const value of [-1, 1.5, 2_147_483_648, "0"]) {
      await failure(client, "scp_servers_list", { limit: value });
      await failure(client, "scp_tasks_list", { offset: value });
    }
    for (const domainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      await failure(client, "ccp_domains_list", { domainId });
      await failure(client, "ccp_dns_revisions_get", { domainId, revisionId });
    }
    for (const revision of [
      "latest",
      "current",
      "not-a-uuid",
      ` ${revisionId}`,
      `${revisionId}\n`,
    ]) {
      for (const name of ["ccp_dns_revisions_get", "ccp_dns_records_list"]) {
        await failure(client, name, { domainId: 1, revisionId: revision });
      }
    }
    for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await failure(client, "ccp_domains_list", { page });
      await failure(client, "ccp_dns_revisions_list", {
        domainId: 1,
        perPage: page,
      });
    }
    await failure(client, "scp_tasks_list", { state: "ROLLBACK" });
    for (const uuid of [" ", ".", ".."]) {
      await failure(client, "scp_tasks_get", { uuid });
    }
    await failure(client, "ccp_domains_list", { field: "nickname" });
    await failure(client, "scp_servers_list", { sort: ["hostname"] });
    expect(fixture.requests).toHaveLength(0);
  });

  test("all nine tools bind their literal GET routes and native queries", async () => {
    const taskId = "plain task/id?value%2e";
    const fixture = await setup(
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/servers")) return json([{ id: 1 }]);
        if (path.endsWith("/servers/2147483647"))
          return json({ id: 2_147_483_647 });
        if (path.endsWith("/tasks"))
          return json([{ uuid: taskId, state: "ROLLBACK" }]);
        if (path.includes("/tasks/")) return json({ uuid: taskId });
        if (path.endsWith("/recordType"))
          return json(envelope({ type: ["A", "TXT"] }));
        if (path.endsWith("/domain")) return json(envelope([{ id: 42 }]));
        if (path.endsWith("/record"))
          return json(envelope([{ identifier: recordId }]));
        if (path.endsWith(`/revision/${revisionId}`))
          return json(envelope({ identifier: revisionId }));
        return json(envelope([{ identifier: revisionId }]));
      },
      { NETCUP_ACCESS_TOKEN: "fixture-scp", NETCUP_CCP_API_KEY: "fixture-ccp" },
    );
    const { client } = await fixture.connect();
    const cases: {
      name: string;
      args: Record<string, unknown>;
      path: string;
      query: Record<string, string>;
    }[] = [
      {
        name: "scp_servers_list",
        args: {
          firewallPolicyId: 1,
          ip: "192.0.2.1",
          limit: 0,
          name: "web",
          offset: 0,
          q: "a b",
          sort: ["name", "-nickname"],
        },
        path: "/scp-core/api/v1/servers",
        query: {
          firewallPolicyId: "1",
          ip: "192.0.2.1",
          limit: "0",
          name: "web",
          offset: "0",
          q: "a b",
          sort: "-nickname",
        },
      },
      {
        name: "scp_servers_get",
        args: { serverId: 2_147_483_647, loadServerLiveInfo: false },
        path: "/scp-core/api/v1/servers/2147483647",
        query: { loadServerLiveInfo: "false" },
      },
      {
        name: "scp_tasks_list",
        args: {
          serverId: 1,
          state: "RUNNING",
          q: "plain",
          limit: 0,
          offset: 0,
        },
        path: "/scp-core/api/v1/tasks",
        query: {
          serverId: "1",
          state: "RUNNING",
          q: "plain",
          limit: "0",
          offset: "0",
        },
      },
      {
        name: "scp_tasks_get",
        args: { uuid: taskId },
        path: "/scp-core/api/v1/tasks/plain%20task%2Fid%3Fvalue%252e",
        query: {},
      },
      {
        name: "ccp_domains_list",
        args: {
          domainId: Number.MAX_SAFE_INTEGER,
          fqdn: "example.com",
          field: "fqdn",
          direction: "desc",
          page: 2,
          perPage: 5,
        },
        path: "/v1/domain",
        query: {
          domainId: String(Number.MAX_SAFE_INTEGER),
          fqdn: "example.com",
          field: "fqdn",
          direction: "desc",
          page: "2",
          perPage: "5",
        },
      },
      {
        name: "ccp_dns_record_types_list",
        args: {},
        path: "/v1/dns/recordType",
        query: {},
      },
      {
        name: "ccp_dns_revisions_list",
        args: {
          domainId: 42,
          field: "modifiedAt",
          direction: "asc",
          page: 3,
          perPage: 10,
        },
        path: "/v1/domain/42/dns/revision",
        query: {
          field: "modifiedAt",
          direction: "asc",
          page: "3",
          perPage: "10",
        },
      },
      {
        name: "ccp_dns_revisions_get",
        args: { domainId: 42, revisionId },
        path: `/v1/domain/42/dns/revision/${revisionId}`,
        query: {},
      },
      {
        name: "ccp_dns_records_list",
        args: { domainId: 42, revisionId },
        path: `/v1/domain/42/dns/revision/${revisionId}/record`,
        query: {},
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const result = output(
        await client.callTool({ name: entry.name, arguments: entry.args }),
      );
      if (entry.name === "scp_tasks_list")
        expect(object(rows(result.result)[0]).state).toBe("ROLLBACK");
      const request = fixture.requests[index];
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(url.pathname).toBe(entry.path);
      expect(Object.fromEntries(url.searchParams)).toEqual(entry.query);
      expect(url.origin).toBe(
        entry.name.startsWith("scp_")
          ? "https://servercontrolpanel.de"
          : "https://api.netcup.com",
      );
      expect(request.headers.get("Authorization")).toBe(
        entry.name.startsWith("scp_")
          ? "Bearer fixture-scp"
          : entry.name === "ccp_dns_record_types_list"
            ? null
            : "Bearer fixture-ccp",
      );
    }
    expect(
      new URL(fixture.requests[0].url).searchParams.getAll("sort"),
    ).toEqual(["name", "-nickname"]);
    expect(fixture.requests).toHaveLength(9);
  });

  test("server and task projections strip unknown fields at every depth and preserve nulls", async () => {
    const privateFields = {
      password: "unconfigured-password",
      signedUrl: "https://private.example/signed",
      user: { email: "private@example.com" },
      result: { arbitrary: "private-result" },
      messages: ["private-message"],
    };
    const safeServer = {
      id: 1,
      name: "web",
      hostname: null,
      nickname: null,
      disabled: false,
      template: { id: 2, name: "VPS" },
      architecture: "AMD64",
      site: { id: 3, city: "Vienna" },
      ipv4Addresses: [{ ip: "192.0.2.1" }],
      ipv6Addresses: [{ networkPrefix: "2001:db8::", networkPrefixLength: 64 }],
      serverLiveInfo: {
        state: "ON",
        uptimeInSeconds: 0,
        cpuCount: 2,
        currentServerMemoryInMiB: 256,
        maxServerMemoryInMiB: 1024,
        disks: [{ dev: "sda", capacityInMiB: 2048 }],
      },
    };
    const server = {
      ...safeServer,
      ...privateFields,
      template: { ...safeServer.template, ...privateFields },
      site: { ...safeServer.site, ...privateFields },
      ipv4Addresses: [{ ...safeServer.ipv4Addresses[0], ...privateFields }],
      ipv6Addresses: [{ ...safeServer.ipv6Addresses[0], ...privateFields }],
      serverLiveInfo: {
        ...safeServer.serverLiveInfo,
        ...privateFields,
        disks: [{ ...safeServer.serverLiveInfo.disks[0], ...privateFields }],
      },
    };
    const safeTask = {
      uuid: "plain-task",
      name: "Restore",
      state: "ROLLBACK",
      onRollback: true,
      taskProgress: {
        progressInPercent: 0,
        expectedFinishedAt: "2026-10-14T12:00:00Z",
      },
      steps: [{ uuid: "step", name: "Restore disk", state: "RUNNING" }],
    };
    const task = {
      ...safeTask,
      ...privateFields,
      message: "private-task-message",
      executingUser: { id: 1, email: "private@example.com" },
      responseError: { message: "private-error" },
      taskProgress: { ...safeTask.taskProgress, ...privateFields },
      steps: [{ ...safeTask.steps[0], ...privateFields }],
    };
    const fixture = await setup(
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/servers"))
          return json([server, { hostname: null, template: null }]);
        if (path.endsWith("/servers/2"))
          return json({ serverLiveInfo: null, template: null });
        if (path.endsWith("/servers/1")) return json(server);
        return json(path.endsWith("/tasks") ? [task, {}] : task);
      },
      { NETCUP_ACCESS_TOKEN: "fixture-scp" },
    );
    const { client } = await fixture.connect();
    expect(
      output(
        await client.callTool({
          name: "scp_servers_get",
          arguments: { serverId: 1 },
        }),
      ),
    ).toEqual({ result: safeServer });
    expect(
      output(
        await client.callTool({
          name: "scp_servers_get",
          arguments: { serverId: 2 },
        }),
      ),
    ).toEqual({ result: { serverLiveInfo: null, template: null } });
    const summaries = output(
      await client.callTool({ name: "scp_servers_list", arguments: {} }),
    );
    expect(summaries.result).toEqual([
      {
        id: 1,
        name: "web",
        hostname: null,
        nickname: null,
        disabled: false,
        template: { id: 2, name: "VPS" },
      },
      { hostname: null, template: null },
    ]);
    expect(
      output(
        await client.callTool({
          name: "scp_tasks_get",
          arguments: { uuid: "plain-task" },
        }),
      ),
    ).toEqual({ result: safeTask });
    const { steps: _steps, ...taskSummary } = safeTask;
    expect(
      output(await client.callTool({ name: "scp_tasks_list", arguments: {} }))
        .result,
    ).toEqual([taskSummary, {}]);
  });

  test("SCP total count metadata is numeric or omitted, never a raw header", async () => {
    let count = "12";
    const fixture = await setup(
      () =>
        json([{ id: 1 }], 200, {
          "X-Total-Count": count,
          "X-Private": "private-header",
        }),
      { NETCUP_ACCESS_TOKEN: "fixture-scp" },
    );
    const { client } = await fixture.connect();
    for (const [header, expected] of [
      ["12", 12],
      ["0", 0],
      [" 7 ", 7],
      ["1.5", undefined],
      ["-1", undefined],
      ["9007199254740992", undefined],
      ["12-secret", undefined],
    ] as const) {
      count = header;
      const result = output(
        await client.callTool({ name: "scp_servers_list", arguments: {} }),
      );
      expect(result.meta).toEqual(
        expected === undefined ? undefined : { totalCount: expected },
      );
      expect(JSON.stringify(result)).not.toContain("private-header");
    }
  });

  test("CCP keeps projected warnings, metadata, records and nullable fields", async () => {
    const extra = {
      password: "private-password",
      signedUrl: "private-url",
      user: { id: 1 },
    };
    const meta = {
      sort: { field: "fqdn", direction: "asc" },
      pagination: {
        page: 1,
        perPage: 2,
        totalEntries: 2,
        previousPage: 0,
        nextPage: 0,
        lastPage: 1,
      },
    };
    const warning = { code: "warning", message: "Check the DNS settings" };
    const record = {
      identifier: recordId,
      name: "www",
      type: "A",
      rdata: "192.0.2.10",
      ttl: null,
      immutable: false,
    };
    const revision = {
      identifier: revisionId,
      createdAt: "2026-10-14",
      modifiedAt: "2026-10-14",
      state: "DRAFT",
      serial: null,
    };
    const fixture = await setup(
      (request) => {
        const path = new URL(request.url).pathname;
        const result = path.endsWith("/domain")
          ? [{ id: 42, fqdn: "example.com", isDnsManaged: true, ...extra }, {}]
          : path.endsWith("/record")
            ? [{ ...record, ...extra }, {}]
            : path.endsWith("/revision")
              ? [{ ...revision, ...extra }, {}]
              : { ...revision, ...extra };
        return json({
          ...envelope(result),
          ...extra,
          message: "private-undocumented-provider-message",
          errors: [{ ...warning, ...extra }],
          messages: [{ ...warning, ...extra }],
          meta: {
            ...meta,
            ...extra,
            sort: { ...meta.sort, ...extra },
            pagination: { ...meta.pagination, ...extra },
          },
        });
      },
      { NETCUP_CCP_API_KEY: "fixture-ccp" },
    );
    const { client } = await fixture.connect();
    for (const [name, args, result] of [
      [
        "ccp_domains_list",
        {},
        [{ id: 42, fqdn: "example.com", isDnsManaged: true }, {}],
      ],
      ["ccp_dns_revisions_list", { domainId: 42 }, [revision, {}]],
      ["ccp_dns_revisions_get", { domainId: 42, revisionId }, revision],
      ["ccp_dns_records_list", { domainId: 42, revisionId }, [record, {}]],
    ] as const) {
      const body = output(await client.callTool({ name, arguments: args }));
      expect(body).toEqual({
        success: true,
        errors: [warning],
        messages: [warning],
        meta,
        result,
        ...(name === "ccp_dns_records_list"
          ? { warning: expect.stringContaining("does not confirm") }
          : {}),
      });
    }
  });

  test("records warn about omitted or unconfirmed data without inventing paging or completeness", async () => {
    let meta: unknown = null;
    const fixture = await setup(
      () => json(envelope([{ name: "www", type: "A" }], meta)),
      { NETCUP_CCP_API_KEY: "fixture-ccp" },
    );
    const { client } = await fixture.connect();
    for (const [pagination, partial] of [
      [null, false],
      [{}, false],
      [{ totalEntries: 2 }, true],
      [{ page: 1, nextPage: 2 }, true],
      [{ page: 2, totalEntries: 1 }, true],
      [{ lastPage: 2 }, true],
      [
        { totalEntries: 1, page: 1, nextPage: 1, previousPage: 1, lastPage: 1 },
        false,
      ],
    ] as const) {
      meta = pagination === null ? null : { pagination };
      const body = output(
        await client.callTool({
          name: "ccp_dns_records_list",
          arguments: { domainId: 42, revisionId },
        }),
      );
      expect(body.complete).toBeUndefined();
      expect(String(body.warning)).toContain(
        partial ? "omitted" : "does not confirm",
      );
      expect(String(body.warning)).toContain("Customer Control Panel");
      expect(String(body.warning)).not.toContain("--page");
      expect(new URL(fixture.requests.at(-1)!.url).search).toBe("");
    }
  });

  test("public record types accept only strings, not arbitrary provider objects", async () => {
    let types: unknown = ["A", "TXT"];
    const fixture = await setup(() =>
      json(envelope({ type: types, password: "private" })),
    );
    const { client } = await fixture.connect();
    expect(
      output(
        await client.callTool({
          name: "ccp_dns_record_types_list",
          arguments: {},
        }),
      ),
    ).toEqual(envelope({ type: ["A", "TXT"] }));
    for (const invalid of [
      ["A", { password: "private-record-type" }],
      [1],
      null,
      "A",
    ]) {
      types = invalid;
      const result = output(
        await client.callTool({
          name: "ccp_dns_record_types_list",
          arguments: {},
        }),
        true,
      );
      expect(result.error).toBeString();
      expect(JSON.stringify(result)).not.toContain("private-record-type");
    }
  });
});

describe("MCP credentials and safe output", () => {
  test("discovery and public reads ignore invalid environment credentials and private files", async () => {
    const fixture = await setup(() => json(envelope({ type: ["A"] })), {
      NETCUP_ACCESS_TOKEN: "bad\nscp",
      NETCUP_REFRESH_TOKEN: "also-set",
      NETCUP_CCP_API_KEY: "bad\nccp",
    });
    await fixture.store.save("saved-scp", null);
    await fixture.ccpStore.save("saved-ccp", null);
    await writeFile(fixture.store.path, "malformed-private-scp");
    await writeFile(fixture.ccpStore.path, "malformed-private-ccp");
    if (process.platform !== "win32") {
      await chmod(fixture.store.path, 0o644);
      await chmod(fixture.ccpStore.path, 0o644);
    }
    const { client } = await fixture.connect(true);
    await client.listTools();
    output(
      await client.callTool({
        name: "ccp_dns_record_types_list",
        arguments: {},
      }),
    );
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].headers.has("Authorization")).toBe(false);
    expect(await readFile(fixture.store.path, "utf8")).toBe(
      "malformed-private-scp",
    );
    expect(await readFile(fixture.ccpStore.path, "utf8")).toBe(
      "malformed-private-ccp",
    );
  });

  test("SCP and CCP authenticate lazily and independently with environment precedence", async () => {
    const fixture = await setup(
      (request) =>
        json(
          new URL(request.url).pathname.endsWith("/servers")
            ? [{ id: 1 }]
            : envelope([{ id: 42 }]),
        ),
      { NETCUP_ACCESS_TOKEN: "env-scp", NETCUP_CCP_API_KEY: "env-ccp" },
    );
    await fixture.store.save("saved-scp", null);
    await fixture.ccpStore.save("saved-ccp", null);
    await writeFile(fixture.store.path, "bad-scp-file");
    await writeFile(fixture.ccpStore.path, "bad-ccp-file");
    const { client } = await fixture.connect();
    output(await client.callTool({ name: "scp_servers_list", arguments: {} }));
    output(await client.callTool({ name: "ccp_domains_list", arguments: {} }));
    expect(
      fixture.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer env-scp", "Bearer env-ccp"]);
    expect(await readFile(fixture.store.path, "utf8")).toBe("bad-scp-file");
    expect(await readFile(fixture.ccpStore.path, "utf8")).toBe("bad-ccp-file");

    const ccpOnly = await setup(() => json(envelope([{ id: 42 }])), {
      NETCUP_ACCESS_TOKEN: "bad\nscp",
      NETCUP_REFRESH_TOKEN: "also-set",
      NETCUP_CCP_API_KEY: "only-ccp",
    });
    const connected = await ccpOnly.connect();
    output(
      await connected.client.callTool({
        name: "ccp_domains_list",
        arguments: {},
      }),
    );
    output(
      await connected.client.callTool({
        name: "scp_servers_list",
        arguments: {},
      }),
      true,
    );
    expect(ccpOnly.requests).toHaveLength(1);

    const scpOnly = await setup(() => json([{ id: 1 }]), {
      NETCUP_ACCESS_TOKEN: "only-scp",
      NETCUP_CCP_API_KEY: "bad\nccp",
    });
    const other = await scpOnly.connect();
    output(
      await other.client.callTool({ name: "scp_servers_list", arguments: {} }),
    );
    output(
      await other.client.callTool({ name: "ccp_domains_list", arguments: {} }),
      true,
    );
    expect(scpOnly.requests).toHaveLength(1);
  });

  test("missing credentials are retried and redacted after a file or environment value is added", async () => {
    const fixture = await setup((request) =>
      request.url.endsWith("/token")
        ? json(tokens)
        : json(
            new URL(request.url).pathname.endsWith("/domain")
              ? envelope([{ id: 42 }])
              : [{ id: 1 }],
          ),
    );
    const { client } = await fixture.connect();
    for (const name of ["scp_servers_list", "ccp_domains_list"]) {
      const missing = output(
        await client.callTool({ name, arguments: {} }),
        true,
      );
      expect(String(missing.error)).toContain(
        name.startsWith("scp_") ? "login" : "ccp login",
      );
    }
    expect(fixture.requests).toHaveLength(0);
    expect(await readdir(fixture.root)).toEqual([]);
    await fixture.store.save("saved-scp", null);
    await fixture.ccpStore.save("saved-ccp", null);
    output(await client.callTool({ name: "scp_servers_list", arguments: {} }));
    output(await client.callTool({ name: "ccp_domains_list", arguments: {} }));
    expect(await fixture.store.read()).toBe(tokens.refresh_token);
    expect(await fixture.ccpStore.read()).toBe("saved-ccp");
    if (process.platform !== "win32") {
      expect((await lstat(dirname(fixture.store.path))).mode & 0o777).toBe(
        0o700,
      );
      expect((await lstat(fixture.store.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(fixture.ccpStore.path)).mode & 0o777).toBe(0o600);
    }
    for (const field of [
      "NETCUP_ACCESS_TOKEN",
      "NETCUP_REFRESH_TOKEN",
    ] as const) {
      const secret = `fixture-late-${field.toLowerCase()}-secret`;
      const late = await setup((request) =>
        request.url.endsWith("/token")
          ? json(tokens)
          : json([{ id: 1, name: secret }]),
      );
      const connected = await late.connect();
      output(
        await connected.client.callTool({
          name: "scp_servers_list",
          arguments: {},
        }),
        true,
      );
      expect(late.requests).toHaveLength(0);
      late.env[field] = secret;
      const result = output(
        await connected.client.callTool({
          name: "scp_servers_list",
          arguments: {},
        }),
      );
      expect(object(rows(result.result)[0]).name).toBe("[redacted]");
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("HTTP and transport failures use safe actionable messages, never raw bodies or headers", async () => {
    let status = 401;
    let applicationFailure = false;
    let networkFailure = false;
    const fixture = await setup(
      () => {
        if (networkFailure)
          throw new TypeError(
            "private-network-message fixture-scp fixture-ccp",
          );
        return json(
          {
            success: false,
            errors: [
              {
                code: applicationFailure
                  ? "authenticationError"
                  : "provider-code",
                message: "private-provider-message fixture-scp fixture-ccp",
              },
            ],
            messages: [{ message: "private-warning" }],
            meta: null,
            result: { password: "private-body" },
          },
          status,
          { "X-Private": "private-header" },
        );
      },
      { NETCUP_ACCESS_TOKEN: "fixture-scp", NETCUP_CCP_API_KEY: "fixture-ccp" },
    );
    const { client } = await fixture.connect();
    for (const [code, expected] of [
      [401, "login"],
      [403, "permissions"],
      [404, "ID"],
      [429, "Wait"],
      [503, "retry"],
      [400, "arguments"],
    ] as const) {
      status = code;
      const body = output(
        await client.callTool({ name: "scp_servers_list", arguments: {} }),
        true,
      );
      expect(String(body.error)).toContain(expected);
      for (const secret of [
        "private-provider-message",
        "private-warning",
        "private-body",
        "private-header",
        "fixture-scp",
        "fixture-ccp",
      ])
        expect(JSON.stringify(body)).not.toContain(secret);
    }
    status = 200;
    applicationFailure = true;
    expect(
      String(
        output(
          await client.callTool({ name: "ccp_domains_list", arguments: {} }),
          true,
        ).error,
      ),
    ).toContain("ccp login");
    networkFailure = true;
    const body = output(
      await client.callTool({ name: "scp_servers_list", arguments: {} }),
      true,
    );
    expect(String(body.error)).toContain("connection");
    expect(JSON.stringify(body)).not.toContain("private-network-message");
    expect(fixture.errors).toEqual([]);
  });

  for (const secret of ["result", "name"]) {
    test(`redacting the short secret ${secret} preserves fixed keys and matching JSON-RPC IDs`, async () => {
      const fixture = await setup(
        (request) =>
          json(
            new URL(request.url).pathname.endsWith("/servers")
              ? [{ id: 1, name: secret }]
              : envelope([{ id: 42, fqdn: secret }], {
                  sort: { field: secret },
                }),
          ),
        { NETCUP_ACCESS_TOKEN: secret, NETCUP_CCP_API_KEY: secret },
      );
      const { client, raw } = await fixture.connect();
      const server = output(
        await client.callTool({ name: "scp_servers_list", arguments: {} }),
      );
      expect(object(rows(server.result)[0])).toEqual({
        id: 1,
        name: "[redacted]",
      });
      const domains = output(
        await client.callTool({ name: "ccp_domains_list", arguments: {} }),
      );
      expect(object(rows(domains.result)[0]).fqdn).toBe("[redacted]");
      expect(object(object(domains.meta).sort).field).toBe("[redacted]");
      const response = await raw(secret, "scp_servers_list", {});
      expect("id" in response && response.id).toBe(secret);
      if (!("result" in response)) throw new Error("Expected a tool response");
      const payload = object(response.result);
      expect(
        object(rows(object(payload.structuredContent).result)[0]).name,
      ).toBe("[redacted]");
      expect(Object.keys(payload)).toContain("structuredContent");
    });
  }
});

describe("MCP cancellation and token durability", () => {
  for (const heldAt of ["refresh", "save"] as const) {
    test(`canceling one caller during ${heldAt} keeps one shared refresh durable for its sibling`, async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const originalSave = CredentialStore.prototype.save;
      const fixture = await setup(async (request) => {
        if (request.url.endsWith("/token")) {
          if (heldAt === "refresh") {
            entered.resolve();
            await release.promise;
          }
          expect(request.signal.aborted).toBe(false);
          return json(tokens);
        }
        expect(await fixture.store.read()).toBe(tokens.refresh_token);
        return json([{ id: 2 }]);
      });
      await fixture.store.save("initial-refresh", null);
      const save =
        heldAt === "save"
          ? spyOn(CredentialStore.prototype, "save").mockImplementation(
              async function (this: CredentialStore, secret, previous) {
                if (secret === tokens.refresh_token) {
                  entered.resolve();
                  await release.promise;
                }
                await originalSave.call(this, secret, previous);
              },
            )
          : undefined;
      try {
        const { client } = await fixture.connect();
        const controller = new AbortController();
        const first = client
          .callTool(
            { name: "scp_servers_get", arguments: { serverId: 1 } },
            { signal: controller.signal },
          )
          .then(
            () => "completed",
            () => "canceled",
          );
        await within(entered.promise);
        const second = client.callTool({
          name: "scp_servers_list",
          arguments: {},
        });
        await client.listTools();
        controller.abort();
        expect(await within(first)).toBe("canceled");
        expect(fixture.requests).toHaveLength(1);
        release.resolve();
        output(await within(second));
        expect(
          fixture.requests.filter((request) => request.url.endsWith("/token")),
        ).toHaveLength(1);
        expect(
          fixture.requests.filter((request) => request.method === "GET"),
        ).toHaveLength(1);
        expect(fixture.requests[1].url).toEndWith("/api/v1/servers");
        expect(await fixture.store.read()).toBe(tokens.refresh_token);
      } finally {
        release.resolve();
        save?.mockRestore();
      }
    });
  }

  test("canceling an in-flight GET never cancels another GET", async () => {
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const fixture = await setup(
      (request) => {
        if (request.url.endsWith("/servers/1")) {
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(request.signal.reason);
              },
              { once: true },
            );
          });
        }
        expect(request.signal.aborted).toBe(false);
        return json({ id: 2 });
      },
      { NETCUP_ACCESS_TOKEN: "fixture-scp" },
    );
    const { client } = await fixture.connect();
    const controller = new AbortController();
    const first = client
      .callTool(
        { name: "scp_servers_get", arguments: { serverId: 1 } },
        { signal: controller.signal },
      )
      .catch(() => undefined);
    await within(entered.promise);
    const second = client.callTool({
      name: "scp_servers_get",
      arguments: { serverId: 2 },
    });
    controller.abort();
    await within(first);
    await within(aborted.promise);
    expect(output(await within(second))).toEqual({ result: { id: 2 } });
    expect(fixture.requests).toHaveLength(2);
  });

  test("a pre-aborted runtime or call does not load credentials or send requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = await setup(undefined, {}, { signal: controller.signal });
    const { client } = await fixture.connect();
    output(
      await client.callTool({ name: "scp_servers_list", arguments: {} }),
      true,
    );
    await expect(
      client.callTool(
        { name: "ccp_dns_record_types_list", arguments: {} },
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined();
    expect(fixture.requests).toHaveLength(0);
    expect(await readdir(fixture.root)).toEqual([]);
  });

  test("a failed rotated-token save cannot be bypassed by the next read", async () => {
    const fixture = await setup((request) =>
      request.url.endsWith("/token") ? json(tokens) : json([{ id: 1 }]),
    );
    await fixture.store.save("initial-refresh", null);
    const lock = join(dirname(fixture.store.path), ".credentials.lock");
    await writeFile(lock, "", { mode: 0o600 });
    const { client } = await fixture.connect();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = output(
        await client.callTool({ name: "scp_servers_list", arguments: {} }),
        true,
      );
      expect(String(body.error)).toContain("save");
      expect(JSON.stringify(body)).not.toContain(tokens.refresh_token);
      expect(JSON.stringify(body)).not.toContain(tokens.access_token);
    }
    expect(
      fixture.requests.every((request) => request.url.endsWith("/token")),
    ).toBe(true);
    expect(await fixture.store.read()).toBe("initial-refresh");
  });
});

function childEnvironment(env: Env): Record<string, string> {
  const entries = Object.entries({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...env,
  });
  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function rawChild(env: Env) {
  const child = spawn("node", [cliRunner, "mcp"], {
    env: childEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const protocolErrors: unknown[] = [];
  const pending = new Map<
    string | number,
    ReturnType<typeof deferred<Record<string, unknown>>>
  >();
  const stopped = deferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    try {
      const message = object(JSON.parse(line));
      lines.push(message);
      if (typeof message.id === "string" || typeof message.id === "number")
        pending.get(message.id)?.resolve(message);
    } catch (error) {
      protocolErrors.push(error);
      for (const waiting of pending.values()) waiting.reject(error);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => errors.push(text));
  child.on("error", (error) => stopped.reject(error));
  child.on("close", (code, signal) => {
    for (const waiting of pending.values()) {
      waiting.reject(new Error(`The MCP process exited: ${errors.join("")}`));
    }
    stopped.resolve({ code, signal });
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await stopped.promise;
    reader.close();
  });
  return {
    child,
    lines,
    errors,
    protocolErrors,
    stopped: stopped.promise,
    request(
      id: string | number,
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const response = deferred<Record<string, unknown>>();
      pending.set(id, response);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return within(response.promise, 5000);
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

describe("MCP Node subprocess", () => {
  test("a malformed JSON frame does not close the connection or expose its contents", async () => {
    const fixture = await setup();
    const process = rawChild(fixture.env);
    await process.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "netcup-recovery-test", version: "1.0.0" },
    });
    process.notify("notifications/initialized");
    process.child.stdin.write('{"private-malformed-frame":\n');
    // The SDK drops syntax errors; an invalid RPC version also exercises onerror.
    process.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "private-malformed-frame", id: 99, method: "tools/list" })}\n`,
    );
    const response = await process.request(2, "tools/list");
    expect(
      rows(object(response.result).tools)
        .map((tool) => object(tool).name)
        .sort(),
    ).toEqual([...toolNames].sort());
    process.child.stdin.end();
    expect(await within(process.stopped)).toEqual({ code: 0, signal: null });
    expect(process.protocolErrors).toEqual([]);
    expect(process.errors.join("")).toContain("Could not read an MCP message");
    expect(process.errors.join("")).not.toContain("private-malformed-frame");
    for (const message of process.lines) expect(message.jsonrpc).toBe("2.0");
  }, 10_000);

  for (const modern of [false, true]) {
    test(`official ${modern ? "modern" : "legacy"} client discovers tools, reads public data and receives an auth error`, async () => {
      const fixture = await setup();
      const requests: Request[] = [];
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          requests.push(request.clone());
          return json(envelope({ type: ["A", "TXT"] }));
        },
      });
      cleanups.push(async () => {
        await server.stop(true);
      });
      const transport = new StdioClientTransport({
        command: "node",
        args: [cliRunner, "mcp"],
        env: childEnvironment({
          ...fixture.env,
          NETCUP_CCP_BASE_URL: server.url.origin,
        }),
        stderr: "pipe",
      });
      const errors: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) =>
        errors.push(chunk.toString()),
      );
      const protocolErrors: Error[] = [];
      const client = new Client(
        { name: "netcup-node-test", version: "1.0.0" },
        modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
      client.onerror = (error) => protocolErrors.push(error);
      cleanups.push(() => client.close());
      await within(client.connect(transport), 5000).catch((error: unknown) => {
        throw new Error(
          `The MCP client could not connect: ${errors.join("")}`,
          {
            cause: error,
          },
        );
      });
      expect(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ).toEqual([...toolNames].sort());
      expect(
        output(
          await client.callTool({
            name: "ccp_dns_record_types_list",
            arguments: {},
          }),
        ),
      ).toEqual(envelope({ type: ["A", "TXT"] }));
      const missing = output(
        await client.callTool({ name: "scp_servers_list", arguments: {} }),
        true,
      );
      expect(String(missing.error)).toContain("login");
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).pathname).toBe("/v1/dns/recordType");
      expect(requests[0].headers.has("Authorization")).toBe(false);
      expect(protocolErrors).toEqual([]);
      expect(errors.join("")).not.toContain("Usage:");
      expect(errors.join("")).not.toContain("Requesting a login code");
    }, 10_000);
  }

  for (const ending of ["EOF", "SIGINT", "SIGTERM"] as const) {
    test(`${ending} drains a held refresh and saves rotation before Node exits`, async () => {
      const fixture = await setup();
      await fixture.store.save("initial-refresh", null);
      const entered = deferred<void>();
      const release = deferred<void>();
      let reads = 0;
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (new URL(request.url).pathname === "/token") {
            entered.resolve();
            await release.promise;
            return json(tokens);
          }
          reads += 1;
          return json([{ id: 1 }]);
        },
      });
      cleanups.push(async () => {
        release.resolve();
        await server.stop(true);
      });
      const process = rawChild({
        ...fixture.env,
        NETCUP_AUTH_URL: server.url.origin,
        NETCUP_BASE_URL: server.url.origin,
      });
      try {
        const initialized = await process.request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "netcup-shutdown-test", version: "1.0.0" },
        });
        expect(initialized.result).toBeDefined();
        process.notify("notifications/initialized");
        const calling = process
          .request(2, "tools/call", { name: "scp_servers_list", arguments: {} })
          .catch(() => undefined);
        await within(entered.promise);
        let exited = false;
        void process.stopped.then(() => {
          exited = true;
        });
        if (ending === "EOF") process.child.stdin.end();
        else process.child.kill(ending);
        // A separate round trip yields to signal/EOF delivery without a sleep.
        await fetch(`${server.url.origin}/test-shutdown-barrier`);
        expect(exited).toBe(false);
        release.resolve();
        const stopped = await within(process.stopped);
        expect(stopped.signal).toBeNull();
        expect(stopped.code).toBe(
          ending === "EOF" ? 0 : ending === "SIGINT" ? 130 : 143,
        );
        expect(await fixture.store.read()).toBe(tokens.refresh_token);
        expect(reads).toBe(1);
        for (const line of process.lines) expect(line.jsonrpc).toBe("2.0");
        expect(process.protocolErrors).toEqual([]);
        expect(process.errors.join("")).not.toContain(tokens.access_token);
        expect(process.errors.join("")).not.toContain(tokens.refresh_token);
        await calling;
      } finally {
        release.resolve();
      }
    }, 10_000);
  }
});
