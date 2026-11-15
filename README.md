# cse-compat

A small self-hosted server that answers `GET /customsearch/v1` with the same request parameters, response JSON and error bodies as Google's Custom Search JSON API. Point an existing client at it by changing the base URL. The code that reads `items[].link` and catches `HttpError` stays as it is.

Why it exists: Google's overview page says the Custom Search JSON API "is closed to new customers" and that existing customers "have until January 1, 2027 to transition to an alternative solution". The suggested replacement, Vertex AI Search, covers up to 50 domains, and full-web search means filling in a contact form. A lot of code (LangChain's `GoogleSearchAPIWrapper`, LlamaIndex's `GoogleSearchToolSpec`, Open WebUI's PSE search, countless scripts) speaks this one wire format.

This is a personal project. Three backends answer the searches: your own [SearXNG](https://docs.searxng.org) instance, the [Brave Search API](https://api-dashboard.search.brave.com) with your own key, or `corpus`, a local JSON file that works as a deterministic, offline stand-in for Google in CI. None of them is Google's index, so results differ from what Google returned. What stays the same is the protocol: parameters, paging, response fields, error bodies.

## What is checked

- **Error bodies equal Google's.** The 403 (no key), 400 `API_KEY_INVALID` and 400 `alt=xml` bodies were captured from `customsearch.googleapis.com` and are compared with `toEqual` in `tests/contract.test.ts`.
- **The real Python clients run against it**, unmodified (`tests/clients/run_clients.py`, 10 checks):
  - google-api-python-client 2.202.0, built from this server's discovery document and from its own bundled document;
  - `HttpError.reason` / `error_details` parsing;
  - LangChain `GoogleSearchAPIWrapper` (`run`, `results`, `siterestrict=True`, the empty case) from langchain-google-community 5.1.1;
  - LlamaIndex's URL template.
- **Request shapes copied from client source** are replayed in vitest: LangChain/googleapiclient (with `alt=json`), LlamaIndex (`quote_plus` query), Open WebUI's pagination loop (`start += 10` up to `start=91`, `Content-Type: application/json` on a GET), field masks, JSONP, `prettyPrint=false`.

- **Live, against a real SearXNG** (`tests/clients/run_live.py`, 8 checks, all passing on 2026-11-15, also from a fresh clone): unmodified googleapiclient and LangChain, paging with no repeated links, `siteSearch` include and exclude, image search, a `q` containing SearXNG syntax, the 400 past result 100.
- **SearXNG responses recorded from a real instance** (10 fixtures: web pages 1 and 2, `site:`, time range, language, images, empty, a typo, a 400, the 403 an instance without `json` sends) are replayed in `tests/searxng.test.ts`.
- **Brave** is tested against a local HTTP server playing `api.search.brave.com`, with bodies written from the response types in Brave's own MCP server and the error body Brave support posted. I had no Brave key, so **the Brave backend has not been run against the real API yet.**

184 vitest tests in total. Every defect found in code review has its own regression test (`tests/regressions.test.ts`, `tests/backend-regressions.test.ts`). The Search resource fields and types come from the official v1 reference and Google's discovery document (revision 20261112).

## Compatibility

| Area | Behaviour |
| --- | --- |
| Paths | `/customsearch/v1` and `/customsearch/v1/siterestrict` (the same here; LangChain uses the second with `siterestrict=True`) |
| Parameters | All 33 `cse.list` parameters from the discovery document are accepted and validated. `num` is 1-10; enum values are case-insensitive. Only parameters the discovery document declares with an `enum` (`safe`, `searchType`, `siteSearchFilter`, the four `img*`) reject an unknown value. `lr`, `c2coff` and `filter` are plain strings there, so an unknown value such as the `lr=en` camel sends is ignored and reported, not a 400. What Google itself does with `lr=en` is not verified (no key). |
| Paging | Results stop at index 100. `start=91&num=10` works and `start=92&num=10` is a 400. Google's docs say "start + num > 100" is an error; I chose the reading that does not reject a page Google serves. `nextPage` never points past 100. |
| `items` | Omitted when there are no results, as Google does. Clients that do `res.get("items", [])` keep working. |
| Types | `searchInformation.totalResults` and `queries.*.totalResults` are strings; `searchTime`, `count` and `startIndex` are numbers. `pagemap.cse_thumbnail` width/height are strings. |
| `htmlTitle` / `htmlSnippet` / `htmlFormattedUrl` | HTML-escaped, with whole-word query matches in `<b>`. |
| System parameters | `key` (or `X-Goog-Api-Key` header), `alt=json`, `fields` partial responses (`items(title,link),searchInformation/totalResults`), `prettyPrint`, `callback` (JSONP). `quotaUser`, `$.xgafv` etc. are accepted. |
| Errors | Google's body shape for every error: `code`, `message`, `errors[0].reason`, `status`, plus `details` where Google sends them. A bad cx, a bad value or a page past 100 is the generic `400 Request contains an invalid argument.` A backend outage or timeout is a 503 `backendError`, which googleapiclient retries when `num_retries` is set. |
| Quota | Optional per-key "Queries per day" limit with Google's 429 message, reset at midnight Pacific time. |
| `filter` | `filter=1` (the default) drops repeated URLs. Google's filter also removes near-duplicate content; this one does not. |
| `snippetLength` | Honoured: snippets are cut at a word boundary, never inside a character, ellipsis included in the limit. |
| Empty values | `&sort=&cr=` is the same as not sending them. |
| Unknown paths and methods | A JSON 404 in Google's error shape. Google itself sends an HTML error page there; JSON is easier to debug and no client parses that page. |

### Parameters a backend cannot honour

These are never silently dropped. Each request lists them in a response header:

```
X-CSE-Compat-Ignored: highRange, lowRange, rights
```

That covers parameters the backend lacks, values that cannot be translated (a boolean `cr` expression, `dateRestrict=yesterday`, `sort=title`, `lr=en`), `c2coff=1` and unknown parameters. Set `CSE_STRICT=1` to turn them into a 400 that names them. `searchType=image` on a backend without image search is always a 400, because web results handed to an image client would break it later and in a less obvious place. The deprecated `googlehost` and `relatedSite` are accepted without a header, since Google marks them deprecated.

Values a backend can only approximate (SearXNG has no "past 3 days", so `dateRestrict=d3` searches the past week) are listed in `X-CSE-Compat-Approximated` instead. They are never a 400, even in strict mode.

## Backends

| | `corpus` | `searxng` | `brave` |
| --- | --- | --- | --- |
| What it is | A local JSON file. Offline and deterministic, for CI | Your own [SearXNG](https://docs.searxng.org) instance, via `/search?format=json` | [Brave Search API](https://api-dashboard.search.brave.com), your own key |
| Web / image search | yes / yes | yes / yes (`categories=images`) | yes / yes (`/res/v1/images/search`) |
| `q` operators (`"phrase"`, `-word`, `OR`, `site:`, `filetype:`) | parsed here | passed through; each SearXNG engine reads them its own way | passed through; Brave reads them |
| `exactTerms`, `excludeTerms`, `orTerms`, `hq` | yes | rewritten into `q` as operators | rewritten into `q` as operators |
| `siteSearch` and engine site lists | yes | as `site:` / `-site:`, and checked again here | as `site:` / `-site:`, and checked again here |
| `fileType` | yes | as `filetype:` | as `filetype:` |
| `dateRestrict` | yes | `d1` `w1` `m1` `y1` exactly; other values widened to the next SearXNG range (`d3` → past week) and listed in `X-CSE-Compat-Approximated`; over a year: ignored | yes, as Brave `freshness` (`pd`, `pw`, `py`, or an exact date range); web only |
| `lr`, `hl` | yes | `language=` | `search_lang=` for the 51 languages Brave lists (`zh-CN` → `zh-hans`, `iw` → `he`); others ignored |
| `gl`, `cr` | yes | ignored (SearXNG has no country filter) | `country=` for the 36 countries Brave lists (`uk` → `GB`); others ignored |
| `safe=active` | yes | `safesearch=2` | `safesearch=strict` |
| `sort=date` | yes | ignored | ignored |
| `lowRange`, `highRange`, `linkSite`, `rights`, `img*` filters | ignored | ignored | ignored |
| `totalResults` | exact | a lower bound (current SearXNG reports no total) | a lower bound (Brave reports no total) |
| `spelling` | no | from SearXNG `corrections` | from Brave `query.altered` |
| Upstream cost per page | none | SearXNG pages are stitched and cached (see below) | exactly one billed request per Google page |

Anything a backend does not honour is listed in `X-CSE-Compat-Ignored` and becomes a 400 with `CSE_STRICT=1`; approximations go in `X-CSE-Compat-Approximated` and are never fatal.

### SearXNG notes

- **Pages are stitched.** A SearXNG page is whatever its engines returned: 20 web results from one engine, 25-30 from two, 140 images in the recorded fixtures. Pages 1 and 2 of the same query shared 2 of 20 URLs. So the backend fetches pages until it has the window Google asked for, removes repeats, and caches the list for 10 minutes (`SEARXNG_CACHE_TTL_MS`). A client walking `start=1, 11, ... 91` costs 5 upstream pages instead of 30 (test in `tests/searxng.test.ts`). Measured on the live instance with two queries: 99 and 96 distinct results for that walk (no link repeated), in 1.7 s and 1.4 s, with pages served from the cache in 3-27 ms.
- **SearXNG syntax inside `q` is escaped.** SearXNG reads `!bang`, `!!bang`, `:lang` and `<3` anywhere in the query, even inside quotes. On the live instance `hono !!g` came back as a **302 redirect to google.com** although `format=json` was asked for, `hono !ddg` searched DuckDuckGo only, and `i <3 hono` searched `i hono` with a 3-second timeout. Such tokens are sent quoted. A phrase containing one is split into quoted words, which loosens the phrase (reported as approximated for `exactTerms`).
- **An engine failure is not "no results".** A page that adds nothing while SearXNG reports unresponsive engines is not cached, so the next request asks again.
- What comes back depends on which engines your instance enables. In the default settings used here, most web results came from SearXNG's `google cse` engine, with DuckDuckGo and Brave often rate-limited or showing a CAPTCHA.
- The instance needs `json` in `search.formats` (otherwise it answers 403; cse-compat logs that fix). `deploy/searxng/settings.yml` is the file used for the tests.

### Brave notes

- **One billed request per Google page.** Brave's `offset` is a page index (0-9) in units of `count` (1-20). For each Google window the backend picks the smallest page size whose page holds the whole window: `start=16&num=10` becomes `count=13&offset=1`. A test walks all 955 (`start`, `num`) pairs Google accepts and checks that each one fits in one request and starts at the right result.
- Answers are not cached by default (`BRAVE_CACHE_TTL_MS=0`). Check that your Brave plan allows storing results before you turn caching on.
- `QUOTA_LIMITED` from Brave becomes Google's 429 shape; `RATE_LIMITED`, a rejected key or an unreachable API become a 503, which googleapiclient retries when `num_retries` is set. Brave's error detail and your key are logged by name only, never sent to the client.
- Brave reads `site:` as a hint, so results outside the requested sites are dropped here, and a page can come back with fewer than `num` items.

## Engines (cx)

Without configuration, any non-empty `cx` is accepted. To act like Programmable Search Engines with "Sites to search", give each cx a site list:

```json
{
  "docs-only": { "title": "Larkqueue docs", "sites": ["docs.larkqueue.example"] },
  "no-mirrors": { "title": "Everything but mirrors", "excludeSites": ["mirror-site.example"] }
}
```

`CSE_ENGINES_FILE=examples/engines.sample.json`. With a file set, an unknown cx gets Google's 400. Sites match subdomains, and a path prefix such as `docs.example/guides` also works (host case-insensitive, path case-sensitive). A request's `siteSearch` narrows the engine's list rather than adding to it, so a caller can't search outside the sites the cx allows.

## Run it

Node 22.12 or newer.

```sh
npm ci
npm run build
CSE_CORPUS_FILE=examples/sample-corpus.json CSE_API_KEYS=demo-key npm start
curl 'http://127.0.0.1:8080/customsearch/v1?key=demo-key&cx=any&q=queue&num=2&fields=items(title,link)'
```

All settings are environment variables, listed in `.env.example`. `npm start` also reads a `.env` file if there is one (`cp .env.example .env`); variables set in the shell win over the file.

### With SearXNG

```sh
# a SearXNG instance with json enabled, e.g. from source:
#   SEARXNG_SETTINGS_PATH=$PWD/deploy/searxng/settings.yml SEARXNG_SECRET=$(openssl rand -hex 16) python -m searx.webapp
SEARXNG_URL=http://127.0.0.1:8888 CSE_BACKEND=searxng CSE_API_KEYS=demo-key npm start
```

`docker-compose.yml` starts cse-compat and SearXNG together with that settings file. **I have not run the compose file** (there was no Docker on the machine I built this on). The same two services started by hand are what the live checks ran against.

### With Brave

```sh
BRAVE_API_KEY=... CSE_BACKEND=brave CSE_API_KEYS=demo-key npm start
```

Several backends can be configured at once: the engines file can send one cx to SearXNG and another to Brave with `"backend": "brave"`.

The sample corpus is invented data on `.example` domains (a fictional queue library called Larkqueue). Use your own file for real tests. Its format is a JSON array of `{url, title, snippet, language?, country?, publishedAt?, adult?, mime?, thumbnail?, image?}`, validated at startup.

## Pointing clients at it

**google-api-python-client** (and anything built on it):

```python
from googleapiclient.discovery import build
service = build("customsearch", "v1", developerKey=KEY,
                client_options={"api_endpoint": "http://127.0.0.1:8080/"})
```

One catch: the client's bundled discovery document lists `imgSize` values in uppercase and rejects `imgSize="large"` with a `TypeError` before any request is sent. Pass `"LARGE"`, or build from this server's own document, which has no enums:

```python
service = build("customsearch", "v1", developerKey=KEY, static_discovery=False,
                discoveryServiceUrl="http://127.0.0.1:8080/discovery/v1/apis/{api}/{apiVersion}/rest")
```

**LangChain** `GoogleSearchAPIWrapper` builds its client in a validator, so replace it after construction:

```python
wrapper = GoogleSearchAPIWrapper(google_api_key=KEY, google_cse_id=CX)
wrapper.search_engine = service  # the build() above
```

**Plain HTTP clients** (LlamaIndex, Open WebUI, n8n HTTP Request nodes, fetch snippets) hardcode `https://www.googleapis.com/customsearch/v1`. Swap that string for your server's URL. In LlamaIndex it is the module constant `QUERY_URL_TMPL`.

`GOOGLE_CLOUD_UNIVERSE_DOMAIN` looks like a way to redirect googleapiclient without code, but it is not: with an API key and no credentials, the first `cse().list()` raises `UniverseMismatchError`. `client_options={"api_endpoint": ...}` works.

### How many apps can switch without a code change

On 2026-11-15 I read the code that calls this API in 25 open-source projects (default branches; AI chat apps, agent frameworks, RAG libraries, a few plugins). In 2 of them the endpoint is a setting (MetaGPT's `discovery_service_url`, mattermost-plugin-agents' "API URL"). In 3 the calling code can pass one value (eino-ext `BaseURL`, LazyLLM `base_url`, the Semantic Kernel .NET initializer). The other 20 hardcode the URL, so moving them to anything, this server included, takes a code change.

The same reading turned up request shapes this server has to accept, now covered by `tests/census-shapes.test.ts`: the key in an `X-Goog-Api-Key` header, `start=0` from clients that treat `start` as a 0-based offset, a literal `dateRestrict=undefined`, and paging that stops when `queries.nextPage` is missing. One client skips every result that has no `pagemap.metatags`. This server does not invent page metadata, so with that client the results come back empty. Google also returns items without metatags, which that client drops just the same.

## Development

```sh
npm run check          # tsc, eslint (strict type-checked), vitest
npm run build && CSE_CORPUS_FILE=examples/sample-corpus.json CSE_API_KEYS=demo-key npm start &
python3 -m venv .venv && . .venv/bin/activate   # the scripts run with python3 -I, so use a venv, not pip --user
pip install google-api-python-client==2.202.0 langchain-google-community==5.1.1
CSE_COMPAT_URL=http://127.0.0.1:8080 CSE_COMPAT_KEY=demo-key npm run test:clients
```

Live check against a web backend (results change, so it asserts shapes and invariants rather than exact results):

```sh
SEARXNG_URL=http://127.0.0.1:8888 CSE_BACKEND=searxng CSE_API_KEYS=demo-key npm start &
CSE_COMPAT_URL=http://127.0.0.1:8080 CSE_COMPAT_KEY=demo-key python3 -I tests/clients/run_live.py
```

Layout: `src/cse/` holds the wire format (params, errors, response, field masks, discovery), `src/backends/` the backends (`corpus`, `searxng`, `brave`) and their shared HTTP, cache and site helpers, and `src/app.ts` the Hono routes. A backend implements `search(query, signal)`, declares the features it honours, and can say per request which values it will drop or approximate (`limits`). The CSE layer handles everything Google-specific.

Stack: Node.js, TypeScript, Hono, zod, vitest.

## Licence

MIT
