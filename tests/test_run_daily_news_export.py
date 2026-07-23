"""Offline checks for the daily static-news export."""

import importlib.util
import json
from pathlib import Path

import pytest


def _load_runner():
    script = Path(__file__).parents[1] / "scripts" / "run_daily.py"
    spec = importlib.util.spec_from_file_location("run_daily_news_export", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _bundle(*, query_type, ticker, status="ok", items=None, source_statuses=None):
    return {
        "status": status,
        "query_type": query_type,
        "ticker": ticker,
        "start_date": "2026-07-22",
        "end_date": "2026-07-22",
        "fetched_at": "2026-07-22T08:00:00Z",
        "items": items or [],
        "source_statuses": source_statuses or [
            {"source": "Test source", "status": "ok", "item_count": len(items or [])}
        ],
    }


def _item(title, url, *, ticker=None, published_at="2026-07-22T08:00:00Z"):
    return {
        "title": title,
        "summary": f"Summary: {title}",
        "url": url,
        "source": "Test wire",
        "published_at": published_at,
        "fetched_at": "2026-07-22T08:01:00Z",
        "ticker": ticker,
        "source_tier": "aggregator",
    }


@pytest.mark.unit
def test_write_news_export_combines_public_bundles_and_dedupes(monkeypatch, tmp_path):
    runner = _load_runner()
    import tradingagents.dataflows.news_aggregator as aggregator

    shared_global = _item("Shared story", "https://example.com/story?utm_source=global")
    shared_ticker = _item("Shared story", "https://example.com/story?utm_source=ticker", ticker="AAPL")
    monkeypatch.setattr(
        aggregator,
        "get_global_news_bundle",
        lambda date: _bundle(
            query_type="global",
            ticker=None,
            items=[shared_global],
            source_statuses=[
                {
                    "source": "Test source",
                    "status": "ok",
                    "item_count": 1,
                    "detail": "private diagnostic must not be public",
                }
            ],
        ),
    )
    monkeypatch.setattr(
        aggregator,
        "get_news_bundle",
        lambda ticker, start, end: _bundle(
            query_type="ticker",
            ticker=ticker,
            items=[
                shared_ticker,
                _item(f"{ticker} specific", f"https://example.com/{ticker}", ticker=ticker),
            ],
        ),
    )

    result = runner.write_news_export(
        tmp_path,
        tickers=["AAPL", "MSFT"],
        trade_date="2026-07-22",
        generated_at="2026-07-22T16:00:00+08:00",
    )
    saved = json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))

    assert saved == result
    assert result["version"] == 1
    assert result["trade_date"] == "2026-07-22"
    assert result["global"]["query_type"] == "global"
    assert set(result["tickers"]) == {"AAPL", "MSFT"}
    assert [item["title"] for item in result["items"]] == [
        "Shared story",
        "AAPL specific",
        "MSFT specific",
    ]
    assert "private diagnostic" not in (tmp_path / "news.json").read_text(encoding="utf-8")


@pytest.mark.unit
def test_news_export_failure_is_safe_and_llm_keyless_run_still_writes_contract(monkeypatch, tmp_path):
    runner = _load_runner()
    import tradingagents.dataflows.news_aggregator as aggregator

    secret = "https://vendor.example/news?api_key=very-secret-value"
    monkeypatch.setattr(aggregator, "get_global_news_bundle", lambda date: (_ for _ in ()).throw(RuntimeError(secret)))
    monkeypatch.setattr(
        aggregator,
        "get_news_bundle",
        lambda ticker, start, end: (_ for _ in ()).throw(ConnectionError(secret)),
    )
    monkeypatch.setattr(runner, "resolve_llm_key_status", lambda: (False, "openai"))

    assert runner.main([
        "--tickers", "AAPL",
        "--date", "2026-07-22",
        "--output", str(tmp_path),
        "--no-push",
    ]) == 0

    payload = json.loads((tmp_path / "data" / "news.json").read_text(encoding="utf-8"))
    raw = (tmp_path / "data" / "news.json").read_text(encoding="utf-8")
    assert payload["version"] == 1
    assert payload["status"] == "failed"
    assert payload["global"]["status"] == "failed"
    assert payload["tickers"]["AAPL"]["status"] == "failed"
    assert payload["items"] == []
    assert secret not in raw
    assert (tmp_path / "data" / "latest.json").exists()


@pytest.mark.unit
def test_news_export_preserves_unavailable_status_without_items(monkeypatch, tmp_path):
    runner = _load_runner()
    import tradingagents.dataflows.news_aggregator as aggregator

    def unavailable(query_type, ticker):
        return _bundle(
            query_type=query_type,
            ticker=ticker,
            status="unavailable",
            source_statuses=[
                {"source": "Offline source", "status": "failed", "item_count": 0}
            ],
        )

    monkeypatch.setattr(
        aggregator, "get_global_news_bundle", lambda date: unavailable("global", None)
    )
    monkeypatch.setattr(
        aggregator,
        "get_news_bundle",
        lambda ticker, start, end: unavailable("ticker", ticker),
    )

    result = runner.write_news_export(
        tmp_path,
        tickers=["AAPL"],
        trade_date="2026-07-22",
        generated_at="2026-07-22T16:00:00+08:00",
    )

    assert result["status"] == "unavailable"
    assert result["global"]["status"] == "unavailable"
    assert result["tickers"]["AAPL"]["status"] == "unavailable"
    assert result["items"] == []
