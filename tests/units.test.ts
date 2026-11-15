import { describe, expect, it } from "vitest";
import { applyFieldMask, parseFieldMask } from "../src/cse/fields.js";
import { parseDateRestrict, toOperatorQuery } from "../src/cse/query.js";
import { bold, highlightTerms } from "../src/cse/response.js";
import type { SearchQuery } from "../src/backends/types.js";
import type { Operator } from "../src/cse/query.js";

describe("field masks", () => {
  const doc = {
    kind: "k",
    searchInformation: { totalResults: "3", searchTime: 0.1 },
    items: [
      { title: "a", link: "l1", pagemap: { cse_image: [{ src: "i" }] } },
      { title: "b", link: "l2" },
    ],
  };
  const apply = (mask: string) => applyFieldMask(doc, parseFieldMask(mask));

  it("selects sub-fields of every array element", () => {
    expect(apply("items(title)")).toEqual({ items: [{ title: "a" }, { title: "b" }] });
  });

  it("supports paths, nested parentheses and merging", () => {
    expect(apply("items/pagemap(cse_image(src)),items/link")).toEqual({
      items: [{ link: "l1", pagemap: { cse_image: [{ src: "i" }] } }, { link: "l2" }],
    });
  });

  it("* selects everything at its level", () => {
    expect(apply("searchInformation/*")).toEqual({ searchInformation: doc.searchInformation });
    expect(apply("*")).toEqual(doc);
  });

  it("a missing field selects nothing", () => {
    expect(apply("spelling")).toEqual({});
  });

  it.each(["items(", "items)", "items(title", "", ",", "items//title", "a b(c"])("rejects %j", (mask) => {
    expect(() => parseFieldMask(mask)).toThrow(/Invalid field selection/);
  });
});

describe("dateRestrict", () => {
  it.each([
    ["d7", { unit: "d", amount: 7 }],
    ["W2", { unit: "w", amount: 2 }],
    ["m6", { unit: "m", amount: 6 }],
    ["y1", { unit: "y", amount: 1 }],
  ])("%s", (value, expected) => {
    expect(parseDateRestrict(value)).toEqual(expected);
  });

  it.each(["", "d", "d0", "7d", "x3", "d-1", "d1.5"])("rejects %j", (value) => {
    expect(parseDateRestrict(value)).toBeUndefined();
  });
});

describe("operator query for text backends", () => {
  const base: SearchQuery = { terms: "queue", includeSites: [], excludeSites: [], safe: false, sortByDate: false, searchType: "web", offset: 0, count: 10 };
  const all = new Set<Operator>(["quotes", "minus", "or", "site", "filetype"]);

  it("renders every operator", () => {
    const q: SearchQuery = {
      ...base,
      hq: "postgres",
      exactTerms: 'skip "locked"',
      excludeTerms: "redis cluster",
      orTerms: "cron  priority",
      includeSites: ["docs.a.example", "blog.a.example"],
      excludeSites: ["mirror.example"],
      fileType: "pdf",
    };
    expect(toOperatorQuery(q, all)).toBe(
      'queue postgres "skip locked" -"redis cluster" (cron OR priority) (site:docs.a.example OR site:blog.a.example) -site:mirror.example filetype:pdf',
    );
  });

  it("leaves out operators the backend does not read", () => {
    expect(toOperatorQuery({ ...base, exactTerms: "a b", fileType: "pdf" }, new Set<Operator>(["site"]))).toBe("queue");
  });

  it("a single word exclusion needs no quotes; a single site needs no parentheses", () => {
    expect(toOperatorQuery({ ...base, excludeTerms: "redis", includeSites: ["a.example"] }, all)).toBe("queue -redis site:a.example");
  });
});

describe("highlighting", () => {
  it("bolds whole words only, case-insensitively, and escapes HTML", () => {
    const terms = highlightTerms("Queue <script>", undefined);
    expect(bold("A queue & queues <script>", terms)).toBe("A <b>queue</b> &amp; queues &lt;<b>script</b>&gt;");
  });

  it("skips operators and excluded words", () => {
    expect(highlightTerms("redis -cluster site:a.example OR filetype:pdf")).toEqual(["redis"]);
  });

  it("works for non-Latin scripts", () => {
    expect(bold("Повторы и задержка", highlightTerms("повторы"))).toBe("<b>Повторы</b> и задержка");
  });
});
