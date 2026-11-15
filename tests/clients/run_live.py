"""Live check with the real Python clients against cse-compat in front of a real web backend (SearXNG or Brave).

    pip install google-api-python-client langchain-google-community
    SEARXNG_URL=http://127.0.0.1:8888 CSE_BACKEND=searxng CSE_API_KEYS=demo-key npm start   # other shell
    CSE_COMPAT_URL=http://127.0.0.1:8080 CSE_COMPAT_KEY=demo-key python3 -I tests/clients/run_live.py

Unlike run_clients.py this cannot assert exact results (the web changes), so it checks shapes and
invariants: types, paging without overlap, siteSearch keeping every link on the site, image fields,
errors as googleapiclient HttpError. Each check prints PASS/FAIL; the exit code is the number of failures.
"""

from __future__ import annotations

import os
import sys
import time
import traceback
import urllib.parse
from typing import Callable

BASE = os.environ.get("CSE_COMPAT_URL", "http://127.0.0.1:8080").rstrip("/")
KEY = os.environ.get("CSE_COMPAT_KEY", "demo-key")
CX = "live-check"

checks: list[tuple[str, Callable[[], None]]] = []
timings: list[tuple[str, float]] = []


def check(name: str):
    def register(fn: Callable[[], None]):
        checks.append((name, fn))
        return fn

    return register


def service():
    from googleapiclient.discovery import build

    return build("customsearch", "v1", developerKey=KEY, client_options={"api_endpoint": f"{BASE}/"}, cache_discovery=False)


def timed(label: str, request):
    started = time.perf_counter()
    res = request.execute()
    timings.append((label, time.perf_counter() - started))
    return res


def host_of(link: str) -> str:
    return urllib.parse.urlsplit(link).hostname or ""


@check("googleapiclient: a web search returns Google-typed fields")
def web_search():
    res = timed("page 1 (cold)", service().cse().list(q="hono web framework", cx=CX, num=10))
    items = res["items"]
    assert 5 <= len(items) <= 10, len(items)
    assert isinstance(res["searchInformation"]["totalResults"], str)
    assert isinstance(res["queries"]["request"][0]["startIndex"], int)
    for item in items:
        assert item["kind"] == "customsearch#result"
        assert item["link"].startswith(("http://", "https://")), item["link"]
        assert item["displayLink"] == urllib.parse.urlsplit(item["link"]).netloc
        assert "<script" not in item["htmlSnippet"].lower()
    assert res["queries"]["nextPage"][0]["startIndex"] == 11


@check("paging: start=11 continues page 1 with no repeated link")
def paging():
    cse = service().cse()
    first = timed("page 1 (warm)", cse.list(q="hono web framework", cx=CX))
    second = timed("page 2", cse.list(q="hono web framework", cx=CX, start=11))
    a = {i["link"] for i in first["items"]}
    b = {i["link"] for i in second["items"]}
    assert len(b) >= 5, len(b)
    assert not (a & b), a & b
    assert second["queries"]["request"][0]["startIndex"] == 11
    assert second["queries"]["previousPage"][0]["startIndex"] == 1


@check("siteSearch: every link is on the site")
def site_search():
    res = timed("siteSearch", service().cse().list(q="middleware", cx=CX, siteSearch="hono.dev", siteSearchFilter="i"))
    hosts = {host_of(i["link"]) for i in res["items"]}
    assert hosts and all(h == "hono.dev" or h.endswith(".hono.dev") for h in hosts), hosts


@check("siteSearch with siteSearchFilter=e: the site is excluded")
def site_exclude():
    res = timed("siteSearch=e", service().cse().list(q="hono framework", cx=CX, siteSearch="hono.dev", siteSearchFilter="e"))
    hosts = {host_of(i["link"]) for i in res["items"]}
    assert hosts and not any(h == "hono.dev" or h.endswith(".hono.dev") for h in hosts), hosts


@check("image search: link is the image, contextLink the page")
def images():
    res = timed("image search", service().cse().list(q="hono logo", cx=CX, searchType="image", num=5))
    assert len(res["items"]) == 5, len(res["items"])
    for item in res["items"]:
        assert item["link"].startswith(("http://", "https://"))
        assert item["image"]["contextLink"].startswith(("http://", "https://"))
        assert item["image"]["contextLink"] != item["link"]


@check("a q with SearXNG syntax tokens comes back as a normal JSON search")
def bang_tokens():
    res = timed("bang tokens", service().cse().list(q="hono !!g", cx=CX, num=3))
    assert res["kind"] == "customsearch#search"
    assert res["queries"]["request"][0]["searchTerms"] == "hono !!g"


@check("start=92 is HttpError 400, as on Google")
def past_100():
    from googleapiclient.errors import HttpError

    try:
        service().cse().list(q="hono", cx=CX, start=92).execute()
    except HttpError as error:
        assert error.resp.status == 400, error.resp.status
        return
    raise AssertionError("no HttpError")


@check("LangChain GoogleSearchAPIWrapper.results() works unmodified")
def langchain():
    from langchain_google_community import GoogleSearchAPIWrapper

    wrapper = GoogleSearchAPIWrapper(google_api_key=KEY, google_cse_id=CX, k=3)
    wrapper.search_engine = service()
    results = wrapper.results("hono middleware", 3)
    assert len(results) == 3, results
    assert all(r["link"].startswith("http") and r["title"] for r in results), results
    assert isinstance(wrapper.run("hono middleware"), str)


def main() -> int:
    failures = 0
    for name, fn in checks:
        try:
            fn()
            print(f"PASS  {name}")
        except Exception:  # noqa: BLE001 - report every failure and keep going
            failures += 1
            print(f"FAIL  {name}")
            traceback.print_exc(limit=3)
    print(f"\n{len(checks) - failures}/{len(checks)} passed against {BASE}")
    for label, seconds in timings:
        print(f"  {label:<16} {seconds * 1000:7.0f} ms")
    return failures


if __name__ == "__main__":
    sys.exit(main())
