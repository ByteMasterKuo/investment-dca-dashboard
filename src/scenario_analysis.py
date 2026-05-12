#!/usr/bin/env python3
"""
多场景 × 多参数回测对比
用法: python src/scenario_analysis.py [nasdaq|sp500]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = PROJECT_ROOT / "frontend" / "data" / "analysis.json"

# ── XIRR ──────────────────────────────────────────────────────────────────────

def xirr(cash_flows: list[tuple[str, float]]) -> float | None:
    import datetime
    if not cash_flows:
        return None
    has_pos = any(a > 0 for _, a in cash_flows)
    has_neg = any(a < 0 for _, a in cash_flows)
    if not (has_pos and has_neg):
        return None

    dates = [datetime.date.fromisoformat(d) for d, _ in cash_flows]
    start = dates[0]

    def npv(rate: float) -> float:
        return sum(
            a / (1 + rate) ** ((d - start).days / 365.25)
            for d, a in zip(dates, [a for _, a in cash_flows])
        )

    low, high = -0.9999, 1.0
    nl, nh = npv(low), npv(high)
    while nl * nh > 0 and high < 1024:
        high *= 2
        nh = npv(high)
    if nl * nh > 0:
        return None
    for _ in range(200):
        mid = (low + high) / 2
        nm = npv(mid)
        if abs(nm) < 1e-8:
            return mid
        if nl * nm <= 0:
            high, nh = mid, nm
        else:
            low, nl = mid, nm
    return (low + high) / 2


# ── 策略模拟 ──────────────────────────────────────────────────────────────────

def simulate_dca(tl: list[dict], amount: float, frequency: str) -> dict:
    prev, principal, shares, flows = None, 0.0, 0.0, []
    for i, p in enumerate(tl):
        invest = 0.0
        if frequency == "once":
            if i == 0:
                invest = amount
        else:
            key = p["date"][:7] if frequency == "monthly" else p["date"][:4]
            if key != prev:
                invest = amount
                prev = key
        if invest > 0:
            shares += invest / p["average_price"]
            principal += invest
            flows.append((p["date"], -invest))
    ending = shares * tl[-1]["average_price"] if tl else 0.0
    irr = xirr(flows + [(tl[-1]["date"], ending)]) if flows else None
    return {"principal": principal, "ending": ending,
            "multiple": ending / principal if principal > 0 else None, "xirr": irr}


def simulate_va(tl: list[dict], base: float, annual_r: float, band: float) -> dict:
    """带宽 VA：band > base 时允许减仓，band = inf 为无限制VA。"""
    monthly_r = (1 + annual_r) ** (1 / 12) - 1
    prev, idx, shares, net, flows = None, 0, 0.0, 0.0, []
    for p in tl:
        period, price = p["date"][:7], p["average_price"]
        if period != prev:
            prev, idx = period, idx + 1
            target = base * idx * (1 + monthly_r) ** idx
            raw = target - shares * price
            invest = raw if band == float("inf") else min(max(raw, base - band), base + band)
            if invest > 0:
                shares += invest / price
                net += invest
                flows.append((p["date"], -invest))
            elif invest < 0:
                sell = min(-invest, shares * price)
                shares -= sell / price
                net -= sell
                flows.append((p["date"], sell))
    ending = shares * tl[-1]["average_price"] if tl else 0.0
    irr = xirr(flows + [(tl[-1]["date"], ending)]) if flows else None
    mult = ending / net if net > 0 else None
    return {"principal": net, "ending": ending, "multiple": mult, "xirr": irr}


# ── 场景 & 参数矩阵 ───────────────────────────────────────────────────────────

SCENARIOS: list[tuple[str, str, str]] = [
    # 名称                             起始        截止
    ("【全周期】2000–2026",            "2000-01-01", "2026-05-04"),
    ("【熊市】科网崩盘 2000-03→02-10", "2000-03-01", "2002-10-31"),
    ("【熊市】金融危机 2007-10→09-03", "2007-10-01", "2009-03-31"),
    ("【熊市】加息下跌 2021-12→22-12", "2021-12-01", "2022-12-31"),
    ("【牛市】科网复苏 2002-10→07-10", "2002-10-01", "2007-10-31"),
    ("【牛市】超长牛   2009-03→21-11", "2009-03-01", "2021-11-30"),
    ("【牛市】近期复苏 2022-10→26-05", "2022-10-01", "2026-05-04"),
    ("【完整】科网全程 2000-03→07-10", "2000-03-01", "2007-10-31"),
    ("【完整】金融危机 2007-10→13-01", "2007-10-01", "2013-01-31"),
    ("【完整】疫情→今  2020-01→26-05", "2020-01-01", "2026-05-04"),
    ("【完整】近十年   2015-01→26-05", "2015-01-01", "2026-05-04"),
]

# 每组: (显示名, 模拟函数工厂)
def make_strategies(base: float = 1000.0) -> list[tuple[str, object]]:
    return [
        ("月定投(基准)",        lambda tl: simulate_dca(tl, base, "monthly")),
        ("周定投",              lambda tl: simulate_dca(tl, base / 4, "weekly")),  # ~250/周
        # 仅买不卖 VA (b ≤ base)
        ("VA r=5%  b=300",     lambda tl: simulate_va(tl, base, 0.05, 300)),
        ("VA r=8%  b=300",     lambda tl: simulate_va(tl, base, 0.08, 300)),
        ("VA r=10% b=300",     lambda tl: simulate_va(tl, base, 0.10, 300)),
        ("VA r=12% b=300",     lambda tl: simulate_va(tl, base, 0.12, 300)),
        ("VA r=15% b=300",     lambda tl: simulate_va(tl, base, 0.15, 300)),
        # 允许减仓 VA (b > base)
        ("VA r=8%  b=1500",    lambda tl: simulate_va(tl, base, 0.08, 1500)),
        ("VA r=10% b=1500",    lambda tl: simulate_va(tl, base, 0.10, 1500)),
        ("VA r=12% b=1500",    lambda tl: simulate_va(tl, base, 0.12, 1500)),
        ("VA r=15% b=1500",    lambda tl: simulate_va(tl, base, 0.15, 1500)),
        # 无限制 VA
        ("无限VA r=8%",        lambda tl: simulate_va(tl, base, 0.08, float("inf"))),
        ("无限VA r=10%",       lambda tl: simulate_va(tl, base, 0.10, float("inf"))),
        ("无限VA r=12%",       lambda tl: simulate_va(tl, base, 0.12, float("inf"))),
    ]


# ── 输出格式 ──────────────────────────────────────────────────────────────────

def fx(v) -> str:
    return f"{v*100:+6.2f}%" if v is not None else "   N/A "

def fm(v) -> str:
    return f"{v:5.2f}x" if v is not None else "  N/A "

def fc(v) -> str:
    return f"${v:>11,.0f}"


def run(index_key: str) -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    idx = data["indices"][index_key]
    label = idx["label"]
    timeline_all = idx["market_timeline"]

    strategies = make_strategies(1000.0)
    col_w = 18

    print(f"\n{'█'*120}")
    print(f"  指数: {label}  |  基准月定投: $1,000  |  基准周定投: $250")
    print(f"  VA 带宽说明: b≤1000 仅买不卖；b=1500 允许减仓最多 $500/月；无限VA 不限幅度")
    print(f"{'█'*120}")

    for sc_name, sc_start, sc_end in SCENARIOS:
        tl = [p for p in timeline_all if sc_start <= p["date"] <= sc_end]
        if len(tl) < 20:
            continue
        months = len({p["date"][:7] for p in tl})
        first_px = tl[0]["average_price"]
        last_px  = tl[-1]["average_price"]
        idx_return = (last_px / first_px - 1) * 100

        print(f"\n  ┌{'─'*116}┐")
        print(f"  │  {sc_name:<28}  {tl[0]['date']} → {tl[-1]['date']}  ({months} 个月)  "
              f"指数涨跌: {idx_return:+.1f}%{' '*20}│")
        print(f"  ├{'─'*col_w}─┬{'─'*9}─┬{'─'*13}─┬{'─'*12}─┬{'─'*7}─┤")
        print(f"  │ {'策略':<{col_w}}│ {'XIRR':>9} │ {'期末资产':>13} │ {'净本金':>12} │ {'倍数':>7} │")
        print(f"  ├{'─'*col_w}─┼{'─'*9}─┼{'─'*13}─┼{'─'*12}─┼{'─'*7}─┤")

        results = []
        for name, fn in strategies:
            r = fn(tl)
            results.append((name, r))

        # 按 XIRR 排序（None 排末尾）
        results.sort(key=lambda x: x[1]["xirr"] if x[1]["xirr"] is not None else -999, reverse=True)

        for i, (name, r) in enumerate(results):
            marker = " ★" if i == 0 else "  "
            print(f"  │{marker}{name:<{col_w}}│ {fx(r['xirr'])} │ {fc(r['ending'])} │"
                  f" {fc(r['principal'])} │ {fm(r['multiple'])} │")

        print(f"  └{'─'*col_w}─┴{'─'*9}─┴{'─'*13}─┴{'─'*12}─┴{'─'*7}─┘")

    print()


# ── 入口 ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    key = sys.argv[1] if len(sys.argv) > 1 else "nasdaq"
    if key not in ("nasdaq", "sp500"):
        print("用法: python src/scenario_analysis.py [nasdaq|sp500]")
        sys.exit(1)
    run(key)
