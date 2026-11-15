/** One test per defect found in code review of the protocol layer. */
import { describe, expect, it } from "vitest";
import { DailyQuota, KeyChecker } from "../src/auth.js";
import { CorpusBackend, parseTerms } from "../src/backends/corpus.js";
import type { SearchBackend } from "../src/backends/types.js";
import { applyFieldMask, parseFieldMask } from "../src/cse/fields.js";
import { normaliseSite } from "../src/cse/query.js";
import { bold, highlightTerms, truncate } from "../src/cse/response.js";
import { IGNORED_HEADER } from "../src/app.js";
import { get, sampleEngines, testApp } from "./helpers.js";

const links = (body: { items?: { link: string }[] }) => (body.items ?? []).map((i) => i.link);

const tiny = (urls: string[]) =>
  CorpusBackend.fromJson(urls.map((url) => ({ url, title: "page", snippet: "text" })));

describe("review fixes", () => {
  it("siteSearch narrows an engine's site list instead of widening it", async () => {
    const app = testApp({ engines: sampleEngines() });
    const { body } = await get(app, "/customsearch/v1?cx=docs-only&q=retries&siteSearch=forum.larkqueue.example");
    expect(body).not.toHaveProperty("items");
    const inside = await get(app, "/customsearch/v1?cx=docs-only&q=retries&siteSearch=docs.larkqueue.example/ru");
    expect(links(inside.body)).toEqual(["https://docs.larkqueue.example/ru/guide/retries"]);
  });

  it("overlapping nested field masks keep every branch", () => {
    const doc = { items: [{ title: "t", pagemap: { cse_image: [1], cse_thumbnail: [2], metatags: [3] } }] };
    const expected = { items: [{ pagemap: { cse_image: [1], cse_thumbnail: [2] } }] };
    expect(applyFieldMask(doc, parseFieldMask("items(pagemap(cse_image)),items(pagemap(cse_thumbnail))"))).toEqual(expected);
    expect(applyFieldMask(doc, parseFieldMask("items/pagemap/cse_image,items(pagemap(cse_thumbnail))"))).toEqual(expected);
    expect(applyFieldMask(doc, parseFieldMask("items(title),items"))).toEqual(doc);
  });

  it("site paths keep their case and ports are matched", async () => {
    expect(normaliseSite("HTTPS://*.D.Example/Guides/*")).toBe("d.example/Guides");
    const backend = tiny(["https://d.example/Guides/x", "https://d.example:8443/y", "https://d.example/guides/z"]);
    const app = testApp({ backends: new Map([["corpus", backend]]) });
    expect(links((await get(app, "/customsearch/v1?cx=e&q=page&siteSearch=d.example/Guides")).body)).toEqual(["https://d.example/Guides/x"]);
    expect(links((await get(app, "/customsearch/v1?cx=e&q=page&siteSearch=d.example:8443")).body)).toEqual(["https://d.example:8443/y"]);
  });

  it("dotted and symbol terms are bolded whole", () => {
    expect(bold("Using node.js with C++ and v2.0", highlightTerms("node.js c++ v2.0"))).toBe(
      "Using <b>node.js</b> with <b>C++</b> and <b>v2.0</b>",
    );
    expect(bold("C is not C++", highlightTerms("c++"))).toBe("C is not <b>C++</b>");
  });

  it("snippetLength never splits a character and never exceeds the limit", () => {
    const cut = truncate("aaaaaaaaa😀bbbbbbbbbbbb", 12);
    expect(cut).toBe("aaaaaaaa ...");
    expect(truncate("👩‍💻👩‍💻👩‍💻👩‍💻", 3)).toBe("👩‍💻👩‍💻👩‍💻");
    expect(truncate("short", 10)).toBe("short");
  });

  it("q operators work in the corpus backend", async () => {
    const app = testApp();
    expect(links((await get(app, '/customsearch/v1?cx=e&q="dead letter"')).body)).toEqual(["https://docs.larkqueue.example/guide/dead-letter"]);
    const minus = links((await get(app, "/customsearch/v1?cx=e&q=retries -backoff&num=10")).body);
    expect(minus).not.toContain("https://docs.larkqueue.example/guide/retries");
    expect(minus.length).toBeGreaterThan(0);
    expect(links((await get(app, "/customsearch/v1?cx=e&q=retries site:forum.larkqueue.example")).body)).toEqual([
      "https://forum.larkqueue.example/t/retries-not-firing/412",
    ]);
    expect(links((await get(app, "/customsearch/v1?cx=e&q=meetup OR benchmarking")).body)).toHaveLength(2);
    expect(parseTerms("a or b").clauses).toEqual([["a"], ["or"], ["b"]]);
  });

  it("an empty key= falls back to the X-Goog-Api-Key header", async () => {
    const app = testApp({ keys: new KeyChecker(["k1"]) });
    expect((await get(app, "/customsearch/v1?cx=e&q=retries&key=", { headers: { "X-Goog-Api-Key": "k1" } })).status).toBe(200);
  });

  it("a failed backend call does not use quota", async () => {
    let fail = true;
    const flaky: SearchBackend = {
      name: "flaky",
      features: new Set(),
      search: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve({ hits: [], hasMore: false })),
    };
    const app = testApp({ backends: new Map([["flaky", flaky]]), defaultBackend: "flaky", quota: new DailyQuota(1), logError: () => undefined });
    expect((await get(app, "/customsearch/v1?cx=e&q=x")).status).toBe(500);
    fail = false;
    expect((await get(app, "/customsearch/v1?cx=e&q=x")).status).toBe(200);
    expect((await get(app, "/customsearch/v1?cx=e&q=x")).status).toBe(429);
  });

  it("empty parameter values count as not sent", async () => {
    const { status, res, body } = await get(testApp({ strict: true }), "/customsearch/v1?cx=e&q=retries&dateRestrict=&sort=&cr=&fileType=&siteSearch=&num=");
    expect(status).toBe(200);
    expect(res.headers.get(IGNORED_HEADER)).toBeNull();
    expect(body.queries.request[0]).not.toHaveProperty("sort");
    expect(body.queries.request[0].count).toBe(10);
  });

  it("dedupe keeps URLs that differ only after the query string", async () => {
    const app = testApp({ backends: new Map([["corpus", tiny(["https://d.example/a?x=1", "https://d.example/a?x=1/", "https://d.example/b/", "https://d.example/b"])]]) });
    expect(links((await get(app, "/customsearch/v1?cx=e&q=page")).body)).toEqual(["https://d.example/a?x=1", "https://d.example/a?x=1/", "https://d.example/b/"]);
  });

  it("credentials in a result URL are never echoed", async () => {
    const app = testApp({ backends: new Map([["corpus", tiny(["https://user:pw@d.example/"])]]) });
    const { text, body } = await get(app, "/customsearch/v1?cx=e&q=page");
    expect(body.items[0].link).toBe("https://d.example/");
    expect(text).not.toContain("pw@");
  });
});

describe("pre-publish review", () => {
  it("unknown parameter names in the ignored header are percent-encoded, so any name is a valid header", async () => {
    const { status, res } = await get(testApp(), "/customsearch/v1?cx=e&q=queue&%E4%B8%AD=1&%7F=1&a%0D%0Ab=1&ok_name=1");
    expect(status).toBe(200);
    const header = res.headers.get(IGNORED_HEADER) ?? "";
    expect(header).toMatch(/^[\x21-\x7e ,]+$/);
    expect(header.split(", ")).toEqual(["a%0D%0Ab", "ok_name", "%7F", "%E4%B8%AD"]);
  });

  it("a deeply nested fields mask is Google's 400, not a stack overflow", async () => {
    const deep = `${"a(".repeat(5000)}b${")".repeat(5000)}`;
    const { status, body } = await get(testApp(), `/customsearch/v1?cx=e&q=queue&fields=${deep}`);
    expect(status).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect((await get(testApp(), `/customsearch/v1?cx=e&q=queue&fields=${"a(".repeat(32)}b${")".repeat(32)}`)).status).toBe(200);
  });

  it("a long flat fields mask parses in linear time", async () => {
    const mask = Array.from({ length: 20_000 }, (_, i) => `f${String(i)}`).join(",");
    const started = performance.now();
    expect((await get(testApp(), `/customsearch/v1?cx=e&q=queue&fields=${mask}`)).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("a q of only operators or punctuation matches nothing; a lone OR is the word 'or'", () => {
    for (const q of ["OR", "%22", "-", "-queue", "%26"]) {
      expect(parseTerms(decodeURIComponent(q)).clauses.flat().filter((t) => t !== "or")).toEqual([]);
    }
    expect(parseTerms("OR").clauses).toEqual([["or"]]);
    expect(parseTerms("a OR b").clauses).toEqual([["a", "b"]]);
  });

  it.each(["%22", "-", "-queue", "%26"])("q=%s returns no items from the corpus", async (q) => {
    const { status, body } = await get(testApp(), `/customsearch/v1?cx=e&q=${q}`);
    expect(status).toBe(200);
    expect(body.items).toBeUndefined();
    expect(body.searchInformation.totalResults).toBe("0");
  });

  it("parallel searches on a slow backend cannot exceed the daily quota", async () => {
    const slow: SearchBackend = {
      name: "slow",
      features: new Set(),
      search: () => new Promise((resolve) => setTimeout(() => { resolve({ hits: [], hasMore: false }); }, 20)),
    };
    const app = testApp({ backends: new Map([["slow", slow]]), defaultBackend: "slow", quota: new DailyQuota(3) });
    const statuses = await Promise.all(Array.from({ length: 8 }, () => get(app, "/customsearch/v1?cx=e&q=x").then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it("a refund after Pacific midnight does not hand out an extra query for the new day", () => {
    let now = new Date("2026-11-16T07:59:00Z"); // 23:59 in Los Angeles
    const quota = new DailyQuota(1, () => now);
    const reservation = quota.reserve("k");
    now = new Date("2026-11-16T08:01:00Z");
    quota.reserve("k");
    reservation.refund();
    expect(() => quota.reserve("k")).toThrow();
  });
});
