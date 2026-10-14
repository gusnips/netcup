import type { NetcupTokens } from "./auth";
import { isRecord } from "./errors";

export function terminalSafe(text: string): string {
  return text.replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\t"
      ? character
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function createRedactor(env: Record<string, string | undefined>) {
  const secrets = new Set<string>();
  const rememberSecret = (value: string | undefined | null): void => {
    if (!value) return;
    for (const secret of [
      value,
      value.trim(),
      JSON.stringify(value.trim()).slice(1, -1),
    ])
      if (secret) secrets.add(secret);
  };
  for (const value of [
    env.NETCUP_ACCESS_TOKEN,
    env.NETCUP_REFRESH_TOKEN,
    env.NETCUP_CCP_API_KEY,
  ])
    rememberSecret(value);
  const rememberTokens = (tokens: NetcupTokens): void => {
    rememberSecret(tokens.access_token);
    rememberSecret(tokens.refresh_token);
  };
  const redact = (text: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length))
      text = text.split(secret).join("[redacted]");
    return text;
  };
  const redactJson = (value: unknown, redactKeys = true): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value))
      return value.map((item) => redactJson(item, redactKeys));
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redactKeys ? redact(key) : key,
          redactJson(item, redactKeys),
        ]),
      );
    return value;
  };
  return { rememberSecret, rememberTokens, redact, redactJson };
}
