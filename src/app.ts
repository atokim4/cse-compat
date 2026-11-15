import { Hono } from "hono";
import type { Context } from "hono";
import type { DailyQuota, KeyChecker } from "./auth.js";
import { BackendQuotaError, BackendUnavailableError } from "./backends/types.js";
import type { SearchBackend } from "./backends/types.js";
import { discoveryDocument } from "./cse/discovery.js";
import { GoogleApiError, errors } from "./cse/errors.js";
import { applyFieldMask, parseFieldMask } from "./cse/fields.js";
import { parseMethodParams, parseSystemParams } from "./cse/params.js";
import type { SystemParams } from "./cse/params.js";
import { buildQuery, paramsOf } from "./cse/query.js";
import { buildSearch, highlightTerms, toResult } from "./cse/response.js";
import type { CseResult } from "./cse/response.js";
import type { EngineRegistry } from "./engines.js";

export interface AppDeps {
  engines: EngineRegistry;
  /** Backends by name; `defaultBackend` must be one of them. */
  backends: ReadonlyMap<string, SearchBackend>;
  defaultBackend: string;
  keys: KeyChecker;
  quota: DailyQuota;
  strict: boolean;
  backendTimeoutMs: number;
  /** Fixed public base URL; when undefined it is taken from each request. */
  publicBaseUrl?: string;
  /** Logs unexpected failures. Expected Google errors (400/403/429) are not logged. */
  logError?: (error: unknown) => void;
  now?: () => number;
}

export const IGNORED_HEADER = "X-CSE-Compat-Ignored";
export const BACKEND_HEADER = "X-CSE-Compat-Backend";
export const APPROXIMATED_HEADER = "X-CSE-Compat-Approximated";

const JSON_TYPE = "application/json; charset=UTF-8";

function render(c: Context, status: number, body: unknown, system: Pick<SystemParams, "prettyPrint" | "callback">): Response {
  const json = system.prettyPrint ? JSON.stringify(body, null, 2) : JSON.stringify(body);
  if (system.callback !== undefined) {
    return c.body(`// API callback\n${system.callback}(${json});`, status as 200, {
      "Content-Type": "text/javascript; charset=UTF-8",
    });
  }
  return c.body(json, status as 200, { "Content-Type": JSON_TYPE });
}

/** Same page = same URL once the fragment and a trailing slash on the path are ignored. */
function pageKey(link: string): string {
  const url = new URL(link);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.href;
}

function dedupe(items: CseResult[]): CseResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = pageKey(item.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => performance.now());
  const app = new Hono();
  const baseUrlOf = (c: Context) => deps.publicBaseUrl ?? new URL(c.req.url).origin;

  const search = async (c: Context): Promise<Response> => {
    const started = now();
    const url = new URL(c.req.url);
    let system: SystemParams = { prettyPrint: true };
    try {
      system = parseSystemParams(url.searchParams);
      const headerKey = c.req.header("x-goog-api-key");
      const quotaKey = deps.keys.check(system.key !== undefined && system.key !== "" ? system.key : headerKey);
      const request = parseMethodParams(url.searchParams, system);

      const cx = request.params.cx?.trim() ?? "";
      const engine = cx === "" ? undefined : deps.engines.resolve(cx);
      if (engine === undefined) throw errors.invalidArgument();
      const backendName = engine.backend ?? deps.defaultBackend;
      const backend = deps.backends.get(backendName);
      if (backend === undefined) throw errors.internal();

      const mask = system.fields === undefined ? undefined : parseFieldMask(system.fields);
      const { query, ignored } = buildQuery(request.params, request.sent, engine, backend);
      const limits = backend.limits?.(query) ?? { ignored: [], approximated: [] };
      // Known parameters first, then unknown ones; each group sorted.
      const known = [...new Set([...ignored, ...paramsOf(limits.ignored, request.sent)])].sort();
      const notHonoured = [...known, ...request.unknown];
      const approximated = paramsOf(limits.approximated, request.sent).filter((p) => !notHonoured.includes(p));
      if (deps.strict && notHonoured.length > 0) {
        throw errors.invalidArgument(`Parameters not supported by the '${backend.name}' backend: ${notHonoured.join(", ")}`);
      }
      // Reserved before the search so parallel requests cannot all pass the check, and refunded when the
      // backend fails, so an outage does not burn the day's quota.
      const reservation = deps.quota.reserve(quotaKey);
      let result;
      try {
        result = await backend.search(query, AbortSignal.timeout(deps.backendTimeoutMs));
      } catch (error) {
        reservation.refund();
        throw error;
      }

      const terms = highlightTerms(query.terms, query.hq, query.exactTerms, query.orTerms);
      let items = result.hits
        .slice(0, query.count)
        .map((hit) => toResult(hit, terms, query.searchType, request.params.snippetLength))
        .filter((item) => item !== undefined);
      if (request.params.filter?.trim() !== "0") items = dedupe(items);

      const body = buildSearch({
        baseUrl: baseUrlOf(c),
        engineTitle: engine.title,
        request,
        result,
        items,
        searchTimeSeconds: (now() - started) / 1000,
      });
      c.header(BACKEND_HEADER, backend.name);
      // Unknown names come from the client and may hold any character, so they are percent-encoded.
      if (notHonoured.length > 0) c.header(IGNORED_HEADER, notHonoured.map(encodeURIComponent).join(", "));
      if (approximated.length > 0) c.header(APPROXIMATED_HEADER, approximated.join(", "));
      return render(c, 200, mask === undefined ? body : applyFieldMask(body, mask), system);
    } catch (error) {
      const apiError = toApiError(error);
      // Upstream quota is the operator's problem, so it is logged like an outage.
      if (apiError.code >= 500 || error instanceof BackendQuotaError) deps.logError?.(error);
      return render(c, apiError.code, apiError.toBody(), system);
    }
  };

  app.get("/customsearch/v1", search);
  app.get("/customsearch/v1/siterestrict", search);

  const discovery = (c: Context) => render(c, 200, discoveryDocument(baseUrlOf(c)), { prettyPrint: true });
  app.get("/discovery/v1/apis/customsearch/v1/rest", discovery);
  app.get("/$discovery/rest", discovery);

  app.get("/healthz", (c) => c.json({ status: "ok", backend: deps.defaultBackend }));

  app.notFound((c) => render(c, 404, errors.notFound().toBody(), { prettyPrint: true }));
  app.onError((error, c) => {
    deps.logError?.(error);
    return render(c, 500, errors.internal().toBody(), { prettyPrint: true });
  });
  return app;
}

function toApiError(error: unknown): GoogleApiError {
  if (error instanceof GoogleApiError) return error;
  if (error instanceof BackendUnavailableError) return errors.backendUnavailable();
  if (error instanceof BackendQuotaError) return errors.backendQuota();
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return errors.backendUnavailable();
  }
  return errors.internal();
}
