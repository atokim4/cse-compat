/**
 * Brave backend against a local HTTP server that plays api.search.brave.com. No Brave key was available,
 * so the upstream bodies are handwritten from the response types in Brave's own MCP server
 * (brave/brave-search-mcp-server, src/tools/web/types.ts and src/tools/images/types.ts, 2026-11-09) and the
 * ErrorResponse body Brave support posted for an invalid token. Results are on .example domains.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPROXIMATED_HEADER, IGNORED_HEADER } from "../src/app.js";
import { BraveBackend, braveCountry, braveLanguage, freshness, planWebRequest, plainText } from "../src/backends/brave.js";
import { get, testApp } from "./helpers.js";

const KEY = "test-brave-key";
const NOW = new Date("2026-11-15T12:00:00Z");

interface Seen {
  path: string;
  params: URLSearchParams;
  token: string | undefined;
}

type Reply = { status: number; body: unknown } | ((req: Seen) => { status: number; body: unknown });

let server: Server;
let baseUrl = "";
let seen: Seen[] = [];
let reply: Reply = { status: 200, body: {} };

function webResult(i: number) {
  return {
    type: "search_result",
    subtype: "generic",
    is_live: false,
    is_source_local: false,
    is_source_both: false,
    family_friendly: true,
    language: "en",
    title: `Result ${String(i)} &amp; more`,
    url: `https://site${String(i)}.example/page`,
    description: `Snippet with <strong>hono</strong> number ${String(i)}`,
    page_age: "2026-11-06T00:00:00",
    meta_url: { scheme: "https", netloc: `site${String(i)}.example`, hostname: `site${String(i)}.example`, favicon: "", path: "› page" },
    thumbnail: { src: `https://imgs.search.brave.example/t${String(i)}.jpg`, original: `https://site${String(i)}.example/og.jpg` },
  };
}

/** A web page of Brave results: result indexes [offset*count, offset*count + count), up to `total`. */
function webPage(params: URLSearchParams, total = 200) {
  const count = Number(params.get("count") ?? "20");
  const offset = Number(params.get("offset") ?? "0");
  const first = offset * count;
  const results = Array.from({ length: Math.max(0, Math.min(count, total - first)) }, (_, i) => webResult(first + i));
  return {
    type: "search",
    query: { original: params.get("q") ?? "", more_results_available: first + count < total },
    web: { type: "search", results, family_friendly: true },
  };
}

function record(req: IncomingMessage): Seen {
  const url = new URL(req.url ?? "/", "http://brave.test");
  const token = req.headers["x-subscription-token"];
  return { path: url.pathname, params: url.searchParams, token: Array.isArray(token) ? token[0] : token };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const s = record(req);
    seen.push(s);
    const r = typeof reply === "function" ? reply(s) : reply;
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  reply = (s) => ({ status: 200, body: webPage(s.params) });
});

function brave(options: { cacheTtlMs?: number } = {}) {
  return new BraveBackend({ apiKey: KEY, baseUrl, now: () => NOW, ...options });
}

function app(backend = brave(), extra: Parameters<typeof testApp>[0] = {}) {
  return testApp({ backends: new Map([["brave", backend]]), defaultBackend: "brave", ...extra });
}

describe("Brave window planning", () => {
  it("serves Google's usual pages with page size 10", () => {
    for (let start = 1; start <= 91; start += 10) {
      expect(planWebRequest(start - 1, 10)).toEqual({ count: 10, offset: (start - 1) / 10, skip: 0 });
    }
  });

  it("finds a page size that holds an odd window", () => {
    expect(planWebRequest(60, 5)).toEqual({ count: 10, offset: 6, skip: 0 });
    expect(planWebRequest(4, 3)).toEqual({ count: 4, offset: 1, skip: 0 });
    expect(planWebRequest(15, 10)).toEqual({ count: 13, offset: 1, skip: 2 });
    expect(planWebRequest(98, 2)).toEqual({ count: 10, offset: 9, skip: 8 });
  });

  it("every one of the 955 windows Google allows fits in ONE Brave request, starting at the right result", () => {
    let windows = 0;
    for (let num = 1; num <= 10; num++) {
      for (let offset = 0; offset + num <= 100; offset++) {
        const plan = planWebRequest(offset, num);
        expect(plan.count).toBeGreaterThanOrEqual(num);
        expect(plan.count).toBeLessThanOrEqual(20);
        expect(plan.offset).toBeLessThanOrEqual(9);
        expect(plan.offset * plan.count + plan.skip).toBe(offset);
        expect(plan.skip + num).toBeLessThanOrEqual(plan.count);
        windows += 1;
      }
    }
    expect(windows).toBe(955);
  });

  it("refuses a window past Brave's reach instead of returning wrong results", () => {
    expect(() => planWebRequest(195, 10)).toThrow(RangeError);
  });
});

describe("Brave request", () => {
  it("sends the key header, plain text, web+query filter, safesearch=off and the operator query", async () => {
    const { status, body } = await get(app(), "/customsearch/v1?cx=x&q=hono&exactTerms=web+standards&siteSearch=hono.example&siteSearchFilter=e");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(10);
    const s = seen[0];
    expect(s?.path).toBe("/res/v1/web/search");
    expect(s?.token).toBe(KEY);
    expect(s?.params.get("q")).toBe('hono "web standards" -site:hono.example');
    expect(s?.params.get("text_decorations")).toBe("false");
    expect(s?.params.get("result_filter")).toBe("web,query");
    expect(s?.params.get("safesearch")).toBe("off");
    expect(s?.params.get("count")).toBe("10");
    expect(s?.params.get("offset")).toBe("0");
  });

  it("maps lr, gl, cr and safe=active onto Brave's values", async () => {
    await get(app(), "/customsearch/v1?cx=x&q=a&lr=lang_zh-TW&gl=uk&safe=active");
    expect(seen[0]?.params.get("search_lang")).toBe("zh-hant");
    expect(seen[0]?.params.get("country")).toBe("GB");
    expect(seen[0]?.params.get("safesearch")).toBe("strict");
    await get(app(), "/customsearch/v1?cx=x&q=a&lr=lang_iw&cr=countryJP");
    expect(seen[1]?.params.get("search_lang")).toBe("he");
    expect(seen[1]?.params.get("country")).toBe("JP");
  });

  it("drops a language or country Brave does not cover and lists the parameter", async () => {
    expect(braveCountry("uz")).toBeUndefined();
    expect(braveLanguage("pt")).toBeUndefined();
    const { res } = await get(app(), "/customsearch/v1?cx=x&q=a&gl=uz&lr=lang_pt");
    expect(seen[0]?.params.has("country")).toBe(false);
    expect(seen[0]?.params.has("search_lang")).toBe(false);
    expect(res.headers.get(IGNORED_HEADER)).toBe("gl, lr");
  });

  it("strict mode turns an uncovered country into a 400 before any billed request", async () => {
    const { status } = await get(app(brave(), { strict: true }), "/customsearch/v1?cx=x&q=a&gl=uz");
    expect(status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("hl is a language preference only when lr is absent, and is reported by name", async () => {
    await get(app(), "/customsearch/v1?cx=x&q=a&hl=de");
    expect(seen[0]?.params.get("search_lang")).toBe("de");
    const { res } = await get(app(), "/customsearch/v1?cx=x&q=a&hl=pt");
    expect(res.headers.get(IGNORED_HEADER)).toBe("hl");
  });

  it("maps dateRestrict to Brave freshness exactly", async () => {
    expect(freshness({ unit: "d", amount: 1 }, NOW)).toBe("pd");
    expect(freshness({ unit: "w", amount: 1 }, NOW)).toBe("pw");
    expect(freshness({ unit: "y", amount: 1 }, NOW)).toBe("py");
    // Brave's pm is 31 days, so a calendar month is sent as a range.
    expect(freshness({ unit: "m", amount: 1 }, NOW)).toBe("2026-10-15to2026-11-15");
    expect(freshness({ unit: "d", amount: 3 }, NOW)).toBe("2026-11-12to2026-11-15");
    expect(freshness({ unit: "w", amount: 2 }, NOW)).toBe("2026-11-01to2026-11-15");
    const { res } = await get(app(), "/customsearch/v1?cx=x&q=a&dateRestrict=d3");
    expect(seen[0]?.params.get("freshness")).toBe("2026-11-12to2026-11-15");
    expect(res.headers.get(APPROXIMATED_HEADER)).toBeNull();
    expect(res.headers.get(IGNORED_HEADER)).toBeNull();
  });

  it("reports sort=date and lowRange as ignored", async () => {
    const { res } = await get(app(), "/customsearch/v1?cx=x&q=a&sort=date&lowRange=1");
    expect(res.headers.get(IGNORED_HEADER)).toBe("lowRange, sort");
  });
});

describe("Brave response mapping", () => {
  it("decodes entities, strips tags and keeps the thumbnail", async () => {
    const { body } = await get(app(), "/customsearch/v1?cx=x&q=hono&num=1");
    expect(body.items[0]).toMatchObject({
      title: "Result 0 & more",
      htmlTitle: "Result 0 &amp; more",
      snippet: "Snippet with hono number 0",
      htmlSnippet: "Snippet with <b>hono</b> number 0",
      link: "https://site0.example/page",
      pagemap: { cse_thumbnail: [{ src: "https://imgs.search.brave.example/t0.jpg" }] },
    });
    expect(plainText("a &#x27;b&#39; &lt;c&gt; &bogus;")).toBe("a 'b' <c> &bogus;");
  });

  it("walking start=1..91 costs exactly 10 billed requests and returns 100 distinct results", async () => {
    const a = app();
    const links: string[] = [];
    for (let start = 1; start <= 91; start += 10) {
      const { body } = await get(a, `/customsearch/v1?cx=x&q=walk&start=${String(start)}`);
      links.push(...(body.items as { link: string }[]).map((i) => i.link));
    }
    expect(seen).toHaveLength(10);
    expect(new Set(links).size).toBe(100);
    expect(links[0]).toBe("https://site0.example/page");
    expect(links[99]).toBe("https://site99.example/page");
  });

  it("an odd window is sliced from the right page", async () => {
    const { body } = await get(app(), "/customsearch/v1?cx=x&q=a&start=99&num=2");
    expect(seen.map((s) => [s.params.get("count"), s.params.get("offset")])).toEqual([["10", "9"]]);
    expect((body.items as { link: string }[]).map((i) => i.link)).toEqual(["https://site98.example/page", "https://site99.example/page"]);
  });

  it("follows more_results_available for nextPage, and stops when Brave runs out", async () => {
    reply = (s) => ({ status: 200, body: webPage(s.params, 15) });
    const first = await get(app(), "/customsearch/v1?cx=x&q=a");
    expect(first.body.queries.nextPage[0].startIndex).toBe(11);
    const second = await get(app(), "/customsearch/v1?cx=x&q=a&start=11");
    expect(second.body.items).toHaveLength(5);
    expect(second.body.queries.nextPage).toBeUndefined();
  });

  it("a window inside a short last page returns what there is", async () => {
    reply = (s) => ({ status: 200, body: webPage(s.params, 18) });
    const { body } = await get(app(), "/customsearch/v1?cx=x&q=a&start=16&num=10");
    expect(seen.map((s) => [s.params.get("count"), s.params.get("offset")])).toEqual([["13", "1"]]);
    expect((body.items as { link: string }[]).map((i) => i.link)).toEqual([15, 16, 17].map((i) => `https://site${String(i)}.example/page`));
    expect(body.queries.nextPage).toBeUndefined();
  });

  it("uses query.altered as spelling", async () => {
    reply = (s) => ({ status: 200, body: { ...webPage(s.params), query: { original: "javascrpit", altered: "javascript", more_results_available: true } } });
    const { body } = await get(app(), "/customsearch/v1?cx=x&q=javascrpit");
    expect(body.spelling.correctedQuery).toBe("javascript");
  });

  it("an answer without web results is an empty search, not an error", async () => {
    reply = { status: 200, body: { type: "search", query: { original: "a", more_results_available: false } } };
    const { status, body } = await get(app(), "/customsearch/v1?cx=x&q=a");
    expect(status).toBe(200);
    expect(body.items).toBeUndefined();
  });

  it("image search: one request with count = window + 1, image and page links mapped", async () => {
    reply = {
      status: 200,
      body: {
        type: "images",
        query: { original: "logo" },
        results: Array.from({ length: 4 }, (_, i) => ({
          type: "image_result",
          title: `Logo ${String(i)}`,
          url: `https://gallery.example/p${String(i)}`,
          source: "gallery.example",
          thumbnail: { src: `https://imgs.search.brave.example/i${String(i)}.jpg`, width: 200, height: 100 },
          properties: { url: `https://gallery.example/img/${String(i)}.png`, width: 1200, height: 600 },
          meta_url: { scheme: "https", netloc: "gallery.example", hostname: "gallery.example", favicon: "", path: "" },
          confidence: "high",
        })),
        extra: { might_be_offensive: false },
      },
    };
    const { status, body } = await get(app(), "/customsearch/v1?cx=x&q=logo&searchType=image&num=3&dateRestrict=w1");
    expect(status).toBe(200);
    expect(seen[0]?.path).toBe("/res/v1/images/search");
    expect(seen[0]?.params.get("count")).toBe("4");
    expect(seen[0]?.params.has("offset")).toBe(false);
    expect(seen[0]?.params.has("freshness")).toBe(false);
    expect(body.items[0]).toMatchObject({
      link: "https://gallery.example/img/0.png",
      mime: "image/png",
      displayLink: "gallery.example",
      image: { contextLink: "https://gallery.example/p0", width: 1200, height: 600, thumbnailLink: "https://imgs.search.brave.example/i0.jpg", thumbnailWidth: 200, thumbnailHeight: 100 },
    });
    expect(body.queries.nextPage[0].startIndex).toBe(4);
  });
});

describe("Brave failures", () => {
  const errorBody = (code: string, status: number) => ({
    type: "ErrorResponse",
    error: { code, detail: "detail text from Brave", meta: { component: "x" }, status },
  });

  it("an invalid token (Brave's documented 422 body) is a 503 and the log names the setting", async () => {
    reply = { status: 422, body: errorBody("SUBSCRIPTION_TOKEN_INVALID", 422) };
    const logged: unknown[] = [];
    const { status, body, text } = await get(app(brave(), { logError: (e) => logged.push(e) }), "/customsearch/v1?cx=x&q=a");
    expect(status).toBe(503);
    expect(body.error.status).toBe("UNAVAILABLE");
    expect(text).not.toContain("detail text from Brave");
    expect(String(logged[0])).toContain("check BRAVE_API_KEY");
    expect(String(logged[0])).not.toContain(KEY);
  });

  it("RATE_LIMITED is a retryable 503; QUOTA_LIMITED is a 429 that is logged", async () => {
    reply = { status: 429, body: errorBody("RATE_LIMITED", 429) };
    expect((await get(app(), "/customsearch/v1?cx=x&q=a")).status).toBe(503);
    reply = { status: 429, body: errorBody("QUOTA_LIMITED", 429) };
    const logged: unknown[] = [];
    const { status, body } = await get(app(brave(), { logError: (e) => logged.push(e) }), "/customsearch/v1?cx=x&q=a");
    expect(status).toBe(429);
    expect(body.error.errors[0].reason).toBe("rateLimitExceeded");
    expect(logged).toHaveLength(1);
  });

  it("an unexpected shape is a 503", async () => {
    reply = { status: 200, body: { web: { results: "nope" } } };
    expect((await get(app(), "/customsearch/v1?cx=x&q=a")).status).toBe(503);
  });

  it("an unreachable Brave is a 503", async () => {
    const dead = new BraveBackend({ apiKey: KEY, baseUrl: "http://127.0.0.1:9" });
    expect((await get(app(dead), "/customsearch/v1?cx=x&q=a")).status).toBe(503);
  });

  it("needs a key", () => {
    expect(() => new BraveBackend({ apiKey: " " })).toThrow(/API key/);
  });
});

describe("Brave caching", () => {
  it("is off by default: the same request is billed twice", async () => {
    const a = app();
    await get(a, "/customsearch/v1?cx=x&q=a");
    await get(a, "/customsearch/v1?cx=x&q=a");
    expect(seen).toHaveLength(2);
  });

  it("when turned on, a repeated request is served from the cache", async () => {
    const a = app(brave({ cacheTtlMs: 60_000 }));
    await get(a, "/customsearch/v1?cx=x&q=a");
    await get(a, "/customsearch/v1?cx=x&q=a");
    await get(a, "/customsearch/v1?cx=x&q=b");
    expect(seen).toHaveLength(2);
  });
});
