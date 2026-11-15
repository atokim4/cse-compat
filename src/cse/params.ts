import { z } from "zod";
import { errors } from "./errors.js";

/**
 * The cse.list method parameters, in the order of Google's discovery document (revision 20261112).
 *
 * One table drives three things: request validation, the `queries.request[0]` echo in the response
 * (`queryField` is the name the Query object uses) and the discovery document this server publishes.
 */
interface ParamSpec {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  /** Allowed values, lowercase. Google matches enum values case-insensitively (its own discovery enum is uppercase for imgSize). */
  readonly values?: readonly string[];
  /** Field name in the response Query object, when it differs from the parameter name or is echoed at all. */
  readonly queryField?: string | null;
}

const LANGUAGES = [
  "ar", "bg", "ca", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "id", "is", "it", "iw",
  "ja", "ko", "lt", "lv", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "tr", "zh-cn", "zh-tw",
] as const;

export const PARAMS = {
  q: { type: "string", description: "Query", queryField: "searchTerms" },
  cx: { type: "string", description: "The Programmable Search Engine ID to use for this request." },
  num: { type: "integer", description: "Number of search results to return (1-10).", queryField: "count" },
  start: { type: "integer", description: "The index of the first result to return (1-based).", queryField: "startIndex" },
  c2coff: { type: "string", description: "Simplified/Traditional Chinese search: 0 enabled (default), 1 disabled.", values: ["0", "1"], queryField: "disableCnTwTranslation" },
  cr: { type: "string", description: "Restricts results to documents originating in a country (countryXX)." },
  dateRestrict: { type: "string", description: "Restricts results by age: d[n], w[n], m[n] or y[n]." },
  exactTerms: { type: "string", description: "A phrase that all documents in the results must contain." },
  excludeTerms: { type: "string", description: "A word or phrase that must not appear in any result." },
  fileType: { type: "string", description: "Restricts results to files of a specified extension." },
  filter: { type: "string", description: "Duplicate content filter: 0 off, 1 on (default).", values: ["0", "1"] },
  gl: { type: "string", description: "Two-letter country code of the end user; boosts results from that country." },
  googlehost: { type: "string", description: "Deprecated. Use gl.", queryField: "googleHost" },
  highRange: { type: "string", description: "End of an inclusive search range lowRange...highRange." },
  hl: { type: "string", description: "Interface language." },
  hq: { type: "string", description: "Appends terms to the query, as if combined with AND." },
  imgColorType: { type: "string", description: "Image colour type.", values: ["color", "gray", "mono", "trans"] },
  imgDominantColor: { type: "string", description: "Image dominant colour.", values: ["black", "blue", "brown", "gray", "green", "orange", "pink", "purple", "red", "teal", "white", "yellow"] },
  imgSize: { type: "string", description: "Image size.", values: ["huge", "icon", "large", "medium", "small", "xlarge", "xxlarge"] },
  imgType: { type: "string", description: "Image type.", values: ["clipart", "face", "lineart", "stock", "photo", "animated"] },
  linkSite: { type: "string", description: "All results must contain a link to this URL." },
  lowRange: { type: "string", description: "Start of an inclusive search range lowRange...highRange." },
  lr: { type: "string", description: "Restricts results to a language (lang_xx).", values: LANGUAGES.map((l) => `lang_${l}`), queryField: "language" },
  orTerms: { type: "string", description: "Each result must contain at least one of these terms." },
  relatedSite: { type: "string", description: "Deprecated." },
  rights: { type: "string", description: "Licence filter: cc_publicdomain, cc_attribute, cc_sharealike, cc_noncommercial, cc_nonderived." },
  safe: { type: "string", description: "SafeSearch: active or off (default).", values: ["active", "off", "high", "medium"] },
  searchType: { type: "string", description: "Set to image for image search.", values: ["image"] },
  siteSearch: { type: "string", description: "A site to always include or exclude (see siteSearchFilter)." },
  siteSearchFilter: { type: "string", description: "e to exclude, i to include the siteSearch site.", values: ["e", "i"] },
  sort: { type: "string", description: "Sort expression, e.g. date." },
  snippetLength: { type: "integer", description: "Maximum snippet length in characters.", queryField: null },
  enableAlternateSearchHandler: { type: "boolean", description: "Routes to an alternate search handler (accepted and ignored).", queryField: null },
} as const satisfies Record<string, ParamSpec>;

export type ParamName = keyof typeof PARAMS;
export const PARAM_NAMES = Object.keys(PARAMS) as ParamName[];

/** Standard Google API query parameters accepted on every method. */
export const SYSTEM_PARAMS = [
  "key", "alt", "fields", "prettyPrint", "quotaUser", "callback", "$.xgafv",
  "access_token", "oauth_token", "upload_protocol", "uploadType",
] as const;

const optionalString = z.string().optional();
const intString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\s*\d+\s*$/)
    .transform((s) => Number.parseInt(s, 10))
    .pipe(z.number().int().min(min).max(max));
const enumString = (values: readonly string[]) =>
  z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => values.includes(s))
    .optional();

// Only parameters that Google's discovery document declares with an `enum` reject unknown values.
// lr, c2coff and filter list their values in the description alone, so they are free strings there:
// an unknown value is accepted and ignored (camel's SearchToolkit sends `lr=en` on every call).
const methodSchema = z.object({
  q: optionalString,
  cx: optionalString,
  num: intString(1, 10).default(10),
  // uint32 in discovery. 0 is treated as 1 (both mean "first page" to clients that compute offsets).
  start: intString(0, 100).default(1).transform((n) => Math.max(1, n)),
  c2coff: optionalString,
  cr: optionalString,
  dateRestrict: optionalString,
  exactTerms: optionalString,
  excludeTerms: optionalString,
  fileType: optionalString,
  filter: optionalString,
  gl: optionalString,
  googlehost: optionalString,
  highRange: optionalString,
  hl: optionalString,
  hq: optionalString,
  imgColorType: enumString(PARAMS.imgColorType.values),
  imgDominantColor: enumString(PARAMS.imgDominantColor.values),
  imgSize: enumString(PARAMS.imgSize.values),
  imgType: enumString(PARAMS.imgType.values),
  linkSite: optionalString,
  lowRange: optionalString,
  lr: optionalString,
  orTerms: optionalString,
  relatedSite: optionalString,
  rights: optionalString,
  safe: enumString(PARAMS.safe.values),
  searchType: enumString(PARAMS.searchType.values),
  siteSearch: optionalString,
  siteSearchFilter: enumString(PARAMS.siteSearchFilter.values),
  sort: optionalString,
  snippetLength: intString(1, 100_000).optional(),
  enableAlternateSearchHandler: z.enum(["true", "false"]).optional(),
});

export type MethodParams = z.output<typeof methodSchema>;

export interface SystemParams {
  key?: string;
  fields?: string;
  prettyPrint: boolean;
  callback?: string;
}

export interface ParsedRequest {
  params: MethodParams;
  /** Every method parameter the caller actually sent, normalised (for the Query echo). */
  sent: Partial<Record<ParamName, string>>;
  system: SystemParams;
  /** Query parameters that are neither method nor system parameters. They are ignored and reported. */
  unknown: string[];
}

const SYSTEM_SET = new Set<string>(SYSTEM_PARAMS);
const METHOD_SET = new Set<string>(PARAM_NAMES);

/** The first value of each parameter; later repeats are dropped. */
function firstValues(search: URLSearchParams): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of search) {
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Step 1 of 2. Google validates system parameters before it looks at the API key, so `alt=xml`
 * fails with 400 even on a keyless request. The key check sits between the two steps.
 */
export function parseSystemParams(search: URLSearchParams): SystemParams {
  const values = firstValues(search);
  const alt = values.get("alt");
  if (alt !== undefined && alt !== "json") throw errors.invalidSystemParam("alt", alt);

  const pretty = values.get("prettyPrint");
  if (pretty !== undefined && pretty !== "true" && pretty !== "false") {
    throw errors.invalidSystemParam("prettyPrint", pretty);
  }

  const xgafv = values.get("$.xgafv");
  if (xgafv !== undefined && xgafv !== "1" && xgafv !== "2") throw errors.invalidSystemParam("$.xgafv", xgafv);

  const callback = values.get("callback");
  if (callback !== undefined && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
    throw errors.invalidSystemParam("callback", callback);
  }

  const system: SystemParams = { prettyPrint: pretty !== "false" };
  const key = values.get("key");
  const fields = values.get("fields");
  if (key !== undefined) system.key = key;
  if (fields !== undefined) system.fields = fields;
  if (callback !== undefined) system.callback = callback;
  return system;
}

/** Step 2 of 2: the cse.list parameters. Any invalid value is Google's generic 400. */
export function parseMethodParams(search: URLSearchParams, system: SystemParams): ParsedRequest {
  const raw: Record<string, string> = {};
  const unknown: string[] = [];
  for (const [name, value] of firstValues(search)) {
    // An empty value is the same as not sending the parameter (`&sort=&cr=` from form-built URLs).
    if (METHOD_SET.has(name)) {
      if (value.trim() !== "") raw[name] = value;
    } else if (!SYSTEM_SET.has(name)) unknown.push(name);
  }

  const result = methodSchema.safeParse(raw);
  if (!result.success) throw errors.invalidArgument();
  const params = result.data;

  // Results never go past index 100: start=91&num=10 is the last full page.
  if (params.start + params.num - 1 > 100) throw errors.invalidArgument();

  const sent: ParsedRequest["sent"] = {};
  for (const name of PARAM_NAMES) {
    const value = params[name];
    if (raw[name] !== undefined && value !== undefined) sent[name] = String(value);
  }
  return { params, sent, system, unknown: unknown.sort() };
}
