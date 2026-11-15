import { readFileSync } from "node:fs";
import { z } from "zod";
import { normaliseSite } from "./cse/query.js";

/**
 * A search engine, addressed by its `cx` like a Programmable Search Engine. An engine can limit the
 * web to a list of sites ("Sites to search" in the PSE control panel) and pick a backend.
 */
export interface Engine {
  cx: string;
  title: string;
  includeSites: readonly string[];
  excludeSites: readonly string[];
  /** Backend name; undefined means the server default. */
  backend?: string;
}

const engineFileSchema = z.record(
  z.string().min(1),
  z.strictObject({
    title: z.string().min(1).optional(),
    sites: z.array(z.string().min(1)).default([]),
    excludeSites: z.array(z.string().min(1)).default([]),
    backend: z.string().min(1).optional(),
  }),
);

export interface EngineRegistry {
  /** Returns the engine for a cx, or undefined when the cx is unknown (Google answers 400 then). */
  resolve(cx: string): Engine | undefined;
}

/** With no engines file every cx is accepted and searches the whole web. */
export function openRegistry(defaultTitle: string): EngineRegistry {
  return { resolve: (cx) => ({ cx, title: defaultTitle, includeSites: [], excludeSites: [] }) };
}

/** Builds the registry; throws on a malformed file or an engine naming a backend that is not configured. */
export function registryFromJson(json: unknown, defaultTitle: string, knownBackends: readonly string[]): EngineRegistry {
  const parsed = engineFileSchema.parse(json);
  const engines = new Map<string, Engine>();
  for (const [cx, def] of Object.entries(parsed)) {
    if (def.backend !== undefined && !knownBackends.includes(def.backend)) {
      throw new Error(`Engine '${cx}' uses backend '${def.backend}', which is not configured`);
    }
    const engine: Engine = {
      cx,
      title: def.title ?? defaultTitle,
      includeSites: def.sites.map(normaliseSite),
      excludeSites: def.excludeSites.map(normaliseSite),
    };
    if (def.backend !== undefined) engine.backend = def.backend;
    engines.set(cx, engine);
  }
  return { resolve: (cx) => engines.get(cx) };
}

export function registryFromFile(path: string, defaultTitle: string, knownBackends: readonly string[]): EngineRegistry {
  return registryFromJson(JSON.parse(readFileSync(path, "utf8")) as unknown, defaultTitle, knownBackends);
}
