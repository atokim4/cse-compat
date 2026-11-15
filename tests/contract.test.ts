/**
 * Contract tests: the exact request shapes real Custom Search clients send, and the response fields
 * they read. Each block names the client and the source it was copied from.
 */
import { describe, expect, it } from "vitest";
import { KeyChecker } from "../src/auth.js";
import { BASE, get, readJson, sampleEngines, testApp } from "./helpers.js";

const KEY = "test-key-1";

describe("error bodies match the live Google service byte for byte (captured 2026-11-15)", () => {
  const app = testApp({ keys: new KeyChecker([KEY]) });

  it("no key → 403 PERMISSION_DENIED", async () => {
    const { status, body } = await get(app, "/customsearch/v1?q=test&cx=abc");
    expect(status).toBe(403);
    expect(body).toEqual(readJson("./fixtures/google/no-key-403.json"));
  });

  it("unknown key → 400 API_KEY_INVALID", async () => {
    const { status, body } = await get(app, "/customsearch/v1?q=test&cx=abc&key=AIzaSyINVALIDKEY0000000000000000000000");
    expect(status).toBe(400);
    expect(body).toEqual(readJson("./fixtures/google/bad-key-400.json"));
  });

  it("alt=xml → 400 before the key is even checked", async () => {
    const { status, body } = await get(app, "/customsearch/v1?q=x&alt=xml");
    expect(status).toBe(400);
    expect(body).toEqual(readJson("./fixtures/google/alt-xml-400.json"));
  });

  it("the key may also come in the X-Goog-Api-Key header", async () => {
    const { status } = await get(app, "/customsearch/v1?q=retries&cx=abc", { headers: { "X-Goog-Api-Key": KEY } });
    expect(status).toBe(200);
  });

  it("Content-Type is Google's", async () => {
    const { res } = await get(app, "/customsearch/v1?q=x&cx=abc");
    expect(res.headers.get("content-type")).toBe("application/json; charset=UTF-8");
  });
});

describe("LangChain GoogleSearchAPIWrapper (langchain-google-community search.py, via googleapiclient)", () => {
  // googleapiclient sends cse.list(q=..., cx=..., num=k) as this URL, with alt=json appended.
  const app = testApp({ keys: new KeyChecker([KEY]) });

  it("run(): items[].snippet joined", async () => {
    const { status, body } = await get(app, `/customsearch/v1?q=retries+backoff&cx=my-cse-id&num=4&key=${KEY}&alt=json`);
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(4);
    for (const item of body.items) expect(typeof item.snippet).toBe("string");
  });

  it("results(): title, link, pagemap.cse_image[0].src and cse_thumbnail[0].src", async () => {
    const { body } = await get(app, `/customsearch/v1?q=benchmarking&cx=my-cse-id&num=4&key=${KEY}&alt=json`);
    const [item] = body.items;
    expect(item.title).toContain("Benchmarking");
    expect(item.link).toBe("https://blog.larkqueue.example/2026/postgres-queue-benchmark");
    expect(item.pagemap.cse_image[0].src).toBe("https://blog.larkqueue.example/img/bench-thumb.png");
    expect(item.pagemap.cse_thumbnail[0]).toEqual({ src: "https://blog.larkqueue.example/img/bench-thumb.png", width: "310", height: "163" });
  });

  it("siterestrict=True uses /customsearch/v1/siterestrict with the same contract", async () => {
    const { status, body } = await get(app, `/customsearch/v1/siterestrict?q=retries&cx=my-cse-id&num=10&key=${KEY}&alt=json`);
    expect(status).toBe(200);
    expect(body.kind).toBe("customsearch#search");
  });

  it("no results: items is absent so res.get('items', []) is empty", async () => {
    const { status, body } = await get(app, `/customsearch/v1?q=zzzzqqqq&cx=my-cse-id&num=4&key=${KEY}&alt=json`);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty("items");
    expect(body.searchInformation.totalResults).toBe("0");
  });
});

describe("LlamaIndex GoogleSearchToolSpec (llama-index-tools-google search/base.py)", () => {
  // QUERY_URL_TMPL = ".../customsearch/v1?key={key}&cx={engine}&q={query}" + "&num={num}", query via quote_plus.
  const app = testApp();

  it("reads items[].title/link/snippet", async () => {
    const q = encodeURIComponent("dead letter queue").replaceAll("%20", "+");
    const { status, body } = await get(app, `/customsearch/v1?key=anything&cx=engine&q=${q}&num=3`);
    expect(status).toBe(200);
    expect(body.items[0]).toMatchObject({
      title: "Dead letter queue - Larkqueue docs",
      link: "https://docs.larkqueue.example/guide/dead-letter",
    });
    expect(body.items[0].snippet).toMatch(/dead letter table/);
  });
});

describe("Open WebUI search_google_pse (backend/open_webui/retrieval/web/google_pse.py)", () => {
  // Pages with num=min(remaining,10) and start += 10 until it has `count` items or a page has none.
  // It also sends Content-Type: application/json on a GET.
  const app = testApp();

  async function searchGooglePse(query: string, count: number) {
    const all: { link: string }[] = [];
    let start = 1;
    let remaining = count;
    while (remaining > 0) {
      const params = new URLSearchParams({ cx: "engine", q: query, key: "k", num: String(Math.min(remaining, 10)), start: String(start) });
      const { status, body } = await get(app, `/customsearch/v1?${params.toString()}`, { headers: { "Content-Type": "application/json" } });
      expect(status).toBe(200); // raise_for_status()
      const items = (body.items ?? []) as { link: string }[];
      if (items.length === 0) break;
      all.push(...items);
      remaining -= items.length;
      start += 10;
    }
    return all;
  }

  it("collects every page without duplicates and stops on an empty page", async () => {
    const results = await searchGooglePse("larkqueue", 25);
    const links = results.map((r) => r.link);
    expect(links.length).toBeGreaterThan(10);
    expect(new Set(links).size).toBe(links.length);
  });

  it("count=100 reaches start=91&num=10, the last page Google serves", async () => {
    const { status } = await get(app, "/customsearch/v1?cx=engine&q=larkqueue&key=k&num=10&start=91");
    expect(status).toBe(200);
  });
});

describe("n8n HTTP Request node / plain fetch shapes", () => {
  const app = testApp();

  it("fields mask trims the response like Google's partial response", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=engine&q=retries&fields=items(title,link),searchInformation/totalResults");
    expect(Object.keys(body).sort()).toEqual(["items", "searchInformation"]);
    expect(Object.keys(body.searchInformation)).toEqual(["totalResults"]);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["link", "title"]);
  });

  it("prettyPrint=false returns compact JSON", async () => {
    const { text } = await get(app, "/customsearch/v1?cx=engine&q=retries&prettyPrint=false");
    expect(text).not.toContain("\n");
  });

  it("callback= returns JSONP", async () => {
    const { res, text } = await get(app, "/customsearch/v1?cx=engine&q=retries&callback=handle");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=UTF-8");
    expect(text.startsWith("// API callback\nhandle({")).toBe(true);
  });
});

describe("Search resource shape", () => {
  const app = testApp();

  it("has every top-level field with Google's types", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=engine&q=retries&num=2&start=3&lr=lang_en&safe=active&gl=us");
    expect(body.kind).toBe("customsearch#search");
    expect(body.url).toEqual({ type: "application/json", template: expect.stringContaining(`${BASE}/customsearch/v1?q={searchTerms}`) as string });
    expect(typeof body.searchInformation.searchTime).toBe("number");
    expect(typeof body.searchInformation.formattedSearchTime).toBe("string");
    expect(body.searchInformation.totalResults).toMatch(/^\d+$/);
    expect(body.context).toEqual({ title: "cse-compat" });

    const [request] = body.queries.request;
    expect(request).toMatchObject({
      searchTerms: "retries",
      count: 2,
      startIndex: 3,
      language: "lang_en",
      safe: "active",
      gl: "us",
      cx: "engine",
      inputEncoding: "utf8",
      outputEncoding: "utf8",
    });
    expect(typeof request.totalResults).toBe("string");
    expect(body.queries.previousPage[0]).toMatchObject({ startIndex: 1, count: 2 });
  });

  it("items have Google's result fields, with query words bolded and HTML escaped", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=engine&q=dead+letter");
    const [item] = body.items;
    expect(item).toMatchObject({
      kind: "customsearch#result",
      displayLink: "docs.larkqueue.example",
      formattedUrl: "https://docs.larkqueue.example/guide/dead-letter",
    });
    expect(item.htmlTitle).toBe("<b>Dead</b> <b>letter</b> queue - Larkqueue docs");
    expect(item.htmlFormattedUrl).toBe("https://docs.larkqueue.example/guide/<b>dead</b>-<b>letter</b>");
  });

  it("image search returns image{} and mime", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=engine&q=diagram&searchType=image");
    const [item] = body.items;
    expect(item.mime).toBe("image/png");
    expect(item.link).toMatch(/\.png$/);
    expect(item.image).toMatchObject({ width: expect.any(Number) as number, height: expect.any(Number) as number, thumbnailLink: expect.stringContaining("/thumb/") as string });
    expect(item.image.contextLink).toMatch(/\/guide\//);
    expect(item.displayLink).toBe("docs.larkqueue.example");
  });

  it("PDF results carry mime and fileFormat", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=engine&q=reference&fileType=pdf");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ mime: "application/pdf", fileFormat: "PDF/Adobe Acrobat" });
  });
});

describe("engines (cx) work like Programmable Search Engine site lists", () => {
  const app = testApp({ engines: sampleEngines() });

  it("an unknown cx is Google's generic 400", async () => {
    const { status, body } = await get(app, "/customsearch/v1?cx=nope&q=retries");
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" });
    expect(body.error.errors[0]).toEqual({ message: "Request contains an invalid argument.", domain: "global", reason: "badRequest" });
  });

  it("a site-list engine only returns its sites", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=docs-only&q=retries");
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.displayLink).toBe("docs.larkqueue.example");
    expect(body.context.title).toBe("Larkqueue docs");
  });

  it("an exclude-list engine drops those sites", async () => {
    const { body } = await get(app, "/customsearch/v1?cx=no-mirrors&q=retries");
    for (const item of body.items as { displayLink: string }[]) expect(item.displayLink).not.toContain("mirror-site");
  });
});
