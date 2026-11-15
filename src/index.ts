import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DailyQuota, KeyChecker } from "./auth.js";
import { BraveBackend } from "./backends/brave.js";
import { CorpusBackend } from "./backends/corpus.js";
import { SearxngBackend } from "./backends/searxng.js";
import type { SearchBackend } from "./backends/types.js";
import { loadConfig } from "./config.js";
import { openRegistry, registryFromFile } from "./engines.js";

function main(): void {
  const config = loadConfig();

  const backends = new Map<string, SearchBackend>();
  if (config.CSE_CORPUS_FILE !== undefined) backends.set("corpus", CorpusBackend.fromFile(config.CSE_CORPUS_FILE));
  if (config.SEARXNG_URL !== undefined) {
    backends.set("searxng", new SearxngBackend({ baseUrl: config.SEARXNG_URL, cacheTtlMs: config.SEARXNG_CACHE_TTL_MS }));
  }
  if (config.BRAVE_API_KEY !== undefined) {
    backends.set(
      "brave",
      new BraveBackend({
        apiKey: config.BRAVE_API_KEY,
        cacheTtlMs: config.BRAVE_CACHE_TTL_MS,
        ...(config.BRAVE_BASE_URL === undefined ? {} : { baseUrl: config.BRAVE_BASE_URL }),
      }),
    );
  }
  if (!backends.has(config.CSE_BACKEND)) {
    const needs = { corpus: "CSE_CORPUS_FILE", searxng: "SEARXNG_URL", brave: "BRAVE_API_KEY" }[config.CSE_BACKEND];
    throw new Error(`Invalid configuration: backend '${config.CSE_BACKEND}' is not configured (it needs ${needs})`);
  }

  const engines =
    config.CSE_ENGINES_FILE === undefined
      ? openRegistry(config.CSE_ENGINE_TITLE)
      : registryFromFile(config.CSE_ENGINES_FILE, config.CSE_ENGINE_TITLE, [...backends.keys()]);

  const app = createApp({
    engines,
    backends,
    defaultBackend: config.CSE_BACKEND,
    keys: new KeyChecker(config.CSE_API_KEYS),
    quota: new DailyQuota(config.CSE_DAILY_QUOTA),
    strict: config.CSE_STRICT,
    backendTimeoutMs: config.BACKEND_TIMEOUT_MS,
    ...(config.PUBLIC_BASE_URL === undefined ? {} : { publicBaseUrl: config.PUBLIC_BASE_URL }),
    logError: (error) => {
      console.error(error);
    },
  });

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    console.log(`cse-compat listening on http://${info.address}:${info.port} (backends: ${[...backends.keys()].join(", ")}; default ${config.CSE_BACKEND})`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
