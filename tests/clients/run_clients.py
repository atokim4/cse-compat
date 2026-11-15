"""End-to-end check with the real Python clients, against a running cse-compat server.

    pip install google-api-python-client langchain-google-community
    CSE_CORPUS_FILE=examples/sample-corpus.json CSE_API_KEYS=demo-key npm start   # other shell
    CSE_COMPAT_URL=http://127.0.0.1:8080 CSE_COMPAT_KEY=demo-key python3 tests/clients/run_clients.py

Each check prints PASS/FAIL; the exit code is the number of failures.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import urllib.parse
import urllib.request
from typing import Callable

BASE = os.environ.get("CSE_COMPAT_URL", "http://127.0.0.1:8080").rstrip("/")
KEY = os.environ.get("CSE_COMPAT_KEY", "demo-key")
CX = "any-engine"

checks: list[tuple[str, Callable[[], None]]] = []


def check(name: str):
    def register(fn: Callable[[], None]):
        checks.append((name, fn))
        return fn

    return register


def build_static(**kwargs):
    """googleapiclient's bundled discovery doc, requests sent to this server."""
    from googleapiclient.discovery import build

    return build("customsearch", "v1", developerKey=KEY, client_options={"api_endpoint": f"{BASE}/"}, **kwargs)


@check("googleapiclient: build() from this server's discovery document")
def discovery_from_server():
    from googleapiclient.discovery import build

    service = build(
        "customsearch",
        "v1",
        developerKey=KEY,
        discoveryServiceUrl=f"{BASE}/discovery/v1/apis/{{api}}/{{apiVersion}}/rest",
        static_discovery=False,
        cache_discovery=False,
    )
    res = service.cse().list(q="retries", cx=CX, num=3).execute()
    assert res["kind"] == "customsearch#search", res
    assert 1 <= len(res["items"]) <= 3, res
    # This document has no enums, so lowercase imgSize passes the client-side check.
    res = service.cse().list(q="diagram", cx=CX, searchType="image", imgSize="large").execute()
    assert res["items"][0]["image"]["contextLink"].startswith("https://"), res


@check("googleapiclient: bundled discovery + client_options api_endpoint")
def bundled_discovery_with_endpoint():
    service = build_static()
    request = service.cse().list(q="dead letter", cx=CX, num=2)
    assert request.uri.startswith(f"{BASE}/customsearch/v1?"), request.uri
    res = request.execute()
    assert res["items"][0]["link"] == "https://docs.larkqueue.example/guide/dead-letter", res


@check("googleapiclient: HttpError carries Google's reason and details for a bad key")
def http_error_parsing():
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    service = build("customsearch", "v1", developerKey="wrong-key", client_options={"api_endpoint": f"{BASE}/"})
    try:
        service.cse().list(q="x", cx=CX).execute()
    except HttpError as err:
        assert err.status_code == 400, err.status_code
        assert err.reason == "API key not valid. Please pass a valid API key.", err.reason
        assert err.error_details[0]["reason"] == "API_KEY_INVALID", err.error_details
        return
    raise AssertionError("expected HttpError")


@check("googleapiclient: page past 100 is a 400 HttpError, like Google")
def past_100():
    from googleapiclient.errors import HttpError

    try:
        build_static().cse().list(q="larkqueue", cx=CX, start=95, num=10).execute()
    except HttpError as err:
        assert err.status_code == 400 and err.reason == "Request contains an invalid argument.", err
        return
    raise AssertionError("expected HttpError")


@check("googleapiclient bundled doc: imgSize must be UPPERCASE client-side; the server accepts it")
def bundled_enum_case():
    service = build_static()
    try:
        service.cse().list(q="diagram", cx=CX, searchType="image", imgSize="large")
    except TypeError:
        pass
    else:
        raise AssertionError("bundled discovery doc no longer rejects lowercase imgSize")
    res = service.cse().list(q="diagram", cx=CX, searchType="image", imgSize="LARGE").execute()
    assert len(res["items"]) > 0, res


def langchain_wrapper(**kwargs):
    from langchain_google_community import GoogleSearchAPIWrapper

    wrapper = GoogleSearchAPIWrapper(google_api_key=KEY, google_cse_id=CX, **kwargs)
    # The wrapper builds its own client in a validator; swapping the base URL means replacing it.
    wrapper.search_engine = build_static()
    return wrapper


@check("LangChain GoogleSearchAPIWrapper.run()")
def langchain_run():
    text = langchain_wrapper(k=3).run("retries backoff")
    assert "exponential backoff" in text, text


@check("LangChain GoogleSearchAPIWrapper.results() reads title/link/snippet/image/thumbnail")
def langchain_results():
    results = langchain_wrapper().results("benchmarking", num_results=2)
    first = results[0]
    assert first["link"] == "https://blog.larkqueue.example/2026/postgres-queue-benchmark", first
    assert first["image"] == first["thumbnail"] == "https://blog.larkqueue.example/img/bench-thumb.png", first


@check("LangChain GoogleSearchAPIWrapper(siterestrict=True) hits /customsearch/v1/siterestrict")
def langchain_siterestrict():
    results = langchain_wrapper(siterestrict=True).results("scheduled jobs", num_results=1)
    assert results[0]["link"] == "https://docs.larkqueue.example/guide/scheduling", results


@check("LangChain: no results gives its own 'No good Google Search Result was found'")
def langchain_empty():
    assert langchain_wrapper().run("zzzzqqqq") == "No good Google Search Result was found"


@check("LlamaIndex GoogleSearchToolSpec URL template (plain GET, quote_plus)")
def llamaindex_template():
    url = f"{BASE}/customsearch/v1?key={KEY}&cx={CX}&q={urllib.parse.quote_plus('rate limits')}&num=2"
    with urllib.request.urlopen(url, timeout=10) as response:
        items = json.loads(response.read()).get("items", [])
    cleaned = [{"title": r["title"], "link": r["link"], "snippet": r["snippet"]} for r in items if "snippet" in r]
    assert cleaned[0]["link"] == "https://docs.larkqueue.example/guide/rate-limits", cleaned


def main() -> int:
    failures = 0
    for name, fn in checks:
        try:
            fn()
            print(f"PASS  {name}")
        except Exception:  # noqa: BLE001 - report every failing check, then exit non-zero
            failures += 1
            print(f"FAIL  {name}")
            traceback.print_exc(limit=3)
    print(f"\n{len(checks) - failures}/{len(checks)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(main())
