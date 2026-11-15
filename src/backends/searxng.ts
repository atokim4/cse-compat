import { z } from "zod";
import { toOperatorQuery } from "../cse/query.js";
import type { Operator } from "../cse/query.js";
import { ResultCache } from "./cache.js";
import { withinSites } from "./sites.js";
import { UpstreamHttpError, getJson } from "./http.js";
import type { FetchFn } from "./http.js";
import type { BackendHit, BackendResult, DateRestrict, Feature, QueryLimits, SearchBackend, SearchQuery } from "./types.js";
import { BackendUnavailableError } from "./types.js";

/**
 * SearXNG (https://docs.searxng.org) through its JSON output: `GET /search?format=json`.
 *
 * SearXNG pages are not a fixed size: one page is whatever its engines returned (20 web results from
 * one engine, 25-30 from two, 140 images in the recorded fixtures), and consecutive pages overlap. So
 * this backend stitches pages into one de-duplicated list per query, fetching only as many pages as
 * the requested window needs, and caches the list so a client walking start=1, 11, 21... costs one
 * upstream page now and then instead of one per request.
 */

const OPERATORS: ReadonlySet<Operator> = new Set<Operator>(["quotes", "minus", "or", "site", "filetype"]);

const FEATURES: ReadonlySet<Feature> = new Set<Feature>([
  "exactTerms", "excludeTerms", "orTerms", "hq", "siteSearch", "fileType", "dateRestrict",
  "language", "safe", "imageSearch",
]);

/** Enough for Google's 100-result window even when engines return small pages. */
const MAX_PAGES = 10;

const resultSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  publishedDate: z.string().nullish(),
  thumbnail: z.string().nullish(),
  img_src: z.string().nullish(),
  thumbnail_src: z.string().nullish(),
  resolution: z.string().nullish(),
  img_format: z.string().nullish(),
  filesize: z.union([z.string(), z.number()]).nullish(),
});

const responseSchema = z.looseObject({
  results: z.array(z.unknown()),
  corrections: z.array(z.string()).optional(),
  /** Present in older SearXNG releases; removed from the JSON output in current ones. */
  number_of_results: z.number().optional(),
  unresponsive_engines: z.array(z.unknown()).optional(),
});

type SearxResult = z.output<typeof resultSchema>;

interface Stitched {
  hits: BackendHit[];
  seen: Set<string>;
  pages: number;
  /** Consecutive pages that added no new result. */
  barren: number;
  exhausted: boolean;
  total?: number;
  corrected?: string;
}

export interface SearxngOptions {
  /** Instance base URL, e.g. http://searxng:8080 (no trailing /search). */
  baseUrl: string;
  /** Extra headers, e.g. for an instance behind a reverse proxy that wants a token. */
  headers?: Record<string, string>;
  cacheTtlMs?: number;
  cacheEntries?: number;
  fetch?: FetchFn;
}

/**
 * SearXNG reads these tokens anywhere in q as its own syntax: `!bang` / `!!bang` (route to an engine or
 * redirect, a 302 even with format=json), `:lang` (language) and `<3` (timeout). It splits q on whitespace
 * and ignores quotes, so a token inside a "phrase" is read the same way. Measured on SearXNG 2d500cb6:
 * `hono !!g` → 302 to google.com, `hono !ddg` → only DuckDuckGo, `i <3 hono` searched as `i hono`; with
 * the token quoted (`"!!g"`) all three were searched as typed.
 *
 * So a bare special token is quoted, and a phrase holding one is split into quoted words, which keeps
 * every word but loosens the phrase. `phraseLoosened` says when that happened.
 */
export function escapeSearxSyntax(query: string): { text: string; phraseLoosened: boolean } {
  const special = (word: string) => /^[!:<]/.test(word);
  let phraseLoosened = false;
  const text = query.replace(/"([^"]*)"|[^\s"]+|"/g, (whole, phrase: string | undefined) => {
    if (phrase === undefined) return special(whole) ? `"${whole}"` : whole;
    const words = phrase.split(/\s+/).filter((w) => w !== "");
    if (!words.some(special)) return whole;
    phraseLoosened = true;
    return words.map((w) => `"${w}"`).join(" ");
  });
  return { text, phraseLoosened };
}

/** SearXNG time ranges and how a dateRestrict maps onto them. */
export function timeRange(restrict: DateRestrict): { range?: "day" | "week" | "month" | "year"; exact: boolean } {
  const days = restrict.amount * { d: 1, w: 7, m: 30, y: 365 }[restrict.unit];
  const exact = restrict.amount === 1;
  if (days <= 1) return { range: "day", exact };
  if (days <= 7) return { range: "week", exact };
  if (days <= 31) return { range: "month", exact };
  if (days <= 366) return { range: "year", exact };
  return { exact: false };
}

/** `zh-cn` → `zh-CN`: the form SearXNG's locale check accepts. */
function searxLanguage(language: string): string {
  const [lang = "", region] = language.split("-");
  return region === undefined ? lang : `${lang}-${region.toUpperCase()}`;
}

/** `1400x375`, `410 x 229` → width/height. */
export function parseResolution(value: string | null | undefined): { width?: number; height?: number } {
  const match = /^\s*(\d{1,6})\s*[x×]\s*(\d{1,6})\s*$/i.exec(value ?? "");
  if (!match?.[1] || !match[2]) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

const MIME_BY_FORMAT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  "svg+xml": "image/svg+xml",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Engines report the format as `png`, `PNG`, `image/png` or `svg+xml`. */
export function imageMime(format: string | null | undefined): string | undefined {
  const f = (format ?? "").trim().toLowerCase();
  if (f === "") return undefined;
  if (/^image\/[a-z0-9.+-]+$/.test(f)) return f;
  return MIME_BY_FORMAT[f];
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, kib: 1024, mib: 1024 ** 2 };

/** `166.48 KB` → 170476. Engines report sizes rounded, so this is an estimate. */
export function parseFileSize(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const match = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(value ?? "");
  const unit = SIZE_UNITS[match?.[2]?.toLowerCase() ?? ""];
  if (!match?.[1] || unit === undefined) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n * unit) : undefined;
}

function normaliseUrl(link: string): string | undefined {
  try {
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** SearXNG dates look like `2026-11-06T00:00:00`; only the calendar date is kept. */
function publishedDay(value: string | null | undefined): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "");
  return match?.[1];
}

export function toHit(result: SearxResult, searchType: "web" | "image"): BackendHit | undefined {
  const page = normaliseUrl(result.url);
  if (page === undefined) return undefined;
  const publishedAt = publishedDay(result.publishedDate);
  if (searchType === "web") {
    const hit: BackendHit = { url: page, title: result.title ?? "", snippet: result.content ?? "" };
    const thumb = result.thumbnail ? normaliseUrl(result.thumbnail) : undefined;
    if (thumb !== undefined) hit.thumbnail = { url: thumb };
    if (publishedAt !== undefined) hit.publishedAt = publishedAt;
    return hit;
  }
  const image = result.img_src ? normaliseUrl(result.img_src) : undefined;
  if (image === undefined) return undefined;
  const mime = imageMime(result.img_format);
  const byteSize = parseFileSize(result.filesize);
  const hit: BackendHit = {
    url: image,
    title: result.title ?? "",
    snippet: result.content ?? "",
    contextUrl: page,
    image: { ...parseResolution(result.resolution), ...(byteSize === undefined ? {} : { byteSize }), ...(mime === undefined ? {} : { mime }) },
  };
  if (mime !== undefined) hit.mime = mime;
  const thumb = result.thumbnail_src ? normaliseUrl(result.thumbnail_src) : undefined;
  if (thumb !== undefined) hit.thumbnail = { url: thumb };
  if (publishedAt !== undefined) hit.publishedAt = publishedAt;
  return hit;
}

export class SearxngBackend implements SearchBackend {
  readonly name = "searxng";
  readonly features = FEATURES;
  private readonly baseUrl: string;
  private readonly cache: ResultCache<Stitched>;
  private readonly fetchFn: FetchFn;
  /** Upstream page requests made, for tests and the startup log. */
  upstreamRequests = 0;

  constructor(private readonly options: SearxngOptions) {
    // Accept the URL with or without the /search path people copy from the browser.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "").replace(/\/search$/, "");
    this.cache = new ResultCache(options.cacheTtlMs ?? 10 * 60_000, options.cacheEntries ?? 500);
    this.fetchFn = options.fetch ?? fetch;
  }

  limits(query: SearchQuery): QueryLimits {
    const limits: QueryLimits = { ignored: [], approximated: [] };
    if (escapeSearxSyntax(toOperatorQuery(query, OPERATORS)).phraseLoosened) {
      // Only exactTerms is a parameter of its own; a phrase in q has no parameter to name.
      if (query.exactTerms !== undefined && escapeSearxSyntax(`"${query.exactTerms}"`).phraseLoosened) limits.approximated.push("exactTerms");
    }
    if (query.dateRestrict) {
      const { range, exact } = timeRange(query.dateRestrict);
      if (range === undefined) limits.ignored.push("dateRestrict");
      else if (!exact) limits.approximated.push("dateRestrict");
    }
    return limits;
  }

  /** The upstream query parameters except pageno: also the cache key. */
  private upstreamParams(query: SearchQuery): URLSearchParams {
    const params = new URLSearchParams();
    params.set("q", escapeSearxSyntax(toOperatorQuery(query, OPERATORS)).text);
    params.set("format", "json");
    params.set("categories", query.searchType === "image" ? "images" : "general");
    // Google's default is no filtering, so safesearch is always sent rather than left to the instance default.
    params.set("safesearch", query.safe ? "2" : "0");
    if (query.language !== undefined) params.set("language", searxLanguage(query.language));
    const range = query.dateRestrict ? timeRange(query.dateRestrict).range : undefined;
    if (range !== undefined) params.set("time_range", range);
    return params;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<BackendResult> {
    const params = this.upstreamParams(query);
    const key = params.toString();
    const need = query.offset + query.count;
    const done = (s: Stitched) => s.hits.length >= need || s.exhausted || s.pages >= MAX_PAGES;

    let state = this.cache.get(key) ?? newState();
    let transient = false;
    while (!done(state) && !transient) {
      const current = state;
      const step = await this.cache.shared(
        key,
        async () => {
          const latest = this.cache.get(key) ?? current;
          const page = done(latest) ? "ok" : await this.fetchPage(latest, params, query, signal);
          // A page that failed upstream leaves the state as it was and is retried by the next request.
          if (page === "ok") this.cache.set(key, latest);
          return { state: latest, page };
        },
        signal,
      );
      state = step.state;
      transient = step.page === "transient";
    }

    const result: BackendResult = {
      hits: state.hits.slice(query.offset, need),
      // After a failed page nothing is promised beyond what is already stitched.
      hasMore: state.hits.length > need || (!transient && !state.exhausted && state.pages < MAX_PAGES),
    };
    if (state.total !== undefined) result.totalEstimate = state.total;
    if (state.corrected !== undefined) result.correctedQuery = state.corrected;
    return result;
  }

  /**
   * Fetches the next page into `state`, changing it only once the page has been read in full.
   * "transient": the page added nothing while some engines failed, so nothing was recorded.
   */
  private async fetchPage(state: Stitched, params: URLSearchParams, query: SearchQuery, signal: AbortSignal): Promise<"ok" | "transient"> {
    const url = new URL(`${this.baseUrl}/search`);
    url.search = params.toString();
    url.searchParams.set("pageno", String(state.pages + 1));
    this.upstreamRequests += 1;
    let json: unknown;
    try {
      json = await getJson("SearXNG", url, this.options.headers ?? {}, signal, this.fetchFn);
    } catch (error) {
      throw explain(error);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new BackendUnavailableError("SearXNG answered JSON without a results array");

    const fresh: BackendHit[] = [];
    const urls = new Set<string>();
    for (const raw of parsed.data.results) {
      const item = resultSchema.safeParse(raw);
      if (!item.success) continue;
      const hit = toHit(item.data, query.searchType);
      if (hit === undefined || state.seen.has(hit.url) || urls.has(hit.url)) continue;
      if (!withinSites(hit.contextUrl ?? hit.url, query)) continue;
      urls.add(hit.url);
      fresh.push(hit);
    }
    const failedEngines = (parsed.data.unresponsive_engines?.length ?? 0) > 0;
    if (fresh.length === 0 && failedEngines) return "transient";

    for (const u of urls) state.seen.add(u);
    state.hits.push(...fresh);
    state.pages += 1;
    // Pages overlap, so one page with nothing new is not the end; an empty page or two barren ones are.
    state.barren = fresh.length === 0 ? state.barren + 1 : 0;
    if (parsed.data.results.length === 0 || state.barren >= 2) state.exhausted = true;
    const total = parsed.data.number_of_results;
    if (total !== undefined && total > 0) state.total = Math.max(state.total ?? 0, total);
    const corrected = parsed.data.corrections?.[0];
    if (state.pages === 1 && corrected !== undefined && corrected !== "") state.corrected = corrected;
    return "ok";
  }
}

function newState(): Stitched {
  return { hits: [], seen: new Set<string>(), pages: 0, barren: 0, exhausted: false };
}

/** Turns the usual SearXNG misconfigurations into log messages an operator can act on. */
function explain(error: unknown): unknown {
  if (!(error instanceof UpstreamHttpError)) return error;
  if (error.status === 403) {
    return new BackendUnavailableError("SearXNG refused format=json (HTTP 403): add json to search.formats in its settings.yml", { cause: error });
  }
  if (error.status === 429) {
    return new BackendUnavailableError("SearXNG rate-limited this server (HTTP 429): turn off server.limiter or allow this server's IP", { cause: error });
  }
  if (error.status >= 300 && error.status < 400) {
    return new BackendUnavailableError(`SearXNG redirected the search (HTTP ${String(error.status)}): check the base URL`, { cause: error });
  }
  return error;
}
