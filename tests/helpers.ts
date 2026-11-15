import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import type { AppDeps } from "../src/app.js";
import { DailyQuota, KeyChecker } from "../src/auth.js";
import { CorpusBackend } from "../src/backends/corpus.js";
import { openRegistry, registryFromJson } from "../src/engines.js";

export const BASE = "http://cse.test";

/** Fixed clock for dateRestrict: the sample corpus is dated relative to 2026-11-15. */
export const NOW = new Date("2026-11-15T12:00:00Z");

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
}

export const corpus = () => CorpusBackend.fromJson(readJson("../examples/sample-corpus.json"), () => NOW);

export function testApp(overrides: Partial<AppDeps> & { keys?: KeyChecker; engines?: AppDeps["engines"] } = {}) {
  return createApp({
    engines: openRegistry("cse-compat"),
    backends: new Map([["corpus", corpus()]]),
    defaultBackend: "corpus",
    keys: new KeyChecker([]),
    quota: new DailyQuota(0),
    strict: false,
    backendTimeoutMs: 2_000,
    publicBaseUrl: BASE,
    ...overrides,
  });
}

export const sampleEngines = () => registryFromJson(readJson("../examples/engines.sample.json"), "cse-compat", ["corpus"]);

export async function get(app: ReturnType<typeof testApp>, pathAndQuery: string, init?: RequestInit) {
  const res = await app.request(`${BASE}${pathAndQuery}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  // Tests assert on the parsed body, so it is handed over untyped.
  return { res, status: res.status, body: body as any, text };
}
