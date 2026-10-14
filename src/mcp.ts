import {
  McpServer,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { version } from "../package.json";
import type { NetcupFetch } from "./auth";
import { NetcupClient } from "./client";
import { NetcupCcpClient } from "./ccp-client";
import { unwrapCcp } from "./ccp-http";
import { loadCcpKey, loadScpAuth } from "./cli-credentials";
import { createRedactor, terminalSafe } from "./cli-output";
import { isRecord, NetcupAuthError, NetcupError } from "./errors";
import { unwrap } from "./http";

export interface McpOptions {
  env?: Record<string, string | undefined>;
  fetch?: NetcupFetch;
  signal?: AbortSignal;
  stderr?: (text: string) => void;
}

export interface McpRuntime {
  createServer(): McpServer;
  close(): Promise<void>;
}

const int32 = z.number().int().min(0).max(2_147_483_647);
const serverId = int32.min(1);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonblank = z
  .string()
  .refine((value) => value.trim().length > 0, "Use a nonblank string.");
const revisionId = z
  .string()
  .length(36)
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const paging = {
  page: positiveInteger.optional(),
  perPage: positiveInteger.optional(),
  direction: z.enum(["asc", "desc"]).optional(),
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const serverSummary = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  hostname: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
  template: z
    .object({ id: z.number().optional(), name: z.string() })
    .nullable()
    .optional(),
});
const serverDetail = serverSummary.extend({
  architecture: z.string().optional(),
  site: z.object({ id: z.number().optional(), city: z.string() }).optional(),
  ipv4Addresses: z.array(z.object({ ip: z.string().optional() })).optional(),
  ipv6Addresses: z
    .array(
      z.object({
        networkPrefix: z.string().optional(),
        networkPrefixLength: z.number().optional(),
      }),
    )
    .optional(),
  serverLiveInfo: z
    .object({
      state: z.string().optional(),
      uptimeInSeconds: z.number().optional(),
      cpuCount: z.number().optional(),
      currentServerMemoryInMiB: z.number().optional(),
      maxServerMemoryInMiB: z.number().optional(),
      disks: z
        .array(
          z.object({
            dev: z.string().optional(),
            capacityInMiB: z.number().optional(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
});
const taskStep = z.object({
  uuid: z.string().optional(),
  name: z.string().optional(),
  state: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});
const taskSummary = taskStep.extend({
  onRollback: z.boolean().optional(),
  taskProgress: z
    .object({
      expectedFinishedAt: z.string().optional(),
      progressInPercent: z.number().optional(),
    })
    .optional(),
});
const taskDetail = taskSummary.extend({ steps: z.array(taskStep).optional() });
const scpMeta = z.object({
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const message = z.string().optional();
const serversOutput = z.object({
  result: z.array(serverSummary),
  meta: scpMeta.optional(),
  message,
});
const serverOutput = z.object({ result: serverDetail, message });
const tasksOutput = z.object({
  result: z.array(taskSummary),
  meta: scpMeta.optional(),
  message,
});
const taskOutput = z.object({ result: taskDetail, message });

const ccpMessage = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});
const ccpMeta = z
  .object({
    sort: z
      .object({
        field: z.string().optional(),
        direction: z.string().optional(),
      })
      .optional(),
    pagination: z
      .object({
        page: z.number().optional(),
        perPage: z.number().optional(),
        totalEntries: z.number().optional(),
        previousPage: z.number().optional(),
        nextPage: z.number().optional(),
        lastPage: z.number().optional(),
      })
      .optional(),
  })
  .nullable();
const ccpEnvelope = z.object({
  success: z.literal(true),
  errors: z.array(ccpMessage),
  messages: z.array(ccpMessage),
  meta: ccpMeta,
});
const domain = z.object({
  id: z.number().optional(),
  fqdn: z.string().optional(),
  isDnsManaged: z.boolean().optional(),
});
const revision = z.object({
  identifier: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
  state: z.string().optional(),
  serial: z.number().nullable().optional(),
});
const record = z.object({
  identifier: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  rdata: z.string().optional(),
  ttl: z.number().nullable().optional(),
  immutable: z.boolean().optional(),
});
const domainsOutput = ccpEnvelope.extend({ result: z.array(domain), message });
const recordTypesOutput = ccpEnvelope.extend({
  meta: z.null(),
  result: z.object({ type: z.array(z.string()).optional() }),
  message,
});
const revisionsOutput = ccpEnvelope.extend({
  result: z.array(revision),
  message,
});
const revisionOutput = ccpEnvelope.extend({ result: revision });
const recordsResponse = ccpEnvelope.extend({ result: z.array(record) });
const recordsOutput = recordsResponse.extend({
  warning: z.string().optional(),
  message,
});

class McpCredentialsError extends Error {}

function totalCount(response: Response): { totalCount: number } | undefined {
  const header = response.headers.get("X-Total-Count");
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  const count = Number(header);
  return Number.isSafeInteger(count) ? { totalCount: count } : undefined;
}

function result(
  data: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(
  error: unknown,
  ccp: boolean,
  signal: AbortSignal,
): CallToolResult {
  const login = `npx --yes netcup-sdk@${version} ${ccp ? "ccp login" : "login"}`;
  const reconnect = `Run ${login}, then reconnect your MCP client.`;
  let message: string;
  if (signal.aborted) {
    message =
      "The read was canceled. Retry the tool if you still need its result.";
  } else if (error instanceof McpCredentialsError) {
    message = ccp
      ? `No usable CCP key was found. Check NETCUP_CCP_API_KEY and the saved key folder's permissions. ${reconnect}`
      : `No usable SCP login was found. Set only one of NETCUP_ACCESS_TOKEN and NETCUP_REFRESH_TOKEN, or use a saved login. Check the login folder's permissions. ${reconnect}`;
  } else if (error instanceof NetcupAuthError) {
    message =
      error.code === "token_storage_failed"
        ? `Could not save the refreshed SCP login. Check the login folder's permissions and free disk space. ${reconnect}`
        : `Netcup could not use the ${ccp ? "CCP key" : "SCP login"}. Check your environment credentials. ${reconnect}`;
  } else if (error instanceof NetcupError) {
    const ccpAuthError =
      ccp &&
      isRecord(error.body) &&
      Array.isArray(error.body.errors) &&
      error.body.errors.some(
        (item) => isRecord(item) && item.code === "authenticationError",
      );
    if (error.status === 401 || ccpAuthError) {
      message = `Netcup rejected the ${ccp ? "CCP key. SCP login tokens do not work with CCP" : "SCP login"}. ${reconnect}`;
    } else if (error.status === 403) {
      message = ccp
        ? "Netcup denied this CCP read. Check that the API key and domain belong to the intended Customer Control Panel account, then retry."
        : "Netcup denied this SCP read. Check the account permissions and API IP allowlist in the Server Control Panel, then retry.";
    } else if (error.status === 404) {
      message =
        "Netcup could not find that item. Check its ID with the matching list tool, then retry.";
    } else if (error.status === 429) {
      message =
        "Netcup is limiting requests. Wait a moment, then retry this read.";
    } else if (error.status >= 500) {
      message =
        "Netcup could not complete this read. Wait a moment, then retry. Check Netcup's service status if it keeps failing.";
    } else {
      message =
        "Netcup rejected this read or returned an invalid response. Check the tool arguments and the selected account, then retry.";
    }
  } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
    message =
      "Netcup returned data that does not match this tool's response format. Retry the read. If it keeps failing, check the control panel and report the response format to the package maintainer.";
  } else {
    message =
      "Could not complete the Netcup read. Check your connection and API address, then retry.";
  }
  return result({ error: message }, true);
}

// Concurrent first calls share one load; a failed load is retried on the next call.
function cachedUntilFailure<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
}

function waitForRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createMcpRuntime(options: McpOptions = {}): McpRuntime {
  const env = options.env ?? process.env;
  const redactor = createRedactor(env);
  const transport = options.fetch ?? globalThis.fetch;
  const fetch: NetcupFetch = (request) => {
    request.signal.throwIfAborted();
    return transport(
      new Request(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      }),
    );
  };
  const shutdown = new AbortController();
  const shutdownSignal = options.signal
    ? AbortSignal.any([shutdown.signal, options.signal])
    : shutdown.signal;
  const pending = new Set<Promise<unknown>>();
  let publicCcp: NetcupCcpClient | undefined;
  let closed: Promise<void> | undefined;

  const scpClient = cachedUntilFailure(async () => {
    const auth = await loadScpAuth(env, redactor).catch(() => {
      throw new McpCredentialsError();
    });
    return new NetcupClient({
      ...auth,
      fetch,
      baseUrl: env.NETCUP_BASE_URL,
      authUrl: env.NETCUP_AUTH_URL,
    });
  });
  const ccpClient = cachedUntilFailure(async () => {
    const apiKey = await loadCcpKey(env, redactor.rememberSecret).catch(() => {
      throw new McpCredentialsError();
    });
    return new NetcupCcpClient({
      apiKey,
      fetch,
      baseUrl: env.NETCUP_CCP_BASE_URL,
    });
  });
  const publicClient = (): NetcupCcpClient =>
    (publicCcp ??= new NetcupCcpClient({
      fetch,
      baseUrl: env.NETCUP_CCP_BASE_URL,
    }));

  async function read<Shape extends z.ZodRawShape>(
    schema: z.ZodObject<Shape>,
    ctx: ServerContext,
    ccp: boolean,
    execute: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<CallToolResult> {
    const signal = AbortSignal.any([ctx.mcpReq.signal, shutdownSignal]);
    try {
      signal.throwIfAborted();
      const work = execute(signal);
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      const projected = schema.parse(await waitForRead(work, signal));
      const redacted = redactor.redactJson(projected, false);
      if (!isRecord(redacted)) throw new Error();
      return result(redacted);
    } catch (error) {
      return toolError(error, ccp, signal);
    }
  }

  return {
    createServer() {
      const server = new McpServer({ name: "netcup", version });
      server.registerTool(
        "scp_servers_list",
        {
          description:
            "List Server Control Panel servers with names and IDs. Use serverId with scp_servers_get for network and live-state details. Results may be paged; meta.totalCount is Netcup's total when supplied.",
          inputSchema: z.strictObject({
            firewallPolicyId: serverId.optional(),
            ip: nonblank.optional(),
            limit: int32.optional(),
            name: nonblank.optional(),
            offset: int32.optional(),
            q: nonblank.optional(),
            sort: z
              .array(z.enum(["name", "-name", "nickname", "-nickname"]))
              .optional(),
          }),
          outputSchema: serversOutput,
          annotations,
        },
        (query, ctx) =>
          read(serversOutput, ctx, false, async (signal) => {
            const client = await scpClient();
            signal.throwIfAborted();
            const response = await client.api.GET("/api/v1/servers", {
              params: { query },
              signal,
            });
            const data = await unwrap(Promise.resolve(response));
            return {
              result: data,
              meta: totalCount(response.response),
              ...(data?.length === 0
                ? {
                    message:
                      "No servers returned on this page. Check the filters or offset. Add or manage servers in the Server Control Panel.",
                  }
                : {}),
            };
          }),
      );
      server.registerTool(
        "scp_servers_get",
        {
          description:
            "Read one SCP server's identity, site, IP addresses and selected live state. Set loadServerLiveInfo to request current CPU, memory, disk capacity and power state. No passwords or rescue details are returned.",
          inputSchema: z.strictObject({
            serverId,
            loadServerLiveInfo: z.boolean().optional(),
          }),
          outputSchema: serverOutput,
          annotations,
        },
        ({ serverId, loadServerLiveInfo }, ctx) =>
          read(serverOutput, ctx, false, async (signal) => {
            const client = await scpClient();
            signal.throwIfAborted();
            return {
              result: await unwrap(
                client.api.GET("/api/v1/servers/{serverId}", {
                  params: { path: { serverId }, query: { loadServerLiveInfo } },
                  signal,
                }),
              ),
            };
          }),
      );
      server.registerTool(
        "scp_tasks_list",
        {
          description:
            "List SCP tasks and their progress. Filter by server, state or search text. ROLLBACK can appear in results but cannot be used as a state filter. Results may be paged; meta.totalCount is Netcup's total when supplied.",
          inputSchema: z.strictObject({
            limit: int32.optional(),
            offset: int32.optional(),
            q: nonblank.optional(),
            serverId: serverId.optional(),
            state: z
              .enum([
                "PENDING",
                "RUNNING",
                "FINISHED",
                "ERROR",
                "WAITING_FOR_CANCEL",
                "CANCELED",
              ])
              .optional(),
          }),
          outputSchema: tasksOutput,
          annotations,
        },
        (query, ctx) =>
          read(tasksOutput, ctx, false, async (signal) => {
            const client = await scpClient();
            signal.throwIfAborted();
            const response = await client.api.GET("/api/v1/tasks", {
              params: { query },
              signal,
            });
            const data = await unwrap(Promise.resolve(response));
            return {
              result: data,
              meta: totalCount(response.response),
              ...(data?.length === 0
                ? {
                    message:
                      "No tasks returned on this page. Check the filters, server ID or offset. View recent work in the Server Control Panel.",
                  }
                : {}),
            };
          }),
      );
      server.registerTool(
        "scp_tasks_get",
        {
          description:
            "Read one SCP task and its steps. Pass the exact uuid string from scp_tasks_list; it need not have UUID format. Excludes user details, task messages, errors and arbitrary results.",
          inputSchema: z.strictObject({
            uuid: nonblank.refine(
              (value) => value !== "." && value !== "..",
              "Use a task ID from scp_tasks_list, not '.' or '..'.",
            ),
          }),
          outputSchema: taskOutput,
          annotations,
        },
        ({ uuid }, ctx) =>
          read(taskOutput, ctx, false, async (signal) => {
            const client = await scpClient();
            signal.throwIfAborted();
            return {
              result: await unwrap(
                client.api.GET("/api/v1/tasks/{uuid}", {
                  params: { path: { uuid } },
                  signal,
                }),
              ),
            };
          }),
      );
      server.registerTool(
        "ccp_domains_list",
        {
          description:
            "List Customer Control Panel domains with numeric IDs and DNS-management status. Uses a separate CCP API key, not the SCP login. Preserves Netcup's paging, sorting and warning messages.",
          inputSchema: z.strictObject({
            ...paging,
            fqdn: nonblank.optional(),
            domainId: positiveInteger.optional(),
            field: z.enum(["domainId", "fqdn"]).optional(),
          }),
          outputSchema: domainsOutput,
          annotations,
        },
        (query, ctx) =>
          read(domainsOutput, ctx, true, async (signal) => {
            const client = await ccpClient();
            signal.throwIfAborted();
            const data = await unwrapCcp(
              client.api.GET("/v1/domain", { params: { query }, signal }),
            );
            return {
              ...data,
              message:
                data.result?.length === 0
                  ? "No domains returned on this page. Check the filters or page number. Add or manage domains in the Customer Control Panel."
                  : undefined,
            };
          }),
      );
      server.registerTool(
        "ccp_dns_record_types_list",
        {
          description:
            "Read supported DNS record types. This public read needs no login and does not open saved credentials. The result contains optional type, a list of strings.",
          inputSchema: z.strictObject({}),
          outputSchema: recordTypesOutput,
          annotations,
        },
        (_args, ctx) =>
          read(recordTypesOutput, ctx, true, async (signal) => {
            const data = await unwrapCcp(
              publicClient().api.GET("/v1/dns/recordType", { signal }),
            );
            return {
              ...data,
              message:
                data.result?.type?.length === 0
                  ? "Netcup returned no DNS record types. Retry this read. Check Netcup's service status if it keeps returning an empty list."
                  : undefined,
            };
          }),
      );
      server.registerTool(
        "ccp_dns_revisions_list",
        {
          description:
            "List DNS revisions for one CCP domain. Get domainId from ccp_domains_list. Pass a nonblank field to sort by a field supported by Netcup. Preserves paging and provider messages.",
          inputSchema: z.strictObject({
            domainId: positiveInteger,
            ...paging,
            field: nonblank.optional(),
          }),
          outputSchema: revisionsOutput,
          annotations,
        },
        ({ domainId, ...query }, ctx) =>
          read(revisionsOutput, ctx, true, async (signal) => {
            const client = await ccpClient();
            signal.throwIfAborted();
            const data = await unwrapCcp(
              client.api.GET("/v1/domain/{domainId}/dns/revision", {
                params: { path: { domainId }, query },
                signal,
              }),
            );
            return {
              ...data,
              message:
                data.result?.length === 0
                  ? "No DNS revisions returned on this page. Check the domain ID or page number. Manage DNS changes in the Customer Control Panel."
                  : undefined,
            };
          }),
      );
      server.registerTool(
        "ccp_dns_revisions_get",
        {
          description:
            "Read one DNS revision's ID, dates, state and serial number. Use the exact canonical revision UUID from ccp_dns_revisions_list. No latest or current shortcut is supported.",
          inputSchema: z.strictObject({
            domainId: positiveInteger,
            revisionId,
          }),
          outputSchema: revisionOutput,
          annotations,
        },
        (path, ctx) =>
          read(revisionOutput, ctx, true, async (signal) => {
            const client = await ccpClient();
            signal.throwIfAborted();
            return unwrapCcp(
              client.api.GET(
                "/v1/domain/{domainId}/dns/revision/{revisionId}",
                { params: { path }, signal },
              ),
            );
          }),
      );
      server.registerTool(
        "ccp_dns_records_list",
        {
          description:
            "Read DNS records for an exact CCP domain and revision. The API documents no paging flags. Preserves provider metadata and warns when it reports omitted records or the response cannot confirm a full list.",
          inputSchema: z.strictObject({
            domainId: positiveInteger,
            revisionId,
          }),
          outputSchema: recordsOutput,
          annotations,
        },
        (path, ctx) =>
          read(recordsOutput, ctx, true, async (signal) => {
            const client = await ccpClient();
            signal.throwIfAborted();
            const data = recordsResponse.parse(
              await unwrapCcp(
                client.api.GET(
                  "/v1/domain/{domainId}/dns/revision/{revisionId}/record",
                  { params: { path }, signal },
                ),
              ),
            );
            const pagination = data.meta?.pagination;
            const count = data.result.length;
            const partial =
              pagination !== undefined &&
              ((pagination.totalEntries !== undefined &&
                pagination.totalEntries > count) ||
                (pagination.nextPage !== undefined &&
                  pagination.nextPage > (pagination.page ?? 1)) ||
                (pagination.page !== undefined && pagination.page > 1) ||
                (pagination.lastPage !== undefined && pagination.lastPage > 1));
            return {
              ...data,
              warning: partial
                ? "Netcup's metadata says some DNS records were omitted. The API documents no record paging flags. Use the Customer Control Panel or ask Netcup how to retrieve every record."
                : "The API documents no record paging flags. This response alone does not confirm that every DNS record was returned. Check the Customer Control Panel before relying on it as a full list.",
              message:
                count === 0
                  ? "No DNS records returned for this revision. Check its ID with ccp_dns_revisions_list. Manage DNS records in the Customer Control Panel."
                  : undefined,
            };
          }),
      );
      return server;
    },
    close() {
      if (closed) return closed;
      // Aborting rejects new reads at their first signal check.
      shutdown.abort();
      // Wait for real reads, including shared refresh and token saves, not just canceled callers.
      closed = Promise.allSettled([...pending]).then(() => undefined);
      return closed;
    },
  };
}

export function runMcp(options: McpOptions = {}): Promise<number> {
  const runtime = createMcpRuntime(options);
  const stderr =
    options.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const report = (): void =>
    stderr(
      terminalSafe(
        "The MCP connection failed. Reconnect your MCP client and try again.\n",
      ),
    );
  return new Promise((resolve) => {
    let handle: StdioServerHandle | undefined;
    let shutdown: Promise<void> | undefined;
    let exitCode = 0;
    const stop = (): void => {
      if (shutdown) return;
      const drain = runtime.close();
      const keepAlive = setInterval(() => {}, 1_000);
      shutdown = Promise.resolve()
        .then(async () => {
          try {
            await handle?.close();
          } finally {
            await drain;
          }
        })
        .catch(() => {
          exitCode = 1;
          report();
        })
        .finally(() => {
          clearInterval(keepAlive);
          process.stdin.removeListener("end", stop);
          process.stdin.removeListener("close", stop);
          process.stdin.removeListener("error", fail);
          process.stdout.removeListener("error", fail);
          process.removeListener("SIGTERM", terminate);
          options.signal?.removeEventListener("abort", interrupt);
          resolve(exitCode);
        });
    };
    const fail = (): void => {
      if (shutdown) return;
      exitCode = 1;
      report();
      stop();
    };
    const terminate = (): void => {
      if (shutdown) return;
      exitCode = 143;
      stop();
    };
    const interrupt = (): void => {
      if (shutdown) return;
      exitCode = 130;
      stop();
    };
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    process.stdin.once("error", fail);
    process.stdout.once("error", fail);
    process.once("SIGTERM", terminate);
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) {
      interrupt();
      return;
    }
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      stop();
      return;
    }
    try {
      handle = serveStdio(runtime.createServer, {
        onerror: () =>
          stderr(
            terminalSafe(
              "Could not read an MCP message. Check your MCP client's requests, then retry.\n",
            ),
          ),
      });
    } catch {
      fail();
    }
  });
}
