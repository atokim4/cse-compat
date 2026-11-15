/**
 * Request shapes found in the run 2 census of open-source clients (default branches, 2026-11-15), replayed
 * against the corpus backend. Each test names the client the shape comes from.
 */
import { describe, expect, it } from "vitest";
import { IGNORED_HEADER } from "../src/app.js";
import { KeyChecker } from "../src/auth.js";
import { get, testApp } from "./helpers.js";

describe("shapes seen in client code", () => {
  it("inspect_ai: key in the X-Goog-Api-Key header and a first call with start=0", async () => {
    const app = testApp({ keys: new KeyChecker(["k1"]) });
    const { status, body } = await get(app, "/customsearch/v1?cx=x&q=retries&start=0", { headers: { "X-Goog-Api-Key": "k1" } });
    expect(status).toBe(200);
    expect(body.queries.request[0].startIndex).toBe(1);
  });

  it("lobehub: a literal dateRestrict=undefined is ignored and reported, not a 400", async () => {
    const { status, res } = await get(testApp(), "/customsearch/v1?cx=x&q=retries&dateRestrict=undefined");
    expect(status).toBe(200);
    expect(res.headers.get(IGNORED_HEADER)).toBe("dateRestrict");
  });

  it("GPTDiscord: paging stops when queries.nextPage is missing, so it must be there while more results exist", async () => {
    const first = await get(testApp(), "/customsearch/v1?cx=x&q=larkqueue&num=2");
    expect(first.body.queries.nextPage[0].startIndex).toBe(3);
  });

  it("Semantic Kernel: a 0-based skip sent as start (start=0, then start=10) is served", async () => {
    for (const start of [0, 10]) expect((await get(testApp(), `/customsearch/v1?cx=x&q=larkqueue&start=${String(start)}`)).status).toBe(200);
  });

  it("camel: the lr=en it sends on every call is ignored and reported, not a 400", async () => {
    const plain = await get(testApp(), "/customsearch/v1?cx=x&q=retries&start=1&num=10");
    const camel = await get(testApp(), "/customsearch/v1?cx=x&q=retries&start=1&lr=en&num=10");
    expect(camel.status).toBe(200);
    expect(camel.res.headers.get(IGNORED_HEADER)).toBe("lr");
    expect(camel.body.items.map((i: { link: string }) => i.link)).toEqual(plain.body.items.map((i: { link: string }) => i.link));
  });

  it("MetaGPT: num above 10 is Google's 400", async () => {
    expect((await get(testApp(), "/customsearch/v1?cx=x&q=larkqueue&num=11")).status).toBe(400);
  });
});
