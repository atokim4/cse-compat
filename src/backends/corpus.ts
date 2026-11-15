import { readFileSync } from "node:fs";
import { z } from "zod";
import { normaliseSite } from "../cse/query.js";
import { siteMatches, withinSites } from "./sites.js";
import type { BackendHit, BackendResult, Feature, SearchBackend, SearchQuery } from "./types.js";

/**
 * Searches a local JSON file of documents. Deterministic and offline: meant for CI of apps that call
 * the Custom Search API (no quota, no network) and for this project's own contract tests.
 *
 * Matching is plain and predictable: every word or quoted phrase of q/hq must occur in the title,
 * snippet or URL (case-insensitive), with Google's in-query operators honoured (see parseTerms).
 * exactTerms must occur as a phrase, excludeTerms must not occur, and at least one orTerms word must
 * occur. Results keep file order unless sort=date.
 */

const documentSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  snippet: z.string(),
  language: z.string().optional(),
  country: z.string().length(2).optional(),
  publishedAt: z.iso.date().optional(),
  adult: z.boolean().default(false),
  mime: z.string().optional(),
  thumbnail: z.strictObject({ url: z.url(), width: z.number().int().optional(), height: z.number().int().optional() }).optional(),
  image: z
    .strictObject({
      contextUrl: z.url(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      byteSize: z.number().int().optional(),
    })
    .optional(),
});

export type CorpusDocument = z.output<typeof documentSchema>;

const corpusSchema = z.array(documentSchema);

const FEATURES: ReadonlySet<Feature> = new Set<Feature>([
  "exactTerms", "excludeTerms", "orTerms", "hq", "siteSearch", "fileType", "dateRestrict",
  "language", "country", "safe", "sortByDate", "imageSearch",
]);

const DAY_MS = 86_400_000;
const UNIT_DAYS = { d: 1, w: 7, m: 30, y: 365 } as const;

interface ParsedTerms {
  /** Every clause must match; a clause matches when any of its alternatives occurs (`a OR b`). */
  clauses: string[][];
  excluded: string[];
  sites: string[];
  excludedSites: string[];
  fileTypes: string[];
}

/**
 * Reads the operators Google users put in q itself: `"exact phrase"`, `-word`, `-"phrase"`,
 * `a OR b` (uppercase only, as in Google), `site:` / `-site:` and `filetype:`.
 */
export function parseTerms(text: string): ParsedTerms {
  const parsed: ParsedTerms = { clauses: [], excluded: [], sites: [], excludedSites: [], fileTypes: [] };
  let joinNext = false;
  for (const match of text.matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const negated = match[1] === "-";
    const raw = match[2] ?? match[3] ?? "";
    const isPhrase = match[2] !== undefined;
    if (!isPhrase && raw === "OR" && parsed.clauses.length > 0) {
      joinNext = true;
      continue;
    }
    const operator = isPhrase ? undefined : /^(-?)(site|filetype):(.+)$/i.exec(raw);
    if (operator?.[2] && operator[3]) {
      const value = operator[3];
      if (operator[2].toLowerCase() === "filetype") parsed.fileTypes.push(value.toLowerCase().replace(/^\./, ""));
      else (operator[1] === "-" ? parsed.excludedSites : parsed.sites).push(normaliseSite(value));
      joinNext = false;
      continue;
    }
    const minus = !isPhrase && raw.startsWith("-") && raw.length > 1;
    const term = (minus ? raw.slice(1) : raw).toLowerCase().trim();
    // Punctuation on its own (`-`, `"`, `&`) is not a search term, as on Google.
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    if (negated || minus) {
      parsed.excluded.push(term);
      joinNext = false;
      continue;
    }
    const last = parsed.clauses.at(-1);
    if (joinNext && last !== undefined) last.push(term);
    else parsed.clauses.push([term]);
    joinNext = false;
  }
  return parsed;
}

function words(text: string | undefined): string[] {
  return (text ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");
}

/** A document in `pt` matches a request for `pt-br`, and one in `pt-br` matches `pt-br` or `pt`. */
function sameLanguage(docLanguage: string, wanted: string): boolean {
  const doc = docLanguage.toLowerCase();
  const primary = (code: string) => code.split("-")[0];
  return doc === wanted || primary(doc) === wanted || doc === primary(wanted);
}

export class CorpusBackend implements SearchBackend {
  readonly name = "corpus";
  readonly features = FEATURES;

  constructor(
    private readonly documents: readonly CorpusDocument[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  static fromFile(path: string): CorpusBackend {
    return new CorpusBackend(corpusSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  }

  static fromJson(json: unknown, now?: () => Date): CorpusBackend {
    return new CorpusBackend(corpusSchema.parse(json), now);
  }

  search(query: SearchQuery, signal: AbortSignal): Promise<BackendResult> {
    signal.throwIfAborted();
    let matches = this.documents.filter((doc) => this.matches(doc, query));
    if (query.sortByDate) {
      matches = [...matches].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    }
    const page = matches.slice(query.offset, query.offset + query.count);
    return Promise.resolve({
      hits: page.map((doc) => this.toHit(doc, query)),
      totalEstimate: matches.length,
      hasMore: matches.length > query.offset + query.count,
    });
  }

  private matches(doc: CorpusDocument, query: SearchQuery): boolean {
    const isImage = doc.image !== undefined;
    if ((query.searchType === "image") !== isImage) return false;

    const url = new URL(doc.url);
    const haystack = `${doc.title} ${doc.snippet} ${doc.url}`.toLowerCase();
    const terms = parseTerms(`${query.terms} ${query.hq ?? ""}`);
    const orWords = words(query.orTerms);
    // A query of only exclusions or punctuation (`-foo`, `"`) asks for nothing, so it matches nothing.
    const asksForSomething =
      terms.clauses.length > 0 || terms.sites.length > 0 || terms.fileTypes.length > 0 || Boolean(query.exactTerms) || orWords.length > 0;
    if (!asksForSomething) return false;
    if (!terms.clauses.every((alternatives) => alternatives.some((t) => haystack.includes(t)))) return false;
    if (terms.excluded.some((t) => haystack.includes(t))) return false;
    if (!terms.fileTypes.every((ext) => url.pathname.toLowerCase().endsWith(`.${ext}`))) return false;
    if (query.exactTerms && !haystack.includes(query.exactTerms.toLowerCase())) return false;
    if (query.excludeTerms && haystack.includes(query.excludeTerms.toLowerCase())) return false;
    if (orWords.length > 0 && !orWords.some((w) => haystack.includes(w))) return false;

    const pageUrl = doc.image ? new URL(doc.image.contextUrl) : url;
    if (!withinSites(pageUrl.href, query)) return false;
    if (!terms.sites.every((s) => siteMatches(pageUrl, s))) return false;
    if (terms.excludedSites.some((s) => siteMatches(pageUrl, s))) return false;

    if (query.fileType && !url.pathname.toLowerCase().endsWith(`.${query.fileType}`)) return false;
    if (query.language && doc.language !== undefined && !sameLanguage(doc.language, query.language)) return false;
    if (query.country && doc.country !== undefined && doc.country.toLowerCase() !== query.country) return false;
    if (query.safe && doc.adult) return false;
    if (query.dateRestrict) {
      if (doc.publishedAt === undefined) return false;
      const ageMs = this.now().getTime() - Date.parse(doc.publishedAt);
      if (ageMs > query.dateRestrict.amount * UNIT_DAYS[query.dateRestrict.unit] * DAY_MS) return false;
    }
    return true;
  }

  private toHit(doc: CorpusDocument, query: SearchQuery): BackendHit {
    const hit: BackendHit = { url: doc.url, title: doc.title, snippet: doc.snippet };
    if (doc.mime !== undefined) hit.mime = doc.mime;
    if (doc.publishedAt !== undefined) hit.publishedAt = doc.publishedAt;
    if (doc.thumbnail !== undefined) hit.thumbnail = stripUndefined(doc.thumbnail);
    if (query.searchType === "image" && doc.image !== undefined) {
      hit.contextUrl = doc.image.contextUrl;
      hit.image = stripUndefined({ width: doc.image.width, height: doc.image.height, byteSize: doc.image.byteSize, mime: doc.mime });
    }
    return hit;
  }
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
