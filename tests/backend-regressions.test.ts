/** One test per defect found in code review of the SearXNG and Brave backends. */
import { describe, expect, it } from "vitest";
import { IGNORED_HEADER } from "../src/app.js";
import { BraveBackend, braveLanguage, freshness, plainText } from "../src/backends/brave.js";
import { ResultCache } from "../src/backends/cache.js";
import { getJson } from "../src/backends/http.js";
import type { FetchFn } from "../src/backends/http.js";
import { SearxngBackend } from "../src/backends/searxng.js";
import type { SearchQuery } from "../src/backends/types.js";
import { BackendUnavailableError } from "../src/backends/types.js";
import { get, testApp } from "./helpers.js";

const hits = (from: number, to: number, host = "r.example") =>
  Array.from({ length: to - from }, (_, i) => ({ url: `https://${host}/${String(from + i)}`, title: "t", content: "c" }));

function searx(pages: unknown[], calls: URL[] = []) {
  const fetchFn: FetchFn = (input) => {
    const url = new URL(input);
    calls.push(url);
    return Promise.resolve(Response.json(pages[Number(url.searchParams.get("pageno")) - 1] ?? { results: [] }));
  };
  return new SearxngBackend({ baseUrl: "http://searx.test", fetch: fetchFn });
}

const query = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  terms: "q", includeSites: [], excludeSites: [], safe: false, sortByDate: false, searchType: "web", offset: 0, count: 10, ...over,
});

describe("SearXNG stitching", () => {
  it("a page that repeats the previous one does not end the list", async () => {
    const backend = searx([{ results: hits(0, 10) }, { results: hits(0, 10) }, { results: hits(10, 20) }]);
    const result = await backend.search(query({ offset: 10 }), AbortSignal.timeout(1000));
    expect(result.hits.map((h) => h.url)).toEqual(hits(10, 20).map((h) => h.url));
    expect(result.hasMore).toBe(true);
  });

  it("a later page that failed upstream is not cached as the end of the list", async () => {
    let failing = true;
    const calls: URL[] = [];
    const fetchFn: FetchFn = (input) => {
      const url = new URL(input);
      calls.push(url);
      const page = url.searchParams.get("pageno");
      if (page === "1") return Promise.resolve(Response.json({ results: hits(0, 10) }));
      if (failing) return Promise.resolve(Response.json({ results: [], unresponsive_engines: [["google cse", "timeout"]] }));
      return Promise.resolve(Response.json({ results: hits(10, 20) }));
    };
    const backend = new SearxngBackend({ baseUrl: "http://searx.test", fetch: fetchFn });
    const first = await backend.search(query({ offset: 10 }), AbortSignal.timeout(1000));
    expect(first.hits).toHaveLength(0);
    expect(first.hasMore).toBe(false);
    failing = false;
    const again = await backend.search(query({ offset: 10 }), AbortSignal.timeout(1000));
    expect(again.hits).toHaveLength(10);
    expect(calls.map((u) => u.searchParams.get("pageno"))).toEqual(["1", "2", "2"]);
  });

  it("drops results outside the engine's sites even when an upstream engine ignored site:", async () => {
    const backend = searx([{ results: [...hits(0, 3, "docs.allowed.example"), ...hits(3, 6, "elsewhere.example")] }]);
    const result = await backend.search(query({ includeSites: ["allowed.example"], excludeSites: ["blocked.allowed.example"] }), AbortSignal.timeout(1000));
    expect(result.hits.map((h) => new URL(h.url).hostname)).toEqual(["docs.allowed.example", "docs.allowed.example", "docs.allowed.example"]);
  });

  it("accepts a base URL copied with /search on the end", async () => {
    const calls: URL[] = [];
    const fetchFn: FetchFn = (input) => {
      calls.push(new URL(input));
      return Promise.resolve(Response.json({ results: hits(0, 10) }));
    };
    await new SearxngBackend({ baseUrl: "http://searx.test/search/", fetch: fetchFn }).search(query(), AbortSignal.timeout(1000));
    expect(calls[0]?.pathname).toBe("/search");
  });
});

describe("Brave site restriction", () => {
  it("drops results Brave returned outside siteSearch", async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve(Response.json({ query: { original: "a" }, web: { results: [...hits(0, 2, "a.example"), ...hits(2, 4, "b.example")].map((h) => ({ ...h, description: "d" })) } }));
    const app = testApp({ backends: new Map([["brave", new BraveBackend({ apiKey: "k", fetch: fetchFn })]]), defaultBackend: "brave" });
    const { body } = await get(app, "/customsearch/v1?cx=x&q=a&siteSearch=a.example");
    expect((body.items as { link: string }[]).map((i) => i.link)).toEqual(["https://a.example/0", "https://a.example/1"]);
  });
});

describe("shared loads", () => {
  it("a waiting caller survives the first caller's timeout", async () => {
    const cache = new ResultCache<string>(60_000, 10);
    const first = new AbortController();
    let runs = 0;
    const load = (signal: AbortSignal) => () =>
      new Promise<string>((resolve, reject) => {
        runs += 1;
        const timer = setTimeout(() => {
          resolve("page");
        }, 30);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        });
      });
    const second = AbortSignal.timeout(1000);
    const a = cache.shared("k", load(first.signal), first.signal);
    const b = cache.shared("k", load(second), second);
    first.abort(new DOMException("gone", "TimeoutError"));
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe("rejected");
    expect(rb).toEqual({ status: "fulfilled", value: "page" });
    expect(runs).toBe(2);
  });
});

describe("Brave freshness and text", () => {
  it("one month before 31 March is 28 February, and 29 in a leap year", () => {
    expect(freshness({ unit: "m", amount: 1 }, new Date("2026-03-31T10:00:00Z"))).toBe("2026-02-28to2026-03-31");
    expect(freshness({ unit: "m", amount: 1 }, new Date("2028-03-31T10:00:00Z"))).toBe("2028-02-29to2028-03-31");
    expect(freshness({ unit: "y", amount: 2 }, new Date("2028-02-29T10:00:00Z"))).toBe("2026-02-28to2028-02-29");
  });

  it("a range reaching before the web is no restriction, listed as ignored", async () => {
    expect(freshness({ unit: "y", amount: 3000 }, new Date("2026-11-15T00:00:00Z"))).toBeUndefined();
    expect(freshness({ unit: "d", amount: 99_999 }, new Date("2026-11-15T00:00:00Z"))).toBeUndefined();
    const sent: URL[] = [];
    const fetchFn: FetchFn = (input) => {
      sent.push(new URL(input));
      return Promise.resolve(Response.json({ query: { original: "a" }, web: { results: [] } }));
    };
    const brave = new BraveBackend({ apiKey: "k", fetch: fetchFn });
    const app = testApp({ backends: new Map([["brave", brave]]), defaultBackend: "brave" });
    const { res } = await get(app, "/customsearch/v1?cx=x&q=a&dateRestrict=y3000");
    expect(sent[0]?.searchParams.has("freshness")).toBe(false);
    expect(res.headers.get(IGNORED_HEADER)).toBe("dateRestrict");
  });

  it("keeps literal < and > and never produces a lone surrogate", () => {
    expect(plainText("a < b > c")).toBe("a < b > c");
    expect(plainText("x <strong>y</strong>")).toBe("x y");
    expect(plainText("&#xD800;&#55296;&#0;")).toBe("&#xD800;&#55296;&#0;");
    expect(plainText("&#128512;")).toBe("😀");
  });
});

describe("language codes", () => {
  it("hl keeps its region, so Brave gets pt-br and zh-hans", async () => {
    expect(braveLanguage("pt-br")).toBe("pt-br");
    expect(braveLanguage("de-at")).toBe("de");
    const sent: URL[] = [];
    const fetchFn: FetchFn = (input) => {
      sent.push(new URL(input));
      return Promise.resolve(Response.json({ query: { original: "a" }, web: { results: [] } }));
    };
    const app = testApp({ backends: new Map([["brave", new BraveBackend({ apiKey: "k", fetch: fetchFn })]]), defaultBackend: "brave" });
    await get(app, "/customsearch/v1?cx=x&q=a&hl=pt-BR");
    await get(app, "/customsearch/v1?cx=x&q=a&hl=zh_CN");
    expect(sent.map((u) => u.searchParams.get("search_lang"))).toEqual(["pt-br", "zh-hans"]);
  });

  it("Google's legacy iw reaches SearXNG as he", async () => {
    const calls: URL[] = [];
    const app = testApp({ backends: new Map([["searxng", searx([{ results: hits(0, 3) }], calls)]]), defaultBackend: "searxng" });
    await get(app, "/customsearch/v1?cx=x&q=a&lr=lang_iw");
    expect(calls[0]?.searchParams.get("language")).toBe("he");
  });
});

describe("upstream body limit", () => {
  const big = (chunks: number, chunk: Uint8Array) => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > chunks) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return { response: new Response(body), pulled: () => pulled };
  };

  it("stops reading a chunked body without content-length once it passes 5 MB", async () => {
    const { response, pulled } = big(50, new Uint8Array(1024 * 1024).fill(0x20));
    const fetchFn: FetchFn = () => Promise.resolve(response);
    await expect(getJson("X", new URL("http://x.test"), {}, AbortSignal.timeout(1000), fetchFn)).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(pulled()).toBeLessThanOrEqual(7);
  });

  it("counts bytes, not UTF-16 characters", async () => {
    // 2M three-byte characters: 6 MB of UTF-8 in 2M JavaScript characters.
    const json = `"${"中".repeat(2_000_000)}"`;
    const fetchFn: FetchFn = () => Promise.resolve(new Response(json));
    await expect(getJson("X", new URL("http://x.test"), {}, AbortSignal.timeout(5000), fetchFn)).rejects.toThrow(/more than/);
  });
});
