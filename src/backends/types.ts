/**
 * What every search backend receives and returns. The CSE layer turns a Custom Search request into a
 * `SearchQuery`; a backend answers with plain `BackendHit`s and the CSE layer formats them into
 * Google's `items[]`. A backend never has to know the Google wire format.
 */

export type Feature =
  | "exactTerms"
  | "excludeTerms"
  | "orTerms"
  | "hq"
  | "siteSearch"
  | "fileType"
  | "dateRestrict"
  | "language"
  | "country"
  | "safe"
  | "sortByDate"
  | "imageSearch"
  | "numericRange"
  | "linkSite"
  | "rights"
  | "imageFilters";

export interface DateRestrict {
  unit: "d" | "w" | "m" | "y";
  amount: number;
}

export interface SearchQuery {
  /** The caller's q, untouched. */
  terms: string;
  exactTerms?: string;
  excludeTerms?: string;
  orTerms?: string;
  hq?: string;
  /**
   * Sites as `host[:port][/path-prefix]`, host lowercase, no scheme. Subdomains of a host match.
   * includeSites come from the engine (cx): a result must be on ANY of them. requiredSite comes from
   * siteSearch with siteSearchFilter=i: a result must ALSO be on it. excludeSites come from both.
   */
  includeSites: string[];
  requiredSite?: string;
  excludeSites: string[];
  fileType?: string;
  dateRestrict?: DateRestrict;
  /** ISO 639-1 language from lr (or hl when lr is absent), e.g. "en", "zh-cn". */
  language?: string;
  /** ISO 3166-1 alpha-2 country from gl or cr, lowercase. */
  country?: string;
  safe: boolean;
  sortByDate: boolean;
  searchType: "web" | "image";
  lowRange?: string;
  highRange?: string;
  linkSite?: string;
  rights?: string;
  /** 0-based offset of the first wanted result and how many results are wanted. */
  offset: number;
  count: number;
}

export interface BackendHit {
  url: string;
  title: string;
  snippet: string;
  /** Present for image search: the page the image appears on. */
  contextUrl?: string;
  thumbnail?: { url: string; width?: number; height?: number };
  image?: { width?: number; height?: number; byteSize?: number; mime?: string };
  mime?: string;
  publishedAt?: string;
}

export interface BackendResult {
  hits: BackendHit[];
  /** Estimated total matches, when the backend reports one. */
  totalEstimate?: number;
  /** True when the backend has (or may have) results after this page. */
  hasMore: boolean;
  correctedQuery?: string;
}

export interface SearchBackend {
  readonly name: string;
  /** Request features this backend honours. Anything else the caller sends is reported as ignored. */
  readonly features: ReadonlySet<Feature>;
  /**
   * For features the backend declares but cannot honour for this particular value (a country Brave
   * does not cover, dateRestrict=y5 on SearXNG): which ones it will drop and which it will only
   * approximate. Called before the search, so strict mode can reject dropped ones.
   */
  limits?(query: SearchQuery): QueryLimits;
  search(query: SearchQuery, signal: AbortSignal): Promise<BackendResult>;
}

export interface QueryLimits {
  ignored: Feature[];
  approximated: Feature[];
}

/** Thrown by a backend when the upstream search service failed or timed out. Mapped to a Google 503. */
export class BackendUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendUnavailableError";
  }
}

/** Thrown by a backend when its own paid quota is used up. Mapped to a Google 429. */
export class BackendQuotaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendQuotaError";
  }
}
