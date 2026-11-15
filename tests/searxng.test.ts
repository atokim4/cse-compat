/**
 * SearXNG backend against responses recorded on 2026-11-15 from a local SearXNG (git 2d500cb6, default
 * engines, search.formats [html, json], limiter off), GET /search?format=json. images.json keeps its
 * first 40 results. Titles and snippets are third-party text, kept as returned.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROXIMATED_HEADER, IGNORED_HEADER } from "../src/app.js";
import type { FetchFn } from "../src/backends/http.js";
import { SearxngBackend, escapeSearxSyntax, imageMime, parseFileSize, parseResolution, timeRange } from "../src/backends/searxng.js";
import type { SearchQuery } from "../src/backends/types.js";
import { get, readJson, testApp } from "./helpers.js";

const fixture = (name: string) => readJson(`./fixtures/searxng/${name}.json`);

interface Call {
  url: URL;
  init: RequestInit;
}

/** A fake SearXNG: answers each call from `pages` by pageno (1-based), records every call. */
function fakeSearx(pages: unknown[], calls: Call[] = []): FetchFn {
  return (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const page = pages[Number(url.searchParams.get("pageno") ?? "1") - 1] ?? { results: [] };
    return Promise.resolve(page instanceof Response ? page : Response.json(page));
  };
}

function backend(pages: unknown[], calls: Call[] = [], cacheTtlMs?: number) {
  return new SearxngBackend({ baseUrl: "http://searx.test/", fetch: fakeSearx(pages, calls), ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }) });
}

function app(searx: SearxngBackend) {
  return testApp({ backends: new Map([["searxng", searx]]), defaultBackend: "searxng" });
}

const baseQuery: SearchQuery = { terms: "hono web framework", includeSites: [], excludeSites: [], safe: false, sortByDate: false, searchType: "web", offset: 0, count: 10 };

describe("SearXNG request", () => {
  it("sends format=json, general category, safesearch=0 and the operator query", async () => {
    const calls: Call[] = [];
    const { status } = await get(app(backend([fixture("web-p1")], calls)), "/customsearch/v1?cx=x&q=hono&exactTerms=web+standards&excludeTerms=deno&siteSearch=hono.dev");
    expect(status).toBe(200);
    const params = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe("/search");
    expect(params?.get("format")).toBe("json");
    expect(params?.get("categories")).toBe("general");
    expect(params?.get("safesearch")).toBe("0");
    expect(params?.get("pageno")).toBe("1");
    expect(params?.get("q")).toBe('hono "web standards" -deno site:hono.dev');
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("maps safe=active, lr, and dateRestrict d1/w1/m1/y1 exactly", async () => {
    const calls: Call[] = [];
    const { res } = await get(app(backend([fixture("month")], calls)), "/customsearch/v1?cx=x&q=node&safe=active&lr=lang_zh-CN&dateRestrict=m1");
    const params = calls[0]?.url.searchParams;
    expect(params?.get("safesearch")).toBe("2");
    expect(params?.get("language")).toBe("zh-CN");
    expect(params?.get("time_range")).toBe("month");
    expect(res.headers.get(APPROXIMATED_HEADER)).toBeNull();
    expect(res.headers.get(IGNORED_HEADER)).toBeNull();
  });

  it("widens other dateRestrict values to the next SearXNG range and says so; drops ranges over a year", async () => {
    expect(timeRange({ unit: "d", amount: 3 })).toEqual({ range: "week", exact: false });
    expect(timeRange({ unit: "w", amount: 2 })).toEqual({ range: "month", exact: false });
    expect(timeRange({ unit: "m", amount: 6 })).toEqual({ range: "year", exact: false });
    expect(timeRange({ unit: "y", amount: 2 })).toEqual({ exact: false });

    const calls: Call[] = [];
    const searx = backend([fixture("month")], calls);
    const widened = await get(app(searx), "/customsearch/v1?cx=x&q=node&dateRestrict=d3");
    expect(calls[0]?.url.searchParams.get("time_range")).toBe("week");
    expect(widened.res.headers.get(APPROXIMATED_HEADER)).toBe("dateRestrict");

    const dropped = await get(app(searx), "/customsearch/v1?cx=x&q=node+lts&dateRestrict=y5");
    expect(calls[1]?.url.searchParams.has("time_range")).toBe(false);
    expect(dropped.res.headers.get(IGNORED_HEADER)).toBe("dateRestrict");
    expect(dropped.res.headers.get(APPROXIMATED_HEADER)).toBeNull();
  });

  it("rejects an unsupported dateRestrict in strict mode, but not an approximated one", async () => {
    const strict = testApp({ backends: new Map([["searxng", backend([fixture("month")])]]), defaultBackend: "searxng", strict: true });
    expect((await get(strict, "/customsearch/v1?cx=x&q=node&dateRestrict=y5")).status).toBe(400);
    expect((await get(strict, "/customsearch/v1?cx=x&q=node&dateRestrict=d3")).status).toBe(200);
  });

  it("reports gl/cr and sort=date as ignored: SearXNG has no country filter or date sort", async () => {
    const { res } = await get(app(backend([fixture("web-p1")])), "/customsearch/v1?cx=x&q=hono&gl=de&sort=date");
    expect(res.headers.get(IGNORED_HEADER)).toBe("gl, sort");
  });
});

describe("SearXNG query syntax escaping", () => {
  const esc = (q: string) => escapeSearxSyntax(q).text;

  it("quotes !bang, !!bang, :lang and <timeout tokens so SearXNG searches them as text", () => {
    expect(esc("hono !!g")).toBe('hono "!!g"');
    expect(esc("hono !ddg")).toBe('hono "!ddg"');
    expect(esc("i <3 hono")).toBe('i "<3" hono');
    expect(esc("ruby :de")).toBe('ruby ":de"');
    expect(esc("css !important")).toBe('css "!important"');
  });

  it("leaves ordinary operators and phrases alone", () => {
    expect(escapeSearxSyntax('-site:a.example "exact phrase" (a OR b) -!x')).toEqual({ text: '-site:a.example "exact phrase" (a OR b) -!x', phraseLoosened: false });
  });

  // Review findings: SearXNG ignores quotes when it looks for syntax, and stray quotes must not shift the state.
  it("splits a phrase holding a special token into quoted words, and says so", () => {
    expect(escapeSearxSyntax('"say !wp now" tail')).toEqual({ text: '"say" "!wp" "now" tail', phraseLoosened: true });
  });

  it("stray and unmatched quotes do not hide the next token", () => {
    expect(esc('!a" !b')).toBe('"!a"" "!b"');
    // Every whitespace-separated token SearXNG will see is safe.
    for (const q of ['!a" !b', '5" screen !ddg', '"open phrase !ddg', '"x !y" "!z w"', 'a "" !b']) {
      expect(esc(q).split(/\s+/).filter((t) => /^[!:<]/.test(t))).toEqual([]);
    }
    expect(esc('5" screen !ddg')).toBe('5" screen "!ddg"');
    expect(esc('"open phrase !ddg')).toBe('"open phrase "!ddg"');
  });

  it("an exactTerms phrase with a special token is listed as approximated", async () => {
    const calls: Call[] = [];
    const { res } = await get(app(backend([fixture("web-p1")], calls)), "/customsearch/v1?cx=x&q=a&exactTerms=foo+!ddg+bar");
    expect(calls[0]?.url.searchParams.get("q")).toBe('a "foo" "!ddg" "bar"');
    expect(res.headers.get(APPROXIMATED_HEADER)).toBe("exactTerms");
  });

  it("escapes what the client put in q and in hq", async () => {
    const calls: Call[] = [];
    await get(app(backend([fixture("web-p1")], calls)), "/customsearch/v1?cx=x&q=hono+!!g&hq=%3Cfast");
    expect(calls[0]?.url.searchParams.get("q")).toBe('hono "!!g" "<fast"');
  });
});

describe("SearXNG response mapping", () => {
  it("turns recorded web results into Google items", async () => {
    const { status, body } = await get(app(backend([fixture("web-p1")])), "/customsearch/v1?cx=x&q=hono+web+framework");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(10);
    expect(body.items[0]).toMatchObject({
      kind: "customsearch#result",
      title: "Hono - Web framework built on Web Standards",
      link: "https://hono.dev/",
      displayLink: "hono.dev",
      formattedUrl: "https://hono.dev",
    });
    expect(body.items[0].htmlTitle).toBe("<b>Hono</b> - <b>Web</b> <b>framework</b> built on <b>Web</b> Standards");
    expect(body.items[0].pagemap.cse_thumbnail[0].src).toMatch(/^https:\/\/encrypted-tbn0\.gstatic\.com\//);
    expect(body.queries.nextPage[0].startIndex).toBe(11);
  });

  it("an empty answer has no items and no nextPage", async () => {
    const { body } = await get(app(backend([fixture("empty")])), "/customsearch/v1?cx=x&q=zxqvbnmplkjhgf");
    expect(body.items).toBeUndefined();
    expect(body.queries.nextPage).toBeUndefined();
    expect(body.searchInformation.totalResults).toBe("0");
  });

  it("maps image results: link = image, contextLink = page, size from resolution", async () => {
    const { status, body } = await get(app(backend([fixture("images")])), "/customsearch/v1?cx=x&q=hono+logo&searchType=image&num=3");
    expect(status).toBe(200);
    expect(body.items[0]).toMatchObject({
      link: "https://hono.dev/images/hono-title.png",
      mime: "image/png",
      image: { contextLink: "https://hono.dev/", width: 1400, height: 375 },
    });
    expect(body.items[0].image.thumbnailLink).toMatch(/^https:\/\/encrypted-tbn0\.gstatic\.com\//);
    // Wikimedia Commons reports a file size; it becomes byteSize.
    expect(body.items[1].image).toMatchObject({ width: 410, height: 229, byteSize: 170476 });
  });

  it("parses the formats engines really send", () => {
    expect(parseResolution("1400x375")).toEqual({ width: 1400, height: 375 });
    expect(parseResolution("410 x 229")).toEqual({ width: 410, height: 229 });
    expect(parseResolution("")).toEqual({});
    expect(parseResolution(null)).toEqual({});
    expect(imageMime("PNG")).toBe("image/png");
    expect(imageMime("image/png")).toBe("image/png");
    expect(imageMime("svg+xml")).toBe("image/svg+xml");
    expect(imageMime("JPG")).toBe("image/jpeg");
    expect(imageMime("tiff-ish")).toBeUndefined();
    expect(parseFileSize("166.48 KB")).toBe(170476);
    expect(parseFileSize("1.27 KB")).toBe(1300);
    expect(parseFileSize("big")).toBeUndefined();
    expect(parseFileSize(2048)).toBe(2048);
  });

  it("every recorded image result with an img_src maps to a valid item", async () => {
    const recorded = (fixture("images") as { results: { img_src?: string }[] }).results;
    const { body } = await get(app(backend([fixture("images")])), "/customsearch/v1?cx=x&q=hono+logo&searchType=image&num=10&filter=0");
    expect(recorded.filter((r) => r.img_src).length).toBeGreaterThanOrEqual(10);
    for (const item of body.items as { link: string; image: { contextLink: string } }[]) {
      expect(() => new URL(item.link)).not.toThrow();
      expect(() => new URL(item.image.contextLink)).not.toThrow();
    }
  });

  it("uses SearXNG corrections as spelling and the old number_of_results field when present", async () => {
    const page = { ...(fixture("typo") as object), corrections: ["javascript framework"], number_of_results: 1_250_000 };
    const { body } = await get(app(backend([page])), "/customsearch/v1?cx=x&q=javascrpit+framwork");
    expect(body.spelling).toEqual({ correctedQuery: "javascript framework", htmlCorrectedQuery: "javascript framework" });
    expect(body.searchInformation.totalResults).toBe("1250000");
  });
});

describe("SearXNG paging", () => {
  it("stitches overlapping pages into one de-duplicated list", async () => {
    const p1 = fixture("web-p1") as { results: { url: string }[] };
    const p2 = fixture("web-p2") as { results: { url: string }[] };
    const overlap = p2.results.filter((r) => p1.results.some((a) => a.url === r.url)).length;
    expect(overlap).toBe(2); // measured: pages 1 and 2 share 2 of 20 URLs

    const calls: Call[] = [];
    const searx = backend([p1, p2], calls);
    const { body } = await get(app(searx), "/customsearch/v1?cx=x&q=hono+web+framework&start=21&num=10");
    expect(calls.map((c) => c.url.searchParams.get("pageno"))).toEqual(["1", "2"]);
    const expected = [...new Set([...p1.results, ...p2.results].map((r) => r.url))].slice(20, 30);
    expect((body.items as { link: string }[]).map((i) => i.link)).toEqual(expected);
  });

  it("a client walking start=1,11,...,91 costs one upstream page per new page needed, not one per request", async () => {
    const pageOf = (n: number) => ({ results: Array.from({ length: 20 }, (_, i) => ({ url: `https://p${String(n)}.example/${String(i)}`, title: `r${String(i)}`, content: "x" })) });
    const calls: Call[] = [];
    const searx = backend([1, 2, 3, 4, 5].map(pageOf), calls);
    const a = app(searx);
    const seen: string[] = [];
    for (let start = 1; start <= 91; start += 10) {
      const { status, body } = await get(a, `/customsearch/v1?cx=x&q=walk&start=${String(start)}`);
      expect(status).toBe(200);
      seen.push(...(body.items as { link: string }[]).map((i) => i.link));
    }
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(calls).toHaveLength(5);
  });

  it("without the cache the same walk refetches from page 1 each time", async () => {
    const pageOf = (n: number) => ({ results: Array.from({ length: 20 }, (_, i) => ({ url: `https://p${String(n)}.example/${String(i)}`, title: "t", content: "x" })) });
    const calls: Call[] = [];
    const a = app(backend([1, 2, 3, 4, 5].map(pageOf), calls, 0));
    for (let start = 1; start <= 91; start += 10) await get(a, `/customsearch/v1?cx=x&q=walk&start=${String(start)}`);
    expect(calls).toHaveLength(30); // 1+1+2+2+3+3+4+4+5+5
  });

  it("stops after two pages in a row add nothing new, then says there is no next page", async () => {
    const page = { results: [{ url: "https://a.example/1", title: "a", content: "" }, { url: "https://a.example/2", title: "b", content: "" }] };
    const calls: Call[] = [];
    const { body } = await get(app(backend([page, page, page, page], calls)), "/customsearch/v1?cx=x&q=a");
    expect(calls).toHaveLength(3);
    expect(body.items).toHaveLength(2);
    expect(body.queries.nextPage).toBeUndefined();
  });

  it("does not cache an empty first page while engines were failing", async () => {
    const calls: Call[] = [];
    const searx = backend([fixture("empty")], calls);
    await get(app(searx), "/customsearch/v1?cx=x&q=zxq");
    await get(app(searx), "/customsearch/v1?cx=x&q=zxq");
    expect(calls).toHaveLength(2);
  });

  it("concurrent requests for the same page share one upstream fetch", async () => {
    const calls: Call[] = [];
    const searx = backend([fixture("web-p1")], calls);
    const a = app(searx);
    const results = await Promise.all([1, 2, 3].map(() => get(a, "/customsearch/v1?cx=x&q=hono")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toHaveLength(1);
  });

  it("asks at most 10 pages, whatever the window", async () => {
    const pageOf = (n: number) => ({ results: [{ url: `https://tiny.example/${String(n)}`, title: "t", content: "" }] });
    const calls: Call[] = [];
    const { body } = await get(app(backend(Array.from({ length: 20 }, (_, i) => pageOf(i)), calls)), "/customsearch/v1?cx=x&q=tiny&start=11");
    expect(calls).toHaveLength(10);
    expect(body.items).toBeUndefined();
  });

  it("works with the real SearchBackend contract outside HTTP", async () => {
    const result = await backend([fixture("web-p1")]).search(baseQuery, AbortSignal.timeout(1000));
    expect(result.hits).toHaveLength(10);
    expect(result.hasMore).toBe(true);
  });
});

describe("SearXNG failures", () => {
  it("a 403 (json not enabled) is a Google 503 and the log says what to fix", async () => {
    const logged: unknown[] = [];
    const html = new Response(readFileSync(new URL("./fixtures/searxng/forbidden-403.html", import.meta.url), "utf8"), { status: 403, headers: { "content-type": "text/html" } });
    const a = testApp({ backends: new Map([["searxng", backend([html])]]), defaultBackend: "searxng", logError: (e) => logged.push(e) });
    const { status, body } = await get(a, "/customsearch/v1?cx=x&q=hono");
    expect(status).toBe(503);
    expect(body.error.errors[0].reason).toBe("backendError");
    expect(String(logged[0])).toContain("add json to search.formats");
  });

  it("a 400 from SearXNG (recorded body) is a 503, not passed through", async () => {
    const bad = Response.json(fixture("error-400"), { status: 400 });
    const { status, text } = await get(app(backend([bad])), "/customsearch/v1?cx=x&q=hono");
    expect(status).toBe(503);
    expect(text).not.toContain("time_range");
  });

  it("a redirect is not followed", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "https://www.google.com/search?q=hono" } });
    const logged: unknown[] = [];
    const a = testApp({ backends: new Map([["searxng", backend([redirect])]]), defaultBackend: "searxng", logError: (e) => logged.push(e) });
    expect((await get(a, "/customsearch/v1?cx=x&q=hono")).status).toBe(503);
    expect(String(logged[0])).toContain("redirected");
  });

  it("non-JSON and a missing results array are 503s", async () => {
    expect((await get(app(backend([new Response("<html>")])), "/customsearch/v1?cx=x&q=a")).status).toBe(503);
    expect((await get(app(backend([{ answers: [] }])), "/customsearch/v1?cx=x&q=a")).status).toBe(503);
  });

  it("a hung instance times out into a 503", async () => {
    const hang: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const searx = new SearxngBackend({ baseUrl: "http://searx.test", fetch: hang });
    const a = testApp({ backends: new Map([["searxng", searx]]), defaultBackend: "searxng", backendTimeoutMs: 100 });
    expect((await get(a, "/customsearch/v1?cx=x&q=a")).status).toBe(503);
  });
});
