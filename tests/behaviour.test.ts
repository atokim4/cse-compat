import { describe, expect, it } from "vitest";
import { DailyQuota, KeyChecker } from "../src/auth.js";
import type { SearchBackend, SearchQuery } from "../src/backends/types.js";
import { BackendUnavailableError } from "../src/backends/types.js";
import { IGNORED_HEADER, BACKEND_HEADER } from "../src/app.js";
import { get, testApp } from "./helpers.js";

const INVALID = "Request contains an invalid argument.";

describe("parameter validation", () => {
  const app = testApp();

  it.each([
    ["num=11", "num above 10"],
    ["num=0", "num below 1"],
    ["num=abc", "num not a number"],
    ["start=92&num=10", "page past result 100"],
    ["start=101&num=1", "start past 100"],
    ["safe=bogus", "unknown safe value"],
    ["siteSearchFilter=x&siteSearch=a.example", "unknown siteSearchFilter"],
    ["imgSize=gigantic&searchType=image", "unknown imgSize"],
    ["lr=lang_xx", "unknown language"],
  ])("%s (%s) → Google's generic 400", async (query) => {
    const { status, body } = await get(app, `/customsearch/v1?cx=e&q=retries&${query}`);
    expect(status).toBe(400);
    expect(body.error.message).toBe(INVALID);
  });

  it("missing cx → 400", async () => {
    const { status } = await get(app, "/customsearch/v1?q=retries");
    expect(status).toBe(400);
  });

  it("missing q (and no other terms) → 400; exactTerms alone is enough", async () => {
    expect((await get(app, "/customsearch/v1?cx=e")).status).toBe(400);
    expect((await get(app, "/customsearch/v1?cx=e&exactTerms=dead%20letter")).status).toBe(200);
  });

  it("enum values are case-insensitive (Google's discovery doc says imgSize=HUGE, its docs say huge)", async () => {
    const { status } = await get(app, "/customsearch/v1?cx=e&q=diagram&searchType=image&imgSize=HUGE&safe=ACTIVE");
    expect(status).toBe(200);
  });

  it("start=0 is treated as the first page", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=e&q=retries&start=0");
    expect(body.queries.request[0].startIndex).toBe(1);
  });

  it("a repeated parameter uses its first value", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=e&q=retries&num=2&num=9");
    expect(body.queries.request[0].count).toBe(2);
  });
});

describe("paging metadata", () => {
  const app = testApp();

  it("nextPage points at start+num while more results exist", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=e&q=larkqueue&num=5");
    expect(body.queries.nextPage[0]).toMatchObject({ startIndex: 6, count: 5 });
    expect(body.queries).not.toHaveProperty("previousPage");
  });

  it("the last page has no nextPage", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=e&q=larkqueue&num=10&start=21");
    expect(body.queries).not.toHaveProperty("nextPage");
    expect(body.queries.previousPage[0]).toMatchObject({ startIndex: 11, count: 10 });
  });

  it("nextPage never asks for results past 100", async () => {
    const many: SearchBackend = {
      name: "many",
      features: new Set(),
      search: (q: SearchQuery) =>
        Promise.resolve({
          hits: Array.from({ length: q.count }, (_, i) => ({ url: `https://r.example/${q.offset + i}`, title: "t", snippet: "s" })),
          totalEstimate: 5_000_000,
          hasMore: true,
        }),
    };
    const big = testApp({ backends: new Map([["many", many]]), defaultBackend: "many" });
    const { body } = await get(big, "/customsearch/v1?cx=e&q=x&num=10&start=85");
    expect(body.queries.nextPage[0]).toMatchObject({ startIndex: 95, count: 6 });
    expect(body.searchInformation).toMatchObject({ totalResults: "5000000", formattedTotalResults: "5,000,000" });

    const last = await get(big, "/customsearch/v1?cx=e&q=x&num=10&start=91");
    expect(last.body.queries).not.toHaveProperty("nextPage");
  });
});

describe("parameters a backend cannot honour", () => {
  it("are listed in the X-CSE-Compat-Ignored header and do not fail the request", async () => {
    const { status, res } = await get(testApp(), "/customsearch/v1?cx=e&q=retries&lowRange=1&highRange=5&c2coff=1&rights=cc_publicdomain&foo=bar");
    expect(status).toBe(200);
    expect(res.headers.get(IGNORED_HEADER)).toBe("c2coff, highRange, lowRange, rights, foo");
    expect(res.headers.get(BACKEND_HEADER)).toBe("corpus");
  });

  it("an untranslatable value counts as ignored too", async () => {
    const { res } = await get(testApp(), "/customsearch/v1?cx=e&q=retries&cr=(countryUS|countryCA)&dateRestrict=yesterday&sort=title");
    expect(res.headers.get(IGNORED_HEADER)).toBe("cr, dateRestrict, sort");
  });

  it("defaults and deprecated parameters are not reported", async () => {
    const { res } = await get(testApp(), "/customsearch/v1?cx=e&q=retries&safe=off&c2coff=0&filter=1&googlehost=google.de&relatedSite=a.example");
    expect(res.headers.get(IGNORED_HEADER)).toBeNull();
  });

  it("are rejected with a specific message in strict mode", async () => {
    const { status, body } = await get(testApp({ strict: true }), "/customsearch/v1?cx=e&q=retries&lowRange=1&highRange=5");
    expect(status).toBe(400);
    expect(body.error.message).toBe("Parameters not supported by the 'corpus' backend: highRange, lowRange");
  });

  it("searchType=image on a backend without image search is a clear 400, never web results", async () => {
    const webOnly: SearchBackend = { name: "web-only", features: new Set(), search: () => Promise.reject(new Error("unreachable")) };
    const app = testApp({ backends: new Map([["web-only", webOnly]]), defaultBackend: "web-only" });
    const { status, body } = await get(app, "/customsearch/v1?cx=e&q=x&searchType=image");
    expect(status).toBe(400);
    expect(body.error.message).toBe("searchType=image is not supported by the 'web-only' backend.");
  });
});

describe("filters the corpus backend applies", () => {
  const app = testApp();
  const links = async (query: string) => ((await get(app, `/customsearch/v1?cx=e&${query}`)).body.items ?? []).map((i: { link: string }) => i.link) as string[];

  it("siteSearch include / exclude", async () => {
    expect((await links("q=retries&siteSearch=forum.larkqueue.example")).every((l) => l.includes("forum."))).toBe(true);
    expect((await links("q=retries&siteSearch=https://forum.larkqueue.example/&siteSearchFilter=e")).some((l) => l.includes("forum."))).toBe(false);
  });

  it("exactTerms, excludeTerms, orTerms, hq", async () => {
    expect(await links("q=jobs&exactTerms=skip%20locked")).toEqual([
      "https://docs.larkqueue.example/guide/postgres",
      "https://blog.larkqueue.example/2026/postgres-queue-benchmark",
    ]);
    const withoutBackoff = await links("q=retries&excludeTerms=backoff");
    expect(withoutBackoff).not.toContain("https://docs.larkqueue.example/guide/retries");
    expect(withoutBackoff).toContain("https://docs.larkqueue.example/ru/guide/retries");
    expect(await links("q=larkqueue&orTerms=cron%20priority&num=10")).toContain("https://docs.larkqueue.example/guide/scheduling");
    expect(await links("q=queue&hq=meetup")).toEqual(["https://news.uz-tech.example/larkqueue-meetup"]);
  });

  it("dateRestrict and sort=date", async () => {
    const recent = await links("q=larkqueue&dateRestrict=w1");
    expect(recent).toEqual(["https://news.uz-tech.example/larkqueue-meetup"]);
    const sorted = await links("q=larkqueue&sort=date&num=3");
    expect(sorted[0]).toBe("https://news.uz-tech.example/larkqueue-meetup");
  });

  it("lr and safe", async () => {
    expect(await links("q=larkqueue&lr=lang_ru")).toEqual(["https://docs.larkqueue.example/ru/guide/retries"]);
    expect(await links("q=retries&safe=active")).not.toContain("https://casino-ads.example/queue");
    expect(await links("q=bonuses")).toContain("https://casino-ads.example/queue");
  });

  it("filter=1 (default) drops duplicate links; filter=0 keeps them", async () => {
    const dup: SearchBackend = {
      name: "dup",
      features: new Set(),
      search: () =>
        Promise.resolve({
          hits: [
            { url: "https://a.example/page", title: "a", snippet: "" },
            { url: "https://a.example/page#top", title: "a", snippet: "" },
          ],
          hasMore: false,
        }),
    };
    const dupApp = testApp({ backends: new Map([["dup", dup]]), defaultBackend: "dup" });
    expect((await get(dupApp, "/customsearch/v1?cx=e&q=a")).body.items).toHaveLength(1);
    expect((await get(dupApp, "/customsearch/v1?cx=e&q=a&filter=0")).body.items).toHaveLength(2);
  });

  it("snippetLength truncates at a word boundary", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=e&q=dead+letter&snippetLength=30");
    expect(body.items[0].snippet).toBe("Jobs that exhaust their ...");
  });
});

describe("failures", () => {
  it("a backend outage is a Google-shaped 503", async () => {
    const down: SearchBackend = { name: "down", features: new Set(), search: () => Promise.reject(new BackendUnavailableError("connect ECONNREFUSED")) };
    const logged: unknown[] = [];
    const app = testApp({ backends: new Map([["down", down]]), defaultBackend: "down", logError: (e) => logged.push(e) });
    const { status, body } = await get(app, "/customsearch/v1?cx=e&q=x");
    expect(status).toBe(503);
    expect(body.error).toMatchObject({ code: 503, status: "UNAVAILABLE", errors: [{ reason: "backendError", domain: "global" }] });
    expect(logged).toHaveLength(1);
  });

  it("a slow backend times out into a 503", async () => {
    const slow: SearchBackend = {
      name: "slow",
      features: new Set(),
      search: (_q, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    };
    const app = testApp({ backends: new Map([["slow", slow]]), defaultBackend: "slow", backendTimeoutMs: 100 });
    const { status } = await get(app, "/customsearch/v1?cx=e&q=x");
    expect(status).toBe(503);
  });

  it("an unexpected backend bug is a 500 that does not leak the message", async () => {
    const buggy: SearchBackend = { name: "buggy", features: new Set(), search: () => Promise.reject(new TypeError("secret detail")) };
    const app = testApp({ backends: new Map([["buggy", buggy]]), defaultBackend: "buggy", logError: () => undefined });
    const { status, text } = await get(app, "/customsearch/v1?cx=e&q=x");
    expect(status).toBe(500);
    expect(text).not.toContain("secret detail");
  });

  it("unknown paths are a JSON 404", async () => {
    const { status, body } = await get(testApp(), "/customsearch/v2?q=x");
    expect(status).toBe(404);
    expect(body.error.status).toBe("NOT_FOUND");
  });

  it("daily quota → 429 RESOURCE_EXHAUSTED with Google's message, reset at Pacific midnight", async () => {
    let now = new Date("2026-11-15T07:00:00Z"); // 23:00 Pacific, Nov 14
    const app = testApp({ keys: new KeyChecker(["k"]), quota: new DailyQuota(2, () => now) });
    const q = "/customsearch/v1?cx=e&q=retries&key=k";
    expect((await get(app, q)).status).toBe(200);
    expect((await get(app, q)).status).toBe(200);
    const third = await get(app, q);
    expect(third.status).toBe(429);
    expect(third.body.error.message).toBe(
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'customsearch.googleapis.com'.",
    );
    expect(third.body.error.errors[0].reason).toBe("rateLimitExceeded");
    now = new Date("2026-11-15T08:30:00Z"); // 00:30 Pacific, Nov 15
    expect((await get(app, q)).status).toBe(200);
  });

  it("rejected requests do not use quota", async () => {
    const app = testApp({ keys: new KeyChecker(["k"]), quota: new DailyQuota(1) });
    expect((await get(app, "/customsearch/v1?cx=e&q=retries&key=k&num=99")).status).toBe(400);
    expect((await get(app, "/customsearch/v1?cx=e&q=retries&key=k")).status).toBe(200);
  });
});

describe("discovery document", () => {
  it("points rootUrl at this server and lists every cse.list parameter", async () => {
    const { body } = await get(testApp(), "/discovery/v1/apis/customsearch/v1/rest");
    expect(body.rootUrl).toBe("http://cse.test/");
    expect(body.resources.cse.methods.list.path).toBe("customsearch/v1");
    expect(body.resources.cse.resources.siterestrict.methods.list.path).toBe("customsearch/v1/siterestrict");
    // The 33 names in Google's own discovery document, revision 20261112.
    const google = [
      "c2coff", "cr", "cx", "dateRestrict", "enableAlternateSearchHandler", "exactTerms", "excludeTerms", "fileType",
      "filter", "gl", "googlehost", "highRange", "hl", "hq", "imgColorType", "imgDominantColor", "imgSize", "imgType",
      "linkSite", "lowRange", "lr", "num", "orTerms", "q", "relatedSite", "rights", "safe", "searchType", "siteSearch",
      "siteSearchFilter", "snippetLength", "sort", "start",
    ];
    expect(Object.keys(body.resources.cse.methods.list.parameters).sort()).toEqual(google);
  });

  it("is also served at the v2 discovery path", async () => {
    const { status } = await get(testApp(), "/$discovery/rest?version=v1");
    expect(status).toBe(200);
  });
});

describe("country", () => {
  it("cr restricts and wins over gl", async () => {
    const { body, res } = await get(testApp(), "/customsearch/v1?cx=e&q=meetup&cr=countryUZ&gl=us");
    expect(body.items.map((i: { link: string }) => i.link)).toEqual(["https://news.uz-tech.example/larkqueue-meetup"]);
    expect(res.headers.get(IGNORED_HEADER)).toBeNull();
  });
});
