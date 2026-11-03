# SPDX-License-Identifier: MIT
"""The yahoo sidecar's tests (WP 12.6). No test reaches the network.

Run inside the built image (the same interpreter and the same pinned wheels
that ship), with the tests mounted read-only and the root filesystem
read-only, as `just yahoo-test` does:

    docker run --rm --read-only --tmpfs /tmp --network none \
      -v "$PWD/docker/yahoo:/src:ro" --entrypoint python <image> \
      -I -m unittest discover -s /src/tests -t /src -v

`--network none` is part of the claim: a test that tried to reach Yahoo would
fail rather than quietly succeed. Every outbound "request" here is answered by
`FakeTransport` from the synthetic JSON in fixtures/ — Yahoo's documented
response SHAPES with invented numbers and an invented symbol (PFTEST); no
Yahoo data is committed (research 14 §4).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

import server

FIXTURES = Path(__file__).parent / "fixtures"


class FakeResponse:
    """Enough of curl_cffi's Response for yfinance's history and search paths."""

    def __init__(self, url: str, status: int = 200, body: Any = None,
                 headers: Optional[dict[str, str]] = None) -> None:
        self.url = url
        self.status_code = status
        self.headers = headers or {}
        self.text = body if isinstance(body, str) else json.dumps(body if body is not None else {})
        self.content = self.text.encode("utf-8")
        self.cookies: dict[str, str] = {}

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeTransport:
    """Stands where the socket would be: records every request that would leave."""

    def __init__(self, answer: Callable[[str, str], FakeResponse]) -> None:
        self.answer = answer
        self.sent: list[tuple[str, str]] = []

    def __call__(self, method: str, url: str, **_kwargs: Any) -> FakeResponse:
        self.sent.append((method, url))
        return self.answer(method, url)


def chart_fixture() -> dict[str, Any]:
    return json.loads((FIXTURES / "chart-pftest.json").read_text())


def search_fixture() -> dict[str, Any]:
    return json.loads((FIXTURES / "search-pftest.json").read_text())


def yahoo_answers(chart: Optional[dict[str, Any]] = None, status: int = 200) -> Callable[[str, str], FakeResponse]:
    def answer(_method: str, url: str) -> FakeResponse:
        path = server.urlsplit(url).path
        if path.startswith("/v8/finance/chart/"):
            return FakeResponse(url, status, chart if chart is not None else chart_fixture())
        if path == "/v1/finance/search":
            return FakeResponse(url, status, search_fixture())
        if path == "/v1/test/getcrumb":
            return FakeResponse(url, 200, "")
        return FakeResponse(url, 404, {"finance": {"error": "not found"}})

    return answer


def guarded_session(transport: FakeTransport, budget: Optional[server.RateBudget] = None,
                    backoff: Optional[server.Backoff] = None) -> Any:
    session_class = server.make_guarded_session_class(server._session_base())
    session = session_class(budget or server.RateBudget(), backoff or server.Backoff())
    session._send = transport  # the one call that would open a socket
    return session


def reset_yfinance() -> None:
    """yfinance keeps a process-wide singleton and an lru cache; start each test clean."""
    from yfinance.data import YfData

    YfData._instances.pop(YfData, None)  # type: ignore[attr-defined]


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


# ---------------------------------------------------------------------------
# The host check
# ---------------------------------------------------------------------------


class HostCheckTest(unittest.TestCase):
    def test_the_two_yahoo_query_hosts_on_443_are_allowed(self) -> None:
        for url in ("https://query1.finance.yahoo.com/v8/finance/chart/X",
                    "https://query2.finance.yahoo.com:443/v1/finance/search?q=x",
                    "https://QUERY2.finance.yahoo.com./v1/test/getcrumb"):
            server.check_url(url)

    def test_every_other_destination_is_refused(self) -> None:
        refused = [
            "https://fc.yahoo.com/",                        # yfinance's cookie step
            "https://guce.yahoo.com/consent",               # yfinance's consent step
            "https://consent.yahoo.com/v2/collectConsent",
            "https://finance.yahoo.com/quote/X",
            "https://query3.finance.yahoo.com/x",
            "https://query1.finance.yahoo.com.evil.example/x",
            "https://evil.example/?h=query1.finance.yahoo.com",
            "http://query1.finance.yahoo.com/x",            # cleartext
            "https://query1.finance.yahoo.com:8443/x",      # odd port
            "https://user:pw@query1.finance.yahoo.com/x",   # credentials
            "https://169.254.169.254/latest/meta-data",
            "https://db:5432/",
            "file:///etc/passwd",
            "https://[::1]/",
        ]
        for url in refused:
            with self.subTest(url=url), self.assertRaises(server.HostNotAllowed):
                server.check_url(url)

    def test_the_refusal_is_an_oserror_so_yfinance_degrades_rather_than_crashes(self) -> None:
        self.assertTrue(issubclass(server.HostNotAllowed, OSError))


class GuardedSessionTest(unittest.TestCase):
    def test_a_foreign_host_is_refused_before_anything_is_sent(self) -> None:
        transport = FakeTransport(yahoo_answers())
        session = guarded_session(transport)
        with self.assertRaises(server.HostNotAllowed):
            session.get("https://fc.yahoo.com", timeout=30, allow_redirects=True)
        self.assertEqual(transport.sent, [])

    def test_a_redirect_to_a_foreign_host_is_refused_not_followed(self) -> None:
        def answer(_method: str, url: str) -> FakeResponse:
            return FakeResponse(url, 302, "", {"location": "https://evil.example/steal"})

        transport = FakeTransport(answer)
        session = guarded_session(transport)
        with self.assertRaises(server.HostNotAllowed) as caught:
            session.get("https://query2.finance.yahoo.com/v8/finance/chart/PFTEST", timeout=30)
        self.assertIn("evil.example", str(caught.exception))
        # The first hop left; the second never did.
        self.assertEqual(transport.sent, [("GET", "https://query2.finance.yahoo.com/v8/finance/chart/PFTEST")])

    def test_a_redirect_between_the_two_allowed_hosts_is_followed_by_us_not_by_curl(self) -> None:
        def answer(_method: str, url: str) -> FakeResponse:
            if "query2" in url:
                return FakeResponse(url, 301, "", {"Location": "https://query1.finance.yahoo.com/v1/x"})
            return FakeResponse(url, 200, {"ok": True})

        transport = FakeTransport(answer)
        seen: list[Any] = []
        session = guarded_session(transport)
        original = session._send

        def spy(method: str, url: str, **kwargs: Any) -> FakeResponse:
            seen.append(kwargs.get("allow_redirects"))
            return original(method, url, **kwargs)

        session._send = spy
        response = session.get("https://query2.finance.yahoo.com/v1/y", allow_redirects=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([url for _, url in transport.sent],
                         ["https://query2.finance.yahoo.com/v1/y", "https://query1.finance.yahoo.com/v1/x"])
        self.assertEqual(seen, [False, False])

    def test_proxy_and_dns_arguments_are_refused(self) -> None:
        session = guarded_session(FakeTransport(yahoo_answers()))
        for name, value in (("proxy", "http://p:3128"), ("proxies", {"https": "http://p"}),
                            ("dns", "1.1.1.1"), ("doh_url", "https://doh.example"), ("interface", "eth0")):
            with self.subTest(name=name), self.assertRaises(server.HostNotAllowed):
                session.get("https://query1.finance.yahoo.com/x", **{name: value})

    def test_the_timeout_is_capped_at_fifteen_seconds(self) -> None:
        captured: list[Any] = []
        session = guarded_session(FakeTransport(yahoo_answers()))
        session._send = lambda method, url, **kw: captured.append(kw["timeout"]) or FakeResponse(url)
        session.get("https://query1.finance.yahoo.com/x", timeout=30)
        session.get("https://query1.finance.yahoo.com/x")
        session.get("https://query1.finance.yahoo.com/x", timeout=5)
        self.assertEqual(captured, [15.0, 15.0, 5.0])

    def test_the_environment_is_not_trusted_for_a_proxy(self) -> None:
        session = guarded_session(FakeTransport(yahoo_answers()))
        self.assertFalse(session.trust_env)


# ---------------------------------------------------------------------------
# Budget and backoff
# ---------------------------------------------------------------------------


class BudgetTest(unittest.TestCase):
    def test_sixty_per_sliding_hour_and_the_sixty_first_never_leaves(self) -> None:
        clock = Clock()
        budget = server.RateBudget(clock=clock)
        transport = FakeTransport(yahoo_answers())
        session = guarded_session(transport, budget=budget)
        for _ in range(60):
            session.get("https://query1.finance.yahoo.com/x")
            clock.now += 1
        with self.assertRaises(server.BudgetSpent) as caught:
            session.get("https://query1.finance.yahoo.com/x")
        self.assertEqual(len(transport.sent), 60)
        self.assertGreater(caught.exception.retry_after_s, 3000)
        clock.now = 1_000.0 + 3600.5  # the first spend has slid out
        session.get("https://query1.finance.yahoo.com/x")
        self.assertEqual(len(transport.sent), 61)

    def test_the_limit_is_the_workers_yfinance_windows_number(self) -> None:
        self.assertEqual((server.BUDGET_LIMIT, server.BUDGET_WINDOW_S), (60, 3600.0))

    def test_a_refused_host_costs_nothing(self) -> None:
        budget = server.RateBudget()
        session = guarded_session(FakeTransport(yahoo_answers()), budget=budget)
        with self.assertRaises(server.HostNotAllowed):
            session.get("https://fc.yahoo.com")
        self.assertEqual(budget.used(), 0)

    def test_a_429_backs_off_exponentially_and_nothing_leaves_meanwhile(self) -> None:
        clock = Clock()
        backoff = server.Backoff(clock=clock)
        transport = FakeTransport(lambda _m, url: FakeResponse(url, 429, "Too Many Requests"))
        session = guarded_session(transport, backoff=backoff)
        self.assertEqual(session.get("https://query1.finance.yahoo.com/x").status_code, 429)
        self.assertEqual(backoff.remaining(), 60.0)
        with self.assertRaises(server.BackingOff):
            session.get("https://query1.finance.yahoo.com/x")
        self.assertEqual(len(transport.sent), 1)
        clock.now += 61
        session.get("https://query1.finance.yahoo.com/x")
        self.assertEqual(backoff.remaining(), 120.0)
        for _ in range(10):
            backoff.hit()
        self.assertEqual(backoff.remaining(), 3600.0)
        backoff.reset()
        self.assertEqual(backoff.remaining(), 0.0)


# ---------------------------------------------------------------------------
# Through yfinance itself, against recorded shapes
# ---------------------------------------------------------------------------


class YfinanceLayerTest(unittest.TestCase):
    def setUp(self) -> None:
        import yfinance as yf

        self.cache = tempfile.mkdtemp(prefix="yf-cache-")
        yf.set_tz_cache_location(self.cache)
        yf.config.debug.hide_exceptions = False
        yf.config.network.retries = 0
        reset_yfinance()

    def service(self, transport: FakeTransport) -> server.Service:
        budget, backoff = server.RateBudget(), server.Backoff()
        yahoo = server.YahooFinance(lambda: guarded_session(transport, budget, backoff))
        return server.Service(yahoo, budget, backoff, "test")

    def test_a_quote_is_the_latest_close_on_or_before_the_day_as_a_decimal_string(self) -> None:
        transport = FakeTransport(yahoo_answers())
        status, body = self.service(transport).quote({"symbol": "PFTEST", "date": "2026-10-29"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"symbol": "PFTEST", "date": "2026-10-29", "close": "102",
                                "currency": "USD", "stale": False})
        hosts = {server.urlsplit(url).hostname for _, url in transport.sent}
        self.assertLessEqual(hosts, server.ALLOWED_HOSTS)
        self.assertTrue(transport.sent, "the chart endpoint was asked")

    def test_a_weekend_is_a_carry_forward_and_says_so(self) -> None:
        status, body = self.service(FakeTransport(yahoo_answers())).quote(
            {"symbol": "PFTEST", "date": "2026-11-01"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["date"], body["close"], body["stale"]), ("2026-10-30", "103.125", True))

    def test_fx_asks_for_the_pair_symbol(self) -> None:
        transport = FakeTransport(yahoo_answers())
        status, body = self.service(transport).fx({"from": "EUR", "to": "USD", "date": "2026-10-28"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"from": "EUR", "to": "USD", "date": "2026-10-28", "rate": "99.75", "stale": False})
        self.assertTrue(any("/v8/finance/chart/EURUSD=X" in url for _, url in transport.sent))

    def test_search_names_symbols_and_kinds(self) -> None:
        status, body = self.service(FakeTransport(yahoo_answers())).search({"q": "personalfi test"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["results"][0], {"symbol": "PFTEST", "name": "PersonalFi Test Company",
                                              "kind": "EQUITY", "exchange": "NMS"})
        self.assertEqual(len(body["results"]), 2)

    def test_a_shape_change_is_an_answer_with_a_reason_not_a_crash(self) -> None:
        broken = chart_fixture()
        del broken["chart"]["result"][0]["indicators"]
        status, body = self.service(FakeTransport(yahoo_answers(broken))).quote(
            {"symbol": "PFTEST", "date": "2026-10-29"})
        self.assertEqual(status, 502, body)
        self.assertEqual(body["error"], "shape_changed")
        self.assertIn("indicators", body["detail"])

    def test_a_yahoo_429_is_a_429_with_retry_after_and_starts_the_backoff(self) -> None:
        service = self.service(FakeTransport(yahoo_answers(status=429)))
        status, body = service.quote({"symbol": "PFTEST", "date": "2026-10-29"})
        self.assertEqual(status, 429, body)
        self.assertEqual(body["error"], "rate_limited")
        self.assertGreaterEqual(body["retryAfterSeconds"], 60)
        self.assertGreater(service.backoff.remaining(), 0)
        status, _ = service.quote({"symbol": "PFTEST", "date": "2026-10-28"})
        self.assertEqual(status, 429)

    def test_a_chart_redirect_to_a_foreign_host_is_a_refusal_not_a_fetch(self) -> None:
        def answer(_m: str, url: str) -> FakeResponse:
            return FakeResponse(url, 302, "", {"location": "https://consent.yahoo.com/collect"})

        transport = FakeTransport(answer)
        status, body = self.service(transport).quote({"symbol": "PFTEST", "date": "2026-10-29"})
        self.assertEqual(status, 502, body)
        self.assertEqual(body["error"], "host_refused")
        self.assertFalse(any("consent.yahoo.com" in url for _, url in transport.sent))


# ---------------------------------------------------------------------------
# Validation and the HTTP surface
# ---------------------------------------------------------------------------


class StubYahoo:
    def __init__(self) -> None:
        self.calls = 0

    def daily_closes(self, symbol: str, start: dt.date, end: dt.date) -> tuple[str, list[tuple[str, str]]]:
        self.calls += 1
        return "usd", [("2026-10-29", "1.5")]

    def search(self, query: str) -> list[dict[str, Optional[str]]]:
        self.calls += 1
        return []


class ValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.yahoo = StubYahoo()
        self.service = server.Service(self.yahoo, server.RateBudget(), server.Backoff(), "test")

    def test_bad_input_is_400_and_never_reaches_yahoo(self) -> None:
        for call, params in (
            (self.service.quote, {"symbol": "", "date": "2026-10-29"}),
            (self.service.quote, {"symbol": "A B", "date": "2026-10-29"}),
            (self.service.quote, {"symbol": "../../etc", "date": "2026-10-29"}),
            (self.service.quote, {"symbol": "X" * 33, "date": "2026-10-29"}),
            (self.service.quote, {"symbol": "AAPL", "date": "2026-02-30"}),
            (self.service.quote, {"symbol": "AAPL"}),
            (self.service.fx, {"from": "usd", "to": "EUR", "date": "2026-10-29"}),
            (self.service.fx, {"from": "USD", "to": "USD", "date": "2026-10-29"}),
            (self.service.search, {"q": ""}),
            (self.service.search, {"q": "a\nb"}),
            (self.service.search, {"q": "x" * 65}),
        ):
            with self.subTest(params=params):
                self.assertEqual(call(params)[0], 400)
        self.assertEqual(self.yahoo.calls, 0)

    def test_currency_is_upper_cased(self) -> None:
        status, body = self.service.quote({"symbol": "AAPL", "date": "2026-10-29"})
        self.assertEqual((status, body["currency"]), (200, "USD"))

    def test_decimal_strings_have_no_exponent_and_no_float_noise(self) -> None:
        self.assertEqual(server.decimal_string(1e-7), "0.0000001")
        self.assertEqual(server.decimal_string(271.489990234375), "271.489990234375")
        self.assertEqual(server.decimal_string(100.0), "100")
        with self.assertRaises(server.ShapeChanged):
            server.decimal_string(float("nan"))
        with self.assertRaises(server.ShapeChanged):
            server.decimal_string("1.5")


class HttpSurfaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.service = server.Service(StubYahoo(), server.RateBudget(), server.Backoff(), "test")
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(cls.service))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def fetch(self, path: str, method: str = "GET") -> tuple[int, dict[str, Any], dict[str, str]]:
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read()), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read()), dict(error.headers)

    def test_health_reports_the_budget_and_spends_nothing(self) -> None:
        status, body, _ = self.fetch("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["budget"], {"used": 0, "limit": 60, "windowSeconds": 3600})
        self.assertEqual(self.service.yahoo.calls, 0)

    def test_quote_is_json(self) -> None:
        status, body, headers = self.fetch("/quote?symbol=AAPL&date=2026-10-29")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("content-type"), "application/json")
        self.assertEqual(body["close"], "1.5")

    def test_unknown_paths_methods_and_repeated_parameters_are_refused(self) -> None:
        self.assertEqual(self.fetch("/admin")[0], 404)
        self.assertEqual(self.fetch("/quote", method="POST")[0], 405)
        self.assertEqual(self.fetch("/quote?symbol=A&symbol=B&date=2026-10-29")[0], 400)


if __name__ == "__main__":
    unittest.main()
