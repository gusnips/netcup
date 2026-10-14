import { afterEach, describe, expect, test } from "bun:test";
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
    expect(cli.output.join("")).toContain("0.2.0");
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
    expect(cli.errors.join("")).toContain("may still run");
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
    expect(await cli.store.read()).toEqual({
      refreshToken: tokens.refresh_token,
    });
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
    expect(await cli.store.read()).toEqual({
      refreshToken: "previous-refresh",
    });
    expect(cli.output).toEqual([]);
    expect(cli.errors.join("")).not.toContain("fixture-private-response");
  });

  test("file-backed refresh rotates tokens before the API request", async () => {
    const cli = await setup(async (request) => {
      if (request.url.endsWith("/token")) return json(tokens);
      expect((await cli.store.read())?.refreshToken).toBe(tokens.refresh_token);
      return json([{ id: 123 }]);
    });
    await cli.store.save("previous-refresh", null);
    expect(await cli.run(["servers", "list"])).toBe(0);
    expect(cli.requests).toHaveLength(2);
    expect(cli.requests[1].headers.get("Authorization")).toBe(
      `Bearer ${tokens.access_token}`,
    );
    expect((await cli.store.read())?.refreshToken).toBe(tokens.refresh_token);
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
    expect(await cli.store.read()).toEqual({ refreshToken: "saved-refresh" });
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
    expect(await cli.store.read()).toEqual({ refreshToken: "second" });
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
    expect((await cli.store.read())?.refreshToken).toBe("saved");
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
    expect((await cli.store.read())?.refreshToken).toBe("saved");
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
