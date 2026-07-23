"""yfinance news collector plus backwards-compatible Markdown wrappers."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

import yfinance as yf

from .config import get_config
from .news_common import (
    NewsAggregationResult,
    NewsItem,
    SourceStatus,
    ensure_utc,
    format_news_report,
    normalize_filter_dedupe,
    parse_timestamp,
    ticker_window_timezone,
    utc_now,
)
from .stockstats_utils import yf_retry
from .symbol_utils import normalize_symbol

_COMPANY_STOPWORDS = {
    "company",
    "corporation",
    "corp",
    "group",
    "holdings",
    "inc",
    "incorporated",
    "international",
    "limited",
    "ltd",
    "plc",
    "the",
}


def _article_symbols(article: dict) -> set[str]:
    """Extract exact related-ticker metadata when Yahoo provides it."""
    content = article.get("content") if isinstance(article.get("content"), dict) else article
    finance = content.get("finance", {}) if isinstance(content, dict) else {}
    candidates: list[Any] = []
    for value in (
        article.get("relatedTickers"),
        content.get("relatedTickers") if isinstance(content, dict) else None,
        finance.get("stockTickers") if isinstance(finance, dict) else None,
    ):
        if isinstance(value, list):
            candidates.extend(value)

    symbols: set[str] = set()
    for candidate in candidates:
        if isinstance(candidate, str):
            symbol = candidate
        elif isinstance(candidate, dict):
            symbol = candidate.get("symbol") or candidate.get("ticker")
        else:
            continue
        if symbol:
            symbols.add(str(symbol).strip().upper())
    return symbols


def _extract_article_data(article: dict) -> dict:
    """Normalize flat and nested Yahoo news payloads without filtering them."""
    if "content" in article and isinstance(article["content"], dict):
        content = article["content"]
        provider = content.get("provider", {})
        if not isinstance(provider, dict):
            provider = {}
        url_obj = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
        link = url_obj.get("url", "") if isinstance(url_obj, dict) else url_obj
        return {
            "title": content.get("title", "No title"),
            "summary": content.get("summary") or content.get("description") or "",
            "publisher": provider.get("displayName", "Unknown"),
            "link": link,
            "pub_date": parse_timestamp(content.get("pubDate")),
            "symbols": _article_symbols(article),
        }

    return {
        "title": article.get("title", "No title"),
        "summary": article.get("summary", ""),
        "publisher": article.get("publisher", "Unknown"),
        "link": article.get("link", ""),
        "pub_date": parse_timestamp(article.get("providerPublishTime")),
        "symbols": _article_symbols(article),
    }


def _company_aliases(quotes: list[dict], canonical: str) -> set[str]:
    aliases: set[str] = set()
    for quote in quotes:
        if not isinstance(quote, dict) or str(quote.get("symbol", "")).upper() != canonical.upper():
            continue
        for field in (
            "shortname",
            "longname",
            "shortName",
            "longName",
            "displayName",
            "name",
        ):
            value = " ".join(str(quote.get(field) or "").split()).strip()
            if not value:
                continue
            aliases.add(value.casefold())
            words = re.findall(r"[^\W_]+", value.casefold(), flags=re.UNICODE)
            for word in words:
                if len(word) >= 4 and word not in _COMPANY_STOPWORDS:
                    aliases.add(word)
    return aliases


def _text_has_exact_term(text: str, term: str) -> bool:
    if not term:
        return False
    return re.search(rf"(?<!\w){re.escape(term.casefold())}(?!\w)", text.casefold()) is not None


def _is_ticker_relevant(data: dict, ticker: str, canonical: str, aliases: set[str]) -> bool:
    symbols = data["symbols"]
    ticker_candidates = {ticker.upper(), canonical.upper()}
    base = canonical.upper().split(".", 1)[0]
    if base:
        ticker_candidates.add(base)
    if symbols:
        return bool(ticker_candidates & symbols)

    text = f"{data['title']} {data['summary']}"
    if any(_text_has_exact_term(text, candidate) for candidate in ticker_candidates):
        return True
    return any(_text_has_exact_term(text, alias) for alias in aliases)


def _in_news_window(pub_date, start_dt, end_dt) -> bool:
    """Compatibility helper for callers/tests using datetime window objects."""
    if pub_date is not None:
        published = ensure_utc(pub_date)
        start = ensure_utc(start_dt)
        end = ensure_utc(end_dt) + timedelta(days=1)
        return start <= published <= end
    # Preserve the previous live-window behavior for direct helper callers.
    return ensure_utc(end_dt) >= utc_now() - timedelta(days=1)


def fetch_ticker_news_yfinance(
    ticker: str,
    *,
    limit: int,
    fetched_at: datetime,
) -> list[NewsItem]:
    """Collect dated ticker news as NewsItems; network errors propagate."""
    canonical = normalize_symbol(ticker)
    stock = yf.Ticker(canonical)
    aliases: set[str] = set()
    raw_news: list[dict] = []
    try:
        search = yf_retry(
            lambda: yf.Search(
                query=canonical,
                news_count=limit,
                enable_fuzzy_query=False,
            )
        )
        raw_news = list(getattr(search, "news", None) or [])
        aliases.update(_company_aliases(list(getattr(search, "quotes", None) or []), canonical))
    except Exception:  # noqa: BLE001 - the ticker endpoint remains a best-effort fallback
        raw_news = []

    if not raw_news:
        raw_news = yf_retry(lambda: stock.get_news(count=limit)) or []
    if not aliases:
        try:
            info = stock.get_info() or {}
        except Exception:  # noqa: BLE001 - relevance falls back to exact ticker text
            info = {}
        aliases.update(_company_aliases([{"symbol": canonical, **info}], canonical))

    items: list[NewsItem] = []
    for article in raw_news:
        if not isinstance(article, dict):
            continue
        data = _extract_article_data(article)
        published_at = data["pub_date"]
        if published_at is None:
            # A dated citation is required by the canonical contract.  Keeping
            # an undated item would make look-ahead/age checks unverifiable.
            continue
        if not _is_ticker_relevant(data, ticker, canonical, aliases):
            continue
        items.append(
            NewsItem(
                title=data["title"],
                summary=data["summary"],
                url=data["link"],
                source=data["publisher"] or "Yahoo Finance",
                published_at=published_at,
                fetched_at=fetched_at,
                ticker=ticker,
                source_tier="aggregator",
            )
        )
    return items


def fetch_global_news_yfinance(
    *,
    queries: list[str],
    limit: int,
    fetched_at: datetime,
) -> list[NewsItem]:
    """Collect dated global-market search results as NewsItems."""
    items: list[NewsItem] = []
    for query in queries:
        search = yf_retry(
            lambda q=query: yf.Search(
                query=q,
                news_count=limit,
                enable_fuzzy_query=True,
            )
        )
        for article in getattr(search, "news", None) or []:
            if not isinstance(article, dict):
                continue
            data = _extract_article_data(article)
            if data["pub_date"] is None:
                continue
            items.append(
                NewsItem(
                    title=data["title"],
                    summary=data["summary"],
                    url=data["link"],
                    source=data["publisher"] or "Yahoo Finance",
                    published_at=data["pub_date"],
                    fetched_at=fetched_at,
                    ticker=None,
                    source_tier="aggregator",
                )
            )
    return items


def get_news_yfinance(ticker: str, start_date: str, end_date: str) -> str:
    """Retrieve ticker news using only yfinance (legacy vendor entry point)."""
    config = get_config()
    limit = config["news_article_limit"]
    fetched_at = utc_now()
    canonical = normalize_symbol(ticker)
    window_timezone = ticker_window_timezone(canonical)
    resolved = "" if canonical == ticker else f" (resolved to {canonical})"
    try:
        collected = fetch_ticker_news_yfinance(
            ticker,
            limit=limit,
            fetched_at=fetched_at,
        )
        items = normalize_filter_dedupe(
            collected,
            start_date,
            end_date,
            fetched_at=fetched_at,
            limit=limit,
            window_timezone=window_timezone,
        )
        status = SourceStatus(
            "Yahoo Finance",
            "ok" if collected else "empty",
            len(collected),
        )
    except Exception as exc:  # noqa: BLE001 - represented as source health, not "no news"
        items = []
        status = SourceStatus(
            "Yahoo Finance",
            "failed",
            detail=f"request failed ({type(exc).__name__})",
        )
    result = NewsAggregationResult(
        items=items,
        source_statuses=[status],
        fetched_at=fetched_at,
        start_date=start_date,
        end_date=end_date,
        ticker=ticker.upper(),
    )
    return format_news_report(
        result,
        f"{ticker}{resolved} News, from {start_date} to {end_date}",
    )


def get_global_news_yfinance(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    """Retrieve global news using only yfinance (legacy vendor entry point)."""
    config = get_config()
    look_back_days = (
        config["global_news_lookback_days"] if look_back_days is None else look_back_days
    )
    limit = config["global_news_article_limit"] if limit is None else limit
    curr_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    start_date = (curr_dt - timedelta(days=look_back_days)).strftime("%Y-%m-%d")
    fetched_at = utc_now()
    try:
        collected = fetch_global_news_yfinance(
            queries=config["global_news_queries"],
            limit=limit,
            fetched_at=fetched_at,
        )
        items = normalize_filter_dedupe(
            collected,
            start_date,
            curr_date,
            fetched_at=fetched_at,
            limit=limit,
        )
        status = SourceStatus(
            "Yahoo Finance",
            "ok" if collected else "empty",
            len(collected),
        )
    except Exception as exc:  # noqa: BLE001 - represented as source health, not "no news"
        items = []
        status = SourceStatus(
            "Yahoo Finance",
            "failed",
            detail=f"request failed ({type(exc).__name__})",
        )
    result = NewsAggregationResult(
        items=items,
        source_statuses=[status],
        fetched_at=fetched_at,
        start_date=start_date,
        end_date=curr_date,
        query_type="global",
    )
    return format_news_report(
        result,
        f"Global Market News, from {start_date} to {curr_date}",
    )
