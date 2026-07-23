"""Shared news schema, normalization, filtering, and presentation helpers.

The agent-facing tools still return Markdown strings, but all collectors first
produce :class:`NewsItem` objects.  Keeping one canonical representation avoids
vendor-specific timestamp/link fields leaking into prompts or public exports.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

UTC = timezone.utc

_TRACKING_QUERY_KEYS = {
    "cmpid",
    "guccounter",
    "guce_referrer",
    "guce_referrer_sig",
    "ncid",
    "soc_src",
    "soc_trk",
}
_SOURCE_TIER_RANK = {"primary": 3, "publisher": 2, "aggregator": 1}


def utc_now() -> datetime:
    """Return an aware UTC timestamp (separate helper for deterministic tests)."""
    return datetime.now(UTC)


def ensure_utc(value: datetime) -> datetime:
    """Normalize a datetime to aware UTC; naive vendor values are assumed UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_timestamp(value: Any) -> datetime | None:
    """Parse common vendor, SEC, RSS, and epoch timestamps into aware UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return ensure_utc(value)
    if isinstance(value, date):
        return datetime.combine(value, time.min, tzinfo=UTC)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=UTC)
        except (OSError, OverflowError, ValueError):
            return None

    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d{10}|\d{13}", text):
        epoch = int(text)
        if len(text) == 13:
            epoch /= 1000
        try:
            return datetime.fromtimestamp(epoch, tz=UTC)
        except (OSError, OverflowError, ValueError):
            return None

    iso_text = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return ensure_utc(datetime.fromisoformat(iso_text))
    except ValueError:
        pass

    for fmt in (
        "%Y%m%dT%H%M%S",
        "%Y%m%dT%H%M",
        "%Y%m%d%H%M%S",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue

    try:
        return ensure_utc(parsedate_to_datetime(text))
    except (TypeError, ValueError, OverflowError):
        return None


def isoformat_utc(value: datetime) -> str:
    """Serialize an aware timestamp with a compact, explicit UTC suffix."""
    return ensure_utc(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean_text(value: Any) -> str:
    """Collapse whitespace and remove control characters from vendor text."""
    if value is None:
        return ""
    return " ".join(str(value).replace("\x00", " ").split()).strip()


def canonicalize_url(value: Any) -> str:
    """Validate a citation URL without rewriting its potentially signed query."""
    url = clean_text(value)
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return ""
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, "")
    )


@dataclass
class NewsItem:
    """Vendor-neutral news record used by agents and structured exports."""

    title: str
    summary: str
    url: str
    source: str
    published_at: datetime
    fetched_at: datetime
    ticker: str | None
    source_tier: str

    def __post_init__(self) -> None:
        self.title = clean_text(self.title)
        self.summary = clean_text(self.summary)
        self.url = canonicalize_url(self.url)
        self.source = clean_text(self.source) or "Unknown"
        self.published_at = ensure_utc(self.published_at)
        self.fetched_at = ensure_utc(self.fetched_at)
        self.ticker = clean_text(self.ticker).upper() if self.ticker else None
        self.source_tier = clean_text(self.source_tier).lower() or "aggregator"

    def to_dict(self) -> dict[str, str | None]:
        """Return the stable JSON-ready NewsItem contract."""
        return {
            "title": self.title,
            "summary": self.summary,
            "url": self.url,
            "source": self.source,
            "published_at": isoformat_utc(self.published_at),
            "fetched_at": isoformat_utc(self.fetched_at),
            "ticker": self.ticker,
            "source_tier": self.source_tier,
        }


@dataclass
class SourceStatus:
    """One collector's outcome, kept separate from the returned item count."""

    source: str
    status: str
    item_count: int = 0
    detail: str = ""

    def to_dict(self) -> dict[str, str | int]:
        result: dict[str, str | int] = {
            "source": self.source,
            "status": self.status,
            "item_count": self.item_count,
        }
        if self.detail:
            result["detail"] = self.detail
        return result


@dataclass
class NewsAggregationResult:
    """Structured result with items plus per-source health/provenance."""

    items: list[NewsItem]
    source_statuses: list[SourceStatus]
    fetched_at: datetime
    start_date: str
    end_date: str
    ticker: str | None = None
    query_type: str = "ticker"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def status(self) -> str:
        degraded = any(
            s.status in {"failed", "not_configured", "unsupported"}
            for s in self.source_statuses
        )
        responded = any(s.status in {"ok", "empty"} for s in self.source_statuses)
        if self.items:
            return "partial" if degraded else "ok"
        if degraded and not responded:
            return "unavailable"
        if degraded:
            return "partial_empty"
        return "empty"

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": self.status,
            "query_type": self.query_type,
            "ticker": self.ticker,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "fetched_at": isoformat_utc(self.fetched_at),
            "items": [item.to_dict() for item in self.items],
            "source_statuses": [status.to_dict() for status in self.source_statuses],
        }
        if self.metadata:
            result["metadata"] = self.metadata
        return result


def ticker_window_timezone(ticker: str) -> str:
    """Return the publication-calendar timezone for a ticker's exchange."""
    symbol = ticker.strip().upper()
    for suffix, timezone_name in (
        ((".SS", ".SZ"), "Asia/Shanghai"),
        ((".HK",), "Asia/Hong_Kong"),
        ((".T",), "Asia/Tokyo"),
        ((".L",), "Europe/London"),
        ((".TO",), "America/Toronto"),
        ((".AX",), "Australia/Sydney"),
        ((".NS", ".BO"), "Asia/Kolkata"),
    ):
        if symbol.endswith(suffix):
            return timezone_name
    if "=" in symbol or symbol.endswith("-USD"):
        return "UTC"
    return "America/New_York"


def _window_bounds(
    start_date: str,
    end_date: str,
    window_timezone: str,
) -> tuple[datetime, datetime]:
    zone = ZoneInfo(window_timezone)
    start = datetime.combine(
        datetime.strptime(start_date, "%Y-%m-%d").date(),
        time.min,
        tzinfo=zone,
    ).astimezone(UTC)
    end_day = datetime.strptime(end_date, "%Y-%m-%d").date()
    end = datetime.combine(end_day, time.max, tzinfo=zone).astimezone(UTC)
    if start > end:
        raise ValueError(f"start_date {start_date!r} must not be after end_date {end_date!r}")
    return start, end


def validate_news_window(
    start_date: str,
    end_date: str,
    window_timezone: str = "UTC",
) -> None:
    """Validate a requested window before collectors perform network work."""
    _window_bounds(start_date, end_date, window_timezone)


def latest_feed_supports_window(
    end_date: str,
    fetched_at: datetime,
    window_timezone: str,
    *,
    grace_days: int = 1,
) -> bool:
    """Whether a latest-only feed can honestly cover the requested end date."""
    requested_end = datetime.strptime(end_date, "%Y-%m-%d").date()
    local_today = ensure_utc(fetched_at).astimezone(ZoneInfo(window_timezone)).date()
    return requested_end >= local_today - timedelta(days=grace_days)


def timestamp_in_window(
    published_at: datetime,
    start_date: str,
    end_date: str,
    window_timezone: str = "UTC",
) -> bool:
    """Check a publication timestamp against an exchange-calendar date window."""
    start, end = _window_bounds(start_date, end_date, window_timezone)
    return start <= ensure_utc(published_at) <= end


def _title_key(title: str) -> str:
    # ``\w`` is Unicode-aware, so Chinese and other non-Latin headlines are
    # de-duplicated too (an ASCII-only key silently missed them).
    return re.sub(r"[\W_]+", " ", title.casefold()).strip()


def _url_key(url: str) -> str:
    """Build a de-duplication key while leaving the output citation untouched."""
    if not url:
        return ""
    parts = urlsplit(url)
    query = []
    for key, val in parse_qsl(parts.query, keep_blank_values=True):
        low = key.lower()
        if low.startswith("utm_") or low in _TRACKING_QUERY_KEYS:
            continue
        query.append((key, val))
    return urlunsplit(
        (parts.scheme.lower(), parts.netloc.lower(), parts.path, urlencode(sorted(query)), "")
    )


def normalize_filter_dedupe(
    items: list[NewsItem],
    start_date: str,
    end_date: str,
    *,
    fetched_at: datetime,
    limit: int,
    future_tolerance: timedelta = timedelta(minutes=5),
    window_timezone: str = "UTC",
) -> list[NewsItem]:
    """Apply the date guard and deterministic cross-source de-duplication."""
    start, requested_end = _window_bounds(start_date, end_date, window_timezone)
    future_ceiling = ensure_utc(fetched_at) + future_tolerance
    end = min(requested_end, future_ceiling)

    eligible = [
        item
        for item in items
        if item.title and item.url and start <= item.published_at <= end
    ]

    # Process the highest-quality candidate first so a primary-source document
    # wins over an aggregator copy with the same URL/title.
    eligible.sort(
        key=lambda item: (
            _SOURCE_TIER_RANK.get(item.source_tier, 0),
            bool(item.url),
            len(item.summary),
            item.published_at,
        ),
        reverse=True,
    )
    kept: list[NewsItem] = []
    seen_urls: set[str] = set()
    seen_titles: set[str] = set()
    for item in eligible:
        url_key = _url_key(item.url)
        title_key = _title_key(item.title)
        if (url_key and url_key in seen_urls) or (title_key and title_key in seen_titles):
            continue
        kept.append(item)
        if url_key:
            seen_urls.add(url_key)
        if title_key:
            seen_titles.add(title_key)

    kept.sort(key=lambda item: item.published_at, reverse=True)
    return kept[: max(0, limit)]


def format_news_report(result: NewsAggregationResult, heading: str) -> str:
    """Render structured news for the existing LangChain string tool surface."""
    lines = [f"## {heading}", "", f"Retrieval status: {result.status.upper()}"]
    lines.append("Source status:")
    for status in result.source_statuses:
        detail = f"; {status.detail}" if status.detail else ""
        lines.append(
            f"- {status.source}: {status.status} ({status.item_count} collected{detail})"
        )

    if not result.items:
        lines.append("")
        if result.status == "unavailable":
            lines.append(
                "NEWS_DATA_UNAVAILABLE: every configured news source failed, was not "
                "configured, or cannot cover this window. This is a coverage failure, not "
                "evidence that no news exists."
            )
        elif result.status == "partial_empty":
            lines.append(
                "NEWS_PARTIALLY_UNAVAILABLE: responding sources returned no qualifying items, "
                "but at least one configured source failed. Do not describe this as confirmed "
                "absence of news."
            )
        else:
            lines.append(
                "NO_RELEVANT_NEWS: configured sources responded successfully, but no dated, "
                "relevant items survived the requested time window and quality filters."
            )
        return "\n".join(lines)

    for item in result.items:
        lines.extend(
            [
                "",
                f"### {item.title}",
                f"- Source: {item.source} ({item.source_tier})",
                f"- Published: {isoformat_utc(item.published_at)}",
                f"- URL: {item.url or 'URL unavailable'}",
            ]
        )
        if item.summary:
            lines.append(item.summary)
    return "\n".join(lines)
