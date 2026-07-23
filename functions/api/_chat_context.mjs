import {
  queryMarketBars,
  queryMarketEvents,
  queryNewsItems,
} from "./_d1_repository.mjs";
import { hashChatValue } from "./_chat_repository.mjs";

function value(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function line(parts) {
  return parts.filter(Boolean).join(" | ");
}

function latestAsOf(rows) {
  return rows.reduce((latest, row) => {
    const candidate = row.as_of || row.ts || row.published_at || row.event_at || null;
    return candidate && (!latest || candidate > latest) ? candidate : latest;
  }, null);
}

export async function loadWorkbenchEvidence(db, {
  profileId,
  symbol,
  now = new Date(),
}) {
  if (!db || !profileId || !symbol) {
    return {
      context: "",
      contextLabel: "",
      contextHash: await hashChatValue(""),
      evidence: [],
      asOf: null,
      source: {
        type: "workbench",
        label: "动态工作台暂无可用证据",
        chars: 0,
        truncated: false,
        status: "unavailable",
      },
    };
  }

  const query = {
    profile: profileId,
    symbol,
    from: null,
    to: null,
  };
  const [bars, news, events] = await Promise.all([
    queryMarketBars(db, { ...query, timeframe: "15m", limit: 4 }),
    queryNewsItems(db, { ...query, topic: null, limit: 8 }),
    queryMarketEvents(db, { ...query, topic: null, importance: null, limit: 8 }),
  ]);
  const evidence = [];
  const lines = [
    "以下是服务端动态证据账本。只能依据这些记录和随后附加的研究报告作答；引用时使用证据编号。",
  ];

  bars.reverse().forEach((row, index) => {
    const id = `M${index + 1}`;
    lines.push(`[${id}] ${line([
      `行情 ${row.symbol}`,
      `周期 ${row.timeframe}`,
      `时间 ${row.ts}`,
      `开 ${value(row.open)}`,
      `高 ${value(row.high)}`,
      `低 ${value(row.low)}`,
      `收 ${value(row.close)}`,
      `量 ${value(row.volume)}`,
      `来源 ${row.source}`,
      `asOf ${row.as_of}`,
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "market",
      title: `${row.symbol} ${row.timeframe} 行情`,
      asOf: row.as_of || row.ts,
      source: row.source,
      url: null,
    });
  });
  news.forEach((row, index) => {
    const id = `N${index + 1}`;
    lines.push(`[${id}] ${line([
      `新闻 ${row.title}`,
      row.summary ? `摘要 ${row.summary}` : "",
      `发布时间 ${row.published_at}`,
      `来源 ${row.source}`,
      row.url ? `原文 ${row.url}` : "",
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "news",
      title: row.title,
      asOf: row.published_at,
      source: row.source,
      url: row.url || null,
    });
  });
  events.forEach((row, index) => {
    const id = `E${index + 1}`;
    lines.push(`[${id}] ${line([
      `事件 ${row.title}`,
      row.description ? `说明 ${row.description}` : "",
      `时间 ${row.event_at}`,
      `重要性 ${row.importance}`,
      `来源 ${row.source}`,
      `质量 ${row.freshness}/${row.quality}`,
    ])}`);
    evidence.push({
      id,
      type: "event",
      title: row.title,
      asOf: row.event_at,
      source: row.source,
      url: null,
    });
  });

  const allRows = [...bars, ...news, ...events];
  if (!evidence.length) {
    lines.push("当前没有该标的的动态行情、新闻或事件证据。涉及今日涨跌原因时，必须明确回答“证据不足，无法可靠归因”。");
  }
  const context = lines.join("\n");
  return {
    context,
    contextLabel: `${symbol} 动态证据账本`,
    contextHash: await hashChatValue(context),
    evidence,
    asOf: latestAsOf(allRows),
    source: {
      type: "workbench",
      label: `${symbol} 动态证据账本`,
      chars: context.length,
      truncated: false,
      status: evidence.length ? "ok" : "unavailable",
      fetchedAt: now.toISOString(),
    },
  };
}
