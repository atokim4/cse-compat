import type { DateRestrict, Feature, SearchBackend, SearchQuery } from "../backends/types.js";
import type { Engine } from "../engines.js";
import { errors } from "./errors.js";
import { PARAMS, type MethodParams, type ParamName } from "./params.js";

/** Which backend feature a sent parameter needs. Parameters not listed here are handled by this server itself. */
const FEATURE_OF: Partial<Record<ParamName, Feature>> = {
  exactTerms: "exactTerms",
  excludeTerms: "excludeTerms",
  orTerms: "orTerms",
  hq: "hq",
  siteSearch: "siteSearch",
  fileType: "fileType",
  dateRestrict: "dateRestrict",
  lr: "language",
  gl: "country",
  cr: "country",
  safe: "safe",
  sort: "sortByDate",
  lowRange: "numericRange",
  highRange: "numericRange",
  linkSite: "linkSite",
  rights: "rights",
  imgColorType: "imageFilters",
  imgDominantColor: "imageFilters",
  imgSize: "imageFilters",
  imgType: "imageFilters",
};

/**
 * The sent parameters behind backend features, sorted: `["country"]` with gl and cr sent gives
 * `["cr", "gl"]`. hl counts for "language" only when lr was not sent, since hl is used only then.
 */
export function paramsOf(features: readonly Feature[], sent: Partial<Record<ParamName, string>>): string[] {
  const names = new Set<string>();
  for (const [name, feature] of Object.entries(FEATURE_OF) as [ParamName, Feature][]) {
    if (features.includes(feature) && sent[name] !== undefined) names.add(name);
  }
  if (features.includes("language") && sent.lr === undefined && sent.hl !== undefined) names.add("hl");
  return [...names].sort();
}

export interface BuiltQuery {
  query: SearchQuery;
  /**
   * Sent parameters that had no effect, sorted: ones the backend cannot honour, values this server
   * cannot translate (e.g. a boolean cr expression, lr=en), c2coff=1 and enableAlternateSearchHandler=true.
   * Deprecated parameters that Google itself ignores (googlehost, relatedSite) are accepted silently.
   */
  ignored: string[];
}

/** Google's language codes, lowercased with `-`: `zh-CN` → `zh-cn`, `pt_BR` → `pt-br`, legacy `iw` → `he`. */
export function normaliseLanguage(code: string): string | undefined {
  const value = code.trim().toLowerCase().replace("_", "-");
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(value)) return undefined;
  return value.replace(/^iw(?=-|$)/, "he");
}

export function parseDateRestrict(value: string): DateRestrict | undefined {
  const match = /^([dwmy])(\d{1,5})$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const amount = Number.parseInt(match[2], 10);
  if (amount < 1) return undefined;
  return { unit: match[1].toLowerCase() as DateRestrict["unit"], amount };
}

/** `countryUS` → `us`. Boolean expressions such as `(countryUS|countryCA)` are not translated. */
function parseCountryRestrict(value: string): string | undefined {
  return /^country([a-z]{2})$/i.exec(value.trim())?.[1]?.toLowerCase();
}

function parseSortByDate(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "date" || v === "date:d") return true;
  return undefined;
}

/** `HTTPS://*.Docs.Example/Guides/*` → `docs.example/Guides`: scheme and wildcards dropped, host lowercased, path kept as is. */
export function normaliseSite(value: string): string {
  const bare = value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\*\./, "")
    .replace(/\/?\*?$/, "");
  const slash = bare.indexOf("/");
  return slash === -1 ? bare.toLowerCase() : bare.slice(0, slash).toLowerCase() + bare.slice(slash);
}

export function buildQuery(params: MethodParams, sent: Partial<Record<ParamName, string>>, engine: Engine, backend: SearchBackend): BuiltQuery {
  const ignored = new Set<string>();
  const has = (name: ParamName) => sent[name] !== undefined;
  const supports = (name: ParamName): boolean => {
    const feature = FEATURE_OF[name];
    return feature === undefined || backend.features.has(feature);
  };

  const query: SearchQuery = {
    terms: (params.q ?? "").trim(),
    includeSites: [...engine.includeSites],
    excludeSites: [...engine.excludeSites],
    safe: params.safe === "active" || params.safe === "high" || params.safe === "medium",
    sortByDate: false,
    searchType: params.searchType === "image" ? "image" : "web",
    offset: params.start - 1,
    count: params.num,
  };

  if (query.searchType === "image" && !backend.features.has("imageSearch")) {
    throw errors.invalidArgument(`searchType=image is not supported by the '${backend.name}' backend.`);
  }

  const take = (name: ParamName, apply: () => boolean | undefined): void => {
    if (!has(name)) return;
    if (!supports(name) || apply() !== true) ignored.add(name);
  };

  take("exactTerms", () => assign(query, "exactTerms", params.exactTerms));
  take("excludeTerms", () => assign(query, "excludeTerms", params.excludeTerms));
  take("orTerms", () => assign(query, "orTerms", params.orTerms));
  take("hq", () => assign(query, "hq", params.hq));
  take("fileType", () => assign(query, "fileType", params.fileType?.trim().replace(/^\./, "").toLowerCase()));
  take("lowRange", () => assign(query, "lowRange", params.lowRange));
  take("highRange", () => assign(query, "highRange", params.highRange));
  take("linkSite", () => assign(query, "linkSite", params.linkSite));
  take("rights", () => assign(query, "rights", params.rights));
  take("dateRestrict", () => assign(query, "dateRestrict", parseDateRestrict(params.dateRestrict ?? "")));
  take("lr", () => {
    const lr = params.lr?.trim().toLowerCase() ?? "";
    if (!(PARAMS.lr.values as readonly string[]).includes(lr)) return undefined;
    return assign(query, "language", normaliseLanguage(lr.slice("lang_".length)));
  });
  // cr restricts and gl only boosts, so cr wins when both are sent.
  take("cr", () => assign(query, "country", parseCountryRestrict(params.cr ?? "")));
  take("gl", () => {
    const gl = params.gl?.trim().toLowerCase() ?? "";
    if (!/^[a-z]{2}$/.test(gl)) return undefined;
    query.country ??= gl;
    return true;
  });
  take("sort", () => {
    const byDate = parseSortByDate(params.sort ?? "");
    if (byDate) query.sortByDate = true;
    return byDate;
  });
  take("siteSearch", () => {
    const site = normaliseSite(params.siteSearch ?? "");
    if (site === "") return false;
    if (params.siteSearchFilter === "e") query.excludeSites.push(site);
    else query.requiredSite = site;
    return true;
  });
  // safe=off is Google's default, so it never counts as ignored.
  if (has("safe") && query.safe && !backend.features.has("safe")) ignored.add("safe");
  for (const name of ["imgColorType", "imgDominantColor", "imgSize", "imgType"] as const) {
    if (has(name) && (query.searchType !== "image" || !supports(name))) ignored.add(name);
  }
  // c2coff=1 (no Chinese variant merging) is not supported; unknown c2coff/filter values fall back to the default.
  if (!["", "0"].includes(params.c2coff?.trim() ?? "")) ignored.add("c2coff");
  if (!["", "0", "1"].includes(params.filter?.trim() ?? "")) ignored.add("filter");
  if (params.enableAlternateSearchHandler === "true") ignored.add("enableAlternateSearchHandler");
  if (!has("lr") && params.hl !== undefined && backend.features.has("language")) {
    // hl is the interface language; used only as a language preference when lr is absent.
    const hl = /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(params.hl.trim()) ? normaliseLanguage(params.hl) : undefined;
    if (hl !== undefined) query.language = hl;
  }

  const hasTerms = [query.terms, query.exactTerms, query.orTerms, query.hq].some((t) => t !== undefined && t.trim() !== "");
  if (!hasTerms) throw errors.invalidArgument();

  return { query, ignored: [...ignored].sort() };
}

function assign<K extends keyof SearchQuery>(query: SearchQuery, key: K, value: SearchQuery[K] | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  query[key] = value;
  return true;
}

export type Operator = "quotes" | "minus" | "or" | "site" | "filetype";

/**
 * Renders a `SearchQuery` as one query string using the operators a text-query backend understands
 * (SearXNG and Brave both read `"phrase"`, `-word`, `OR` and `site:`). Used by backends that take a
 * single query string; the corpus backend filters structurally instead.
 */
export function toOperatorQuery(query: SearchQuery, operators: ReadonlySet<Operator>): string {
  const parts: string[] = [];
  const quote = (s: string) => `"${s.replaceAll('"', "")}"`;
  if (query.terms !== "") parts.push(query.terms);
  if (query.hq) parts.push(query.hq);
  if (query.exactTerms && operators.has("quotes")) parts.push(quote(query.exactTerms));
  if (query.excludeTerms && operators.has("minus")) {
    const ex = query.excludeTerms.trim();
    parts.push(/\s/.test(ex) && operators.has("quotes") ? `-${quote(ex)}` : `-${ex}`);
  }
  if (query.orTerms && operators.has("or")) {
    const terms = query.orTerms.trim().split(/\s+/);
    parts.push(terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0] ?? "");
  }
  if (operators.has("site")) {
    if (query.includeSites.length === 1) parts.push(`site:${query.includeSites[0] ?? ""}`);
    else if (query.includeSites.length > 1) {
      parts.push(`(${query.includeSites.map((s) => `site:${s}`).join(" OR ")})`);
    }
    if (query.requiredSite !== undefined) parts.push(`site:${query.requiredSite}`);
    for (const site of query.excludeSites) parts.push(`-site:${site}`);
  }
  if (query.fileType && operators.has("filetype")) parts.push(`filetype:${query.fileType}`);
  return parts.filter((p) => p !== "").join(" ");
}
