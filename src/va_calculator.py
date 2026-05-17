#!/usr/bin/env python3
"""
有限制 VA 定投计算器
- 策略参数自动保存/读取（va_config.json）
- 每月操作记录追加写入（va_history.csv）

用法: python3 src/va_calculator.py
"""
from __future__ import annotations

import csv
import datetime
import json
import sys
from pathlib import Path

# 数据文件存放位置（项目根目录 data/）
DATA_DIR   = Path(__file__).resolve().parents[1] / "data"
CONFIG_PATH = DATA_DIR / "va_config.json"
HISTORY_PATH = DATA_DIR / "va_history.csv"

HISTORY_HEADERS = [
    "月份", "第n月", "目标市值", "操作前市值",
    "偏差方向", "原始信号金额", "实际操作", "实际操作金额",
    "操作后市值", "ETF单价", "备注",
]


# ── 核心计算 ──────────────────────────────────────────────────────────────────

def monthly_rate(annual_r: float) -> float:
    return (1 + annual_r) ** (1 / 12) - 1


def target_value(n: int, base: float, annual_r: float) -> float:
    """年金终值公式：V(n) = a×[(1+r月)ⁿ−1]/r月，Edleson 原版 VA"""
    r = monthly_rate(annual_r)
    if abs(r) < 1e-10:
        return base * n   # r≈0 时退化为线性
    return base * ((1 + r) ** n - 1) / r


def va_action(current_value: float, n: int, base: float, annual_r: float, band: float) -> dict:
    target  = target_value(n, base, annual_r)
    raw     = target - current_value
    clamped = min(max(raw, base - band), base + band)
    clamped = max(clamped, -current_value)   # 不能卖超持仓
    return {
        "target":   target,
        "raw":      raw,
        "clamped":  clamped,
        "clipped":  abs(clamped - raw) > 0.01,
    }


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def add_months(d: datetime.date, months: int) -> datetime.date:
    m = d.month - 1 + months
    return d.replace(year=d.year + m // 12, month=m % 12 + 1, day=1)


def month_n(start: datetime.date, current: datetime.date) -> int:
    return (current.year - start.year) * 12 + (current.month - start.month) + 1


def parse_float(s: str) -> float:
    return float(s.replace(",", "").replace("$", "").replace("，", "").strip())


def parse_month(s: str) -> datetime.date:
    s = s.strip()
    return datetime.date.fromisoformat((s if len(s) > 7 else s + "-01"))


def prompt(text: str, default: str = "") -> str:
    hint = f"（回车默认 {default}）" if default else ""
    val  = input(f"  {text}{hint}: ").strip()
    return val if val else default


def yn(text: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    val  = input(f"  {text} [{hint}]: ").strip().lower()
    if not val:
        return default
    return val.startswith("y")


def bar(ratio: float, width: int = 28) -> str:
    ratio  = max(0.0, min(ratio, 2.0))
    filled = round(ratio * width / 2)
    mid    = width // 2
    filled = min(filled, mid + (width - mid))
    s = "█" * min(filled, mid) + "▓" * max(filled - mid, 0)
    return f"[{s:<{width}}] {ratio*100:.0f}%"


# ── 配置文件 ──────────────────────────────────────────────────────────────────

def load_config() -> dict | None:
    if not CONFIG_PATH.exists():
        return None
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  ✅ 策略参数已保存至 {CONFIG_PATH}")


# ── 历史记录 ──────────────────────────────────────────────────────────────────

def load_history() -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    with HISTORY_PATH.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def append_history(row: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    is_new = not HISTORY_PATH.exists()
    with HISTORY_PATH.open("a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HISTORY_HEADERS)
        if is_new:
            w.writeheader()
        w.writerow(row)
    print(f"  ✅ 已记录至 {HISTORY_PATH}")


def print_history(rows: list[dict]) -> None:
    if not rows:
        return
    print()
    print(f"  {'月份':<9}{'第n月':>5}  {'目标市值':>12}  {'操作前市值':>12}  {'操作':>8}  {'操作金额':>10}  {'操作后市值':>12}")
    print(f"  {'─'*78}")
    for r in rows[-6:]:   # 显示最近 6 条
        act   = r.get("实际操作", "")
        icon  = "📈" if act == "买入" else ("📉" if act == "卖出" else "⏸ ")
        print(
            f"  {r['月份']:<9}{r['第n月']:>5}  "
            f"${float(r['目标市值']):>11,.2f}  "
            f"${float(r['操作前市值']):>11,.2f}  "
            f"{icon}{act:>5}  "
            f"${float(r['实际操作金额']):>9,.2f}  "
            f"${float(r['操作后市值']):>11,.2f}"
        )


# ── 主程序 ────────────────────────────────────────────────────────────────────

def main() -> None:
    today = datetime.date.today()

    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║         有限制 VA 定投计算器  (banded Value Avg)     ║")
    print("╚══════════════════════════════════════════════════════╝")

    # ── 读取历史，展示最近记录 ────────────────────────────────────
    history = load_history()
    if history:
        print(f"\n  📋 历史操作记录（共 {len(history)} 条，最近 6 条）：")
        print_history(history)

    # ── 策略参数：尝试从配置文件加载 ─────────────────────────────
    cfg     = load_config()
    use_cfg = False

    if cfg:
        print()
        print("  📁 发现已保存的策略参数：")
        print(f"     起始月份 {cfg['start_date']}  ·  "
              f"a=${cfg['a']:,.0f}  ·  b=${cfg['b']:,.0f}  ·  r={cfg['r_pct']}%")
        use_cfg = yn("使用上次的参数？", default=True)

    print()
    if use_cfg and cfg:
        print("【策略参数】（已从配置文件加载）")
        start_str = cfg["start_date"]
        a, b, r   = float(cfg["a"]), float(cfg["b"]), float(cfg["r_pct"]) / 100
        etf_name  = cfg.get("etf_name", "")
    else:
        print("【策略参数】")
        start_str = prompt("策略起始月份 (YYYY-MM，首次买入的月份)")
        a = parse_float(prompt("月定投基准金额 a (USD)"))
        b = parse_float(prompt("波动带宽      b (USD)"))
        r = parse_float(prompt("预期年化收益率 r%（如 10）")) / 100
        etf_name  = prompt("ETF 名称（选填，如 EQQQ）", "")

        if yn("保存以上参数供下次使用？"):
            save_config({
                "start_date": start_str,
                "a": a, "b": b, "r_pct": r * 100,
                "etf_name": etf_name,
            })

    try:
        start = parse_month(start_str)
    except Exception:
        print("❌ 起始月份格式错误（应为 YYYY-MM）")
        sys.exit(1)

    # ── 当前状态输入 ──────────────────────────────────────────────
    print()
    print("【当前持仓】")
    current_str = prompt("当前月份 (YYYY-MM)", today.strftime("%Y-%m"))
    value_str   = prompt("当前持仓市值 (USD，持仓股数 × 今日单价)")
    price_str   = prompt("当前 ETF 单价 (USD，选填，用于计算股数)", "")
    note_str    = prompt("备注（选填，如'本月发薪后操作'）", "")

    try:
        current       = parse_month(current_str)
        current_value = parse_float(value_str)
        price         = parse_float(price_str) if price_str else None
    except Exception as e:
        print(f"❌ 格式有误：{e}")
        sys.exit(1)

    n = month_n(start, current)
    if n <= 0:
        print("❌ 当前月份早于策略起始月份")
        sys.exit(1)

    # ── 检查是否本月已有记录 ──────────────────────────────────────
    current_month_str = current.strftime("%Y-%m")
    if any(r["月份"] == current_month_str for r in history):
        print(f"\n  ⚠️  {current_month_str} 已有操作记录，请确认是否重复操作。")
        if not yn("继续计算？", default=False):
            sys.exit(0)

    # ── 核心计算 ──────────────────────────────────────────────────
    res    = va_action(current_value, n, a, r, b)
    target = res["target"]
    raw    = res["raw"]
    action = res["clamped"]

    after_value  = current_value + action
    dev_pct      = (current_value / target - 1) * 100 if target else 0
    after_dev    = (after_value / target - 1) * 100 if target else 0

    # ── 输出结果 ──────────────────────────────────────────────────
    etf_label = f" · {etf_name}" if etf_name else ""
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print(f"║  {current.strftime('%Y年%m月')}  ·  策略第 {n} 个月{etf_label}"
          f"{'':>{max(0, 31-len(str(n))-len(etf_label))}}║")
    print("╠══════════════════════════════════════════════════════╣")
    print(f"║  目标市值   ${target:>12,.2f}                          ║")
    dev_str = f"{'高于' if dev_pct > 0 else '低于'}目标 {abs(dev_pct):.1f}%"
    print(f"║  当前市值   ${current_value:>12,.2f}  ({dev_str})    ║")
    print(f"║  {bar(current_value / target if target else 0)}            ║")
    print("╠══════════════════════════════════════════════════════╣")
    raw_dir = "买入" if raw >= 0 else "卖出"
    print(f"║  原始信号   {raw_dir} ${abs(raw):>10,.2f}                      ║")
    band_range = f"[{a-b:+,.0f}, {a+b:+,.0f}]"
    clip_note  = "已截断" if res["clipped"] else "在范围内"
    print(f"║  带宽限制   {band_range} → {clip_note:<12}           ║")
    print("╠══════════════════════════════════════════════════════╣")

    if abs(action) < 0.01:
        act_label, act_icon, act_dir = "无需操作", "⏸ ", "不操作"
        print( "║  ⏸  本月无需操作（市值贴合目标路径）                 ║")
    elif action > 0:
        act_label, act_icon, act_dir = f"买入 ${action:,.2f}", "📈", "买入"
        print(f"║  📈  本月操作：买入  ${action:>10,.2f}                    ║")
        if price:
            print(f"║      约 {action/price:>8.4f} 股  @ ${price:,.2f}/股"
                  f"{'':>{max(0,18-len(f'{price:,.2f}'))}}║")
    else:
        sell = -action
        act_label, act_icon, act_dir = f"卖出 ${sell:,.2f}", "📉", "卖出"
        print(f"║  📉  本月操作：卖出  ${sell:>10,.2f}                    ║")
        if price:
            print(f"║      约 {sell/price:>8.4f} 股  @ ${price:,.2f}/股"
                  f"{'':>{max(0,18-len(f'{price:,.2f}'))}}║")

    print("╠══════════════════════════════════════════════════════╣")
    print(f"║  操作后市值 ${after_value:>12,.2f}  (偏差目标 {after_dev:+.1f}%)"
          f"{'':>{max(0,7-len(f'{after_dev:+.1f}'))}}║")
    print("╚══════════════════════════════════════════════════════╝")

    # ── 未来 6 个月目标路径 ────────────────────────────────────────
    print()
    print(f"  未来 6 个月目标路径（a=${a:,.0f}  b=${b:,.0f}  r={r*100:.1f}%/年）")
    print(f"  {'月份':<9}{'第n月':>5}  {'目标市值':>12}  {'较本月+':>10}  {'预计买入区间':>20}")
    print(f"  {'─'*64}")
    for i in range(1, 7):
        fm = add_months(current, i)
        fn = n + i
        ft = target_value(fn, a, r)
        dt = ft - target
        lo = max(a - b, 0); hi = a + b
        print(f"  {fm.strftime('%Y-%m'):<9}{fn:>5}  ${ft:>11,.2f}  {dt:>+10,.2f}  "
              f"  买[${lo:,.0f}–${hi:,.0f}] / 卖[${max(b-a,0):,.0f}]")

    # ── 写入历史 ──────────────────────────────────────────────────
    print()
    if yn("将本月操作记录到历史文件？"):
        append_history({
            "月份":       current_month_str,
            "第n月":      n,
            "目标市值":   f"{target:.2f}",
            "操作前市值": f"{current_value:.2f}",
            "偏差方向":   "高于目标" if raw < 0 else "低于目标",
            "原始信号金额": f"{abs(raw):.2f}",
            "实际操作":   act_dir,
            "实际操作金额": f"{abs(action):.2f}",
            "操作后市值": f"{after_value:.2f}",
            "ETF单价":    f"{price:.2f}" if price else "",
            "备注":       note_str,
        })

    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n已退出。")
