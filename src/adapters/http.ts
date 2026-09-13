import { RateLimitError, TimeoutError } from "@/adapters/faults";

export type HttpResponse = { status: number; body: unknown; headers: Headers };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * One HTTP path for every live adapter, so live and shadow surface the SAME error
 * types (RateLimitError, TimeoutError). If they differed, the executor's retry and
 * rollback behaviour would diverge between rehearsal and commit — which is exactly
 * the class of bug this project exists to catch.
 */
export async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: ctl.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new TimeoutError(url);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
    const ms = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 1000;
    throw new RateLimitError(ms);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}
