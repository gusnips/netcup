import { isRecord, NetcupAuthError } from "./errors";

export type NetcupFetch = (request: Request) => Promise<Response>;

export interface NetcupTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in?: number;
  scope?: string;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
  expiresAt: number;
}

export interface NetcupUserInfo {
  id: number;
  sub?: string;
  preferred_username?: string;
}

export interface AuthOptions {
  accessToken?: string | (() => string | Promise<string>);
  refreshToken?: string;
  onTokens?: (tokens: NetcupTokens) => void | Promise<void>;
  authUrl?: string;
  fetch?: NetcupFetch;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new NetcupAuthError(
      "invalid_response",
      "Netcup returned an invalid login response. Try signing in again.",
    );
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new NetcupAuthError(
      "invalid_response",
      "Netcup returned an incomplete login response. Try signing in again.",
    );
  }
  return value;
}

function seconds(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER / 1000
  ) {
    throw new NetcupAuthError(
      "invalid_response",
      "Netcup returned an invalid token expiry. Try signing in again.",
    );
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function verificationUrl(value: unknown): string {
  const url = text(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {
    // Invalid URLs must not be offered as login links.
  }
  throw new NetcupAuthError(
    "invalid_response",
    "Netcup returned an invalid login link. Start a new device login.",
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const authMessages: Record<string, string> = {
  authorization_pending:
    "Approve the device code in your browser, then try again.",
  slow_down: "Netcup asked you to wait longer between login checks.",
  access_denied: "Access was denied. Start a new device login to try again.",
  expired_token: "This device code expired. Start a new device login.",
  invalid_grant:
    "The refresh token or device code is no longer valid. Start a new device login.",
};

export class NetcupAuth {
  private readonly fetch: NetcupFetch;
  private readonly authUrl: string;
  private currentRefreshToken?: string;
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;
  private generation = 0;

  private checkSession(generation: number): void {
    if (generation !== this.generation) {
      throw new NetcupAuthError(
        "session_revoked",
        "This login was revoked. Start a new device login.",
      );
    }
  }

  constructor(private readonly options: AuthOptions = {}) {
    if (
      options.accessToken !== undefined &&
      options.refreshToken !== undefined
    ) {
      throw new NetcupAuthError(
        "invalid_config",
        "Provide an access token or a refresh token, not both.",
      );
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.authUrl = (
      options.authUrl ??
      "https://servercontrolpanel.de/realms/scp/protocol/openid-connect"
    ).replace(/\/+$/, "");
    this.currentRefreshToken = options.refreshToken;
  }

  get refreshToken(): string | undefined {
    return this.currentRefreshToken;
  }

  private async request(
    path: string,
    fields?: Record<string, string>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<unknown> {
    const response = await this.fetch(
      new Request(`${this.authUrl}/${path}`, {
        method: fields ? "POST" : "GET",
        body: fields ? new URLSearchParams(fields) : undefined,
        headers: accessToken
          ? { Authorization: `Bearer ${accessToken}` }
          : undefined,
        signal,
      }),
    );
    const raw = await response.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      throw new NetcupAuthError(
        "invalid_response",
        "Netcup returned an unreadable login response. Try again.",
        response.status,
      );
    }
    if (!response.ok) {
      const value = isRecord(body) ? body.error : undefined;
      const code =
        typeof value === "string" && /^[a-z_]{1,64}$/.test(value)
          ? value
          : "oauth_error";
      throw new NetcupAuthError(
        code,
        authMessages[code] ??
          `Netcup login failed (HTTP ${response.status}). Try signing in again.`,
        response.status,
      );
    }
    return body;
  }

  private async remember(
    value: unknown,
    generation: number,
    fallbackRefreshToken?: string,
  ): Promise<NetcupTokens> {
    this.checkSession(generation);
    const body = record(value);
    const tokens: NetcupTokens = {
      access_token: text(body.access_token),
      refresh_token: text(body.refresh_token ?? fallbackRefreshToken),
      token_type: text(body.token_type),
      expires_in: seconds(body.expires_in),
      scope: optionalText(body.scope),
    };
    if (tokens.token_type.toLowerCase() !== "bearer") {
      throw new NetcupAuthError(
        "invalid_response",
        "Netcup returned an unsupported token type. Start a new device login.",
      );
    }
    if (body.refresh_expires_in !== undefined) {
      tokens.refresh_expires_in =
        body.refresh_expires_in === 0 ? 0 : seconds(body.refresh_expires_in);
    }
    this.currentRefreshToken = tokens.refresh_token;
    this.cached = {
      token: tokens.access_token,
      expiresAt: Date.now() + Math.max(0, tokens.expires_in - 30) * 1000,
    };
    try {
      await this.options.onTokens?.(tokens);
    } catch {
      throw new NetcupAuthError(
        "token_storage_failed",
        "Could not save the new tokens. Save auth.refreshToken before restarting your script.",
      );
    }
    this.checkSession(generation);
    return tokens;
  }

  async startDeviceAuthorization(
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const started = Date.now();
    const body = record(
      await this.request(
        "auth/device",
        { client_id: "scp", scope: "offline_access openid" },
        signal,
      ),
    );
    const expiresIn = seconds(body.expires_in);
    return {
      device_code: text(body.device_code),
      user_code: text(body.user_code),
      verification_uri: verificationUrl(body.verification_uri),
      verification_uri_complete:
        body.verification_uri_complete === undefined
          ? undefined
          : verificationUrl(body.verification_uri_complete),
      expires_in: expiresIn,
      interval: body.interval === undefined ? 5 : seconds(body.interval),
      expiresAt: started + expiresIn * 1000,
    };
  }

  async exchangeDeviceCode(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<NetcupTokens> {
    const generation = this.generation;
    return this.remember(
      await this.request(
        "token",
        {
          client_id: "scp",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: text(deviceCode),
        },
        signal,
      ),
      generation,
    );
  }

  async waitForDeviceAuthorization(
    device: DeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<NetcupTokens> {
    let interval = seconds(device.interval) * 1000;
    if (!Number.isFinite(device.expiresAt)) {
      throw new NetcupAuthError(
        "invalid_response",
        "The device code has no valid expiry. Start a new device login.",
      );
    }
    while (Date.now() < device.expiresAt) {
      await delay(Math.min(interval, device.expiresAt - Date.now()), signal);
      if (Date.now() >= device.expiresAt) break;
      try {
        return await this.exchangeDeviceCode(device.device_code, signal);
      } catch (error) {
        if (!(error instanceof NetcupAuthError)) throw error;
        if (error.code === "slow_down") interval += 5000;
        else if (error.code !== "authorization_pending") throw error;
      }
    }
    signal?.throwIfAborted();
    throw new NetcupAuthError("expired_token", authMessages.expired_token);
  }

  async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<NetcupTokens> {
    const generation = this.generation;
    return this.remember(
      await this.request(
        "token",
        {
          client_id: "scp",
          grant_type: "refresh_token",
          refresh_token: text(refreshToken),
        },
        signal,
      ),
      generation,
      refreshToken,
    );
  }

  async getAccessToken(): Promise<string> {
    if (this.options.accessToken !== undefined) {
      const token =
        typeof this.options.accessToken === "function"
          ? await this.options.accessToken()
          : this.options.accessToken;
      return text(token);
    }
    if (this.pending) return this.pending;
    if (this.cached && Date.now() < this.cached.expiresAt)
      return this.cached.token;
    if (!this.currentRefreshToken) {
      throw new NetcupAuthError(
        "missing_token",
        "Provide an access token or refresh token. Use NetcupAuth.startDeviceAuthorization() to sign in.",
      );
    }
    this.pending = this.refresh(this.currentRefreshToken).then(
      (tokens) => tokens.access_token,
    );
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  async userInfo(signal?: AbortSignal): Promise<NetcupUserInfo> {
    const body = record(
      await this.request(
        "userinfo",
        undefined,
        signal,
        await this.getAccessToken(),
      ),
    );
    if (
      typeof body.id !== "number" ||
      !Number.isSafeInteger(body.id) ||
      body.id < 0
    ) {
      throw new NetcupAuthError(
        "invalid_response",
        "Netcup returned an invalid SCP user ID. Try signing in again.",
      );
    }
    return {
      id: body.id,
      sub: optionalText(body.sub),
      preferred_username: optionalText(body.preferred_username),
    };
  }

  async revoke(
    refreshToken = this.currentRefreshToken,
    signal?: AbortSignal,
  ): Promise<void> {
    const revokesCurrent = refreshToken === this.currentRefreshToken;
    await this.request(
      "revoke",
      {
        client_id: "scp",
        token: text(refreshToken),
        token_type_hint: "refresh_token",
      },
      signal,
    );
    if (revokesCurrent) {
      this.generation += 1;
      this.currentRefreshToken = undefined;
      this.cached = undefined;
    }
  }
}
