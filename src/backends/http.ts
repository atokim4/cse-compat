import { BackendUnavailableError } from "./types.js";

/** An upstream answered, but not with a 2xx. The body is kept for the backend to classify (never sent to clients). */
export class UpstreamHttpError extends BackendUnavailableError {
  constructor(
    readonly upstream: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${upstream} answered HTTP ${String(status)}: ${body.slice(0, 300)}`);
    this.name = "UpstreamHttpError";
  }
}

/** Upstream bodies above this size are refused; a search page is a few hundred KB at most. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * GETs JSON from an upstream search service. Redirects are not followed (a redirect from a search API
 * means something is misconfigured, and following one could leak the request elsewhere). Network
 * failures, timeouts, non-JSON and non-2xx answers all end as BackendUnavailableError.
 */
export async function getJson(
  upstream: string,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url.href, { headers: { Accept: "application/json", ...headers }, redirect: "manual", signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new BackendUnavailableError(`${upstream} request failed`, { cause: error });
  }
  const text = await readCapped(upstream, response, MAX_BODY_BYTES);
  if (response.status < 200 || response.status > 299) throw new UpstreamHttpError(upstream, response.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BackendUnavailableError(`${upstream} answered HTTP ${String(response.status)} with a body that is not JSON`, { cause: error });
  }
}

/** Reads the body as UTF-8, counting bytes as they arrive and cancelling the stream once past `limit`. */
async function readCapped(upstream: string, response: Response, limit: number): Promise<string> {
  const tooBig = () => new BackendUnavailableError(`${upstream} answered with more than ${String(limit)} bytes`);
  if (Number(response.headers.get("content-length") ?? "0") > limit) {
    await response.body?.cancel();
    throw tooBig();
  }
  if (response.body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
