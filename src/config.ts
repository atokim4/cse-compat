import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((s) => (s ?? "").split(",").map((v) => v.trim()).filter((v) => v !== ""));

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().default("127.0.0.1"),
  /** Public base URL used in the OpenSearch template and the discovery document, without a trailing slash. */
  PUBLIC_BASE_URL: z
    .url()
    .optional()
    .transform((u) => u?.replace(/\/+$/, "")),
  /** Comma-separated API keys. Empty means no key is required. */
  CSE_API_KEYS: csv,
  /** Queries per key per day (resets at midnight America/Los_Angeles, like Google). 0 = unlimited. */
  CSE_DAILY_QUOTA: z.coerce.number().int().min(0).default(0),
  /** JSON file mapping cx -> engine. Without it every cx is accepted. */
  CSE_ENGINES_FILE: z.string().optional(),
  CSE_ENGINE_TITLE: z.string().min(1).default("cse-compat"),
  /** Reject requests whose parameters the backend cannot honour, instead of ignoring them. */
  CSE_STRICT: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true"),
  CSE_BACKEND: z.enum(["corpus", "searxng", "brave"]).default("corpus"),
  CSE_CORPUS_FILE: z.string().optional(),
  /** SearXNG base URL, e.g. http://searxng:8080. Its settings.yml must list json in search.formats. */
  SEARXNG_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** How long a stitched SearXNG result list is reused for the next pages of the same query. */
  SEARXNG_CACHE_TTL_MS: z.coerce.number().int().min(0).default(600_000),
  /** Brave Search API key (X-Subscription-Token). */
  BRAVE_API_KEY: z.string().min(1).optional(),
  BRAVE_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** 0 = no caching. Turn on only if your Brave plan allows storing results. */
  BRAVE_CACHE_TTL_MS: z.coerce.number().int().min(0).default(0),
  BACKEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8_000),
});

export type Config = z.output<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty line in .env (FOO=) means "not set", as in the file's own comments.
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
