import { afterEach, describe, expect, test } from "bun:test";
import { version } from "../package.json";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCli } from "./cli";
import type { CliContext } from "./cli";
import { CredentialStore } from "./credentials";

const roots: string[] = [];
const tokens = {
  access_token: "fixture-access-secret",
  refresh_token: "fixture-rotated-secret",
  token_type: "Bearer",
  expires_in: 300,
  refresh_expires_in: 0,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ccpJson(
  result: unknown,
  meta: unknown = null,
  status = 200,
): Response {
  return json(
    { success: true, errors: [], messages: [], meta, result },
    status,
  );
}

const ccpKey = "FixtureCcpKey123";
const revisionId = "2ec5bc64-5460-4ae4-9b13-522e5bb9f350";
const recordId = "7ef6775d-a687-4f80-a0e8-c3cd41f0f20b";
const dnsRecord = { name: "www", type: "A", rdata: "192.0.2.10", ttl: 300 };

async function changesFile(root: string, value: unknown): Promise<string> {
  const path = join(root, "changes.json");
  await writeFile(path, JSON.stringify(value) ?? "null");
  return path;
}

async function setup(
  handler?: (request: Request) => Response | Promise<Response>,
) {
  const root = await mkdtemp(join(tmpdir(), "netcup-cli-test-"));
  roots.push(root);
  const env = {
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    XDG_CONFIG_HOME: root,
  };
  const requests: Request[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const context: CliContext = {
    env,
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
    fetch: async (request) => {
      requests.push(request.clone());
      if (!handler) throw new Error("Unexpected network request");
      return handler(request);
    },
  };
  return {
    root,
    env,
    requests,
    output,
    errors,
    context,
    store: new CredentialStore(env),
    ccpStore: new CredentialStore(env, "ccp"),
    run: (args: string[]) => runCli(args, context),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI commands", () => {
  test("malformed and padded environment credentials never leak through errors", async () => {
    const cli = await setup(() =>
      json({ message: "Rejected fixture-trimmed-secret" }, 400),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "  fixture-first-part\nfixture-second-part  ",
    };
    expect(await cli.run(["servers", "list"])).toBe(2);
    expect(cli.requests).toHaveLength(0);
    expect(cli.errors.join("")).not.toContain("fixture-first-part");
    expect(cli.errors.join("")).not.toContain("fixture-second-part");
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "  fixture-trimmed-secret  ",
    };
    expect(await cli.run(["servers", "list"])).toBe(1);
    expect(cli.errors.join("")).not.toContain("fixture-trimmed-secret");
    expect(cli.errors.join("")).toContain("[redacted]");
  });

  test("Ctrl-C at a real Node terminal confirmation exits 130", async () => {
    const cli = await setup();
    const build = await Bun.build({
      entrypoints: [resolve("src/cli.ts")],
      outdir: join(cli.root, "build"),
      target: "node",
      format: "cjs",
    });
    expect(build.success).toBe(true);
    const runner = join(cli.root, "runner.cjs");
    await writeFile(
      runner,
      `require(${JSON.stringify(build.outputs[0].path)}).main();\n`,
    );
    let output = "";
    let interrupted = false;
    const child = Bun.spawn(["node", runner, "servers", "reboot", "123"], {
      env: {
        ...process.env,
        ...cli.env,
        NETCUP_ACCESS_TOKEN: "",
        NETCUP_REFRESH_TOKEN: "",
      },
      terminal: {
        data(terminal, data) {
          output += new TextDecoder().decode(data);
          if (!interrupted && output.includes("Type yes to continue")) {
            interrupted = true;
            terminal.write("\x03");
          }
        },
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
    }, 3000);
    try {
      expect(await child.exited).toBe(130);
      expect(interrupted).toBe(true);
      expect(output).toContain("Canceled");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      child.terminal?.close();
    }
  });

  test("help and version need no credentials, files or requests", async () => {
    const cli = await setup();
    for (const args of [
      [],
      ["--help"],
      ["servers", "--help"],
      ["snapshots", "--help"],
      ["--version"],
    ])
      expect(await cli.run(args)).toBe(0);
    expect(cli.output.join("")).toContain("netcup servers get 12345");
    expect(cli.output.join("")).toContain(version);
    expect(cli.requests).toHaveLength(0);
    expect(await readdir(cli.root)).toEqual([]);
  });

  test("invalid flags, arguments and updates fail before authentication", async () => {
    const cli = await setup();
    const cases = [
      ["servers", "get"],
      ["servers", "get", "abc"],
      ["servers", "get", "0"],
      ["servers", "get", "2147483648"],
      ["servers", "get", "123", "--unknown"],
      ["servers", "update", "123", "--nickname", "one", "--hostname", "two"],
      ["servers", "get", "123", "--limit", "5"],
      ["metrics", "cpu", "123", "--hours", "1441"],
      ["snapshots", "create", "123", "name", "--online", "--offline"],
      ["constructor"],
    ];
    for (const args of cases) expect(await cli.run(args)).toBe(2);
    expect(cli.errors.join("")).toContain("Usage");
    expect(cli.requests).toHaveLength(0);
    expect(await readdir(cli.root)).toEqual([]);
  });

  test("missing login gives a command to fix it", async () => {
    const cli = await setup();
    expect(await cli.run(["servers", "list"])).toBe(1);
    expect(cli.errors.join("")).toContain("netcup login");
    expect(cli.output).toEqual([]);
    expect(cli.requests).toHaveLength(0);
  });

  test("list filters, repeated sorting, zero limits and JSON output are preserved", async () => {
    const cli = await setup(() => json([]));
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(
      await cli.run([
        "servers",
        "list",
        "--limit",
        "0",
        "--offset",
        "0",
        "--sort=name",
        "--sort=-nickname",
        "--search",
        "web",
        "--compact",
      ]),
    ).toBe(0);
    const request = cli.requests[0];
    const query = new URL(request.url).searchParams;
    expect(query.get("limit")).toBe("0");
    expect(query.get("offset")).toBe("0");
    expect(query.getAll("sort")).toEqual(["name", "-nickname"]);
    expect(query.get("q")).toBe("web");
    expect(request.headers.get("Authorization")).toBe(
      "Bearer fixture-access-secret",
    );
    expect(cli.output.join("")).toBe("[]\n");
    expect(cli.errors.join("")).toContain("No servers returned");
  });

  test("destructive actions can be refused without a request", async () => {
    const cli = await setup();
    let question = "";
    cli.context.confirm = async (text) => {
      question = text;
      return false;
    };
    expect(await cli.run(["servers", "reboot", "123"])).toBe(2);
    expect(question).toContain("123");
    expect(question).toContain("unsaved data");
    expect(cli.errors.join("")).toContain("No request was sent");
    expect(cli.requests).toHaveLength(0);
  });

  test("a noninteractive process requires --yes before any authentication", async () => {
    const cli = await setup();
    const runner = join(cli.root, "runner.ts");
    await writeFile(
      runner,
      `import { main } from ${JSON.stringify(resolve("src/cli.ts"))}; await main();\n`,
    );
    const child = Bun.spawnSync(
      [process.execPath, runner, "servers", "reboot", "123"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...cli.env,
          NETCUP_ACCESS_TOKEN: "",
          NETCUP_REFRESH_TOKEN: "",
        },
      },
    );
    expect(child.exitCode).toBe(2);
    expect(new TextDecoder().decode(child.stderr)).toContain("--yes");
    expect(new TextDecoder().decode(child.stdout)).toBe("");
  });

  test("power actions send one merge-patch and report accepted tasks, not completion", async () => {
    const cli = await setup(() =>
      json({ uuid: "work", state: "PENDING" }, 202),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(await cli.run(["servers", "reboot", "123", "--yes"])).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(new URL(cli.requests[0].url).searchParams.get("stateOption")).toBe(
      "RESET",
    );
    expect(cli.requests[0].headers.get("Content-Type")).toBe(
      "application/merge-patch+json",
    );
    expect(await cli.requests[0].json()).toEqual({ state: "ON" });
    expect(JSON.parse(cli.output.join("")).state).toBe("PENDING");
    expect(cli.errors.join("")).toContain("netcup tasks get");
    expect(cli.errors.join("")).not.toContain("finished successfully");
  });

  test("stop, start and setting changes use the existing typed SDK", async () => {
    const cli = await setup(() => new Response(null, { status: 202 }));
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(await cli.run(["servers", "start", "123"])).toBe(0);
    expect(await cli.run(["servers", "stop", "123", "--yes"])).toBe(0);
    expect(
      await cli.run(["servers", "update", "123", "--nickname", "web-1"]),
    ).toBe(0);
    expect(await cli.requests[0].json()).toEqual({ state: "ON" });
    expect(await cli.requests[1].json()).toEqual({ state: "OFF" });
    expect(await cli.requests[2].json()).toEqual({ nickname: "web-1" });
    expect(cli.output.join("")).toBe("null\nnull\nnull\n");
  });

  test("snapshot mode omission, explicit offline flags and escaped names are correct", async () => {
    const cli = await setup(() => json({ uuid: "snapshot-work" }, 202));
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(
      await cli.run(["snapshots", "create", "123", "before upgrade"]),
    ).toBe(0);
    expect(await cli.requests[0].json()).toEqual({ name: "before upgrade" });
    expect(
      await cli.run([
        "snapshots",
        "dry-run",
        "123",
        "--offline",
        "--disk",
        "vda",
      ]),
    ).toBe(0);
    expect(await cli.requests[1].json()).toEqual({
      diskName: "vda",
      onlineSnapshot: false,
    });
    expect(
      await cli.run(["snapshots", "revert", "123", "before/upgrade", "--yes"]),
    ).toBe(0);
    expect(cli.requests[2].url).toContain("before%2Fupgrade/revert");
  });

  test("metrics, task reads and disk commands do not claim to have changed anything", async () => {
    const cli = await setup((request) =>
      request.url.includes("/tasks/")
        ? json({ uuid: "work", state: "FINISHED" })
        : json([]),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(await cli.run(["metrics", "cpu", "123", "--hours", "24"])).toBe(0);
    expect(new URL(cli.requests[0].url).searchParams.get("hours")).toBe("24");
    expect(await cli.run(["tasks", "get", "work"])).toBe(0);
    expect(await cli.run(["disks", "list", "123"])).toBe(0);
    expect(cli.errors.join("")).not.toContain("accepted the request");
  });

  test("HTTP failures return nonzero without retrying mutations", async () => {
    const cli = await setup(() => json({ message: "Server is busy" }, 503));
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(await cli.run(["servers", "stop", "123", "--yes"])).toBe(1);
    expect(cli.requests).toHaveLength(1);
    expect(cli.output).toEqual([]);
    expect(cli.errors.join("")).not.toContain("fixture-access-secret");
  });

  test("Ctrl-C aborts local waiting and returns 130", async () => {
    const controller = new AbortController();
    const cli = await setup((request) => {
      controller.abort();
      throw request.signal.reason;
    });
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    cli.context.signal = controller.signal;
    expect(await cli.run(["servers", "get", "123"])).toBe(130);
    expect(cli.errors.join("")).toContain("Only read requests were sent");
    expect(cli.output).toEqual([]);
  });
});

describe("CLI login and credentials", () => {
  test("device login persists only the refresh token and keeps secrets out of output", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/auth/device")
        ? json({
            device_code: "fixture-device-secret",
            user_code: "ABCD",
            verification_uri: "https://example.com/approve",
            interval: 1,
            expires_in: 60,
          })
        : json(tokens),
    );
    expect(await cli.run(["login"])).toBe(0);
    expect(cli.errors.join("")).toContain("https://example.com/approve");
    expect(cli.errors.join("")).toContain("ABCD");
    expect(cli.output.join("")).toContain('"authenticated": true');
    expect(await cli.store.read()).toBe(tokens.refresh_token);
    const contents = await readFile(cli.store.path, "utf8");
    expect(Object.keys(JSON.parse(contents))).toEqual(["refreshToken"]);
    const visible = cli.output.join("") + cli.errors.join("");
    for (const secret of [
      tokens.access_token,
      tokens.refresh_token,
      "fixture-device-secret",
    ])
      expect(visible).not.toContain(secret);
    const fields = new URLSearchParams(await cli.requests[0].text());
    expect(fields.get("scope")).toBe("offline_access openid");
    expect(fields.get("client_id")).toBe("scp");
  });

  test("failed device approval preserves the previous login", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/auth/device")
        ? json({
            device_code: "device",
            user_code: "CODE",
            verification_uri: "https://example.com/approve",
            interval: 1,
            expires_in: 60,
          })
        : json(
            {
              error: "access_denied",
              error_description: "fixture-private-response",
            },
            400,
          ),
    );
    await cli.store.save("previous-refresh", null);
    expect(await cli.run(["login"])).toBe(1);
    expect(await cli.store.read()).toBe("previous-refresh");
    expect(cli.output).toEqual([]);
    expect(cli.errors.join("")).not.toContain("fixture-private-response");
  });

  test("file-backed refresh rotates tokens before the API request", async () => {
    const cli = await setup(async (request) => {
      if (request.url.endsWith("/token")) return json(tokens);
      expect(await cli.store.read()).toBe(tokens.refresh_token);
      return json([{ id: 123 }]);
    });
    await cli.store.save("previous-refresh", null);
    expect(await cli.run(["servers", "list"])).toBe(0);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests[1].headers.get("Authorization")).toBe(
      `Bearer ${tokens.access_token}`,
    );
    expect(await cli.store.read()).toBe(tokens.refresh_token);
  });

  test("canceling after a refresh response saves rotation without a resource request", async () => {
    const controller = new AbortController();
    const cli = await setup((request) => {
      if (!request.url.endsWith("/token"))
        throw new Error("A canceled read must not reach the resource API");
      const response = json(tokens);
      const readText = response.text.bind(response);
      response.text = async () => {
        const body = await readText();
        controller.abort();
        return body;
      };
      return response;
    });
    await cli.store.save("previous-refresh", null);
    cli.context.signal = controller.signal;
    expect(await cli.run(["servers", "list"])).toBe(130);
    expect(await cli.store.read()).toBe(tokens.refresh_token);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0].url.endsWith("/token")).toBe(true);
    expect(cli.output).toEqual([]);
    expect(cli.errors.join("")).not.toContain(tokens.refresh_token);
  });

  test("environment refresh tokens are not written to disk", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/token") ? json(tokens) : json([]),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_REFRESH_TOKEN: "fixture-env-refresh",
    };
    expect(await cli.run(["servers", "list"])).toBe(0);
    expect(await readdir(cli.root)).toEqual([]);
    cli.context.env = {
      ...cli.env,
      NETCUP_REFRESH_TOKEN: "one",
      NETCUP_ACCESS_TOKEN: "two",
    };
    expect(await cli.run(["servers", "list"])).toBe(2);
  });

  test("logout revokes before removing the saved login and retains it on failure", async () => {
    const cli = await setup(() => json({ error: "server_error" }, 500));
    await cli.store.save("saved-refresh", null);
    expect(await cli.run(["logout"])).toBe(1);
    expect(await cli.store.read()).toBe("saved-refresh");
    expect(cli.errors.join("")).toContain("--local");
    const fields = new URLSearchParams(await cli.requests[0].text());
    expect(fields.get("token")).toBe("saved-refresh");
    cli.context.fetch = async () => new Response(null, { status: 200 });
    expect(await cli.run(["logout"])).toBe(0);
    expect(await cli.store.read()).toBeUndefined();
  });

  test("local-only logout is explicit and sends no request", async () => {
    const cli = await setup();
    await cli.store.save("saved-refresh", null);
    expect(await cli.run(["logout", "--local"])).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(JSON.parse(cli.output.join("")).revoked).toBe(false);
    expect(cli.errors.join("")).toContain("not revoked");
  });

  test("auth status returns only safe account fields", async () => {
    const cli = await setup(() =>
      json({
        id: 321,
        preferred_username: "customer",
        access_token: "must-not-print",
      }),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "fixture-access-secret",
    };
    expect(await cli.run(["auth", "status"])).toBe(0);
    expect(JSON.parse(cli.output.join("")).user.id).toBe(321);
    expect(cli.output.join("")).not.toContain("must-not-print");
  });

  test("the private store rotates atomically and preserves another session", async () => {
    const cli = await setup();
    await cli.store.save("first", null);
    if (process.platform !== "win32") {
      expect((await lstat(dirname(cli.store.path))).mode & 0o777).toBe(0o700);
      expect((await lstat(cli.store.path)).mode & 0o777).toBe(0o600);
    }
    await cli.store.save("second", "first");
    await expect(cli.store.save("wrong", "first")).rejects.toThrow(
      "changed in another command",
    );
    await expect(cli.store.remove("first")).rejects.toThrow(
      "changed in another command",
    );
    expect(await cli.store.read()).toBe("second");
    expect(await readdir(dirname(cli.store.path))).toEqual([
      "credentials.json",
    ]);
  });

  test("unsafe, linked or malformed files fail without exposing their content", async () => {
    const cli = await setup();
    await cli.store.save("fixture-private-secret", null);
    if (process.platform !== "win32") {
      await chmod(cli.store.path, 0o644);
      await expect(cli.store.read()).rejects.toThrow("600");
      await chmod(cli.store.path, 0o600);
    }
    await writeFile(cli.store.path, '{"fixture-private-secret":', {
      mode: 0o600,
    });
    try {
      await cli.store.read();
      throw new Error("Expected invalid credentials");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain("fixture-private-secret");
      expect(error.message).toContain("netcup login");
    }
    await rm(cli.store.path);
    const target = join(cli.root, "not-credentials.json");
    await writeFile(
      target,
      JSON.stringify({ refreshToken: "fixture-private-secret" }),
      { mode: 0o600 },
    );
    await symlink(target, cli.store.path);
    await expect(cli.store.read()).rejects.toThrow("not a link");
  });

  test("lock contention preserves credentials and names the recovery step", async () => {
    const cli = await setup();
    await cli.store.save("saved", null);
    await writeFile(join(dirname(cli.store.path), ".credentials.lock"), "", {
      mode: 0o600,
    });
    await expect(cli.store.save("new", "saved")).rejects.toThrow(
      "If no Netcup command is running",
    );
    expect(await cli.store.read()).toBe("saved");
  });

  test("canceling device login keeps the saved login", async () => {
    const controller = new AbortController();
    const cli = await setup(() => {
      controller.abort();
      return json({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://example.com/approve",
        interval: 1,
        expires_in: 60,
      });
    });
    await cli.store.save("saved", null);
    cli.context.signal = controller.signal;
    expect(await cli.run(["login"])).toBe(130);
    expect(await cli.store.read()).toBe("saved");
  });

  test("missing credentials do not create a config directory", async () => {
    const cli = await setup();
    expect(await cli.store.read()).toBeUndefined();
    expect(await readdir(cli.root)).toEqual([]);
    await mkdir(join(cli.root, "other-app"));
    expect(await cli.run(["logout"])).toBe(0);
    expect(await readdir(cli.root)).toEqual(["other-app"]);
  });
});

describe("CCP CLI", () => {
  test("help and public record types need no login or credential files", async () => {
    const cli = await setup(() => ccpJson({ type: ["A", "TXT"] }));
    cli.context.env = {
      ...cli.env,
      NETCUP_ACCESS_TOKEN: "bad\nscp-token",
      NETCUP_REFRESH_TOKEN: "also-set",
      NETCUP_CCP_API_KEY: "bad\nccp-key",
    };
    expect(await cli.run(["ccp", "--help"])).toBe(0);
    expect(await cli.run(["ccp", "login", "--help"])).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(cli.output.join("")).toContain("ccp dns prepare");
    expect(await cli.run(["ccp", "dns", "types"])).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(cli.requests[0].headers.has("Authorization")).toBe(false);
    expect(new URL(cli.requests[0].url).pathname).toBe("/v1/dns/recordType");
    expect(await readdir(cli.root)).toEqual([]);
  });

  test("invalid arguments and unrelated flags fail before credentials or requests", async () => {
    const cli = await setup();
    const cases = [
      ["ccp", "constructor"],
      ["ccp", "domains", "list", "--search", "example"],
      ["ccp", "domains", "list", "--page", "0"],
      ["ccp", "domains", "list", "--per-page", "1.5"],
      ["ccp", "domains", "list", "--domain-id", "9007199254740992"],
      ["ccp", "domains", "list", "--field", "nickname"],
      ["ccp", "domains", "list", "--direction", "down"],
      ["ccp", "dns", "revisions", "0"],
      ["ccp", "dns", "records", "42", "latest"],
      ["ccp", "dns", "records", "42", revisionId, "--page", "2"],
      ["ccp", "dns", "review", "42", "current"],
      ["ccp", "dns", "commit", "42", "bad-uuid", "--yes"],
      ["ccp", "dns", "prepare", "42"],
      [
        "ccp",
        "dns",
        "prepare",
        "42",
        "--file",
        "/does-not-exist",
        "--limit",
        "1",
      ],
      ["ccp", "login", "--file", "/does-not-exist"],
      ["ccp", "logout", "--local"],
    ];
    for (const args of cases) expect(await cli.run(args)).toBe(2);
    expect(cli.requests).toHaveLength(0);
    expect(await readdir(cli.root)).toEqual([]);
  });

  test("domain filters preserve native query names, envelopes and independent keys", async () => {
    const meta = { pagination: { page: 2, perPage: 10, totalEntries: 0 } };
    const cli = await setup(() => ccpJson([], meta));
    await cli.store.save("server-refresh", null);
    await writeFile(cli.store.path, "malformed server credentials");
    cli.context.env = {
      ...cli.env,
      NETCUP_CCP_API_KEY: `  ${ccpKey}  `,
      NETCUP_ACCESS_TOKEN: "bad\nserver-token",
      NETCUP_REFRESH_TOKEN: "also-set",
      NETCUP_BASE_URL: "https://wrong-server.example",
      NETCUP_AUTH_URL: "https://wrong-auth.example",
    };
    expect(
      await cli.run([
        "ccp",
        "domains",
        "list",
        "--fqdn",
        "example.com",
        "--domain-id",
        "42",
        "--page",
        "2",
        "--per-page",
        "10",
        "--field",
        "fqdn",
        "--direction",
        "desc",
        "--compact",
      ]),
    ).toBe(0);
    const request = cli.requests[0];
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.netcup.com");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      fqdn: "example.com",
      domainId: "42",
      page: "2",
      perPage: "10",
      field: "fqdn",
      direction: "desc",
    });
    expect(request.headers.get("Authorization")).toBe(`Bearer ${ccpKey}`);
    expect(JSON.parse(cli.output.join(""))).toEqual({
      success: true,
      errors: [],
      messages: [],
      meta,
      result: [],
    });
    expect(cli.errors.join("")).toContain("No domains");
    expect(cli.requests).toHaveLength(1);
    expect(await readFile(cli.store.path, "utf8")).toBe(
      "malformed server credentials",
    );
    expect(await cli.ccpStore.read()).toBeUndefined();
  });

  test("missing CCP credentials never use a saved SCP login", async () => {
    const cli = await setup();
    await cli.store.save("server-refresh", null);
    expect(await cli.run(["ccp", "domains", "list"])).toBe(1);
    expect(cli.requests).toHaveLength(0);
    expect(cli.errors.join("")).toContain("netcup ccp login");
    expect(cli.errors.join("")).toContain("NETCUP_CCP_API_KEY");
    expect(await cli.store.read()).toBe("server-refresh");
  });

  test("CCP saved keys have private independent files, locks and conflict checks", async () => {
    const cli = await setup();
    await cli.store.save("server-refresh", null);
    await cli.ccpStore.save("FirstKey123", null);
    expect(JSON.parse(await readFile(cli.ccpStore.path, "utf8"))).toEqual({
      apiKey: "FirstKey123",
    });
    if (process.platform !== "win32")
      expect((await lstat(cli.ccpStore.path)).mode & 0o777).toBe(0o600);
    await cli.ccpStore.save("SecondKey123", "FirstKey123");
    await expect(
      cli.ccpStore.save("OtherKey123", "FirstKey123"),
    ).rejects.toThrow("changed in another command");
    await expect(cli.ccpStore.remove("FirstKey123")).rejects.toThrow(
      "changed in another command",
    );
    expect(await cli.ccpStore.read()).toBe("SecondKey123");
    expect(await cli.store.read()).toBe("server-refresh");
    await writeFile(
      join(dirname(cli.ccpStore.path), ".ccp-credentials.lock"),
      "",
      { mode: 0o600 },
    );
    await expect(
      cli.ccpStore.save("ThirdKey123", "SecondKey123"),
    ).rejects.toThrow("If no Netcup command is running");
    await cli.store.save("new-server-refresh", "server-refresh");
    expect(await cli.store.read()).toBe("new-server-refresh");
    expect(await cli.ccpStore.read()).toBe("SecondKey123");
  });

  test("CCP login checks the hidden key before saving and preserves the server login", async () => {
    const cli = await setup(() => ccpJson([]));
    await cli.store.save("server-refresh", null);
    cli.context.promptSecret = async () => `  ${ccpKey}  `;
    expect(await cli.run(["ccp", "login"])).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(new URL(cli.requests[0].url).searchParams.get("perPage")).toBe("1");
    expect(cli.requests[0].headers.get("Authorization")).toBe(
      `Bearer ${ccpKey}`,
    );
    expect(await cli.ccpStore.read()).toBe(ccpKey);
    expect(await cli.store.read()).toBe("server-refresh");
    expect(JSON.parse(cli.output.join(""))).toEqual({ authenticated: true });
    expect(cli.errors.join("")).toContain("plaintext API key");
    expect(cli.errors.join("") + cli.output.join("")).not.toContain(ccpKey);
  });

  test("failed or canceled CCP login keeps the previous key", async () => {
    const cli = await setup(() =>
      json(
        {
          success: false,
          errors: [
            { code: "authenticationError", message: `Rejected ${ccpKey}` },
          ],
          messages: [],
          meta: null,
          result: null,
        },
        400,
      ),
    );
    await cli.ccpStore.save("PreviousKey123", null);
    cli.context.promptSecret = async () => ccpKey;
    expect(await cli.run(["ccp", "login"])).toBe(1);
    expect(await cli.ccpStore.read()).toBe("PreviousKey123");
    expect(cli.errors.join("")).toContain("CCP API key");
    expect(cli.errors.join("")).not.toContain(ccpKey);
    const controller = new AbortController();
    cli.context.signal = controller.signal;
    cli.context.promptSecret = async () => {
      controller.abort();
      return ccpKey;
    };
    expect(await cli.run(["ccp", "login"])).toBe(130);
    expect(await cli.ccpStore.read()).toBe("PreviousKey123");
    expect(cli.requests).toHaveLength(1);
  });

  test("invalid prompted and environment keys never reach fetch or output", async () => {
    const cli = await setup();
    const secret = "FirstPrivatePart\nSecondPrivatePart";
    cli.context.promptSecret = async () => secret;
    expect(await cli.run(["ccp", "login"])).toBe(2);
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: secret };
    expect(await cli.run(["ccp", "domains", "list"])).toBe(2);
    expect(cli.requests).toHaveLength(0);
    const visible = cli.errors.join("") + cli.output.join("");
    expect(visible).not.toContain("FirstPrivatePart");
    expect(visible).not.toContain("SecondPrivatePart");
    expect(await cli.ccpStore.read()).toBeUndefined();
  });

  test("environment key precedence is not persisted and status returns no domain data", async () => {
    const cli = await setup(() =>
      ccpJson([{ id: 42, fqdn: "private-domain.example" }]),
    );
    await cli.ccpStore.save("SavedKey123", null);
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "auth", "status"])).toBe(0);
    expect(cli.requests[0].headers.get("Authorization")).toBe(
      `Bearer ${ccpKey}`,
    );
    expect(JSON.parse(cli.output.join(""))).toEqual({
      authenticated: true,
      source: "environment",
    });
    expect(cli.output.join("")).not.toContain("private-domain.example");
    expect(await cli.ccpStore.read()).toBe("SavedKey123");
    delete cli.context.env.NETCUP_CCP_API_KEY;
    cli.output.length = 0;
    expect(await cli.run(["ccp", "auth", "status"])).toBe(0);
    expect(JSON.parse(cli.output.join(""))).toEqual({
      authenticated: true,
      source: "saved",
    });
    expect(cli.requests[1].headers.get("Authorization")).toBe(
      "Bearer SavedKey123",
    );
  });

  test("CCP logout is local, never claims revocation and preserves SCP credentials", async () => {
    const cli = await setup();
    await cli.store.save("server-refresh", null);
    await cli.ccpStore.save(ccpKey, null);
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "logout"])).toBe(2);
    expect(await cli.ccpStore.read()).toBe(ccpKey);
    delete cli.context.env.NETCUP_CCP_API_KEY;
    expect(await cli.run(["ccp", "logout"])).toBe(0);
    expect(cli.requests).toHaveLength(0);
    expect(await cli.ccpStore.read()).toBeUndefined();
    expect(await cli.store.read()).toBe("server-refresh");
    expect(JSON.parse(cli.output.join(""))).toEqual({
      authenticated: false,
      revoked: false,
    });
    expect(cli.errors.join("")).toContain("not revoked");
  });

  test("redaction keeps JSON valid and catches reflected keys and terminal controls", async () => {
    const cli = await setup(() =>
      ccpJson({ [ccpKey]: ccpKey, count: 123, valid: true }),
    );
    cli.context.env = {
      ...cli.env,
      NETCUP_CCP_API_KEY: ccpKey,
      NETCUP_ACCESS_TOKEN: "Fixture",
    };
    expect(await cli.run(["ccp", "domains", "list"])).toBe(0);
    expect(JSON.parse(cli.output.join("")).result).toEqual({
      "[redacted]": "[redacted]",
      count: 123,
      valid: true,
    });
    expect(cli.output.join("")).not.toContain(ccpKey);
    cli.context.fetch = async () =>
      json(
        {
          success: false,
          errors: [
            { code: "invalidRecord", message: `Bad ${ccpKey}\u001b[2J` },
          ],
          messages: [],
          meta: null,
          result: null,
        },
        400,
      );
    expect(await cli.run(["ccp", "domains", "list"])).toBe(1);
    expect(cli.errors.join("")).not.toContain(ccpKey);
    expect(cli.errors.join("")).not.toContain("\u001b");
    expect(cli.errors.join("")).toContain("\\u001b");
  });

  test("JSON output escapes terminal controls without changing parsed string values", async () => {
    const value = "record\u009b[2J.example";
    const cli = await setup(() => ccpJson([{ fqdn: value }]));
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "domains", "list"])).toBe(0);
    expect(cli.output.join("")).not.toContain("\u009b");
    expect(JSON.parse(cli.output.join("")).result[0].fqdn).toBe(value);
  });

  test("changes files cannot override safety flags or send invalid record data", async () => {
    const cli = await setup();
    const invalid = [
      {},
      { create: [] },
      { autoCommit: true, create: [dnsRecord] },
      { strict: false, create: [dnsRecord] },
      { create: ["private-value"] },
      { delete: [recordId] },
      { create: [{ ...dnsRecord, id: recordId }] },
      { create: [{ ...dnsRecord, ttl: 0 }] },
      { create: [{ ...dnsRecord, ttl: 1.5 }] },
      { create: [{ ...dnsRecord, type: "PTR" }] },
      { create: [{ ...dnsRecord, name: "a".repeat(256) }] },
      { create: [{ ...dnsRecord, rdata: "a".repeat(65536) }] },
    ];
    for (const value of invalid) {
      const file = await changesFile(cli.root, value);
      expect(
        await cli.run(["ccp", "dns", "prepare", "42", "--file", file, "--yes"]),
      ).toBe(2);
    }
    const malformed = join(cli.root, "malformed.json");
    await writeFile(malformed, '{"private-json-contents":');
    expect(
      await cli.run([
        "ccp",
        "dns",
        "prepare",
        "42",
        "--file",
        malformed,
        "--yes",
      ]),
    ).toBe(2);
    expect(cli.errors.join("")).not.toContain("private-json-contents");
    expect(cli.requests).toHaveLength(0);
  });

  test("prepare submits one change set with automatic commit off and an explicit review target", async () => {
    const cli = await setup(() => ccpJson({ identifier: revisionId }));
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    const file = await changesFile(cli.root, {
      create: [dnsRecord],
      delete: [{ ...dnsRecord, rdata: "192.0.2.9" }],
    });
    expect(
      await cli.run(["ccp", "dns", "prepare", "42", "--file", file, "--yes"]),
    ).toBe(0);
    expect(cli.requests).toHaveLength(1);
    expect(new URL(cli.requests[0].url).pathname).toBe(
      "/v1/domain/42/changeset",
    );
    expect(await cli.requests[0].json()).toEqual({
      autoCommit: false,
      strict: true,
      create: [dnsRecord],
      delete: [{ ...dnsRecord, rdata: "192.0.2.9" }],
    });
    expect(JSON.parse(cli.output.join("")).result.identifier).toBe(revisionId);
    expect(cli.errors.join("")).toContain(
      `netcup ccp dns review 42 ${revisionId}`,
    );
    expect(cli.errors.join("")).not.toContain("netcup tasks get");
    expect(
      cli.requests.some((request) => request.url.endsWith("/commit")),
    ).toBe(false);
  });

  test("prepare can be refused before authentication and cannot guess a returned revision", async () => {
    const cli = await setup(() => ccpJson({}));
    const file = await changesFile(cli.root, { create: [dnsRecord] });
    cli.context.confirm = async () => false;
    expect(await cli.run(["ccp", "dns", "prepare", "42", "--file", file])).toBe(
      2,
    );
    expect(cli.requests).toHaveLength(0);
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(
      await cli.run(["ccp", "dns", "prepare", "42", "--file", file, "--yes"]),
    ).toBe(1);
    expect(cli.requests).toHaveLength(1);
    expect(cli.errors.join("")).toContain("netcup ccp dns revisions 42");
    expect(cli.output).toEqual([]);
  });

  test("revision listing preserves page and unconstrained sort fields", async () => {
    const cli = await setup(() => ccpJson([], { pagination: { page: 2 } }));
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(
      await cli.run([
        "ccp",
        "dns",
        "revisions",
        "42",
        "--page",
        "2",
        "--per-page",
        "5",
        "--field",
        "modifiedAt",
        "--direction",
        "desc",
      ]),
    ).toBe(0);
    expect(
      Object.fromEntries(new URL(cli.requests[0].url).searchParams),
    ).toEqual({
      page: "2",
      perPage: "5",
      field: "modifiedAt",
      direction: "desc",
    });
    expect(JSON.parse(cli.output.join("")).meta.pagination.page).toBe(2);
  });

  test("empty revisions and records explain what to check or add", async () => {
    const cli = await setup(() => ccpJson([]));
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "dns", "revisions", "42"])).toBe(0);
    expect(cli.errors.join("")).toContain("No DNS revisions");
    expect(cli.errors.join("")).toContain("netcup ccp dns prepare 42");
    expect(await cli.run(["ccp", "dns", "records", "42", revisionId])).toBe(0);
    expect(cli.errors.join("")).toContain("No records");
    expect(cli.errors.join("")).toContain("netcup ccp dns revisions 42");
  });

  test("pagination links to the same page do not falsely imply omitted records", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/record")
        ? ccpJson([dnsRecord], {
            pagination: {
              page: 1,
              nextPage: 1,
              previousPage: 1,
              lastPage: 1,
              totalEntries: 1,
            },
          })
        : ccpJson({ identifier: revisionId }),
    );
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "dns", "review", "42", revisionId])).toBe(0);
    expect(cli.requests).toHaveLength(2);
  });

  test("review is read-only and keeps both response envelopes", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/record")
        ? ccpJson([{ identifier: recordId, ...dnsRecord }], {
            pagination: { page: 1, totalEntries: 1, lastPage: 1, nextPage: 0 },
          })
        : ccpJson({ identifier: revisionId }),
    );
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(await cli.run(["ccp", "dns", "review", "42", revisionId])).toBe(0);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    const value = JSON.parse(cli.output.join(""));
    expect(value.revision.result.identifier).toBe(revisionId);
    expect(value.records.result[0].identifier).toBe(recordId);
    expect(value.records.meta.pagination.totalEntries).toBe(1);
  });

  test("review and commit refuse explicitly partial records without invented paging", async () => {
    for (const pagination of [
      { totalEntries: 2 },
      { page: 1, nextPage: 2 },
      { page: 1, lastPage: 2 },
    ]) {
      const cli = await setup((request) =>
        request.url.endsWith("/record")
          ? ccpJson([dnsRecord], { pagination })
          : ccpJson({ identifier: revisionId }),
      );
      cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
      expect(await cli.run(["ccp", "dns", "review", "42", revisionId])).toBe(1);
      expect(
        await cli.run(["ccp", "dns", "commit", "42", revisionId, "--yes"]),
      ).toBe(1);
      expect(cli.requests.every((request) => request.method === "GET")).toBe(
        true,
      );
      expect(cli.output).toEqual([]);
      expect(cli.errors.join("")).not.toContain("--page");
    }
  });

  test("commit previews before asking and refusal sends no mutation", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/record")
        ? ccpJson([dnsRecord])
        : ccpJson({ identifier: revisionId }),
    );
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    let questions = 0;
    cli.context.confirm = async (question) => {
      questions += 1;
      expect(cli.requests).toHaveLength(2);
      expect(cli.errors.join("")).toContain("192.0.2.10");
      expect(question).toContain(revisionId);
      expect(question).toContain("42");
      return false;
    };
    expect(await cli.run(["ccp", "dns", "commit", "42", revisionId])).toBe(2);
    expect(questions).toBe(1);
    expect(cli.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(cli.errors.join("")).toContain("No change request was sent");
    expect(cli.output).toEqual([]);
  });

  test("noninteractive commit refuses before loading credentials or sending requests", async () => {
    const cli = await setup();
    const runner = join(cli.root, "runner.ts");
    await writeFile(
      runner,
      `import { main } from ${JSON.stringify(resolve("src/cli.ts"))}; await main();\n`,
    );
    const child = Bun.spawnSync(
      [process.execPath, runner, "ccp", "dns", "commit", "42", revisionId],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...cli.env,
          NETCUP_CCP_API_KEY: "",
          NETCUP_ACCESS_TOKEN: "",
          NETCUP_REFRESH_TOKEN: "",
        },
      },
    );
    expect(child.exitCode).toBe(2);
    expect(new TextDecoder().decode(child.stderr)).toContain("--yes");
    expect(new TextDecoder().decode(child.stdout)).toBe("");
    expect(await cli.ccpStore.read()).toBeUndefined();
  });

  test("--yes still previews and sends exactly one bodyless commit", async () => {
    const cli = await setup((request) =>
      request.url.endsWith("/record")
        ? ccpJson([dnsRecord])
        : ccpJson({ identifier: revisionId }),
    );
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(
      await cli.run(["ccp", "dns", "commit", "42", revisionId, "--yes"]),
    ).toBe(0);
    expect(cli.requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
    expect(new URL(cli.requests[2].url).pathname).toBe(
      `/v1/domain/42/dns/revision/${revisionId}/commit`,
    );
    expect(await cli.requests[2].text()).toBe("");
    expect(cli.errors.join("")).toContain("192.0.2.10");
    expect(cli.errors.join("")).not.toContain("netcup tasks get");
    expect(JSON.parse(cli.output.join("")).result.identifier).toBe(revisionId);
  });

  test("failed commits are not retried and retain actionable request errors", async () => {
    const cli = await setup((request) => {
      if (request.method === "POST") throw new TypeError("fetch failed");
      return request.url.endsWith("/record")
        ? ccpJson([dnsRecord])
        : ccpJson({ identifier: revisionId });
    });
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    expect(
      await cli.run(["ccp", "dns", "commit", "42", revisionId, "--yes"]),
    ).toBe(1);
    expect(
      cli.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
    expect(cli.errors.join("")).toContain("before retrying a change");
    expect(cli.output).toEqual([]);
  });

  test("cancellation after preview prevents commit and reports the actual request phase", async () => {
    const controller = new AbortController();
    const cli = await setup((request) =>
      request.url.endsWith("/record")
        ? ccpJson([dnsRecord])
        : ccpJson({ identifier: revisionId }),
    );
    cli.context.env = { ...cli.env, NETCUP_CCP_API_KEY: ccpKey };
    cli.context.signal = controller.signal;
    cli.context.confirm = async () => {
      controller.abort();
      return true;
    };
    expect(await cli.run(["ccp", "dns", "commit", "42", revisionId])).toBe(130);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(cli.errors.join("")).toContain("Only read requests were sent");
    expect(cli.output).toEqual([]);
  });

  test("unsafe or malformed CCP files keep their contents private and name CCP recovery", async () => {
    const cli = await setup();
    await cli.ccpStore.save(ccpKey, null);
    if (process.platform !== "win32") {
      await chmod(cli.ccpStore.path, 0o644);
      await expect(cli.ccpStore.read()).rejects.toThrow("600");
      await chmod(cli.ccpStore.path, 0o600);
    }
    await writeFile(cli.ccpStore.path, `{"${ccpKey}":`);
    cli.context.env = { ...cli.env };
    expect(await cli.run(["ccp", "domains", "list"])).toBe(1);
    expect(cli.errors.join("")).not.toContain(ccpKey);
    expect(cli.errors.join("")).toContain("netcup ccp login");
    await rm(cli.ccpStore.path);
    const target = join(cli.root, "linked-key.json");
    await writeFile(target, JSON.stringify({ apiKey: ccpKey }), {
      mode: 0o600,
    });
    await symlink(target, cli.ccpStore.path);
    await expect(cli.ccpStore.read()).rejects.toThrow("not a link");
    expect(cli.requests).toHaveLength(0);
  });

  for (const [name, input, expected] of [
    ["submit", `${ccpKey}\r`, 0],
    ["Ctrl-C", `${ccpKey}\x03`, 130],
    ["EOF", "\x04", 130],
  ] as const) {
    test(`a real Node terminal hides CCP input and handles ${name}`, async () => {
      const cli = await setup();
      const build = await Bun.build({
        entrypoints: [resolve("src/cli.ts")],
        outdir: join(cli.root, "build"),
        target: "node",
        format: "cjs",
      });
      expect(build.success).toBe(true);
      const runner = join(cli.root, "runner.cjs");
      await writeFile(
        runner,
        `const { runCli } = require(${JSON.stringify(build.outputs[0].path)});\nrunCli(["ccp", "login"], { fetch: async () => new Response(JSON.stringify({ success: true, errors: [], messages: [], meta: null, result: [] }), { headers: { "Content-Type": "application/json" } }) }).then(code => { process.exitCode = code; });\n`,
      );
      let output = "";
      let entered = false;
      const child = Bun.spawn(["node", runner], {
        env: {
          ...process.env,
          ...cli.env,
          NETCUP_CCP_API_KEY: "",
          NETCUP_ACCESS_TOKEN: "",
          NETCUP_REFRESH_TOKEN: "",
        },
        terminal: {
          data(terminal, data) {
            output += new TextDecoder().decode(data);
            if (!entered && output.includes("CCP API key: ")) {
              entered = true;
              terminal.write(input);
            }
          },
        },
      });
      const timeout = setTimeout(() => {
        child.kill();
      }, 3000);
      try {
        expect(await child.exited).toBe(expected);
        expect(entered).toBe(true);
        expect(output).not.toContain(ccpKey);
        expect(await cli.ccpStore.read()).toBe(
          expected === 0 ? ccpKey : undefined,
        );
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
        child.terminal?.close();
      }
    });
  }
});
