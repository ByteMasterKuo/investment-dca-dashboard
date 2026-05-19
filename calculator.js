// ── 核心计算 ─────────────────────────────────────────────────────────────────

function monthlyRate(annualR) {
  return (1 + annualR) ** (1 / 12) - 1;
}

// 标准 VA 年金终值公式：每月固定贡献 a，复利目标 V(n) = a×[(1+r月)ⁿ−1]/r月
function targetValue(n, base, annualR) {
  const r = monthlyRate(annualR);
  if (Math.abs(r) < 1e-10) return base * n;
  return base * ((1 + r) ** n - 1) / r;
}

// 通胀调整 VA：V(n) = V(n-1)×(1+r月) + base×(1+x月)ⁿ
function targetValueInflation(n, base, annualR, annualX) {
  const r = monthlyRate(annualR);
  const x = monthlyRate(annualX);
  let v = 0;
  for (let i = 1; i <= n; i++) {
    v = v * (1 + r) + base * (1 + x) ** i;
  }
  return v;
}

function vaAction(currentValue, n, base, annualR, band, annualX = 0) {
  const x       = monthlyRate(annualX);
  const effBase = annualX > 0 ? base * (1 + x) ** n : base;
  const effBand = annualX > 0 ? band * (1 + x) ** n : band;
  const target  = annualX > 0
    ? targetValueInflation(n, base, annualR, annualX)
    : targetValue(n, base, annualR);
  const raw     = target - currentValue;
  let   clamped = Math.min(Math.max(raw, effBase - effBand), effBase + effBand);
  clamped = Math.max(clamped, -currentValue);
  return { target, raw, clamped, clipped: Math.abs(clamped - raw) > 0.01, effBase, effBand };
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

// ── 行内错误提示 ──────────────────────────────────────────────────────────────

function showError(anchorId, msg) {
  const anchor = document.getElementById(anchorId);
  let el = document.getElementById(anchorId + "-error");
  if (!el) {
    el = document.createElement("p");
    el.id = anchorId + "-error";
    el.style.cssText = "color:#c2410c;font-size:13px;margin:8px 0 0;font-weight:500";
    anchor.insertAdjacentElement("afterend", el);
  }
  el.textContent = "⚠️ " + msg;
  setTimeout(() => { if (el.parentNode) el.textContent = ""; }, 5000);
}

function setStatus(msg) {
  document.getElementById("config-status").textContent = msg;
}

// ── 多标的 Profile 管理 ───────────────────────────────────────────────────────

const PROFILES_KEY  = "va_profiles";   // [{id, name}]
const ACTIVE_ID_KEY = "va_active_id";  // string

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]"); }
  catch { return []; }
}

function saveProfiles(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function getActiveId() {
  return localStorage.getItem(ACTIVE_ID_KEY) || null;
}

function setActiveId(id) {
  localStorage.setItem(ACTIVE_ID_KEY, id);
}

function profileConfigKey(id)  { return `va_config_${id}`; }
function profileHistoryKey(id) { return `va_history_${id}`; }

// 旧版单标的数据迁移
function migrateIfNeeded() {
  const profiles = loadProfiles();
  if (profiles.length > 0) return;

  const oldConfig = (() => {
    try { return JSON.parse(localStorage.getItem("va_calculator_config") || "null"); }
    catch { return null; }
  })();
  const oldHistory = (() => {
    try { return JSON.parse(localStorage.getItem("va_calculator_history") || "[]"); }
    catch { return []; }
  })();

  const id   = genId();
  const name = oldConfig?.etfName || oldConfig?.name || "默认策略";
  saveProfiles([{ id, name }]);
  setActiveId(id);
  if (oldConfig)         localStorage.setItem(profileConfigKey(id),  JSON.stringify(oldConfig));
  if (oldHistory.length) localStorage.setItem(profileHistoryKey(id), JSON.stringify(oldHistory));
}

// ── 读写当前标的的 config / history ──────────────────────────────────────────

function loadConfig() {
  const id = getActiveId();
  if (!id) return null;
  try { return JSON.parse(localStorage.getItem(profileConfigKey(id)) || "null"); }
  catch { return null; }
}

function saveConfig(cfg) {
  const id = getActiveId();
  if (!id) return;
  localStorage.setItem(profileConfigKey(id), JSON.stringify(cfg));
}

function loadHistory() {
  const id = getActiveId();
  if (!id) return [];
  try { return JSON.parse(localStorage.getItem(profileHistoryKey(id)) || "[]"); }
  catch { return []; }
}

function saveHistory(rows) {
  const id = getActiveId();
  if (!id) return;
  localStorage.setItem(profileHistoryKey(id), JSON.stringify(rows));
}

// ── Profile UI ────────────────────────────────────────────────────────────────

function renderProfileSelect() {
  const sel      = document.getElementById("profile-select");
  const profiles = loadProfiles();
  const activeId = getActiveId();
  if (!profiles.length) {
    sel.innerHTML = '<option value="">（无策略）</option>';
    return;
  }
  sel.innerHTML = profiles
    .map(p => `<option value="${p.id}"${p.id === activeId ? " selected" : ""}>${p.name}</option>`)
    .join("");
}

function switchProfile(id) {
  setActiveId(id);
  const cfg = loadConfig();
  if (cfg) applyConfig(cfg);
  else clearConfig();
  renderHistory();
  setStatus("📁 已切换：" + (loadProfiles().find(p => p.id === id)?.name || ""));
}

function saveCurrentProfile() {
  const cfg      = getConfig();
  const profiles = loadProfiles();
  let   activeId = getActiveId();

  if (!activeId || !profiles.find(p => p.id === activeId)) {
    // 没有激活的 profile → 新建
    const id   = genId();
    const name = cfg.name || "新策略";
    profiles.push({ id, name });
    saveProfiles(profiles);
    setActiveId(id);
    activeId = id;
  } else {
    // 更新名称
    const idx = profiles.findIndex(p => p.id === activeId);
    if (idx >= 0) profiles[idx].name = cfg.name || profiles[idx].name;
    saveProfiles(profiles);
  }

  saveConfig(cfg);
  renderProfileSelect();
  setStatus(`✅ 已保存「${cfg.name || "策略"}」（${new Date().toLocaleString("zh-CN")}）`);
}

function addNewProfile() {
  const id   = genId();
  const name = "新策略 " + (loadProfiles().length + 1);
  const profiles = loadProfiles();
  profiles.push({ id, name });
  saveProfiles(profiles);
  setActiveId(id);
  clearConfig();
  renderProfileSelect();
  renderHistory();
  document.getElementById("cfg-name").value = name;
  document.getElementById("cfg-name").focus();
  document.getElementById("cfg-name").select();
  setStatus("✏️ 请填写新策略参数后点击保存");
}

function deleteCurrentProfile() {
  const activeId = getActiveId();
  if (!activeId) return;
  let profiles = loadProfiles();
  const target = profiles.find(p => p.id === activeId);
  if (!target) return;
  if (!confirm(`确定删除策略「${target.name}」？此操作不可撤销。`)) return;

  localStorage.removeItem(profileConfigKey(activeId));
  localStorage.removeItem(profileHistoryKey(activeId));
  profiles = profiles.filter(p => p.id !== activeId);
  saveProfiles(profiles);

  if (profiles.length) {
    setActiveId(profiles[profiles.length - 1].id);
    const cfg = loadConfig();
    if (cfg) applyConfig(cfg);
    else clearConfig();
    renderHistory();
  } else {
    setActiveId(null);
    clearConfig();
    renderHistory();
  }
  renderProfileSelect();
  setStatus("🗑 策略已删除");
}

// ── 读取 / 写入参数面板 ───────────────────────────────────────────────────────

function getConfig() {
  return {
    name:         document.getElementById("cfg-name").value.trim(),
    startDate:    document.getElementById("cfg-start").value,
    a:            Number(document.getElementById("cfg-a").value),
    b:            Number(document.getElementById("cfg-b").value),
    rPct:         Number(document.getElementById("cfg-r").value),
    etfName:      document.getElementById("cfg-etf").value.trim(),
    strategyType: document.getElementById("cfg-strategy").value,
    xPct:         Number(document.getElementById("cfg-x").value) || 0,
  };
}

function applyConfig(cfg) {
  document.getElementById("cfg-name").value      = cfg.name         || "";
  document.getElementById("cfg-start").value     = cfg.startDate    || "";
  document.getElementById("cfg-a").value         = cfg.a            || "";
  document.getElementById("cfg-b").value         = cfg.b            || "";
  document.getElementById("cfg-r").value         = cfg.rPct         || "";
  document.getElementById("cfg-etf").value       = cfg.etfName      || "";
  document.getElementById("cfg-strategy").value  = cfg.strategyType || "standard";
  document.getElementById("cfg-x").value         = cfg.xPct         || "";
  document.getElementById("field-x").style.display =
    cfg.strategyType === "inflation" ? "" : "none";
}

function clearConfig() {
  ["cfg-name","cfg-start","cfg-a","cfg-b","cfg-r","cfg-etf","cfg-x"].forEach(id => {
    document.getElementById(id).value = "";
  });
  document.getElementById("cfg-strategy").value = "standard";
  document.getElementById("field-x").style.display = "none";
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
    const cls  = r.action === "买入" ? "op-buy" : r.action === "卖出" ? "op-sell" : "op-hold";
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

let lastResult = null;

function calculate() {
  const cfg         = getConfig();
  const currentYM   = document.getElementById("cur-month").value;
  const currentVal  = Number(document.getElementById("cur-value").value);
  const priceInput  = document.getElementById("cur-price").value;
  const price       = priceInput ? Number(priceInput) : null;

  const curValueRaw = document.getElementById("cur-value").value;
  if (!cfg.startDate || !cfg.a || !cfg.b || !cfg.rPct || !currentYM || curValueRaw === "") {
    showError("calc-btn", "请填写所有必填项（策略参数 + 当前月份 + 当前市值）");
    return;
  }
  if (cfg.strategyType === "inflation" && !cfg.xPct) {
    showError("calc-btn", "通胀调整 VA 需要填写通货膨胀率 x%");
    return;
  }
  const n = monthN(cfg.startDate, currentYM);
  if (n <= 0) {
    showError("calc-btn", "当前月份早于策略起始月份，请检查。");
    return;
  }

  const annualR = cfg.rPct / 100;
  const annualX = cfg.strategyType === "inflation" ? cfg.xPct / 100 : 0;
  const res     = vaAction(currentVal, n, cfg.a, annualR, cfg.b, annualX);
  const { target, raw, clamped, clipped, effBase, effBand } = res;
  const afterVal = currentVal + clamped;
  const devPct   = (currentVal / target - 1) * 100;
  const afterPct = (afterVal  / target - 1) * 100;

  lastResult = { cfg, currentYM, n, target, raw, clamped, currentVal, afterVal, price, annualX };

  let actionType, icon, amountText, sharesText, cardClass;
  if (Math.abs(clamped) < 0.01) {
    actionType = "hold"; icon = "⏸";
    amountText = "无需操作"; sharesText = "市值贴合目标路径"; cardClass = "hold";
  } else if (clamped > 0) {
    actionType = "buy"; icon = "📈";
    amountText = `买入 ${fmtUSD(clamped, 0)}`;
    sharesText = price ? `≈ ${(clamped / price).toFixed(4)} 股 @ ${fmtUSD(price)}` : "";
    cardClass  = "buy";
  } else {
    const sell = -clamped;
    actionType = "sell"; icon = "📉";
    amountText = `卖出 ${fmtUSD(sell, 0)}`;
    sharesText = price ? `≈ ${(sell / price).toFixed(4)} 股 @ ${fmtUSD(price)}` : "";
    cardClass  = "sell";
  }

  const etfLabel = cfg.etfName ? ` · ${cfg.etfName}` : "";
  document.getElementById("result-title").textContent    = `第 ${n} 个月${etfLabel}`;
  document.getElementById("result-subtitle").textContent = `${cfg.startDate} 起投 · ${currentYM}`;

  const devEl = document.getElementById("res-dev");
  document.getElementById("res-target").textContent  = fmtUSD(target);
  document.getElementById("res-current").textContent = fmtUSD(currentVal);
  devEl.textContent = fmtPct(devPct);
  devEl.className   = `metric-value ${devPct < 0 ? "positive" : "negative"}`;
  document.getElementById("res-after").textContent   = fmtUSD(afterVal);

  const card = document.getElementById("action-card");
  card.className = `action-card ${cardClass}`;
  document.getElementById("action-month").textContent  = `${currentYM}  ·  策略第 ${n} 个月`;
  document.getElementById("action-icon").textContent   = icon;
  document.getElementById("action-amount").textContent = amountText;
  document.getElementById("action-shares").textContent = sharesText;

  const ratio   = Math.min(currentVal / target, 1.5);
  const fillPct = Math.min(ratio * 100, 100);
  document.getElementById("progress-fill").style.width  = `${fillPct}%`;
  document.getElementById("progress-target").style.left = `${Math.min(100, 100 / Math.max(ratio, 0.01) * ratio)}%`;
  document.getElementById("prog-label-mid").textContent = fmtUSD(target / 2, 0);
  document.getElementById("prog-label-end").textContent = fmtUSD(target, 0);
  document.getElementById("progress-hint").textContent  = `操作后偏差：${fmtPct(afterPct)}`;

  const bandLo   = effBase - effBand;
  const bandHi   = effBase + effBand;
  let   bandNote = `带宽 [${fmtUSD(bandLo, 0)}, ${fmtUSD(bandHi, 0)}]`;
  if (annualX > 0) bandNote += `  基线 ${fmtUSD(effBase, 0)}`;
  if (clipped)     bandNote += "  ⚠️ 已触达带宽边界";
  document.getElementById("action-band").textContent = bandNote;

  const recordBtn = document.getElementById("record-btn");
  recordBtn.disabled    = false;
  recordBtn.textContent = "📝 记录本月操作";

  const futureBody = document.getElementById("future-body");
  const xm = monthlyRate(annualX);
  futureBody.innerHTML = Array.from({ length: 6 }, (_, i) => {
    const fi   = i + 1;
    const fYM  = addMonths(currentYM, fi);
    const fn   = n + fi;
    const ft   = annualX > 0
      ? targetValueInflation(fn, cfg.a, annualR, annualX)
      : targetValue(fn, cfg.a, annualR);
    const dt      = ft - target;
    const fBase   = annualX > 0 ? cfg.a * (1 + xm) ** fn : cfg.a;
    const fBand   = annualX > 0 ? cfg.b * (1 + xm) ** fn : cfg.b;
    const lo      = Math.max(fBase - fBand, 0);
    const hi      = fBase + fBand;
    const maxSell = Math.max(fBand - fBase, 0);
    const rowClass = fi === 1 ? "next-month" : "";
    const nextTag  = fi === 1 ? " ← 下月" : "";
    return `<tr class="${rowClass}">
      <td>${fYM}${nextTag}</td><td>${fn}</td>
      <td>${fmtUSD(ft)}</td>
      <td class="${dt >= 0 ? "" : "negative"}">+${fmtUSD(dt, 0)}</td>
      <td>${fmtUSD(lo, 0)} – ${fmtUSD(hi, 0)}</td>
      <td>${maxSell > 0 ? fmtUSD(maxSell, 0) : "—"}</td>
    </tr>`;
  }).join("");

  document.getElementById("result-section").classList.remove("result-hidden");
  document.getElementById("future-section").classList.remove("result-hidden");
  document.getElementById("result-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── 12 个月目标规划 ───────────────────────────────────────────────────────────

function generatePlan() {
  const cfg = getConfig();

  if (!cfg.a || !cfg.b || !cfg.rPct) {
    showError("plan-btn", "请先填写策略参数：月定投基准 a、波动带宽 b、预期年化收益率 r%");
    return;
  }
  const planValueEl = document.getElementById("plan-value");
  const V0 = Number(planValueEl.value);
  if (!planValueEl.value || isNaN(V0) || V0 < 0) {
    showError("plan-btn", "请输入当前持仓市值");
    return;
  }
  if (cfg.strategyType === "inflation" && !cfg.xPct) {
    showError("plan-btn", "通胀调整 VA 需要在策略参数中填写通货膨胀率 x%");
    return;
  }

  const annualR = cfg.rPct / 100;
  const annualX = cfg.strategyType === "inflation" ? cfg.xPct / 100 : 0;
  const r = monthlyRate(annualR);
  const x = monthlyRate(annualX);

  let baseN = 0;
  const curMonthVal = document.getElementById("cur-month").value;
  if (cfg.startDate && curMonthVal) {
    const n = monthN(cfg.startDate, curMonthVal);
    if (n > 0) baseN = n;
  }

  const noteEl = document.getElementById("plan-note");
  if (annualX > 0 && baseN === 0) {
    noteEl.textContent = "⚠️ 通胀调整 VA：未能推算当前月数（请在「本月持仓」填写当前月份和起始月份），带宽缩放从第 1 月开始估算。";
  } else if (annualX > 0) {
    noteEl.textContent = `当前为第 ${baseN} 个月，通胀缩放从第 ${baseN + 1} 月起累计。`;
  } else {
    noteEl.textContent = `标准 VA（x=0），月买入区间固定：[${fmtUSD(Math.max(cfg.a - cfg.b, 0), 0)}, ${fmtUSD(cfg.a + cfg.b, 0)}]。`;
  }

  const rows = [];
  let prevTarget = V0;

  for (let k = 1; k <= 12; k++) {
    const absN      = baseN + k;
    const effBase   = annualX > 0 ? cfg.a * (1 + x) ** absN : cfg.a;
    const effBand   = annualX > 0 ? cfg.b * (1 + x) ** absN : cfg.b;
    const newTarget = prevTarget * (1 + r) + effBase;
    const totalInc  = newTarget - V0;
    const monthInc  = newTarget - prevTarget;
    const lo        = Math.max(effBase - effBand, 0);
    const hi        = effBase + effBand;
    const maxSell   = Math.max(effBand - effBase, 0);
    rows.push({ k, newTarget, totalInc, monthInc, lo, hi, maxSell });
    prevTarget = newTarget;
  }

  document.getElementById("plan-body").innerHTML = rows.map(row => `<tr>
    <td>第 ${row.k} 个月</td>
    <td><strong>${fmtUSD(row.newTarget)}</strong></td>
    <td class="positive">+${fmtUSD(row.totalInc, 0)}</td>
    <td>${fmtUSD(row.monthInc, 0)}</td>
    <td>${fmtUSD(row.lo, 0)} – ${fmtUSD(row.hi, 0)}</td>
    <td>${row.maxSell > 0 ? fmtUSD(row.maxSell, 0) : "—"}</td>
  </tr>`).join("");

  document.getElementById("plan-result").style.display = "";
  document.getElementById("plan-result").scrollIntoView({ behavior: "smooth", block: "start" });
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
    action = "买入"; amount = clamped;
  } else {
    action = "卖出"; amount = -clamped;
  }

  const history = loadHistory();
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
  if (!rows.length) { showError("export-btn", "暂无历史记录"); return; }

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

// ── 参数变化时自动保存草稿 ────────────────────────────────────────────────────

function bindAutoSave() {
  ["cfg-name","cfg-start","cfg-a","cfg-b","cfg-r","cfg-etf","cfg-strategy","cfg-x"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
      const activeId = getActiveId();
      if (activeId) saveConfig(getConfig());
    });
  });
  document.getElementById("cfg-strategy").addEventListener("change", () => {
    const isInflation = document.getElementById("cfg-strategy").value === "inflation";
    document.getElementById("field-x").style.display = isInflation ? "" : "none";
  });
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

function init() {
  // 迁移旧数据
  migrateIfNeeded();

  // 确保有激活的 profile
  const profiles = loadProfiles();
  if (profiles.length && !getActiveId()) setActiveId(profiles[0].id);

  // 渲染 profile 下拉
  renderProfileSelect();

  // 加载当前 profile 参数
  const cfg = loadConfig();
  if (cfg) {
    applyConfig(cfg);
    setStatus("📁 已加载上次保存的参数");
  }

  // 设置当前月份默认值
  const now = new Date();
  document.getElementById("cur-month").value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // 渲染历史
  renderHistory();

  // 绑定 profile 按钮
  document.getElementById("profile-save-btn").addEventListener("click", saveCurrentProfile);
  document.getElementById("profile-add-btn").addEventListener("click", addNewProfile);
  document.getElementById("profile-delete-btn").addEventListener("click", deleteCurrentProfile);
  document.getElementById("profile-select").addEventListener("change", e => {
    if (e.target.value) switchProfile(e.target.value);
  });

  // 绑定功能按钮
  document.getElementById("calc-btn").addEventListener("click", calculate);
  document.getElementById("plan-btn").addEventListener("click", generatePlan);
  document.getElementById("record-btn").addEventListener("click", recordOperation);
  document.getElementById("export-btn").addEventListener("click", exportCSV);
  document.getElementById("clear-btn").addEventListener("click", () => {
    if (confirm("确定清空当前策略的所有历史记录？此操作不可撤销。")) {
      saveHistory([]);
      renderHistory();
    }
  });

  // 自动保存草稿
  bindAutoSave();

  // Enter 键快捷触发
  ["cur-month","cur-value","cur-price"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") calculate();
    });
  });
  document.getElementById("plan-value").addEventListener("keydown", e => {
    if (e.key === "Enter") generatePlan();
  });
}

document.addEventListener("DOMContentLoaded", init);
