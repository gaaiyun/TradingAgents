# 自动化部署说明（gaaiyun fork）

本 fork 在上游 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) 之上
只增加了一层**零侵入**的自动化部署（不改上游任何模块）：

| 组件 | 文件 | 作用 |
|---|---|---|
| 无头运行器 | `scripts/run_daily.py` | 逐 ticker 跑完整多智能体分析，产出 JSON + Markdown 报告 |
| 静态看板 | `public/index.html` | GitHub Pages 报告站，展示评级卡片与完整报告 |
| 定时工作流 | `.github/workflows/daily-analysis.yml` | 美股交易日收盘后自动分析 → 部署 Pages → 微信推送 |

## 线上地址

- 报告看板：https://gaaiyun.github.io/TradingAgents/
- 手动触发：Actions → daily-analysis → Run workflow（可临时指定 tickers）

## 配置（仓库 Settings）

### Secrets（必配一个 LLM key）

| Secret | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 默认 provider（deepseek）的密钥 |
| `OPENAI_COMPATIBLE_API_KEY` | 任意 OpenAI 兼容端点（火山方舟/硅基流动等），配合 `TRADINGAGENTS_LLM_BACKEND_URL` |
| `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / … | 其他 provider 对应密钥（见 `tradingagents/llm_clients/api_key_env.py`） |
| `PUSHPLUS_TOKEN` | 微信推送（可选） |

### Variables（全部可选，有默认值）

| Variable | 默认 | 说明 |
|---|---|---|
| `TRADINGAGENTS_LLM_PROVIDER` | `deepseek` | LLM 供应商 |
| `TRADINGAGENTS_DEEP_THINK_LLM` | `deepseek-v4-pro` | 深度思考模型 |
| `TRADINGAGENTS_QUICK_THINK_LLM` | `deepseek-v4-flash` | 快速模型 |
| `TRADINGAGENTS_LLM_BACKEND_URL` | 空 | 自定义 OpenAI 兼容端点 URL |
| `TRADINGAGENTS_TICKERS` | `SPY,NVDA` | 每日分析的标的列表 |
| `TRADINGAGENTS_ANALYSTS` | `market,news,fundamentals` | 分析师子集（可加 `social`） |
| `TRADINGAGENTS_OUTPUT_LANGUAGE` | `中文` | 报告输出语言 |

数据源默认全走 **yfinance（免 key）**；未配置 LLM key 时，工作流保持绿色并在看板显示配置提示。

## 本地运行

```bash
pip install .
# 配好 provider 对应的 API key 环境变量后：
python scripts/run_daily.py --tickers NVDA --no-push
python -m http.server 8788 --directory public   # 本地预览看板
```

## 风险提示

TradingAgents 为研究框架，输出不构成投资建议；LLM 分析每次运行都会消耗对应 API 的 token 费用
（默认 2 标的 × 3 分析师 × 每日一次，deepseek 档位约几毛钱/天）。
