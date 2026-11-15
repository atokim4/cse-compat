import { z } from "zod";
import { toOperatorQuery } from "../cse/query.js";
import type { Operator } from "../cse/query.js";
import { ResultCache } from "./cache.js";
import { withinSites } from "./sites.js";
import { UpstreamHttpError, getJson } from "./http.js";
import type { FetchFn } from "./http.js";
import type { BackendHit, BackendResult, DateRestrict, Feature, QueryLimits, SearchBackend, SearchQuery } from "./types.js";
import { BackendQuotaError, BackendUnavailableError } from "./types.js";

/**
 * Brave Search API, bring your own key (https://api-dashboard.search.brave.com).
 * Web: GET /res/v1/web/search, `count` 1-20 and `offset` 0-9, where offset is a PAGE index in units of
 * count, so at most 200 results are reachable. Images: GET /res/v1/images/search, `count` up to 200, no
 * offset. Every upstream request is billed, so each window Google asks for (start/num) is served
 * with exactly one request, by picking a page size that holds it.
 */

const OPERATORS: ReadonlySet<Operator> = new Set<Operator>(["quotes", "minus", "or", "site", "filetype"]);

const FEATURES: ReadonlySet<Feature> = new Set<Feature>([
  "exactTerms", "excludeTerms", "orTerms", "hq", "siteSearch", "fileType", "dateRestrict",
  "language", "country", "safe", "imageSearch",
]);

/** Countries the web endpoint accepts (from Brave's own MCP server schema, 2026-11). */
const COUNTRIES = new Set(
  "AR AU AT BE BR CA CL DK FI FR DE HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US".split(" "),
);

/** search_lang values Brave accepts. */
const LANGUAGES = new Set(
  ("ar eu bn bg ca zh-hans zh-hant hr cs da nl en en-gb et fi fr gl de el gu he hi hu is it ja kn ko lv lt ms ml mr " +
    "nb pl pt-br pt-pt pa ro ru sr sk sl es sv ta te th tr uk vi").split(" "),
);

/** Google lr/hl codes that Brave spells differently. Plain `pt` has no Brave equivalent and is dropped. */
const LANGUAGE_ALIASES: Record<string, string> = {
  "zh-cn": "zh-hans",
  "zh-tw": "zh-hant",
  no: "nb",
  "pt-br": "pt-br",
  "pt-pt": "pt-pt",
};

/** Google's gl uses `uk` for the United Kingdom. */
const COUNTRY_ALIASES: Record<string, string> = { uk: "GB" };

/** `pt-br` → `pt-br`, `zh-cn` → `zh-hans`, `de-at` → `de` (falls back to the bare language). */
export function braveLanguage(language: string): string | undefined {
  for (const candidate of [language, language.split("-")[0] ?? ""]) {
    const lang = LANGUAGE_ALIASES[candidate] ?? candidate;
    if (LANGUAGES.has(lang)) return lang;
  }
  return undefined;
}

export function braveCountry(country: string): string | undefined {
  const code = COUNTRY_ALIASES[country] ?? country.toUpperCase();
  return COUNTRIES.has(code) ? code : undefined;
}

const WEB_PAGE_MAX = 20;
const WEB_OFFSET_MAX = 9;
const IMAGE_COUNT_MAX = 200;

export interface WebRequest {
  count: number;
  offset: number;
}

/**
 * The one Brave web request that covers results [offset, offset + count): the smallest page size whose
 * page holds the whole window. `skip` is how many results of that page come before the window. Every
 * window Google allows (start + num - 1 <= 100) has one; tests/brave.test.ts checks all 955 of them.
 */
export function planWebRequest(offset: number, count: number): WebRequest & { skip: number } {
  for (let size = count; size <= WEB_PAGE_MAX; size++) {
    const page = Math.floor(offset / size);
    if (page <= WEB_OFFSET_MAX && Math.floor((offset + count - 1) / size) === page) {
      return { count: size, offset: page, skip: offset - page * size };
    }
  }
  throw new RangeError(`No single Brave page holds results ${String(offset)}..${String(offset + count - 1)}`);
}

/** dateRestrict values reaching before this year are sent as no restriction. */
const EARLIEST_YEAR = 1991;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** dateRestrict → Brave freshness: the four presets where they match, else an explicit date range. */
export function freshness(restrict: DateRestrict, now: Date): string | undefined {
  if (restrict.amount === 1 && restrict.unit !== "m") return { d: "pd", w: "pw", y: "py" }[restrict.unit];
  const from = new Date(now);
  if (restrict.unit === "d") from.setUTCDate(from.getUTCDate() - restrict.amount);
  if (restrict.unit === "w") from.setUTCDate(from.getUTCDate() - restrict.amount * 7);
  if (restrict.unit === "m" || restrict.unit === "y") {
    const months = restrict.unit === "m" ? restrict.amount : restrict.amount * 12;
    // Clamp the day: one month before 31 March is 28 (or 29) February, not 3 March.
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    from.setTime(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(now.getUTCDate(), lastDay)));
  }
  // Before the web there is nothing to restrict: such a range means "any time".
  if (from.getUTCFullYear() < EARLIEST_YEAR) return undefined;
  return `${isoDay(from)}to${isoDay(now)}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Brave text can carry `<strong>` and entities even with text_decorations=false; results get plain text. */
export function plainText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/<\/?(?:strong|b|em|i|mark|span)\b[^>]*>/gi, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, ref: string) => {
      if (ref.startsWith("#")) {
        const hex = ref[1] === "x" || ref[1] === "X";
        const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
        const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
        return valid ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[ref.toLowerCase()] ?? whole;
    });
}

const webSchema = z.looseObject({
  query: z.looseObject({ original: z.string().optional(), altered: z.string().optional(), more_results_available: z.boolean().optional() }).optional(),
  web: z.looseObject({ results: z.array(z.unknown()) }).optional(),
});

const webResultSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  page_age: z.string().nullish(),
  thumbnail: z.looseObject({ src: z.string().optional() }).nullish(),
});

const imageSchema = z.looseObject({
  query: z.looseObject({ altered: z.string().optional() }).optional(),
  results: z.array(z.unknown()),
});

const imageResultSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish(),
  properties: z.looseObject({ url: z.string(), width: z.number().optional(), height: z.number().optional() }),
  thumbnail: z.looseObject({ src: z.string().optional(), width: z.number().optional(), height: z.number().optional() }).nullish(),
});

const errorSchema = z.looseObject({
  error: z.looseObject({ code: z.string().optional(), detail: z.string().optional() }),
});

function httpUrl(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
};

function mimeFromUrl(link: string): string | undefined {
  const ext = /\.([a-z0-9]{3,4})$/i.exec(new URL(link).pathname)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : MIME_BY_EXTENSION[ext];
}

export function toWebHit(raw: unknown): BackendHit | undefined {
  const parsed = webResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const url = httpUrl(parsed.data.url);
  if (url === undefined) return undefined;
  const hit: BackendHit = { url, title: plainText(parsed.data.title), snippet: plainText(parsed.data.description) };
  const thumb = httpUrl(parsed.data.thumbnail?.src);
  if (thumb !== undefined) hit.thumbnail = { url: thumb };
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(parsed.data.page_age ?? "")?.[1];
  if (day !== undefined) hit.publishedAt = day;
  return hit;
}

export function toImageHit(raw: unknown): BackendHit | undefined {
  const parsed = imageResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const image = httpUrl(parsed.data.properties.url);
  const page = httpUrl(parsed.data.url);
  if (image === undefined || page === undefined) return undefined;
  const mime = mimeFromUrl(image);
  const { width, height } = parsed.data.properties;
  const hit: BackendHit = {
    url: image,
    title: plainText(parsed.data.title),
    snippet: "",
    contextUrl: page,
    image: { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }), ...(mime === undefined ? {} : { mime }) },
  };
  if (mime !== undefined) hit.mime = mime;
  const thumb = httpUrl(parsed.data.thumbnail?.src ?? undefined);
  if (thumb !== undefined) {
    const t = parsed.data.thumbnail;
    hit.thumbnail = { url: thumb, ...(t?.width === undefined ? {} : { width: t.width }), ...(t?.height === undefined ? {} : { height: t.height }) };
  }
  return hit;
}

export interface BraveOptions {
  apiKey: string;
  /** Defaults to https://api.search.brave.com; tests point it at a local fake. */
  baseUrl?: string;
  /**
   * Cache answers for this long. Off (0) by default: check that your Brave plan allows storing results
   * before turning it on.
   */
  cacheTtlMs?: number;
  cacheEntries?: number;
  fetch?: FetchFn;
  now?: () => Date;
}

interface Page {
  hits: BackendHit[];
  more: boolean;
  altered?: string;
}

export class BraveBackend implements SearchBackend {
  readonly name = "brave";
  readonly features = FEATURES;
  private readonly baseUrl: string;
  private readonly cache: ResultCache<Page>;
  private readonly fetchFn: FetchFn;
  private readonly now: () => Date;
  /** Billed upstream requests made, for tests. */
  upstreamRequests = 0;

  constructor(private readonly options: BraveOptions) {
    if (options.apiKey.trim() === "") throw new Error("Brave backend needs an API key");
    this.baseUrl = (options.baseUrl ?? "https://api.search.brave.com").replace(/\/+$/, "");
    this.cache = new ResultCache(options.cacheTtlMs ?? 0, options.cacheEntries ?? 500);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  limits(query: SearchQuery): QueryLimits {
    const limits: QueryLimits = { ignored: [], approximated: [] };
    if (query.language !== undefined && braveLanguage(query.language) === undefined) limits.ignored.push("language");
    if (query.country !== undefined && braveCountry(query.country) === undefined) limits.ignored.push("country");
    if (query.dateRestrict !== undefined && (query.searchType === "image" || freshness(query.dateRestrict, this.now()) === undefined)) {
      limits.ignored.push("dateRestrict");
    }
    return limits;
  }

  private commonParams(query: SearchQuery): URLSearchParams {
    const params = new URLSearchParams({ q: toOperatorQuery(query, OPERATORS) });
    const language = query.language === undefined ? undefined : braveLanguage(query.language);
    if (language !== undefined) params.set("search_lang", language);
    const country = query.country === undefined ? undefined : braveCountry(query.country);
    if (country !== undefined) params.set("country", country);
    // Google filters nothing unless safe=active; Brave defaults to moderate (web) and strict (images).
    params.set("safesearch", query.safe ? "strict" : "off");
    return params;
  }

  async search(query: SearchQuery, signal: AbortSignal): Promise<BackendResult> {
    return query.searchType === "image" ? this.searchImages(query, signal) : this.searchWeb(query, signal);
  }

  private async searchWeb(query: SearchQuery, signal: AbortSignal): Promise<BackendResult> {
    const params = this.commonParams(query);
    params.set("text_decorations", "false");
    params.set("result_filter", "web,query");
    const fresh = query.dateRestrict === undefined ? undefined : freshness(query.dateRestrict, this.now());
    if (fresh !== undefined) params.set("freshness", fresh);

    const plan = planWebRequest(query.offset, query.count);
    const page = await this.fetchPage("/res/v1/web/search", params, { count: plan.count, offset: plan.offset }, signal, (json) => {
      const parsed = webSchema.safeParse(json);
      if (!parsed.success) throw new BackendUnavailableError("Brave answered JSON in an unexpected shape");
      const hits = (parsed.data.web?.results ?? []).map(toWebHit).filter((h) => h !== undefined);
      const page: Page = { hits, more: parsed.data.query?.more_results_available === true };
      if (parsed.data.query?.altered !== undefined) page.altered = parsed.data.query.altered;
      return page;
    });
    // Google stops at result 100 and Brave at 200, so any next window Google allows is reachable.
    const result: BackendResult = {
      // site: is only a hint to Brave, so the window is checked here too (and may come back shorter).
      hits: page.hits.slice(plan.skip, plan.skip + query.count).filter((h) => withinSites(h.url, query)),
      hasMore: page.hits.length > plan.skip + query.count || page.more,
    };
    if (page.altered !== undefined && page.altered !== "") result.correctedQuery = page.altered;
    return result;
  }

  private async searchImages(query: SearchQuery, signal: AbortSignal): Promise<BackendResult> {
    const params = this.commonParams(query);
    const need = query.offset + query.count;
    // One extra result tells whether there is a next page.
    const count = Math.min(IMAGE_COUNT_MAX, need + 1);
    const page = await this.fetchPage("/res/v1/images/search", params, { count }, signal, (json) => {
      const parsed = imageSchema.safeParse(json);
      if (!parsed.success) throw new BackendUnavailableError("Brave answered JSON in an unexpected shape");
      const page: Page = { hits: parsed.data.results.map(toImageHit).filter((h) => h !== undefined), more: false };
      if (parsed.data.query?.altered !== undefined) page.altered = parsed.data.query.altered;
      return page;
    });
    const result: BackendResult = {
      hits: page.hits.slice(query.offset, need).filter((h) => withinSites(h.contextUrl ?? h.url, query)),
      hasMore: page.hits.length > need,
    };
    if (page.altered !== undefined && page.altered !== "") result.correctedQuery = page.altered;
    return result;
  }

  private async fetchPage(
    path: string,
    common: URLSearchParams,
    extra: Record<string, number>,
    signal: AbortSignal,
    read: (json: unknown) => Page,
  ): Promise<Page> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.search = common.toString();
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, String(value));
    const key = url.href;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    return this.cache.shared(key, async () => {
      this.upstreamRequests += 1;
      let json: unknown;
      try {
        json = await getJson("Brave", url, { "X-Subscription-Token": this.options.apiKey }, signal, this.fetchFn);
      } catch (error) {
        throw classify(error);
      }
      const page = read(json);
      this.cache.set(key, page);
      return page;
    }, signal);
  }
}

/** Brave error codes → what the client sees. The upstream detail is only logged, never sent to the client. */
export function classify(error: unknown): unknown {
  if (!(error instanceof UpstreamHttpError)) return error;
  let code: string | undefined;
  try {
    code = errorSchema.safeParse(JSON.parse(error.body)).data?.error.code;
  } catch {
    code = undefined;
  }
  if (code === "QUOTA_LIMITED") return new BackendQuotaError("Brave plan quota used up (QUOTA_LIMITED)", { cause: error });
  if (code === "RATE_LIMITED" || error.status === 429) {
    return new BackendUnavailableError("Brave rate limit hit (RATE_LIMITED): lower the request rate or raise the plan", { cause: error });
  }
  if (code?.startsWith("SUBSCRIPTION_TOKEN") === true || error.status === 401) {
    return new BackendUnavailableError(`Brave rejected the API key (${code ?? `HTTP ${String(error.status)}`}): check BRAVE_API_KEY`, { cause: error });
  }
  return error;
}
