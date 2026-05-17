from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pandas as pd
import yfinance as yf


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RAW_DATA_DIR = PROJECT_ROOT / "data" / "raw"
OUTPUT_PATH = PROJECT_ROOT / "frontend" / "data" / "analysis.json"

START_DATE = "1985-01-01"
INDICES = {
    "nasdaq": {"label": "纳斯达克综合指数", "symbol": "^IXIC"},
    "sp500": {"label": "标普500指数", "symbol": "^GSPC"},
}


@dataclass(frozen=True)
class StrategyDefinition:
    key: str
    label: str
    description: str
    simulator: Callable[[pd.DataFrame], dict]


def ensure_directories() -> None:
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)


def download_index_history(symbol: str, name: str) -> pd.DataFrame:
    df = yf.download(symbol, start=START_DATE, auto_adjust=False, progress=False)
    if df.empty:
        raise RuntimeError(f"无法下载 {name} 的历史数据")

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [col[0] for col in df.columns]

    df = df.reset_index()
    df["Date"] = pd.to_datetime(df["Date"]).dt.tz_localize(None)
    df["average_price"] = df[["Open", "High", "Low", "Close"]].mean(axis=1)
    df = df.dropna(subset=["average_price"]).reset_index(drop=True).copy()
    df["date"] = df["Date"].dt.strftime("%Y-%m-%d")

    export_df = df[["date", "Open", "High", "Low", "Close", "Adj Close", "Volume", "average_price"]]
    export_df.to_csv(RAW_DATA_DIR / f"{name}.csv", index=False)
    return df


def build_period_keys(df: pd.DataFrame, frequency: str) -> list[str]:
    dates = pd.to_datetime(df["date"])
    if frequency == "weekly":
        iso = dates.dt.isocalendar()
        return [f"{year}-W{week:02d}" for year, week in zip(iso.year, iso.week)]
    if frequency == "monthly":
        return dates.dt.strftime("%Y-%m").tolist()
    if frequency == "yearly":
        return dates.dt.strftime("%Y").tolist()
    raise ValueError(f"不支持的频率: {frequency}")


def xirr(cash_flows: list[tuple[pd.Timestamp, float]]) -> float | None:
    if not cash_flows:
        return None

    has_positive = any(amount > 0 for _, amount in cash_flows)
    has_negative = any(amount < 0 for _, amount in cash_flows)
    if not (has_positive and has_negative):
        return None

    start_date = cash_flows[0][0]

    def npv(rate: float) -> float:
        total = 0.0
        for flow_date, amount in cash_flows:
            years = (flow_date - start_date).days / 365.25
            total += amount / ((1 + rate) ** years)
        return total

    low = -0.9999
    high = 1.0
    npv_low = npv(low)
    npv_high = npv(high)

    while npv_low * npv_high > 0 and high < 1024:
        high *= 2
        npv_high = npv(high)

    if npv_low * npv_high > 0:
        return None

    for _ in range(200):
        mid = (low + high) / 2
        npv_mid = npv(mid)
        if abs(npv_mid) < 1e-8:
            return mid
        if npv_low * npv_mid <= 0:
            high = mid
            npv_high = npv_mid
        else:
            low = mid
            npv_low = npv_mid

    return (low + high) / 2


def compress_series(series: list[dict]) -> list[dict]:
    if not series:
        return series

    compressed: list[dict] = []
    previous_month = None
    for point in series:
        current_month = point["date"][:7]
        if current_month != previous_month:
            compressed.append(point)
            previous_month = current_month

    if compressed[-1]["date"] != series[-1]["date"]:
        compressed.append(series[-1])

    return compressed


def build_market_timeline(df: pd.DataFrame) -> list[dict]:
    return (
        df[["date", "average_price"]]
        .assign(average_price=df["average_price"].round(4))
        .to_dict("records")
    )


def finalize_strategy(
    *,
    key: str,
    label: str,
    description: str,
    principal: float,
    shares: float,
    cash_flows: list[tuple[pd.Timestamp, float]],
    series: list[dict],
    end_date: pd.Timestamp,
) -> dict:
    ending_value = series[-1]["value"] if series else 0.0
    total_return = ending_value - principal
    annualized = xirr(cash_flows + [(end_date, ending_value)]) if principal > 0 else None

    return {
        "key": key,
        "label": label,
        "description": description,
        "principal": round(principal, 2),
        "shares": round(shares, 6),
        "ending_value": round(ending_value, 2),
        "total_return": round(total_return, 2),
        "total_return_pct": round((total_return / principal) * 100, 2) if principal else 0.0,
        "annualized_return_pct": round(annualized * 100, 2) if annualized is not None else None,
        "series": compress_series(series),
    }


def simulate_fixed_amount_strategy(
    df: pd.DataFrame,
    *,
    key: str,
    label: str,
    description: str,
    frequency: str,
    amount: float,
) -> dict:
    period_keys = build_period_keys(df, frequency) if frequency != "once" else []
    previous_period = None
    principal = 0.0
    shares = 0.0
    cash_flows: list[tuple[pd.Timestamp, float]] = []
    series: list[dict] = []

    for idx, row in df.iterrows():
        trade_date = pd.to_datetime(row["date"])
        avg_price = float(row["average_price"])
        invest_amount = 0.0

        if frequency == "once":
            if idx == 0:
                invest_amount = amount
        else:
            period_key = period_keys[idx]
            if period_key != previous_period:
                invest_amount = amount
                previous_period = period_key

        if invest_amount > 0:
            purchased_shares = invest_amount / avg_price
            shares += purchased_shares
            principal += invest_amount
            cash_flows.append((trade_date, -invest_amount))

        series.append(
            {
                "date": row["date"],
                "value": round(shares * avg_price, 2),
                "principal": round(principal, 2),
                "shares": round(shares, 6),
            }
        )

    return finalize_strategy(
        key=key,
        label=label,
        description=description,
        principal=principal,
        shares=shares,
        cash_flows=cash_flows,
        series=series,
        end_date=pd.to_datetime(df["date"].iloc[-1]),
    )


def simulate_target_value_band_strategy(
    df: pd.DataFrame,
    *,
    key: str,
    label: str,
    description: str,
    annual_target_return: float,
    monthly_base_amount: float,
    band: float,
) -> dict:
    period_keys = build_period_keys(df, "monthly")
    previous_period = None
    period_index = 0
    principal = 0.0
    shares = 0.0
    cash_flows: list[tuple[pd.Timestamp, float]] = []
    series: list[dict] = []
    monthly_target_rate = (1 + annual_target_return) ** (1 / 12) - 1

    for idx, row in df.iterrows():
        trade_date = pd.to_datetime(row["date"])
        avg_price = float(row["average_price"])
        period_key = period_keys[idx]

        if period_key != previous_period:
            previous_period = period_key
            period_index += 1
            current_value = shares * avg_price
            # 标准价值平均法：目标市值沿固定复利路径增长
            # V_n = base × n × (1 + r_月)^n
            target_value = monthly_base_amount * period_index * (1 + monthly_target_rate) ** period_index
            raw_invest_amount = target_value - current_value
            invest_amount = min(
                max(raw_invest_amount, monthly_base_amount - band),
                monthly_base_amount + band,
            )
            invest_amount = max(invest_amount, 0.0)

            if invest_amount > 0:
                purchased_shares = invest_amount / avg_price
                shares += purchased_shares
                principal += invest_amount
                cash_flows.append((trade_date, -invest_amount))

        series.append(
            {
                "date": row["date"],
                "value": round(shares * avg_price, 2),
                "principal": round(principal, 2),
                "shares": round(shares, 6),
            }
        )

    return finalize_strategy(
        key=key,
        label=label,
        description=description,
        principal=principal,
        shares=shares,
        cash_flows=cash_flows,
        series=series,
        end_date=pd.to_datetime(df["date"].iloc[-1]),
    )


def simulate_target_shares_strategy(
    df: pd.DataFrame,
    *,
    key: str,
    label: str,
    description: str,
    target_total_shares: float,
) -> dict:
    period_keys = build_period_keys(df, "monthly")
    unique_periods: list[str] = []
    for period_key in period_keys:
        if not unique_periods or unique_periods[-1] != period_key:
            unique_periods.append(period_key)

    total_periods = len(unique_periods)
    period_index = 0
    previous_period = None
    principal = 0.0
    shares = 0.0
    cash_flows: list[tuple[pd.Timestamp, float]] = []
    series: list[dict] = []

    for idx, row in df.iterrows():
        trade_date = pd.to_datetime(row["date"])
        avg_price = float(row["average_price"])
        period_key = period_keys[idx]

        if period_key != previous_period:
            period_index += 1
            previous_period = period_key
            target_shares_now = target_total_shares * (period_index / total_periods)
            buy_shares = max(target_shares_now - shares, 0.0)
            invest_amount = buy_shares * avg_price
            if invest_amount > 0:
                shares += buy_shares
                principal += invest_amount
                cash_flows.append((trade_date, -invest_amount))

        series.append(
            {
                "date": row["date"],
                "value": round(shares * avg_price, 2),
                "principal": round(principal, 2),
                "shares": round(shares, 6),
            }
        )

    return finalize_strategy(
        key=key,
        label=label,
        description=description,
        principal=principal,
        shares=shares,
        cash_flows=cash_flows,
        series=series,
        end_date=pd.to_datetime(df["date"].iloc[-1]),
    )


def build_strategy_definitions() -> list[StrategyDefinition]:
    return [
        StrategyDefinition(
            key="lump_sum",
            label="一次性投入",
            description="在样本起始日一次性投入 10000 美元。",
            simulator=lambda df: simulate_fixed_amount_strategy(
                df,
                key="lump_sum",
                label="一次性投入",
                description="在样本起始日一次性投入 10000 美元。",
                frequency="once",
                amount=10000.0,
            ),
        ),
        StrategyDefinition(
            key="monthly_dca",
            label="每月固定金额定投",
            description="每个自然月的第一个交易日投入 1000 美元。",
            simulator=lambda df: simulate_fixed_amount_strategy(
                df,
                key="monthly_dca",
                label="每月固定金额定投",
                description="每个自然月的第一个交易日投入 1000 美元。",
                frequency="monthly",
                amount=1000.0,
            ),
        ),
        StrategyDefinition(
            key="yearly_dca",
            label="每年固定金额定投",
            description="每个自然年的第一个交易日投入 12000 美元。",
            simulator=lambda df: simulate_fixed_amount_strategy(
                df,
                key="yearly_dca",
                label="每年固定金额定投",
                description="每个自然年的第一个交易日投入 12000 美元。",
                frequency="yearly",
                amount=12000.0,
            ),
        ),
        StrategyDefinition(
            key="weekly_dca",
            label="每周固定金额定投",
            description="每周第一个交易日投入 250 美元。",
            simulator=lambda df: simulate_fixed_amount_strategy(
                df,
                key="weekly_dca",
                label="每周固定金额定投",
                description="每周第一个交易日投入 250 美元。",
                frequency="weekly",
                amount=250.0,
            ),
        ),
        StrategyDefinition(
            key="target_shares_dca",
            label="目标总股本定投",
            description="按月向 200 股的目标持仓线性逼近，单次投入金额随价格变化。",
            simulator=lambda df: simulate_target_shares_strategy(
                df,
                key="target_shares_dca",
                label="目标总股本定投",
                description="按月向 200 股的目标持仓线性逼近，单次投入金额随价格变化。",
                target_total_shares=200.0,
            ),
        ),
        StrategyDefinition(
            key="target_value_band_dca",
            label="带宽 VA 定投",
            description="标准 VA 加可接受波动带宽 b，每月固定贡献 a 追赶目标路径，单月操作钳制在 [a−b, a+b]，预期年化 12%、基准 1000 美元/月、带宽 2000 美元。",
            simulator=lambda df: simulate_target_value_band_strategy(
                df,
                key="target_value_band_dca",
                label="带宽 VA 定投",
                description="标准 VA 加可接受波动带宽 b，每月固定贡献 a 追赶目标路径，单月操作钳制在 [a−b, a+b]，预期年化 12%、基准 1000 美元/月、带宽 2000 美元。",
                annual_target_return=0.12,
                monthly_base_amount=1000.0,
                band=2000.0,
            ),
        ),
    ]


def build_index_payload(index_key: str, meta: dict) -> dict:
    df = download_index_history(meta["symbol"], index_key)
    strategies = [definition.simulator(df) for definition in build_strategy_definitions()]

    return {
        "label": meta["label"],
        "symbol": meta["symbol"],
        "start_date": df["date"].iloc[0],
        "end_date": df["date"].iloc[-1],
        "trading_days": int(len(df)),
        "price_summary": {
            "first_average_price": round(float(df["average_price"].iloc[0]), 2),
            "last_average_price": round(float(df["average_price"].iloc[-1]), 2),
        },
        "market_timeline": build_market_timeline(df),
        "strategies": strategies,
    }


def main() -> None:
    ensure_directories()

    payload = {
        "meta": {
            "title": "指数定投收益策略对比",
            "start_date": START_DATE,
            "generated_at": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M:%S UTC"),
            "price_method": "日均价 = (Open + High + Low + Close) / 4",
            "currency": "USD",
            "dynamic_strategy_defaults": {
                "annual_target_return_pct": 12.0,
                "monthly_base_amount": 1000.0,
                "band": 2000.0,
                "start_date": "2000-01-01",
                "inflation_rate_pct": 3.0,
            },
        },
        "indices": {index_key: build_index_payload(index_key, meta) for index_key, meta in INDICES.items()},
    }

    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成分析结果: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
