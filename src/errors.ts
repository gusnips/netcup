export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NetcupError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const details = Array.isArray(body) ? body : [body];
    const messages = details
      .filter(isRecord)
      .map((item) => item.message)
      .filter((message): message is string => typeof message === "string");
    super(
      messages.join("; ") ||
        `Netcup request failed (HTTP ${status}). Check the request and your access token.`,
    );
    this.name = "NetcupError";
    this.status = status;
    this.body = body;
  }
}

export class NetcupAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NetcupAuthError";
  }
}
