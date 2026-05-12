// ── 核心计算 ─────────────────────────────────────────────────────────────────

function monthlyRate(annualR) {
  return (1 + annualR) ** (1 / 12) - 1;
}

function targetValue(n, base, annualR) {
  const r = monthlyRate(annualR);
  return base * n * (1 + r) ** n;
}

function vaAction(currentValue, n, base, annualR, band) {
  const target  = targetValue(n, base, annualR);
  const raw     = target - currentValue;
  let   clamped = Math.min(Math.max(raw, base - band), base + band);
  clamped = Math.max(clamped, -currentValue); // 不能卖超持仓
  return { target, raw, clamped, clipped: Math.abs(clamped - raw) > 0.01 };
}

function monthN(startYM, currentYM) {
  const [sy, sm] = startYM.split("-").map(Number);
  const [cy, cm] = currentYM.split("-").map(Number);
  return (cy - sy) * 12 + (cm - sm) + 1;
}

function addMonths(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const total  = (m - 1) + delta;
  return `${y + Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, "0")}`;
}

// ── 格式化 ───────────────────────────────────────────────────────────────────

function fmtUSD(v, decimals = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(v);
}

function fmtPct(v) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

// ── localStorage 持久化 ──────────────────────────────────────────────────────

const CONFIG_KEY  = "va_calculator_config";
const HISTORY_KEY = "va_calculator_history";

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null"); }
  catch { return null; }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  document.getElementById("config-status").textContent =
    `✅ 参数已自动保存（${new Date().toLocaleString("zh-CN")}）`;
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveHistory(rows) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
}

// ── 读取 / 写入参数面板 ───────────────────────────────────────────────────────

function getConfig() {
  return {
    startDate: document.getElementById("cfg-start").value,
    a:         Number(document.getElementById("cfg-a").value),
    b:         Number(document.getElementById("cfg-b").value),
    rPct:      Number(document.getElementById("cfg-r").value),
    etfName:   document.getElementById("cfg-etf").value.trim(),
  };
}

function applyConfig(cfg) {
  document.getElementById("cfg-start").value = cfg.startDate || "";
  document.getElementById("cfg-a").value     = cfg.a     || "";
  document.getElementById("cfg-b").value     = cfg.b     || "";
  document.getElementById("cfg-r").value     = cfg.rPct  || "";
  document.getElementById("cfg-etf").value   = cfg.etfName || "";
}

// ── 历史表格渲染 ─────────────────────────────────────────────────────────────

function renderHistory() {
  const rows = loadHistory();
  const body = document.getElementById("history-body");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted)">暂无记录</td></tr>`;
    return;
  }

  body.innerHTML = [...rows].reverse().map((r) => {
    const cls = r.action === "买入" ? "op-buy" : r.action === "卖出" ? "op-sell" : "op-hold";
    const icon = r.action === "买入" ? "📈" : r.action === "卖出" ? "📉" : "⏸";
    return `<tr>
      <td>${r.month}</td>
      <td>${r.n}</td>
      <td>${fmtUSD(r.target)}</td>
      <td>${fmtUSD(r.valueBefore)}</td>
      <td class="${cls}">${icon} ${r.action}</td>
      <td class="${cls}">${fmtUSD(r.amount)}</td>
      <td>${fmtUSD(r.valueAfter)}</td>
      <td>${r.price ? fmtUSD(r.price) : "—"}</td>
      <td style="color:var(--muted)">${r.note || ""}</td>
    </tr>`;
  }).join("");
}

// ── 计算并展示结果 ────────────────────────────────────────────────────────────

let lastResult = null; // 供"记录"按钮使用

function calculate() {
  const cfg = getConfig();
  const currentYM  = document.getElementById("cur-month").value;
  const currentVal = Number(document.getElementById("cur-value").value);
  const priceInput = document.getElementById("cur-price").value;
  const price      = priceInput ? Number(priceInput) : null;

  // ── 验证 ────────────────────────────────────────────────────────────────────
  if (!cfg.startDate || !cfg.a || !cfg.b || !cfg.rPct || !currentYM || !currentVal) {
    alert("请填写所有必填项（策略参数 + 当前月份 + 当前市值）");
    return;
  }
  const n = monthN(cfg.startDate, currentYM);
  if (n <= 0) {
    alert("当前月份早于策略起始月份，请检查。");
    return;
  }

  // ── 自动保存参数 ─────────────────────────────────────────────────────────
  saveConfig(cfg);

  // ── 核心计算 ─────────────────────────────────────────────────────────────
  const annualR = cfg.rPct / 100;
  const res     = vaAction(currentVal, n, cfg.a, annualR, cfg.b);
  const { target, raw, clamped, clipped } = res;
  const afterVal = currentVal + clamped;
  const devPct   = (currentVal / target - 1) * 100;
  const afterPct = (afterVal  / target - 1) * 100;

  // ── 记录当前结果供"记录"按钮使用 ─────────────────────────────────────────
  lastResult = { cfg, currentYM, n, target, raw, clamped, currentVal, afterVal, price };

  // ── 操作类型 ─────────────────────────────────────────────────────────────
  let actionType, icon, amountText, sharesText, cardClass;
  if (Math.abs(clamped) < 0.01) {
    actionType = "hold";  icon = "⏸";
    amountText = "无需操作";  sharesText = "市值贴合目标路径";  cardClass = "hold";
  } else if (clamped > 0) {
    actionType = "buy";   icon = "📈";
    amountText = `买入 ${fmtUSD(clamped, 0)}`;
    sharesText = price ? `≈ ${(clamped / price).toFixed(4)} 股 @ ${fmtUSD(price)}` : "";
    cardClass  = "buy";
  } else {
    const sell = -clamped;
    actionType = "sell";  icon = "📉";
    amountText = `卖出 ${fmtUSD(sell, 0)}`;
    sharesText = price ? `≈ ${(sell / price).toFixed(4)} 股 @ ${fmtUSD(price)}` : "";
    cardClass  = "sell";
  }

  // ── 更新 DOM ─────────────────────────────────────────────────────────────
  // 标题
  const etfLabel = cfg.etfName ? ` · ${cfg.etfName}` : "";
  document.getElementById("result-title").textContent    = `第 ${n} 个月${etfLabel}`;
  document.getElementById("result-subtitle").textContent = `${cfg.startDate} 起投 · ${currentYM}`;

  // 指标卡
  const devEl = document.getElementById("res-dev");
  document.getElementById("res-target").textContent  = fmtUSD(target);
  document.getElementById("res-current").textContent = fmtUSD(currentVal);
  devEl.textContent = `${fmtPct(devPct)}`;
  devEl.className   = `metric-value ${devPct < 0 ? "positive" : "negative"}`;
  document.getElementById("res-after").textContent   = fmtUSD(afterVal);

  // 操作信号卡
  const card = document.getElementById("action-card");
  card.className = `action-card ${cardClass}`;
  document.getElementById("action-month").textContent  = `${currentYM}  ·  策略第 ${n} 个月`;
  document.getElementById("action-icon").textContent   = icon;
  document.getElementById("action-amount").textContent = amountText;
  document.getElementById("action-shares").textContent = sharesText;

  // 进度条
  const ratio      = Math.min(currentVal / target, 1.5);
  const fillPct    = Math.min(ratio * 100, 100);
  const targetLine = Math.min((1 / Math.min(ratio, 1.5)) * fillPct, 100);
  document.getElementById("progress-fill").style.width   = `${fillPct}%`;
  document.getElementById("progress-target").style.left  = `${Math.min(100, 100 / Math.max(ratio, 0.01) * ratio)}%`;
  document.getElementById("prog-label-mid").textContent  = fmtUSD(target / 2, 0);
  document.getElementById("prog-label-end").textContent  = fmtUSD(target, 0);
  document.getElementById("progress-hint").textContent   = `操作后偏差：${fmtPct(afterPct)}`;

  // 带宽提示
  const bandLo = cfg.a - cfg.b;
  const bandHi = cfg.a + cfg.b;
  let bandNote = `带宽 [${fmtUSD(bandLo < 0 ? bandLo : bandLo, 0)}, ${fmtUSD(bandHi, 0)}]`;
  if (clipped) bandNote += "  ⚠️ 已触达带宽边界";
  document.getElementById("action-band").textContent = bandNote;

  // 记录按钮
  const recordBtn = document.getElementById("record-btn");
  recordBtn.disabled = false;
  recordBtn.textContent = "📝 记录本月操作";

  // 未来路径
  const futureBody = document.getElementById("future-body");
  futureBody.innerHTML = Array.from({ length: 6 }, (_, i) => {
    const fi  = i + 1;
    const fYM = addMonths(currentYM, fi);
    const fn  = n + fi;
    const ft  = targetValue(fn, cfg.a, annualR);
    const dt  = ft - target;
    const lo  = Math.max(cfg.a - cfg.b, 0);
    const hi  = cfg.a + cfg.b;
    const maxSell = Math.max(cfg.b - cfg.a, 0);
    const rowClass = fi === 1 ? "next-month" : "";
    const nextTag  = fi === 1 ? " ← 下月" : "";
    return `<tr class="${rowClass}">
      <td>${fYM}${nextTag}</td>
      <td>${fn}</td>
      <td>${fmtUSD(ft)}</td>
      <td class="${dt >= 0 ? "" : "negative"}">+${fmtUSD(dt, 0)}</td>
      <td>${fmtUSD(lo, 0)} – ${fmtUSD(hi, 0)}</td>
      <td>${maxSell > 0 ? fmtUSD(maxSell, 0) : "—"}</td>
    </tr>`;
  }).join("");

  // 显示结果区
  document.getElementById("result-section").classList.remove("result-hidden");
  document.getElementById("future-section").classList.remove("result-hidden");
  document.getElementById("result-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── 记录操作 ─────────────────────────────────────────────────────────────────

function recordOperation() {
  if (!lastResult) return;
  const { cfg, currentYM, n, target, raw, clamped, currentVal, afterVal, price } = lastResult;
  const note = document.getElementById("cur-note").value.trim();

  let action, amount;
  if (Math.abs(clamped) < 0.01) {
    action = "不操作"; amount = 0;
  } else if (clamped > 0) {
    action = "买入";   amount = clamped;
  } else {
    action = "卖出";   amount = -clamped;
  }

  const history = loadHistory();

  // 检查本月是否已有记录
  if (history.some(r => r.month === currentYM)) {
    if (!confirm(`${currentYM} 已有记录，确定要再追加一条吗？`)) return;
  }

  history.push({
    month: currentYM, n,
    target:      Number(target.toFixed(2)),
    valueBefore: Number(currentVal.toFixed(2)),
    action,
    amount:      Number(amount.toFixed(2)),
    valueAfter:  Number(afterVal.toFixed(2)),
    price:       price ? Number(price.toFixed(2)) : null,
    note,
    savedAt:     new Date().toISOString(),
  });

  saveHistory(history);
  renderHistory();

  const btn = document.getElementById("record-btn");
  btn.textContent = "✅ 已记录";
  btn.disabled    = true;
}

// ── 导出 CSV ─────────────────────────────────────────────────────────────────

function exportCSV() {
  const rows = loadHistory();
  if (!rows.length) { alert("暂无历史记录。"); return; }

  const headers = ["月份","第n月","目标市值","操作前市值","操作","操作金额","操作后市值","ETF单价","备注","记录时间"];
  const lines   = [headers.join(",")];
  rows.forEach(r => {
    lines.push([
      r.month, r.n, r.target, r.valueBefore,
      r.action, r.amount, r.valueAfter,
      r.price ?? "", r.note ?? "", r.savedAt ?? "",
    ].join(","));
  });

  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `va_history_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 参数变化时自动保存 ────────────────────────────────────────────────────────

function bindAutoSave() {
  ["cfg-start","cfg-a","cfg-b","cfg-r","cfg-etf"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
      const cfg = getConfig();
      if (cfg.startDate && cfg.a && cfg.b && cfg.rPct) saveConfig(cfg);
    });
  });
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

function init() {
  // 设置当前月份默认值
  const now = new Date();
  document.getElementById("cur-month").value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // 读取已保存参数
  const cfg = loadConfig();
  if (cfg) {
    applyConfig(cfg);
    document.getElementById("config-status").textContent =
      `📁 已加载上次保存的参数`;
  }

  // 渲染历史
  renderHistory();

  // 绑定按钮
  document.getElementById("calc-btn").addEventListener("click", calculate);
  document.getElementById("record-btn").addEventListener("click", recordOperation);
  document.getElementById("export-btn").addEventListener("click", exportCSV);
  document.getElementById("clear-btn").addEventListener("click", () => {
    if (confirm("确定清空所有历史记录？此操作不可撤销。")) {
      saveHistory([]);
      renderHistory();
    }
  });

  // 自动保存参数
  bindAutoSave();

  // Enter 键触发计算
  ["cur-month","cur-value","cur-price"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") calculate();
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
