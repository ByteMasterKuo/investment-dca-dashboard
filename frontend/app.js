const COLORS = ["#2563eb", "#0f766e", "#9333ea", "#ea580c", "#dc2626", "#b45309", "#0891b2"];
const DYNAMIC_STRATEGY_KEY = "target_value_band_dca";

let appData = null;
let portfolioChart = null;
let annualizedChart = null;
let principalChart = null;

function formatCurrency(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }
  return `${value.toFixed(2)}%`;
}

function xirr(cashFlows) {
  if (!cashFlows.length) {
    return null;
  }

  const hasPositive = cashFlows.some((item) => item.amount > 0);
  const hasNegative = cashFlows.some((item) => item.amount < 0);
  if (!hasPositive || !hasNegative) {
    return null;
  }

  const startDate = new Date(cashFlows[0].date);

  function npv(rate) {
    return cashFlows.reduce((total, flow) => {
      const years = (new Date(flow.date) - startDate) / (365.25 * 24 * 3600 * 1000);
      return total + flow.amount / ((1 + rate) ** years);
    }, 0);
  }

  let low = -0.9999;
  let high = 1.0;
  let npvLow = npv(low);
  let npvHigh = npv(high);

  while (npvLow * npvHigh > 0 && high < 1024) {
    high *= 2;
    npvHigh = npv(high);
  }

  if (npvLow * npvHigh > 0) {
    return null;
  }

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < 1e-8) {
      return mid;
    }
    if (npvLow * npvMid <= 0) {
      high = mid;
      npvHigh = npvMid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }

  return (low + high) / 2;
}

function compressSeries(series) {
  if (!series.length) {
    return [];
  }

  const compressed = [];
  let previousMonth = null;
  series.forEach((point) => {
    const currentMonth = point.date.slice(0, 7);
    if (currentMonth !== previousMonth) {
      compressed.push(point);
      previousMonth = currentMonth;
    }
  });

  if (compressed[compressed.length - 1].date !== series[series.length - 1].date) {
    compressed.push(series[series.length - 1]);
  }

  return compressed;
}

function buildPeriodKey(date, frequency) {
  const targetDate = new Date(`${date}T00:00:00`);
  if (frequency === "monthly") {
    return date.slice(0, 7);
  }
  if (frequency === "yearly") {
    return date.slice(0, 4);
  }
  if (frequency === "weekly") {
    const thursday = new Date(targetDate);
    const day = (targetDate.getDay() + 6) % 7;
    thursday.setDate(targetDate.getDate() - day + 3);
    const firstThursday = new Date(thursday.getFullYear(), 0, 4);
    const firstDay = (firstThursday.getDay() + 6) % 7;
    firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
    const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
    return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  return date;
}

function summarizeStrategy({ key, label, description, principal, shares, cashFlows, series }) {
  const endingValue = series.length ? series[series.length - 1].value : 0;
  const endDateStr = series.length ? series[series.length - 1].date : null;
  const endDate = endDateStr ? new Date(`${endDateStr}T00:00:00`) : null;
  
  const { inflationRate } = getStrategyInputs();
  let adjustedPrincipal = 0;
  
  if (endDate) {
    // 购入为负流（流出），减仓为正流（流入）；取反后购入加、减仓减
    cashFlows.forEach(flow => {
      const flowDate = new Date(`${flow.date}T00:00:00`);
      const years = (endDate - flowDate) / (365.25 * 24 * 3600 * 1000);
      adjustedPrincipal -= flow.amount * Math.pow(1 + inflationRate / 100, years);
    });
  } else {
    adjustedPrincipal = principal;
  }

  const totalReturn = endingValue - principal;
  const adjustedTotalReturn = endingValue - adjustedPrincipal;
  // 有任何现金流就计算 XIRR（支持含减仓的策略）
  const annualized = cashFlows.length > 0 && series.length
    ? xirr([...cashFlows, { date: series[series.length - 1].date, amount: endingValue }])
    : null;
  // adjustedPrincipal ≤ 0 表示减仓已全部回本，倍数无意义（≡ ∞），显示 null
  const realMultiple = adjustedPrincipal > 0
    ? Number((endingValue / adjustedPrincipal).toFixed(2))
    : null;

  return {
    key,
    label,
    description,
    principal: Number(principal.toFixed(2)),
    adjusted_principal: Number(adjustedPrincipal.toFixed(2)),
    shares: Number(shares.toFixed(6)),
    ending_value: Number(endingValue.toFixed(2)),
    total_return: Number(totalReturn.toFixed(2)),
    adjusted_total_return: Number(adjustedTotalReturn.toFixed(2)),
    total_return_pct: principal ? Number(((totalReturn / principal) * 100).toFixed(2)) : 0,
    adjusted_total_return_pct: adjustedPrincipal ? Number(((adjustedTotalReturn / adjustedPrincipal) * 100).toFixed(2)) : 0,
    annualized_return_pct: annualized === null ? null : Number((annualized * 100).toFixed(2)),
    real_multiple: realMultiple,
    series: compressSeries(series),
  };
}

function simulateFixedAmountStrategy(marketTimeline, { key, label, description, frequency, amount }) {
  let previousPeriod = null;
  let principal = 0;
  let shares = 0;
  const cashFlows = [];
  const series = [];

  marketTimeline.forEach((point, index) => {
    let investAmount = 0;
    if (frequency === "once") {
      if (index === 0) {
        investAmount = amount;
      }
    } else {
      const periodKey = buildPeriodKey(point.date, frequency);
      if (periodKey !== previousPeriod) {
        investAmount = amount;
        previousPeriod = periodKey;
      }
    }

    if (investAmount > 0) {
      shares += investAmount / point.average_price;
      principal += investAmount;
      cashFlows.push({ date: point.date, amount: -investAmount });
    }

    series.push({
      date: point.date,
      value: Number((shares * point.average_price).toFixed(2)),
      principal: Number(principal.toFixed(2)),
      shares: Number(shares.toFixed(6)),
    });
  });

  return summarizeStrategy({ key, label, description, principal, shares, cashFlows, series });
}

function simulateTargetSharesStrategy(marketTimeline, targetTotalShares) {
  const uniqueMonths = [...new Set(marketTimeline.map((point) => point.date.slice(0, 7)))];
  const totalPeriods = uniqueMonths.length;
  let periodIndex = 0;
  let previousPeriod = null;
  let principal = 0;
  let shares = 0;
  const cashFlows = [];
  const series = [];

  marketTimeline.forEach((point) => {
    const periodKey = point.date.slice(0, 7);
    if (periodKey !== previousPeriod) {
      periodIndex += 1;
      previousPeriod = periodKey;
      const targetSharesNow = targetTotalShares * (periodIndex / totalPeriods);
      const buyShares = Math.max(targetSharesNow - shares, 0);
      const investAmount = buyShares * point.average_price;
      if (investAmount > 0) {
        shares += buyShares;
        principal += investAmount;
        cashFlows.push({ date: point.date, amount: -investAmount });
      }
    }

    series.push({
      date: point.date,
      value: Number((shares * point.average_price).toFixed(2)),
      principal: Number(principal.toFixed(2)),
      shares: Number(shares.toFixed(6)),
    });
  });

  return summarizeStrategy({
    key: "target_shares_dca",
    label: "目标总股本定投",
    description: `按月向 ${targetTotalShares.toFixed(0)} 股的目标持仓线性逼近，单次投入金额随价格变化。`,
    principal,
    shares,
    cashFlows,
    series,
  });
}

function simulateUnlimitedVaStrategy(marketTimeline, annualTargetReturnPct, monthlyBaseAmount) {
  const monthlyTargetRate = (1 + annualTargetReturnPct / 100) ** (1 / 12) - 1;
  let previousPeriod = null;
  let periodIndex = 0;
  let shares = 0;
  let netPrincipal = 0;
  const cashFlows = [];
  const series = [];
  let maxBuy = { date: null, amount: 0, portfolioValue: 0 };
  let maxSell = { date: null, amount: 0, portfolioValue: 0 };

  marketTimeline.forEach((point) => {
    const periodKey = point.date.slice(0, 7);
    if (periodKey !== previousPeriod) {
      previousPeriod = periodKey;
      periodIndex += 1;
      const currentValue = shares * point.average_price;
      const targetValue = monthlyBaseAmount * periodIndex * (1 + monthlyTargetRate) ** periodIndex;
      const delta = targetValue - currentValue;

      if (delta > 0) {
        shares += delta / point.average_price;
        netPrincipal += delta;
        cashFlows.push({ date: point.date, amount: -delta });
        if (delta > maxBuy.amount) maxBuy = { date: point.date, amount: delta, portfolioValue: shares * point.average_price };
      } else if (delta < 0) {
        const sellValue = Math.min(-delta, shares * point.average_price);
        shares -= sellValue / point.average_price;
        netPrincipal -= sellValue;
        cashFlows.push({ date: point.date, amount: sellValue });
        if (sellValue > maxSell.amount) maxSell = { date: point.date, amount: sellValue, portfolioValue: shares * point.average_price };
      }
    }

    series.push({
      date: point.date,
      value: Number((shares * point.average_price).toFixed(2)),
      principal: Number(netPrincipal.toFixed(2)),
      shares: Number(shares.toFixed(6)),
    });
  });

  const result = summarizeStrategy({
    key: "unlimited_va",
    label: "无限制价值平均",
    description: `无带宽约束的价值平均法，目标市值 V(n)=a×n×(1+r月)ⁿ，不足时全额补入，超出时减仓至目标，年化目标 ${annualTargetReturnPct.toFixed(1)}%、基准 ${monthlyBaseAmount.toFixed(0)} 美元/月。`,
    principal: netPrincipal,
    shares,
    cashFlows,
    series,
  });
  result.max_buy = maxBuy.date ? maxBuy : null;
  result.max_sell = maxSell.date ? maxSell : null;
  return result;
}

function simulateDynamicStrategy(marketTimeline, annualTargetReturnPct, monthlyBaseAmount, band) {
  const monthlyTargetRate = (1 + annualTargetReturnPct / 100) ** (1 / 12) - 1;
  let previousPeriod = null;
  let periodIndex = 0;
  let netPrincipal = 0;
  let shares = 0;
  const cashFlows = [];
  const series = [];
  const canSell = band > monthlyBaseAmount;

  marketTimeline.forEach((point) => {
    const periodKey = point.date.slice(0, 7);
    if (periodKey !== previousPeriod) {
      previousPeriod = periodKey;
      periodIndex += 1;
      const currentValue = shares * point.average_price;
      // 标准价值平均法：目标市值沿固定复利路径增长 V_n = base × n × (1 + r_月)^n
      const targetValue = monthlyBaseAmount * periodIndex * (1 + monthlyTargetRate) ** periodIndex;
      const rawInvestAmount = targetValue - currentValue;
      // 区间 [base−band, base+band]；当 band > base 时下限为负，允许减仓
      const investAmount = Math.min(
        Math.max(rawInvestAmount, monthlyBaseAmount - band),
        monthlyBaseAmount + band,
      );

      if (investAmount > 0) {
        shares += investAmount / point.average_price;
        netPrincipal += investAmount;
        cashFlows.push({ date: point.date, amount: -investAmount });
      } else if (investAmount < 0) {
        // 减仓：卖出不超过持仓市值
        const sellValue = Math.min(-investAmount, shares * point.average_price);
        shares -= sellValue / point.average_price;
        netPrincipal -= sellValue;
        cashFlows.push({ date: point.date, amount: sellValue });
      }
    }

    series.push({
      date: point.date,
      value: Number((shares * point.average_price).toFixed(2)),
      principal: Number(netPrincipal.toFixed(2)),
      shares: Number(shares.toFixed(6)),
    });
  });

  const sellNote = canSell
    ? `；波动带大于月定投额，市值大幅超出目标时允许减仓`
    : `；市值低于目标时多补，高于时少投，不减仓`;

  return summarizeStrategy({
    key: DYNAMIC_STRATEGY_KEY,
    label: "目标收益带宽定投",
    description: `按标准价值平均法，预期年化 ${annualTargetReturnPct.toFixed(1)}%、基准 ${monthlyBaseAmount.toFixed(0)} 美元/月、波动带 ±${band.toFixed(0)} 美元，投入区间 [${(monthlyBaseAmount - band).toFixed(0)}, ${(monthlyBaseAmount + band).toFixed(0)}] 美元${sellNote}。`,
    principal: netPrincipal,
    shares,
    cashFlows,
    series,
  });
}

function getStrategyInputs() {
  return {
    startDate: document.getElementById("start-date").value,
    endDate: document.getElementById("end-date").value,
    inflationRate: Number(document.getElementById("inflation-rate").value) || 0,
    annualTargetReturnPct: Number(document.getElementById("annual-target-return").value),
    monthlyBaseAmount: Number(document.getElementById("monthly-base-amount").value),
    band: Number(document.getElementById("monthly-band").value),
  };
}

function getFilteredTimeline(indexData) {
  const { startDate, endDate } = getStrategyInputs();
  return indexData.market_timeline.filter(
    (point) => point.date >= startDate && (!endDate || point.date <= endDate),
  );
}

function buildStrategies(indexData) {
  const defaults = appData.meta.dynamic_strategy_defaults;
  const inputs = getStrategyInputs();
  const marketTimeline = getFilteredTimeline(indexData);

  if (!marketTimeline.length) {
    return [];
  }

  return [
    simulateFixedAmountStrategy(marketTimeline, {
      key: "lump_sum",
      label: "一次性投入",
      description: "在起投日一次性投入 10000 美元。",
      frequency: "once",
      amount: 10000,
    }),
    simulateFixedAmountStrategy(marketTimeline, {
      key: "monthly_dca",
      label: "每月固定金额定投",
      description: "每个自然月的第一个交易日投入 1000 美元。",
      frequency: "monthly",
      amount: 1000,
    }),
    simulateFixedAmountStrategy(marketTimeline, {
      key: "yearly_dca",
      label: "每年固定金额定投",
      description: "每个自然年的第一个交易日投入 12000 美元。",
      frequency: "yearly",
      amount: 12000,
    }),
    simulateFixedAmountStrategy(marketTimeline, {
      key: "weekly_dca",
      label: "每周固定金额定投",
      description: "每周第一个交易日投入 250 美元。",
      frequency: "weekly",
      amount: 250,
    }),
    simulateTargetSharesStrategy(marketTimeline, 200),
    simulateDynamicStrategy(
      marketTimeline,
      Number.isFinite(inputs.annualTargetReturnPct) ? inputs.annualTargetReturnPct : defaults.annual_target_return_pct,
      Number.isFinite(inputs.monthlyBaseAmount) ? inputs.monthlyBaseAmount : defaults.monthly_base_amount,
      Number.isFinite(inputs.band) ? inputs.band : defaults.band,
    ),
    simulateUnlimitedVaStrategy(
      marketTimeline,
      Number.isFinite(inputs.annualTargetReturnPct) ? inputs.annualTargetReturnPct : defaults.annual_target_return_pct,
      Number.isFinite(inputs.monthlyBaseAmount) ? inputs.monthlyBaseAmount : defaults.monthly_base_amount,
    ),
  ];
}

function renderSummary(strategies) {
  const container = document.getElementById("summary-grid");
  if (!strategies.length) {
    container.innerHTML = "<article class=\"card\"><h3>无可用数据</h3><p class=\"subtext\">请调整起投时间到指数历史区间内。</p></article>";
    return;
  }

  const { inflationRate } = getStrategyInputs();

  container.innerHTML = strategies.map((strategy) => {
    const isPositive = strategy.annualized_return_pct !== null && strategy.annualized_return_pct >= 0;
    const isAdjustedPositive = strategy.adjusted_total_return >= 0;
    return `
      <article class="card">
        <h3>${strategy.label}</h3>
        <div class="value ${isPositive ? "positive" : "negative"}">${formatPercent(strategy.annualized_return_pct)}</div>
        <p class="subtext">年化收益率</p>
        ${strategy.principal >= 0
          ? `<p class="subtext">名义本金 ${formatCurrency(strategy.principal)}</p>`
          : `<p class="subtext positive">已回收超出投入 ${formatCurrency(-strategy.principal)}</p>`}
        ${inflationRate > 0 ? `<p class="subtext">对齐本金 ${formatCurrency(strategy.adjusted_principal)}</p>` : ""}
        <p class="subtext">净回报 <span class="${isAdjustedPositive ? "positive" : "negative"}">${formatCurrency(strategy.adjusted_total_return)}</span></p>
        ${strategy.real_multiple !== null
          ? `<p class="subtext">实际倍数 <strong class="${strategy.real_multiple >= 1 ? "positive" : "negative"}">${strategy.real_multiple.toFixed(2)}x</strong></p>`
          : strategy.principal < 0
            ? `<p class="subtext positive">实际倍数 ∞（已全部回本）</p>`
            : ""}
      </article>
    `;
  }).join("");
}

function renderTable(strategies) {
  const body = document.getElementById("metrics-body");
  body.innerHTML = strategies.map((strategy) => `
    <tr>
      <td>${strategy.label}</td>
      <td>${strategy.description}</td>
      <td>${formatCurrency(strategy.principal)}</td>
      <td>${formatCurrency(strategy.adjusted_principal)}</td>
      <td>${formatCurrency(strategy.ending_value)}</td>
      <td class="${strategy.real_multiple !== null && strategy.real_multiple >= 1 ? "positive" : "negative"}">${strategy.real_multiple !== null ? strategy.real_multiple.toFixed(2) + "x" : "N/A"}</td>
      <td class="${strategy.adjusted_total_return >= 0 ? "positive" : "negative"}">${formatCurrency(strategy.adjusted_total_return)}</td>
      <td class="${strategy.adjusted_total_return_pct >= 0 ? "positive" : "negative"}">${formatPercent(strategy.adjusted_total_return_pct)}</td>
      <td>${formatPercent(strategy.annualized_return_pct)}</td>
      <td>${strategy.shares.toFixed(4)}</td>
    </tr>
  `).join("");
}

function destroyCharts() {
  [portfolioChart, annualizedChart, principalChart].forEach((chart) => {
    if (chart) {
      chart.destroy();
    }
  });
}

function buildPortfolioChart(strategies, annotations = {}) {
  if (!strategies.length) {
    return;
  }

  const ctx = document.getElementById("portfolio-chart");
  const labels = strategies[0].series.map((point) => point.date);

  portfolioChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: strategies.map((strategy, index) => ({
        label: strategy.label,
        data: strategy.series.map((point) => point.value),
        borderColor: COLORS[index % COLORS.length],
        backgroundColor: COLORS[index % COLORS.length],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.12,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
            },
          },
        },
        annotation: { annotations },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: {
          ticks: {
            callback(value) {
              return formatCurrency(value);
            },
          },
        },
      },
    },
  });
}

function buildAnnualizedChart(strategies) {
  if (!strategies.length) {
    return;
  }

  const ctx = document.getElementById("annualized-chart");
  annualizedChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: strategies.map((strategy) => strategy.label),
      datasets: [{
        label: "年化收益率",
        data: strategies.map((strategy) => strategy.annualized_return_pct),
        backgroundColor: COLORS.slice(0, strategies.length),
        borderRadius: 10,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              return formatPercent(context.parsed.y);
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 30, minRotation: 0 },
        },
        y: {
          ticks: {
            callback(value) {
              return `${value}%`;
            },
          },
        },
      },
    },
  });
}

function buildPrincipalChart(strategies) {
  if (!strategies.length) {
    return;
  }

  const ctx = document.getElementById("principal-chart");
  principalChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: strategies.map((strategy) => strategy.label),
      datasets: [
        {
          label: "通胀对齐本金",
          data: strategies.map((strategy) => strategy.adjusted_principal),
          backgroundColor: "#94a3b8",
          borderRadius: 10,
        },
        {
          label: "期末资产",
          data: strategies.map((strategy) => strategy.ending_value),
          backgroundColor: "#2563eb",
          borderRadius: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${formatCurrency(context.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 30, minRotation: 0 },
        },
        y: {
          type: "logarithmic",
          ticks: {
            callback(value) {
              const log = Math.log10(value);
              if (Number.isInteger(log) || [2, 5].includes(value / 10 ** Math.floor(log))) {
                return formatCurrency(value);
              }
              return "";
            },
          },
        },
      },
    },
  });
}

function renderIndex(indexKey) {
  const indexData = appData.indices[indexKey];
  const filteredTimeline = getFilteredTimeline(indexData);
  const strategies = buildStrategies(indexData);
  const { startDate } = getStrategyInputs();
  const actualEndDate = filteredTimeline.length
    ? filteredTimeline[filteredTimeline.length - 1].date
    : startDate;

  document.getElementById("meta-text").textContent =
    `${indexData.label} (${indexData.symbol}) | 回测区间 ${startDate} 至 ${actualEndDate} | 交易日 ${filteredTimeline.length} | ${appData.meta.price_method}`;

  renderSummary(strategies);
  renderTable(strategies);
  destroyCharts();

  const unlimitedVa = strategies.find((s) => s.key === "unlimited_va");
  const portfolioAnnotations = {};
  if (unlimitedVa?.max_buy?.date) {
    portfolioAnnotations.maxBuyLine = {
      type: "line",
      scaleID: "x",
      value: unlimitedVa.max_buy.date,
      borderColor: "#0b8f55",
      borderWidth: 2,
      borderDash: [6, 3],
      label: {
        display: true,
        content: `最大加仓 ${formatCurrency(unlimitedVa.max_buy.amount)}`,
        position: "start",
        color: "#fff",
        backgroundColor: "#0b8f55",
        font: { size: 11 },
      },
    };
  }
  if (unlimitedVa?.max_sell?.date) {
    portfolioAnnotations.maxSellLine = {
      type: "line",
      scaleID: "x",
      value: unlimitedVa.max_sell.date,
      borderColor: "#c2410c",
      borderWidth: 2,
      borderDash: [6, 3],
      label: {
        display: true,
        content: `最大减仓 ${formatCurrency(unlimitedVa.max_sell.amount)}`,
        position: "end",
        color: "#fff",
        backgroundColor: "#c2410c",
        font: { size: 11 },
      },
    };
  }

  buildPortfolioChart(strategies, portfolioAnnotations);
  buildAnnualizedChart(strategies);
  buildPrincipalChart(strategies);
}

async function init() {
  const response = await fetch("./data/analysis.json");
  appData = await response.json();
  const defaults = appData.meta.dynamic_strategy_defaults;
  const select = document.getElementById("index-select");

  Object.entries(appData.indices).forEach(([key, value]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = value.label;
    select.appendChild(option);
  });

  document.getElementById("annual-target-return").value = defaults.annual_target_return_pct;
  document.getElementById("monthly-base-amount").value = defaults.monthly_base_amount;
  document.getElementById("monthly-band").value = defaults.band;
  document.getElementById("inflation-rate").value = defaults.inflation_rate_pct || 3.0;

  function syncDateInput() {
    const indexData = appData.indices[select.value || Object.keys(appData.indices)[0]];
    const startDateInput = document.getElementById("start-date");
    const endDateInput = document.getElementById("end-date");

    startDateInput.min = indexData.start_date;
    startDateInput.max = indexData.end_date;
    endDateInput.min = indexData.start_date;
    endDateInput.max = indexData.end_date;

    if (!startDateInput.value || startDateInput.value < indexData.start_date || startDateInput.value > indexData.end_date) {
      const defaultStart = defaults.start_date < indexData.start_date ? indexData.start_date : defaults.start_date;
      startDateInput.value = defaultStart > indexData.end_date ? indexData.start_date : defaultStart;
    }

    if (!endDateInput.value || endDateInput.value > indexData.end_date || endDateInput.value < indexData.start_date) {
      endDateInput.value = indexData.end_date;
    }
  }

  select.addEventListener("change", (event) => {
    syncDateInput();
    renderIndex(event.target.value);
  });

  document.getElementById("recalculate-btn").addEventListener("click", () => {
    renderIndex(select.value || Object.keys(appData.indices)[0]);
  });

  syncDateInput();
  renderIndex(select.value || Object.keys(appData.indices)[0]);
}

init().catch((error) => {
  document.getElementById("meta-text").textContent = `加载失败: ${error.message}`;
});
