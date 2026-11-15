import type { BackendHit, BackendResult } from "../backends/types.js";
import type { ParamName, ParsedRequest } from "./params.js";
import { PARAMS } from "./params.js";

/** Google never serves a result past index 100, whatever the total says. */
export const MAX_RESULTS = 100;

export type QueryEcho = Record<string, string | number>;

export interface CseResult {
  kind: "customsearch#result";
  title: string;
  htmlTitle: string;
  link: string;
  displayLink: string;
  snippet: string;
  htmlSnippet: string;
  formattedUrl: string;
  htmlFormattedUrl: string;
  mime?: string;
  fileFormat?: string;
  pagemap?: { cse_thumbnail?: { src: string; width?: string; height?: string }[]; cse_image?: { src: string }[] };
  image?: {
    contextLink: string;
    height?: number;
    width?: number;
    byteSize?: number;
    thumbnailLink?: string;
    thumbnailHeight?: number;
    thumbnailWidth?: number;
  };
}

export interface CseSearch {
  kind: "customsearch#search";
  url: { type: "application/json"; template: string };
  queries: { request: QueryEcho[]; nextPage?: QueryEcho[]; previousPage?: QueryEcho[] };
  context: { title: string };
  searchInformation: {
    searchTime: number;
    formattedSearchTime: string;
    totalResults: string;
    formattedTotalResults: string;
  };
  spelling?: { correctedQuery: string; htmlCorrectedQuery: string };
  items?: CseResult[];
}

/** The OpenSearch template from Google's responses, with this server's base URL. */
export function openSearchTemplate(baseUrl: string): string {
  return (
    `${baseUrl}/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&lr={language?}&safe={safe?}` +
    "&cx={cx?}&sort={sort?}&filter={filter?}&gl={gl?}&cr={cr?}&googlehost={googleHost?}&c2coff={disableCnTwTranslation?}" +
    "&hq={hq?}&hl={hl?}&siteSearch={siteSearch?}&siteSearchFilter={siteSearchFilter?}&exactTerms={exactTerms?}" +
    "&excludeTerms={excludeTerms?}&linkSite={linkSite?}&orTerms={orTerms?}&dateRestrict={dateRestrict?}" +
    "&lowRange={lowRange?}&highRange={highRange?}&searchType={searchType}&fileType={fileType?}&rights={rights?}" +
    "&imgSize={imgSize?}&imgType={imgType?}&imgColorType={imgColorType?}&imgDominantColor={imgDominantColor?}&alt=json"
  );
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Words of the query worth bolding, at least 2 chars, with operators and excluded words dropped.
 * Only punctuation at the edges is trimmed, so `node.js`, `v2.0` and `C++` stay whole.
 */
export function highlightTerms(...queries: (string | undefined)[]): string[] {
  const words = new Set<string>();
  for (const q of queries) {
    for (const raw of (q ?? "").split(/\s+/)) {
      if (raw.startsWith("-") || /^(?:site|filetype|inurl|intitle):/i.test(raw) || raw === "OR") continue;
      const word = raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}+#]+$/u, "");
      if (word.length >= 2) words.add(word.toLowerCase());
    }
  }
  return [...words].sort((a, b) => b.length - a.length);
}

/** HTML-escapes `text` and wraps whole-word, case-insensitive matches of `terms` in `<b>`, as Google does. */
export function bold(text: string, terms: readonly string[]): string {
  if (terms.length === 0) return escapeHtml(text);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}+#])`,
    "giu",
  );
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += escapeHtml(text.slice(last, match.index)) + `<b>${escapeHtml(match[0])}</b>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const FILE_FORMATS: Record<string, string> = {
  "application/pdf": "PDF/Adobe Acrobat",
  "application/msword": "Microsoft Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Microsoft Word",
  "application/vnd.ms-excel": "Microsoft Excel",
  "application/vnd.ms-powerpoint": "Microsoft Powerpoint",
  "text/plain": "Text",
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

function displayLink(url: URL): string {
  return url.host;
}

/** Google shows the URL without a trailing slash on bare hosts, e.g. `https://example.org`. */
function formattedUrl(url: URL): string {
  const href = url.href;
  return url.pathname === "/" && url.search === "" && url.hash === "" ? href.slice(0, -1) : href;
}

const ELLIPSIS = " ...";
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Cuts to at most `max` characters (graphemes, ellipsis included), preferring a word boundary. */
export function truncate(text: string, max: number | undefined): string {
  const chars = Array.from(graphemes.segment(text), (s) => s.segment);
  if (max === undefined || chars.length <= max) return text;
  if (max <= ELLIPSIS.length * 2) return chars.slice(0, max).join("");
  const cut = chars.slice(0, max - ELLIPSIS.length).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}${ELLIPSIS}`;
}

export function toResult(hit: BackendHit, terms: readonly string[], searchType: "web" | "image", snippetLength?: number): CseResult | undefined {
  let url: URL;
  try {
    url = new URL(hit.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  // Never echo credentials a backend may have left in a URL.
  url.username = "";
  url.password = "";

  const snippet = truncate(hit.snippet.replace(/\s+/g, " ").trim(), snippetLength);
  const title = hit.title.replace(/\s+/g, " ").trim() || displayLink(url);
  const context = hit.contextUrl !== undefined ? safeUrl(hit.contextUrl) : undefined;
  const pageUrl = searchType === "image" && context !== undefined ? context : url;
  const result: CseResult = {
    kind: "customsearch#result",
    title,
    htmlTitle: bold(title, terms),
    link: url.href,
    displayLink: displayLink(pageUrl),
    snippet,
    htmlSnippet: bold(snippet, terms),
    formattedUrl: formattedUrl(pageUrl),
    htmlFormattedUrl: bold(formattedUrl(pageUrl), terms),
  };

  const mime = hit.image?.mime ?? hit.mime;
  if (mime !== undefined) {
    result.mime = mime;
    const format = FILE_FORMATS[mime];
    if (format !== undefined) result.fileFormat = format;
  }

  if (searchType === "image") {
    result.image = { contextLink: (context ?? url).href };
    copyDefined(result.image, {
      width: hit.image?.width,
      height: hit.image?.height,
      byteSize: hit.image?.byteSize,
      thumbnailLink: hit.thumbnail?.url,
      thumbnailWidth: hit.thumbnail?.width,
      thumbnailHeight: hit.thumbnail?.height,
    });
  } else if (hit.thumbnail !== undefined) {
    // Google's pagemap values are strings, including width and height.
    const thumb: { src: string; width?: string; height?: string } = { src: hit.thumbnail.url };
    if (hit.thumbnail.width !== undefined) thumb.width = String(hit.thumbnail.width);
    if (hit.thumbnail.height !== undefined) thumb.height = String(hit.thumbnail.height);
    result.pagemap = { cse_thumbnail: [thumb], cse_image: [{ src: hit.thumbnail.url }] };
  }
  return result;
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function copyDefined<T extends object>(target: T, source: { [K in keyof T]?: T[K] | undefined }): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

/** Builds a Query object (request / nextPage / previousPage) from the sent parameters. */
function queryEcho(request: ParsedRequest, title: string, totalResults: number, count: number, startIndex: number): QueryEcho {
  const echo: QueryEcho = {
    title,
    totalResults: String(totalResults),
    searchTerms: request.params.q ?? "",
    count,
    startIndex,
    inputEncoding: "utf8",
    outputEncoding: "utf8",
    safe: request.params.safe ?? "off",
  };
  for (const [name, value] of Object.entries(request.sent) as [ParamName, string][]) {
    if (name === "q" || name === "num" || name === "start" || name === "safe") continue;
    const field = (PARAMS[name] as { queryField?: string | null }).queryField;
    if (field === null) continue;
    echo[field ?? name] = value;
  }
  return echo;
}

export interface BuildOptions {
  baseUrl: string;
  engineTitle: string;
  request: ParsedRequest;
  result: BackendResult;
  items: CseResult[];
  searchTimeSeconds: number;
  locale?: string;
}

export function buildSearch(opts: BuildOptions): CseSearch {
  const { request, result, items } = opts;
  const { start, num } = request.params;
  const lastShown = start - 1 + items.length;
  // A backend that cannot estimate a total still tells us whether more exists; report what we know.
  const total = Math.max(result.totalEstimate ?? 0, lastShown + (result.hasMore ? 1 : 0));
  const title = `${opts.engineTitle} - ${request.params.q ?? ""}`.trimEnd();

  const search: CseSearch = {
    kind: "customsearch#search",
    url: { type: "application/json", template: openSearchTemplate(opts.baseUrl) },
    queries: { request: [queryEcho(request, title, total, num, start)] },
    context: { title: opts.engineTitle },
    searchInformation: {
      searchTime: Number(opts.searchTimeSeconds.toFixed(6)),
      formattedSearchTime: opts.searchTimeSeconds.toFixed(2),
      totalResults: String(total),
      formattedTotalResults: total.toLocaleString(opts.locale ?? "en-US"),
    },
  };

  const nextStart = start + num;
  if (items.length > 0 && result.hasMore && nextStart <= MAX_RESULTS) {
    const nextCount = Math.min(num, MAX_RESULTS - nextStart + 1);
    search.queries.nextPage = [queryEcho(request, title, total, nextCount, nextStart)];
  }
  if (start > 1) {
    const prevStart = Math.max(1, start - num);
    search.queries.previousPage = [queryEcho(request, title, total, Math.min(num, start - prevStart), prevStart)];
  }
  if (result.correctedQuery !== undefined && result.correctedQuery !== request.params.q) {
    search.spelling = { correctedQuery: result.correctedQuery, htmlCorrectedQuery: escapeHtml(result.correctedQuery) };
  }
  if (items.length > 0) search.items = items;
  return search;
}
