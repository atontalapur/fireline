// HTTP client for the Fireline tools API: POST ${baseUrl}/api/tools/<name> with the tool input as
// JSON. Every failure becomes a FirelineApiError with a message an LLM can act on.

export const DEFAULT_API_URL = "http://localhost:3000";
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

export class FirelineApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "FirelineApiError";
    this.status = status;
  }
}

export function normalizeBaseUrl(url: string | undefined): string {
  const value = url?.trim() || DEFAULT_API_URL;
  return value.replace(/\/+$/, "");
}

export function createClient(options: ClientOptions = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function callTool(name: string, input: unknown): Promise<unknown> {
    const url = `${baseUrl}/api/tools/${encodeURIComponent(name)}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
          ? `timed out after ${timeoutMs} ms`
          : errorMessage(err);
      throw new FirelineApiError(`Could not reach the Fireline API at ${baseUrl}: ${reason}`);
    }

    const text = await res.text().catch(() => "");
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!res.ok) {
      const detail = extractError(body) ?? (body === undefined && text ? text.slice(0, 300) : res.statusText);
      const prefix =
        res.status === 404
          ? `Fireline API error 404: tool '${name}' not found at ${baseUrl}`
          : `Fireline API error ${res.status} for ${name}`;
      throw new FirelineApiError(detail ? `${prefix}: ${detail}` : prefix, res.status);
    }
    if (body === undefined) {
      throw new FirelineApiError(`Fireline API returned a non-JSON response for ${name}`, res.status);
    }
    return body;
  }

  return { baseUrl, callTool };
}

export type FirelineClient = ReturnType<typeof createClient>;

function extractError(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
    if (e !== undefined) return JSON.stringify(e);
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err);
}
