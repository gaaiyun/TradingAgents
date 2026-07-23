"""Keyless Google News RSS collector with A-share name resolution.

Google News is treated as an aggregator, never as the original publisher.  A
public Eastmoney quote-name endpoint is used only to turn six-digit A-share
codes into a company-name query; failures fall back to an exact ticker query.
"""

from __future__ import annotations

import html
import re
from datetime import datetime
from urllib.parse import urlencode
from xml.etree import ElementTree

import requests

from .news_common import NewsItem, clean_text, parse_timestamp, timestamp_in_window
from .symbol_utils import normalize_symbol

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"


def _strip_markup(value: str) -> str:
    return clean_text(html.unescape(re.sub(r"<[^>]+>", " ", value or "")))


def _a_share_identity(ticker: str) -> tuple[str, str] | None:
    canonical = normalize_symbol(ticker).upper()
    match = re.fullmatch(r"(\d{6})\.(SS|SZ)", canonical)
    return (match.group(1), match.group(2)) if match else None


def resolve_a_share_name(ticker: str, *, timeout: int, user_agent: str) -> str:
    """Resolve an A-share's Chinese short name without an API key."""
    identity = _a_share_identity(ticker)
    if identity is None:
        return ""
    code, exchange = identity
    response = requests.get(
        EASTMONEY_QUOTE,
        params={"secid": f"{'1' if exchange == 'SS' else '0'}.{code}", "fields": "f57,f58"},
        headers={"User-Agent": user_agent, "Accept": "application/json"},
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        return ""
    return clean_text(payload["data"].get("f58"))


def _query_terms(ticker: str, company_name: str) -> tuple[str, set[str]]:
    canonical = normalize_symbol(ticker).upper()
    base = canonical.split(".", 1)[0]
    terms = {base.casefold(), canonical.casefold()}
    if company_name:
        terms.add(company_name.casefold())
        return f'"{company_name}" OR "{base}"', terms
    return f'"{base}" stock', terms


def _relevant(text: str, terms: set[str]) -> bool:
    lowered = text.casefold()
    return any(re.search(rf"(?<!\w){re.escape(term)}(?!\w)", lowered) for term in terms)


def fetch_ticker_news_google(
    ticker: str,
    *,
    start_date: str,
    end_date: str,
    fetched_at: datetime,
    limit: int,
    timeout: int,
    user_agent: str,
    window_timezone: str,
) -> list[NewsItem]:
    """Fetch dated ticker headlines from the public Google News RSS surface."""
    try:
        company_name = resolve_a_share_name(ticker, timeout=timeout, user_agent=user_agent)
    except Exception:  # name resolution is optional; the RSS request remains useful
        company_name = ""
    query, terms = _query_terms(ticker, company_name)
    is_a_share = _a_share_identity(ticker) is not None
    params = {
        "q": query,
        "hl": "zh-CN" if is_a_share else "en-US",
        "gl": "CN" if is_a_share else "US",
        "ceid": "CN:zh-Hans" if is_a_share else "US:en",
    }
    response = requests.get(
        f"{GOOGLE_NEWS_RSS}?{urlencode(params)}",
        headers={"User-Agent": user_agent, "Accept": "application/rss+xml, application/xml"},
        timeout=timeout,
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    items: list[NewsItem] = []
    for node in root.findall(".//item"):
        title = clean_text(node.findtext("title"))
        summary = _strip_markup(node.findtext("description") or "")
        published_at = parse_timestamp(node.findtext("pubDate"))
        if not title or published_at is None:
            continue
        if not timestamp_in_window(published_at, start_date, end_date, window_timezone):
            continue
        if not _relevant(f"{title} {summary}", terms):
            continue
        source_node = node.find("source")
        publisher = clean_text(source_node.text if source_node is not None else "")
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -(len(publisher) + 3)].strip()
        items.append(
            NewsItem(
                title=title,
                summary=summary,
                url=clean_text(node.findtext("link")),
                source=f"Google News / {publisher or 'publisher'}",
                published_at=published_at,
                fetched_at=fetched_at,
                ticker=ticker,
                source_tier="aggregator",
            )
        )
        if len(items) >= limit:
            break
    return items
