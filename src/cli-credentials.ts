import type { AuthOptions } from "./auth";
import { CliUsageError } from "./cli-commands";
import type { createRedactor } from "./cli-output";
import { CredentialStore } from "./credentials";

export function apiKey(value: string): string {
  const key = value.trim();
  if (!key || !/^[!-~]+$/.test(key)) {
    throw new CliUsageError(
      "The CCP API key is empty or contains spaces, line breaks or unsupported characters. Copy it again from CCP > Master Data > API.",
    );
  }
  return key;
}

export function scpEnvironment(env: Record<string, string | undefined>) {
  const accessToken = env.NETCUP_ACCESS_TOKEN?.trim();
  const refreshToken = env.NETCUP_REFRESH_TOKEN?.trim();
  for (const [name, token] of [
    ["NETCUP_ACCESS_TOKEN", accessToken],
    ["NETCUP_REFRESH_TOKEN", refreshToken],
  ]) {
    if (token && !/^[!-~]+$/.test(token))
      throw new CliUsageError(
        `${name} contains spaces, line breaks or unsupported characters. Copy it again, or unset it and run netcup login.`,
      );
  }
  if (accessToken && refreshToken)
    throw new CliUsageError(
      "Both NETCUP_ACCESS_TOKEN and NETCUP_REFRESH_TOKEN are set. Unset one before running this command.",
    );
  return { accessToken, refreshToken };
}

export async function loadCcpKey(
  env: Record<string, string | undefined>,
  rememberSecret: (value: string | undefined | null) => void,
): Promise<string> {
  const key =
    env.NETCUP_CCP_API_KEY?.trim() ||
    (await new CredentialStore(env, "ccp").read());
  rememberSecret(key);
  if (!key)
    throw new Error(
      "No CCP key was found. Run netcup ccp login, or set NETCUP_CCP_API_KEY for a script.",
    );
  return apiKey(key);
}

export async function loadScpAuth(
  env: Record<string, string | undefined>,
  secrets: Pick<
    ReturnType<typeof createRedactor>,
    "rememberSecret" | "rememberTokens"
  >,
): Promise<Pick<AuthOptions, "accessToken" | "refreshToken" | "onTokens">> {
  const { accessToken, refreshToken } = scpEnvironment(env);
  if (accessToken) return { accessToken };
  if (refreshToken) return { refreshToken, onTokens: secrets.rememberTokens };
  const store = new CredentialStore(env);
  const saved = await store.read();
  if (!saved)
    throw new Error(
      "No login was found. Run netcup login, or set NETCUP_ACCESS_TOKEN or NETCUP_REFRESH_TOKEN for a script.",
    );
  secrets.rememberSecret(saved);
  let previous = saved;
  return {
    refreshToken: saved,
    onTokens: async (tokens) => {
      secrets.rememberTokens(tokens);
      await store.save(tokens.refresh_token, previous);
      previous = tokens.refresh_token;
    },
  };
}
