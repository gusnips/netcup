import { describe, expect, test } from "bun:test";
import { NetcupClient } from "./client";
import { NetcupAuth } from "./auth";
import type { NetcupFetch } from "./auth";
import { NetcupAuthError, NetcupError } from "./errors";
import { createApi, unwrap } from "./http";

const tokenResponse = {
  access_token: "access",
  refresh_token: "rotated",
  token_type: "Bearer",
  expires_in: 300,
  refresh_expires_in: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function client(fetch: NetcupFetch) {
  const config = { accessToken: "access", fetch };
  return createApi(config, new NetcupAuth(config));
}

describe("typed transport", () => {
  test("named server methods enforce one setting and preserve write queries", async () => {
    const mock = mockFetch(() => new Response(null, { status: 202 }));
    const netcup = new NetcupClient({
      accessToken: "access",
      fetch: mock.fetch,
    });
    await expect(
      // @ts-expect-error Multi-setting changes must fail at compile time and runtime.
      netcup.servers.update(123, { nickname: "web", hostname: "web" }),
    ).rejects.toThrow("one server setting");
    // @ts-expect-error Empty updates are invalid.
    await expect(netcup.servers.update(123, {})).rejects.toThrow(
      "one server setting",
    );
    expect(mock.requests).toHaveLength(0);
    await netcup.servers.update(123, { nickname: "web", autostart: undefined });
    expect(await mock.requests[0].json()).toEqual({ nickname: "web" });
    await netcup.servers.update(123, { state: "ON" }, { stateOption: "RESET" });
    expect(new URL(mock.requests[1].url).searchParams.get("stateOption")).toBe(
      "RESET",
    );
    await netcup.servers.optimizeStorage(123, {
      disks: ["sda", "sdb"],
      startAfterOptimization: false,
    });
    expect(new URL(mock.requests[2].url).searchParams.getAll("disks")).toEqual([
      "sda",
      "sdb",
    ]);
  });

  test("mixed task results keep 202 data but never invent 204 bodies", async () => {
    const netcup = new NetcupClient({
      accessToken: "access",
      fetch: async () => json({ uuid: "task", state: "PENDING" }, 202),
    });
    expect(await netcup.tasks.cancel("task")).toEqual({
      uuid: "task",
      state: "PENDING",
    });
    const empty = new NetcupClient({
      accessToken: "access",
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(await empty.tasks.cancel("task")).toBeUndefined();
    expect(
      await empty.networking.updateVlan(1, 2, { name: "private" }),
    ).toBeUndefined();
  });

  test("sets bearer auth, repeated query arrays and numeric path IDs", async () => {
    const mock = mockFetch(() => json([]));
    await unwrap(
      client(mock.fetch).GET("/api/v1/servers", {
        params: { query: { limit: 0, sort: ["name", "-nickname"] } },
      }),
    );
    const request = mock.requests[0];
    expect(request.headers.get("Authorization")).toBe("Bearer access");
    expect(new URL(request.url).searchParams.getAll("sort")).toEqual([
      "name",
      "-nickname",
    ]);
    expect(new URL(request.url).searchParams.get("limit")).toBe("0");
    await unwrap(
      client(mock.fetch).GET("/api/v1/servers/{serverId}", {
        params: {
          path: { serverId: 123 },
          query: { loadServerLiveInfo: false },
        },
      }),
    );
    expect(mock.requests[1].url).toBe(
      "https://servercontrolpanel.de/scp-core/api/v1/servers/123?loadServerLiveInfo=false",
    );
  });

  test("keeps merge-patch media type and query parameters on writes", async () => {
    const mock = mockFetch(() => new Response(null, { status: 202 }));
    const api = client(mock.fetch);
    await unwrap(
      api.PATCH("/api/v1/servers/{serverId}", {
        params: { path: { serverId: 123 } },
        headers: { "Content-Type": "application/merge-patch+json" },
        body: { nickname: "test" },
      }),
    );
    expect(mock.requests[0].headers.get("Content-Type")).toBe(
      "application/merge-patch+json",
    );
    expect(await mock.requests[0].json()).toEqual({ nickname: "test" });
  });

  test("encodes path values and preserves array request bodies", async () => {
    const mock = mockFetch(() => new Response(null, { status: 204 }));
    await unwrap(
      client(mock.fetch).PUT("/api/v1/users/{userId}/images/{key}/{uploadId}", {
        params: {
          path: { userId: 1, key: "folder/image name", uploadId: "upload/id" },
        },
        body: [{ partNumber: 1, eTag: "tag" }],
      }),
    );
    expect(mock.requests[0].url).toContain("folder%2Fimage%20name/upload%2Fid");
    expect(await mock.requests[0].json()).toEqual([
      { partNumber: 1, eTag: "tag" },
    ]);
  });

  test("supports HAL JSON, text, empty responses and raw pagination headers", async () => {
    const mock = mockFetch((request) => {
      if (request.url.endsWith("/api/ping")) return new Response("OK");
      return new Response("[]", {
        headers: {
          "Content-Type": "application/hal+json",
          "X-Total-Count": "12",
        },
      });
    });
    const api = client(mock.fetch);
    const result = await api.GET("/api/v1/servers");
    expect(await unwrap(Promise.resolve(result))).toEqual([]);
    expect(result.response.headers.get("X-Total-Count")).toBe("12");
    expect(await unwrap(api.GET("/api/ping", { parseAs: "text" }))).toBe("OK");
    for (const status of [200, 202, 204]) {
      const empty = client(async () => new Response(null, { status }));
      expect(await unwrap(empty.GET("/api/v1/servers"))).toBeUndefined();
    }
  });

  test("throws structured, non-JSON and empty HTTP errors", async () => {
    const errors = [
      json([{ code: "busy", message: "Server is busy" }], 400),
      new Response("Gateway failed", { status: 502 }),
      new Response(null, { status: 403 }),
    ];
    for (const response of errors) {
      try {
        await unwrap(client(async () => response).GET("/api/v1/servers"));
        throw new Error("Expected an API error");
      } catch (error) {
        expect(error).toBeInstanceOf(NetcupError);
        if (!(error instanceof NetcupError)) throw error;
        expect(error.status).toBe(response.status);
        if (response.status === 400)
          expect(error.message).toBe("Server is busy");
      }
    }
  });

  test("uses token providers without guessing their expiry", async () => {
    let token = "first";
    const mock = mockFetch(() => json([]));
    const config = { accessToken: () => token, fetch: mock.fetch };
    const api = createApi(config, new NetcupAuth(config));
    await api.GET("/api/v1/servers");
    token = "second";
    await api.GET("/api/v1/servers");
    expect(
      mock.requests.map((request) => request.headers.get("Authorization")),
    ).toEqual(["Bearer first", "Bearer second"]);
  });
});

describe("authentication", () => {
  test("late refresh responses cannot restore a revoked login", async () => {
    let finish: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const auth = new NetcupAuth({
      refreshToken: "offline",
      fetch: async (request) =>
        request.url.endsWith("/revoke") ? new Response(null) : response,
    });
    const refreshing = auth.getAccessToken();
    await auth.revoke();
    finish(json(tokenResponse));
    await expect(refreshing).rejects.toThrow("revoked");
    expect(auth.refreshToken).toBeUndefined();
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Provide an access token",
    );
  });

  test("token storage can revoke without restoring tokens or deadlocking", async () => {
    const auth = new NetcupAuth({
      refreshToken: "offline",
      fetch: async (request) =>
        request.url.endsWith("/revoke")
          ? new Response(null)
          : json(tokenResponse),
      onTokens: async () => {
        await auth.revoke();
      },
    });
    await expect(auth.getAccessToken()).rejects.toThrow("revoked");
    expect(auth.refreshToken).toBeUndefined();
  });

  test("uses documented device fields and validates the response", async () => {
    const mock = mockFetch(() =>
      json({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://servercontrolpanel.de/device",
        expires_in: 600,
        interval: 5,
      }),
    );
    const device = await new NetcupAuth({
      fetch: mock.fetch,
    }).startDeviceAuthorization();
    expect(mock.requests[0].url).toEndWith("/auth/device");
    expect(
      new URLSearchParams(await mock.requests[0].text()).get("scope"),
    ).toBe("offline_access openid");
    expect(device.expiresAt).toBeGreaterThan(Date.now());
    const invalid = new NetcupAuth({
      fetch: async () => json({ device_code: "device" }),
    });
    await expect(invalid.startDeviceAuthorization()).rejects.toBeInstanceOf(
      NetcupAuthError,
    );
  });

  test("shares refreshes, caches access and awaits rotated-token storage", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = false;
    const mock = mockFetch(() => json(tokenResponse));
    const auth = new NetcupAuth({
      refreshToken: "offline",
      fetch: mock.fetch,
      onTokens: async (tokens) => {
        expect(tokens.refresh_token).toBe("rotated");
        await gate;
        saved = true;
      },
    });
    const calls = [auth.getAccessToken(), auth.getAccessToken()];
    await Promise.resolve();
    release();
    expect(await Promise.all(calls)).toEqual(["access", "access"]);
    expect(saved).toBe(true);
    expect(auth.refreshToken).toBe("rotated");
    expect(await auth.getAccessToken()).toBe("access");
    expect(mock.requests).toHaveLength(1);
    const fields = new URLSearchParams(await mock.requests[0].text());
    expect(fields.get("client_id")).toBe("scp");
    expect(fields.get("grant_type")).toBe("refresh_token");
    expect(fields.get("refresh_token")).toBe("offline");
  });

  test("refreshes expired cached tokens and keeps refresh token when not returned", async () => {
    const { refresh_token: _unused, ...withoutRotation } = tokenResponse;
    const mock = mockFetch(() => json({ ...withoutRotation, expires_in: 1 }));
    const auth = new NetcupAuth({ refreshToken: "offline", fetch: mock.fetch });
    await auth.getAccessToken();
    await auth.getAccessToken();
    expect(mock.requests).toHaveLength(2);
    expect(auth.refreshToken).toBe("offline");
  });

  test("retries unsaved tokens and recovers when storage succeeds", async () => {
    let storageFails = true;
    let saved: string | undefined;
    const mock = mockFetch(() => json(tokenResponse));
    const auth = new NetcupAuth({
      refreshToken: "offline",
      fetch: mock.fetch,
      onTokens: (tokens) => {
        if (storageFails) throw new Error("secret access rotated");
        saved = tokens.refresh_token;
      },
    });
    try {
      await auth.getAccessToken();
      throw new Error("Expected storage failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NetcupAuthError);
      if (!(error instanceof NetcupAuthError)) throw error;
      expect(error.code).toBe("token_storage_failed");
      expect(error.message).not.toContain("rotated");
      expect(error.message).not.toContain("secret");
    }
    expect(auth.refreshToken).toBe("rotated");
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Could not save the new tokens",
    );
    expect(saved).toBeUndefined();
    expect(mock.requests).toHaveLength(2);
    expect(
      new URLSearchParams(await mock.requests[1].text()).get("refresh_token"),
    ).toBe("rotated");
    storageFails = false;
    expect(await auth.getAccessToken()).toBe("access");
    expect(saved).toBe("rotated");
    expect(mock.requests).toHaveLength(3);
    expect(await auth.getAccessToken()).toBe("access");
    expect(mock.requests).toHaveLength(3);
  });

  test("validates token types and never includes raw OAuth errors", async () => {
    for (const body of [
      { ...tokenResponse, expires_in: "300" },
      { ...tokenResponse, token_type: "Basic" },
      { ...tokenResponse, access_token: "" },
    ]) {
      const auth = new NetcupAuth({
        refreshToken: "offline",
        fetch: async () => json(body),
      });
      await expect(auth.getAccessToken()).rejects.toBeInstanceOf(
        NetcupAuthError,
      );
    }
    const auth = new NetcupAuth({
      refreshToken: "secret",
      fetch: async () =>
        json(
          { error: "invalid_grant", error_description: "secret token value" },
          400,
        ),
    });
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Start a new device login",
    );
  });

  test("waits longer after slow_down and keeps checking pending approval", async () => {
    let checks = 0;
    const mock = mockFetch(() => {
      checks += 1;
      if (checks === 1) return json({ error: "authorization_pending" }, 400);
      if (checks === 2) return json({ error: "slow_down" }, 400);
      return json(tokenResponse);
    });
    const auth = new NetcupAuth({ fetch: mock.fetch });
    const start = Date.now();
    const tokens = await auth.waitForDeviceAuthorization({
      device_code: "device",
      user_code: "CODE",
      verification_uri: "https://servercontrolpanel.de/device",
      interval: 1,
      expires_in: 20,
      expiresAt: start + 20_000,
    });
    expect(tokens.access_token).toBe("access");
    expect(Date.now() - start).toBeGreaterThanOrEqual(7900);
    expect(checks).toBe(3);
  }, 12_000);

  test("reports expired, denied and canceled device logins", async () => {
    const auth = new NetcupAuth({
      fetch: async () => json({ error: "access_denied" }, 400),
    });
    await expect(auth.exchangeDeviceCode("device")).rejects.toThrow(
      "Access was denied",
    );
    const device = {
      device_code: "device",
      user_code: "CODE",
      verification_uri: "https://servercontrolpanel.de/device",
      interval: 1,
      expires_in: 1,
      expiresAt: Date.now() - 1,
    };
    await expect(auth.waitForDeviceAuthorization(device)).rejects.toThrow(
      "expired",
    );
    const controller = new AbortController();
    controller.abort(new Error("Canceled"));
    await expect(
      auth.waitForDeviceAuthorization(
        { ...device, expiresAt: Date.now() + 1000 },
        controller.signal,
      ),
    ).rejects.toThrow("Canceled");
  });

  test("uses SCP user IDs and revokes the latest refresh token", async () => {
    const mock = mockFetch((request) =>
      request.url.endsWith("/userinfo")
        ? json({ id: 123, preferred_username: "customer-number" })
        : request.url.endsWith("/revoke")
          ? new Response(null, { status: 200 })
          : json(tokenResponse),
    );
    const auth = new NetcupAuth({ refreshToken: "offline", fetch: mock.fetch });
    expect((await auth.userInfo()).id).toBe(123);
    expect(mock.requests[1].headers.get("Authorization")).toBe("Bearer access");
    await auth.revoke();
    expect(
      new URLSearchParams(await mock.requests[2].text()).get("token"),
    ).toBe("rotated");
    expect(auth.refreshToken).toBeUndefined();
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Provide an access token",
    );
  });
});
