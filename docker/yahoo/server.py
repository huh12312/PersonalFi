# SPDX-License-Identifier: MIT
"""The yahoo sidecar: Yahoo Finance through yfinance, opt-in (WP 12.6, D33).

docs/research/14-yahoo-finance-optional.md is the specification. The short
form: PersonalFi's api and worker are TypeScript; yfinance is Python and does
the cookie-and-crumb dance Yahoo requires. So it runs here, in its own
container, on its own compose network (`yahoo`), joined only by this service
and the worker, and only when the operator set YAHOO_FINANCE_ENABLED=true and
brought the `yahoo` profile up. The holder's consent is checked by the worker
before a request reaches this process; this process holds no state about the
holder and is told nothing about them beyond a symbol and a date.

Surface (JSON out, GET only, no state beyond the process):

    GET /health                       liveness and the budget; never calls Yahoo
    GET /quote?symbol=&date=          the latest daily close on or before date
    GET /fx?from=&to=&date=           the same for the pair `FROMTO=X`
    GET /search?q=                    symbol search

Controls, each tested in docker/yahoo/tests/:

  * **A host check before every outbound request.** `GuardedSession` is the
    only session yfinance is handed. It refuses any URL whose scheme is not
    https, whose host is not exactly query1.finance.yahoo.com or
    query2.finance.yahoo.com, or whose port is not 443, and it never lets
    curl follow a redirect: it reads the Location itself and applies the same
    check to it, so a redirect to a foreign host is refused, not followed.
    yfinance's cookie step also asks fc.yahoo.com and, failing that,
    guce.yahoo.com / consent.yahoo.com; those are refused like any other host.
    The refusal is a PermissionError (an OSError), which yfinance treats as a
    transient failure of a non-critical step, so it carries on without the
    cookie and the chart and search endpoints answer without one.
  * **A per-process budget**, 60 requests per sliding hour, counted per
    request that actually leaves (a refused URL costs nothing) — the same
    number as the worker's `YFINANCE_WINDOWS`, enforced here a second time.
  * **429 backoff**: a 429 from Yahoo starts an exponential backoff (one
    minute, doubling, at most an hour) during which every call is answered
    429 here without contacting Yahoo; a success resets it.
  * **Timeouts**: 15 seconds per outbound request, whatever yfinance asks.
  * No proxy, no environment: `trust_env=False`, and the proxy, DNS and
    interface arguments curl_cffi accepts are refused.

Only the standard library and yfinance (with its pinned closure). The image is
read-only; yfinance's caches live under /tmp, a tmpfs in compose.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import math
import re
import signal
import sys
import threading
import time
from collections import deque
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urljoin, urlsplit

ALLOWED_HOSTS = frozenset({"query1.finance.yahoo.com", "query2.finance.yahoo.com"})
ALLOWED_PORT = 443
OUTBOUND_TIMEOUT_S = 15.0
MAX_REDIRECT_HOPS = 3
BUDGET_LIMIT = 60
BUDGET_WINDOW_S = 3600.0
BACKOFF_BASE_S = 60.0
BACKOFF_MAX_S = 3600.0
LOOKBACK_DAYS = 7
BIND_HOST = "0.0.0.0"
BIND_PORT = 8000
CACHE_DIR = "/tmp/yfinance"

SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^=\-]{1,32}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# curl_cffi arguments that would route a request somewhere other than the
# host in its URL. None of them is ever legitimate here.
_REFUSED_KWARGS = ("proxy", "proxies", "proxy_auth", "dns", "doh_url", "interface")

log = logging.getLogger("yahoo-sidecar")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class HostNotAllowed(PermissionError):
    """An outbound URL failed the host check. Never reached the network."""


class BudgetSpent(Exception):
    """This process's own 60-per-hour budget said no."""

    def __init__(self, retry_after_s: float) -> None:
        super().__init__(f"the sidecar's own budget of {BUDGET_LIMIT} requests per hour is spent")
        self.retry_after_s = retry_after_s


class BackingOff(Exception):
    """Yahoo answered 429 recently; nothing leaves until the backoff ends."""

    def __init__(self, retry_after_s: float) -> None:
        super().__init__("Yahoo answered 429 Too Many Requests; backing off")
        self.retry_after_s = retry_after_s


class ShapeChanged(Exception):
    """Yahoo (or yfinance) answered something this service does not recognise."""


class NoData(Exception):
    """Yahoo answered, and has no close for the subject in the window."""


# ---------------------------------------------------------------------------
# The host check
# ---------------------------------------------------------------------------


def check_url(url: str) -> None:
    """Raise HostNotAllowed unless `url` is https, an allowed host, port 443."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise HostNotAllowed(f"refused a malformed URL ({error})") from None
    if parts.scheme != "https":
        raise HostNotAllowed(f"refused scheme {parts.scheme or '(none)'!r}: https only")
    if parts.username is not None or parts.password is not None:
        raise HostNotAllowed("refused a URL carrying credentials")
    host = (parts.hostname or "").rstrip(".").lower()
    if host not in ALLOWED_HOSTS:
        raise HostNotAllowed(f"refused host {host or '(none)'!r}: only {sorted(ALLOWED_HOSTS)}")
    if port is not None and port != ALLOWED_PORT:
        raise HostNotAllowed(f"refused port {port}: only {ALLOWED_PORT}")


# ---------------------------------------------------------------------------
# Budget and backoff
# ---------------------------------------------------------------------------


class RateBudget:
    """A sliding window: at most `limit` spends in any `window_s` seconds."""

    def __init__(self, limit: int = BUDGET_LIMIT, window_s: float = BUDGET_WINDOW_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window_s = window_s
        self._clock = clock
        self._spends: deque[float] = deque()
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        floor = now - self.window_s
        while self._spends and self._spends[0] <= floor:
            self._spends.popleft()

    def spend(self) -> None:
        """Record one request about to leave, or raise BudgetSpent."""
        with self._lock:
            now = self._clock()
            self._prune(now)
            if len(self._spends) >= self.limit:
                raise BudgetSpent(max(1.0, self._spends[0] + self.window_s - now))
            self._spends.append(now)

    def used(self) -> int:
        with self._lock:
            self._prune(self._clock())
            return len(self._spends)


class Backoff:
    """Exponential backoff after a 429: 60 s, 120 s, 240 s … at most an hour."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._hits = 0
        self._until = 0.0
        self._lock = threading.Lock()

    def hit(self) -> float:
        with self._lock:
            self._hits += 1
            delay = min(BACKOFF_BASE_S * (2 ** (self._hits - 1)), BACKOFF_MAX_S)
            self._until = self._clock() + delay
            return delay

    def reset(self) -> None:
        with self._lock:
            self._hits = 0
            self._until = 0.0

    def remaining(self) -> float:
        with self._lock:
            return max(0.0, self._until - self._clock())

    def check(self) -> None:
        remaining = self.remaining()
        if remaining > 0:
            raise BackingOff(remaining)


# ---------------------------------------------------------------------------
# The guarded session
# ---------------------------------------------------------------------------


def _session_base() -> type:
    from curl_cffi import requests as curl_requests

    return curl_requests.Session


def make_guarded_session_class(base: type) -> type:
    """Build GuardedSession over `base` (curl_cffi's Session in production)."""

    class GuardedSession(base):  # type: ignore[misc, valid-type]
        """The only session yfinance is given. See the module header."""

        def __init__(self, budget: RateBudget, backoff: Backoff, **kwargs: Any) -> None:
            kwargs.setdefault("impersonate", "chrome")
            kwargs["trust_env"] = False
            super().__init__(**kwargs)
            self._budget = budget
            self._backoff = backoff

        def _send(self, method: str, url: str, **kwargs: Any) -> Any:
            """The one call that opens a socket. Tests replace it."""
            return base.request(self, method, url, **kwargs)

        def request(self, method: str, url: str, *args: Any, **kwargs: Any) -> Any:  # noqa: D401
            if args:
                raise TypeError("GuardedSession.request takes keyword arguments only")
            for name in _REFUSED_KWARGS:
                if kwargs.get(name):
                    raise HostNotAllowed(f"refused the {name!r} argument: no proxy, no custom DNS")
                kwargs.pop(name, None)
            # Never let curl follow a redirect: the Location is checked below.
            kwargs["allow_redirects"] = False
            kwargs.pop("max_redirects", None)
            requested = kwargs.get("timeout")
            kwargs["timeout"] = (
                OUTBOUND_TIMEOUT_S
                if not isinstance(requested, (int, float)) or requested <= 0
                else min(float(requested), OUTBOUND_TIMEOUT_S)
            )
            current_method, current_url = method, url
            for _hop in range(MAX_REDIRECT_HOPS + 1):
                check_url(current_url)  # before any byte leaves, every hop
                self._backoff.check()
                self._budget.spend()
                response = self._send(current_method, current_url, **kwargs)
                status = int(getattr(response, "status_code", 0))
                if status == 429:
                    self._backoff.hit()
                    return response
                if 300 <= status < 400:
                    location = _header(response, "location")
                    if not location:
                        return response
                    current_url = urljoin(current_url, location)
                    if status in (301, 302, 303):
                        current_method = "GET"
                        kwargs.pop("data", None)
                        kwargs.pop("json", None)
                        kwargs.pop("content", None)
                    continue
                return response
            raise HostNotAllowed(f"refused: more than {MAX_REDIRECT_HOPS} redirects")

    return GuardedSession


def _header(response: Any, name: str) -> Optional[str]:
    headers = getattr(response, "headers", None) or {}
    try:
        value = headers.get(name)
        if value is None:
            value = headers.get(name.title())
    except AttributeError:
        value = None
    return value


# ---------------------------------------------------------------------------
# The yfinance layer
# ---------------------------------------------------------------------------


def decimal_string(value: Any) -> str:
    """A float from pandas as a plain decimal string: shortest round-trip, no exponent."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ShapeChanged(f"a close was {type(value).__name__}, not a number")
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        raise ShapeChanged("a close was not a finite number")
    try:
        text = format(Decimal(repr(value)), "f")
    except InvalidOperation as error:  # pragma: no cover - repr of a finite float always parses
        raise ShapeChanged(str(error)) from None
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


class YahooFinance:
    """The three calls the PriceSource port has, through yfinance."""

    def __init__(self, session_factory: Callable[[], Any]) -> None:
        self._session_factory = session_factory
        self._session: Any = None
        self._lock = threading.Lock()

    def _get_session(self) -> Any:
        if self._session is None:
            self._session = self._session_factory()
        return self._session

    def daily_closes(self, symbol: str, start: _dt.date, end: _dt.date) -> tuple[Optional[str], list[tuple[str, str]]]:
        import yfinance as yf
        from yfinance import exceptions as yf_exceptions

        with self._lock:
            ticker = yf.Ticker(symbol, session=self._get_session())
            try:
                frame = ticker.history(
                    start=start.isoformat(),
                    end=(end + _dt.timedelta(days=1)).isoformat(),
                    interval="1d",
                    auto_adjust=False,
                    actions=False,
                )
            except (yf_exceptions.YFPricesMissingError, yf_exceptions.YFTzMissingError) as error:
                raise NoData(str(error)) from None
            if frame is None or getattr(frame, "empty", True):
                return None, []
            if "Close" not in getattr(frame, "columns", []):
                raise ShapeChanged("the history frame has no Close column")
            # A mapping-like HistoryMetadata in yfinance 1.7, a dict before it.
            metadata = ticker.get_history_metadata()
        getter = getattr(metadata, "get", None)
        currency = getter("currency") if callable(getter) else None
        rows: list[tuple[str, str]] = []
        for index, value in frame["Close"].items():
            if isinstance(value, float) and math.isnan(value):
                continue
            day = getattr(index, "date", None)
            if day is None:
                raise ShapeChanged("the history index is not dated")
            rows.append((day().isoformat(), decimal_string(value)))
        return (currency if isinstance(currency, str) else None), rows

    def search(self, query: str) -> list[dict[str, Optional[str]]]:
        import yfinance as yf

        with self._lock:
            result = yf.Search(
                query,
                max_results=10,
                news_count=0,
                lists_count=0,
                include_cb=False,
                recommended=0,
                session=self._get_session(),
                timeout=int(OUTBOUND_TIMEOUT_S),
                raise_errors=True,
            )
            quotes = result.quotes
        if not isinstance(quotes, list):
            raise ShapeChanged("search answered no list of quotes")
        hits: list[dict[str, Optional[str]]] = []
        for quote in quotes:
            if not isinstance(quote, dict) or not isinstance(quote.get("symbol"), str):
                continue
            name = quote.get("longname") or quote.get("shortname")
            hits.append({
                "symbol": quote["symbol"],
                "name": name if isinstance(name, str) else None,
                "kind": quote.get("quoteType") if isinstance(quote.get("quoteType"), str) else None,
                "exchange": quote.get("exchange") if isinstance(quote.get("exchange"), str) else None,
            })
        return hits


# ---------------------------------------------------------------------------
# The service: validation, then one call, then a JSON answer
# ---------------------------------------------------------------------------


class Service:
    def __init__(self, yahoo: Any, budget: RateBudget, backoff: Backoff, version: str) -> None:
        self.yahoo = yahoo
        self.budget = budget
        self.backoff = backoff
        self.version = version

    def health(self) -> tuple[int, dict[str, Any]]:
        return 200, {
            "status": "ok",
            "yfinance": self.version,
            "budget": {"used": self.budget.used(), "limit": self.budget.limit,
                       "windowSeconds": int(self.budget.window_s)},
            "backoffSeconds": int(math.ceil(self.backoff.remaining())),
        }

    def quote(self, params: dict[str, str]) -> tuple[int, dict[str, Any]]:
        symbol = params.get("symbol", "")
        if not SYMBOL_RE.match(symbol):
            return _bad("symbol must be 1-32 of A-Z a-z 0-9 . ^ = -")
        day = _date(params.get("date", ""))
        if day is None:
            return _bad("date must be YYYY-MM-DD")
        return self._close(symbol, day, lambda bar_date, close, currency: {
            "symbol": symbol, "date": bar_date, "close": close, "currency": currency,
            "stale": bar_date != day.isoformat(),
        })

    def fx(self, params: dict[str, str]) -> tuple[int, dict[str, Any]]:
        base, quote = params.get("from", ""), params.get("to", "")
        if not CURRENCY_RE.match(base) or not CURRENCY_RE.match(quote) or base == quote:
            return _bad("from and to must be two different ISO-4217 codes")
        day = _date(params.get("date", ""))
        if day is None:
            return _bad("date must be YYYY-MM-DD")
        return self._close(f"{base}{quote}=X", day, lambda bar_date, rate, _currency: {
            "from": base, "to": quote, "date": bar_date, "rate": rate,
            "stale": bar_date != day.isoformat(),
        })

    def search(self, params: dict[str, str]) -> tuple[int, dict[str, Any]]:
        query = params.get("q", "")
        if not (1 <= len(query) <= 64) or any(ord(ch) < 32 or ord(ch) == 127 for ch in query):
            return _bad("q must be 1-64 printable characters")
        return self._guarded(lambda: (200, {"results": self.yahoo.search(query)}))

    def _close(self, symbol: str, day: _dt.date,
               shape: Callable[[str, str, Optional[str]], dict[str, Any]]) -> tuple[int, dict[str, Any]]:
        def run() -> tuple[int, dict[str, Any]]:
            start = day - _dt.timedelta(days=LOOKBACK_DAYS)
            currency, rows = self.yahoo.daily_closes(symbol, start, day)
            wanted = day.isoformat()
            best: Optional[tuple[str, str]] = None
            for bar_date, close in rows:
                if not DATE_RE.match(bar_date) or bar_date > wanted:
                    continue
                if best is None or bar_date > best[0]:
                    best = (bar_date, close)
            if best is None:
                raise NoData(f"no close in the {LOOKBACK_DAYS} days to {wanted}")
            if currency is not None and not CURRENCY_RE.match(currency.upper()):
                raise ShapeChanged("the currency is not an ISO-4217 code")
            return 200, shape(best[0], best[1], currency.upper() if currency else None)

        return self._guarded(run)

    def _guarded(self, run: Callable[[], tuple[int, dict[str, Any]]]) -> tuple[int, dict[str, Any]]:
        try:
            self.backoff.check()
            status, body = run()
            self.backoff.reset()
            return status, body
        except BackingOff as error:
            return 429, {"error": "rate_limited", "detail": str(error),
                         "retryAfterSeconds": int(math.ceil(error.retry_after_s))}
        except BudgetSpent as error:
            return 429, {"error": "budget_spent", "detail": str(error),
                         "retryAfterSeconds": int(math.ceil(error.retry_after_s))}
        except HostNotAllowed as error:
            return 502, {"error": "host_refused", "detail": str(error)}
        except NoData as error:
            return 404, {"error": "no_data", "detail": _short(str(error))}
        except ShapeChanged as error:
            return 502, {"error": "shape_changed", "detail": _short(str(error))}
        except Exception as error:  # noqa: BLE001 - every other failure is upstream's
            name = type(error).__name__
            if name == "YFRateLimitError":
                delay = self.backoff.hit() if self.backoff.remaining() <= 0 else self.backoff.remaining()
                return 429, {"error": "rate_limited",
                             "detail": "Yahoo answered 429 Too Many Requests; backing off",
                             "retryAfterSeconds": int(math.ceil(delay))}
            if isinstance(error, HostNotAllowed) or isinstance(error.__cause__, HostNotAllowed):
                return 502, {"error": "host_refused", "detail": _short(str(error))}
            if isinstance(error, (KeyError, IndexError, TypeError, AttributeError, ValueError)):
                return 502, {"error": "shape_changed", "detail": _short(f"{name}: {error}")}
            return 502, {"error": "upstream_error", "detail": _short(f"{name}: {error}")}


def _bad(detail: str) -> tuple[int, dict[str, Any]]:
    return 400, {"error": "bad_request", "detail": detail}


def _date(text: str) -> Optional[_dt.date]:
    if not DATE_RE.match(text):
        return None
    try:
        return _dt.date.fromisoformat(text)
    except ValueError:
        return None


def _short(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= 300 else flat[:300] + "…"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def make_handler(service: Service) -> type:
    routes: dict[str, Callable[[dict[str, str]], tuple[int, dict[str, Any]]]] = {
        "/quote": service.quote,
        "/fx": service.fx,
        "/search": service.search,
    }

    class Handler(BaseHTTPRequestHandler):
        server_version = "personalfi-yahoo"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
            started = time.monotonic()
            parts = urlsplit(self.path)
            if parts.path == "/health":
                status, body = service.health()
            elif parts.path in routes:
                raw = parse_qs(parts.query, keep_blank_values=True, max_num_fields=8)
                if any(len(values) != 1 for values in raw.values()):
                    status, body = _bad("each parameter once")
                else:
                    status, body = routes[parts.path]({key: values[0] for key, values in raw.items()})
            else:
                status, body = 404, {"error": "not_found", "detail": "no such path"}
            self._send(status, body)
            # Path and status only: the symbol is the holder's business.
            log.info(json.dumps({"path": parts.path, "status": status,
                                 "ms": int((time.monotonic() - started) * 1000)}))

        def _refuse(self) -> None:
            self._send(405, {"error": "method_not_allowed", "detail": "GET only"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _refuse  # noqa: N815

        def _send(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.send_header("cache-control", "no-store")
            if status == 429 and "retryAfterSeconds" in body:
                self.send_header("retry-after", str(body["retryAfterSeconds"]))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
            return  # the stdlib's access log would print the query string

    return Handler


def build_service() -> Service:
    import warnings

    import yfinance as yf

    # yfinance 1.7 calls a pandas method pandas 3.1 deprecates; the warning is
    # about yfinance's code, not ours, and would print on every request.
    warnings.filterwarnings("ignore", category=DeprecationWarning, module="yfinance")
    warnings.filterwarnings("ignore", category=FutureWarning, module="yfinance")

    yf.config.debug.hide_exceptions = False
    yf.config.network.retries = 0
    try:
        yf.set_tz_cache_location(CACHE_DIR)
    except Exception:  # noqa: BLE001 - yfinance falls back to an in-memory cache
        log.warning(json.dumps({"event": "tz cache unavailable; in-memory only"}))
    budget = RateBudget()
    backoff = Backoff()
    session_class = make_guarded_session_class(_session_base())
    yahoo = YahooFinance(lambda: session_class(budget, backoff))
    return Service(yahoo, budget, backoff, yf.__version__)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    service = build_service()
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), make_handler(service))
    server.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info(json.dumps({"event": "listening", "port": BIND_PORT, "yfinance": service.version,
                         "hosts": sorted(ALLOWED_HOSTS)}))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
