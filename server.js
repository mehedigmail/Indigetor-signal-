
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const MIN_SCORE = 80;
const MIN_CANDLES = 120;
const INTERVAL_MS = 60_000;

const ALLOWED_SYMBOLS = [
  "EUR/USD", "GBP/USD", "USD/JPY",
  "AUD/USD", "USD/CAD", "EUR/GBP"
];

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Multi-Strategy Trading Engine is running",
    twelveDataConfigured: Boolean(API_KEY),
    claudeConfigured: false,
    model: "Rule-based Multi-Strategy Engine",
    minimumConfidence: MIN_SCORE
  });
});

function mean(a) {
  return a.reduce((s, v) => s + v, 0) / a.length;
}

function sma(a, p) {
  return a.length < p ? null : mean(a.slice(-p));
}

function emaSeries(a, p) {
  const out = Array(a.length).fill(null);
  if (a.length < p) return out;

  let v = mean(a.slice(0, p));
  out[p - 1] = v;
  const k = 2 / (p + 1);

  for (let i = p; i < a.length; i++) {
    v = a[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function rsiSeries(a, p = 14) {
  const out = Array(a.length).fill(null);
  if (a.length <= p) return out;

  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = a[i] - a[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= p;
  loss /= p;

  const value = () => {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;
    return 100 - 100 / (1 + gain / loss);
  };

  out[p] = value();
  for (let i = p + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    gain = (gain * (p - 1) + Math.max(d, 0)) / p;
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = value();
  }
  return out;
}

function trueRanges(c) {
  return c.map((v, i) => {
    if (!i) return v.high - v.low;
    return Math.max(
      v.high - v.low,
      Math.abs(v.high - c[i - 1].close),
      Math.abs(v.low - c[i - 1].close)
    );
  });
}

function atrSeries(c, p = 14) {
  return emaSeries(trueRanges(c), p);
}

function calculateAdx(c, p = 14) {
  const n = c.length;
  const tr = trueRanges(c);
  const plus = Array(n).fill(0);
  const minus = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }

  const atr = emaSeries(tr, p);
  const pEma = emaSeries(plus, p);
  const mEma = emaSeries(minus, p);
  const dx = Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (!atr[i] || atr[i] === 0 ||
        pEma[i] === null || mEma[i] === null) continue;

    const pd = 100 * pEma[i] / atr[i];
    const md = 100 * mEma[i] / atr[i];
    dx[i] = pd + md === 0 ? 0 :
      100 * Math.abs(pd - md) / (pd + md);
  }

  const valid = dx.map((v, i) => ({ v, i }))
    .filter(x => x.v !== null);
  if (valid.length < p) return { adx: null, plusDI: null, minusDI: null };

  const vals = valid.map(x => x.v);
  const adxVals = emaSeries(vals, p);
  const last = valid.length - 1;
  const lastDX = valid[last].i;
  const pd = 100 * pEma[lastDX] / atr[lastDX];
  const md = 100 * mEma[lastDX] / atr[lastDX];

  return {
    adx: adxVals[last],
    plusDI: pd,
    minusDI: md
  };
}

function calculate(c) {
  const close = c.map(x => x.close);
  const high = c.map(x => x.high);
  const low = c.map(x => x.low);
  const last = c.length - 1;

  const e9 = emaSeries(close, 9);
  const e21 = emaSeries(close, 21);
  const e50 = emaSeries(close, 50);
  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);
  const rsi = rsiSeries(close, 14);
  const atr = atrSeries(c, 14);
  const adx = calculateAdx(c, 14);

  const macd = close.map((_, i) =>
    e12[i] === null || e26[i] === null
      ? null : e12[i] - e26[i]
  );
  const validMacd = macd.filter(v => v !== null);
  const macdSignal = emaSeries(validMacd, 9);
  const ml = macd[last];
  const ms = macdSignal[macdSignal.length - 1];
  const prevMl = macd[last - 1];
  const prevMs = macdSignal[macdSignal.length - 2];
  const hist = ml === null || ms === null ? null : ml - ms;
  const prevHist = prevMl === null || prevMs === null
    ? null : prevMl - prevMs;

  const kLook = c.slice(-14);
  const hh = Math.max(...kLook.map(x => x.high));
  const ll = Math.min(...kLook.map(x => x.low));
  const stochK = hh === ll ? 50 :
    100 * (close[last] - ll) / (hh - ll);

  const kValues = [];
  for (let i = 13; i <= last; i++) {
    const section = c.slice(i - 13, i + 1);
    const h = Math.max(...section.map(x => x.high));
    const l = Math.min(...section.map(x => x.low));
    kValues.push(h === l ? 50 :
      100 * (close[i] - l) / (h - l));
  }
  const stochD = kValues.length >= 3
    ? mean(kValues.slice(-3)) : null;

  const typical = c.map(x => (x.high + x.low + x.close) / 3);
  const tp = typical.slice(-20);
  const tpMean = mean(tp);
  const tpDev = mean(tp.map(x => Math.abs(x - tpMean)));
  const cci = tpDev === 0 ? 0 :
    (typical[last] - tpMean) / (0.015 * tpDev);

  const wr = hh === ll ? -50 :
    -100 * (hh - close[last]) / (hh - ll);

  const bbWindow = close.slice(-20);
  const bbMid = mean(bbWindow);
  const variance = mean(bbWindow.map(x => (x - bbMid) ** 2));
  const bbStd = Math.sqrt(variance);
  const bbUpper = bbMid + 2 * bbStd;
  const bbLower = bbMid - 2 * bbStd;

  // Supertrend using ATR-based bands.
  let stValue = null;
  let stDirection = "Neutral";
  if (atr[last] !== null && atr[last] > 0) {
    let upper = (high[0] + low[0]) / 2 + 3 * (atr[0] || atr[last]);
    let lower = (high[0] + low[0]) / 2 - 3 * (atr[0] || atr[last]);
    let direction = 1;

    for (let i = 1; i <= last; i++) {
      if (atr[i] === null) continue;
      const mid = (high[i] + low[i]) / 2;
      const basicUpper = mid + 3 * atr[i];
      const basicLower = mid - 3 * atr[i];

      upper = basicUpper < upper || close[i - 1] > upper
        ? basicUpper : upper;
      lower = basicLower > lower || close[i - 1] < lower
        ? basicLower : lower;

      if (close[i] > upper) direction = 1;
      else if (close[i] < lower) direction = -1;

      if (direction === 1) upper = basicUpper;
      else lower = basicLower;
    }

    stDirection = direction === 1 ? "Bullish" : "Bearish";
    stValue = direction === 1 ? lower : upper;
  }

  // Ichimoku values: conversion 9, base 26, span B 52.
  function midpoint(period, end) {
    if (end + 1 < period) return null;
    const s = c.slice(end - period + 1, end + 1);
    return (
      Math.max(...s.map(x => x.high)) +
      Math.min(...s.map(x => x.low))
    ) / 2;
  }

  const conversion = midpoint(9, last);
  const base = midpoint(26, last);
  const spanB = midpoint(52, last);
  const spanA = conversion !== null && base !== null
    ? (conversion + base) / 2 : null;

  // Recent support/resistance levels.
  const srWindow = c.slice(-50, -1);
  const support = srWindow.length
    ? Math.min(...srWindow.map(x => x.low)) : null;
  const resistance = srWindow.length
    ? Math.max(...srWindow.map(x => x.high)) : null;

  // Simple two-point divergence heuristic.
  const divergenceWindow = 12;
  const priorStart = Math.max(0, last - divergenceWindow * 2);
  const priorEnd = Math.max(priorStart, last - divergenceWindow);
  const prior = c.slice(priorStart, priorEnd + 1);
  const recent = c.slice(Math.max(0, last - divergenceWindow + 1), last + 1);
  const priorRsi = rsi.slice(priorStart, priorEnd + 1)
    .filter(v => v !== null);
  const recentRsi = rsi.slice(Math.max(0, last - divergenceWindow + 1), last + 1)
    .filter(v => v !== null);

  let divergence = "None";
  if (prior.length && recent.length && priorRsi.length && recentRsi.length) {
    const pLow = Math.min(...prior.map(x => x.low));
    const rLow = Math.min(...recent.map(x => x.low));
    const pHigh = Math.max(...prior.map(x => x.high));
    const rHigh = Math.max(...recent.map(x => x.high));

    if (rLow < pLow && mean(recentRsi) > mean(priorRsi) + 3) {
      divergence = "Bullish";
    } else if (rHigh > pHigh && mean(recentRsi) < mean(priorRsi) - 3) {
      divergence = "Bearish";
    }
  }

  // Basic candle patterns.
  const cur = c[last];
  const prev = c[last - 1];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);

  let candlePattern = "None";
  if (prev.close < prev.open && cur.close > cur.open &&
      cur.open <= prev.close && cur.close >= prev.open) {
    candlePattern = "Bullish Engulfing";
  } else if (prev.close > prev.open && cur.close < cur.open &&
      cur.open >= prev.close && cur.close <= prev.open) {
    candlePattern = "Bearish Engulfing";
  } else if (range > 0 && lowerWick > body * 2 &&
      upperWick < body && cur.close > cur.open) {
    candlePattern = "Bullish Pin Bar";
  } else if (range > 0 && upperWick > body * 2 &&
      lowerWick < body && cur.close < cur.open) {
    candlePattern = "Bearish Pin Bar";
  }

  // SMA 20/50/200.
  const sma20 = sma(close, 20);
  const sma50 = sma(close, 50);
  const sma200 = sma(close, 200);

  return {
    price: cur.close,
    rsi: rsi[last],
    previousRsi: rsi[last - 1],
    ema9: e9[last],
    ema21: e21[last],
    ema50: e50[last],
    sma20, sma50, sma200,
    macd: ml,
    macdSignal: ms,
    macdHistogram: hist,
    previousMacdHistogram: prevHist,
    adx: adx.adx,
    plusDI: adx.plusDI,
    minusDI: adx.minusDI,
    stochasticK: stochK,
    stochasticD: stochD,
    cci,
    williamsR: wr,
    bbUpper, bbMiddle: bbMid, bbLower,
    atr: atr[last],
    supertrend: stValue,
    supertrendTrend: stDirection,
    ichimokuConversion: conversion,
    ichimokuBase: base,
    ichimokuSpanA: spanA,
    ichimokuSpanB: spanB,
    support, resistance,
    divergence,
    candlePattern,
    candleTime: cur.time,
    candleTimestamp: cur.timestamp,
    previousCandle: prev
  };
}

function candleTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T")
    ? value : value.replace(" ", "T");
  const hasTZ = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  return Date.parse(hasTZ ? normalized : `${normalized}Z`);
}

async function fetchCandles(symbol, interval, outputsize) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("order", "desc");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();

  if (!response.ok || data.status === "error" ||
      !Array.isArray(data.values)) {
    throw new Error(data.message || "Twelve Data request failed.");
  }

  const duration = interval === "1min" ? 60_000 :
    interval === "5min" ? 300_000 : 900_000;

  return data.values
    .map(x => ({
      time: x.datetime,
      timestamp: candleTimestamp(x.datetime),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close)
    }))
    .filter(x =>
      Number.isFinite(x.timestamp) &&
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close) &&
      x.high >= Math.max(x.open, x.close) &&
      x.low <= Math.min(x.open, x.close) &&
      x.high >= x.low &&
      x.timestamp + duration <= Date.now()
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

function directionOf(v) {
  if (v > 0) return "Bullish";
  if (v < 0) return "Bearish";
  return "Neutral";
}

function evaluate(main, tf5, tf15) {
  const groups = [];

  // Group 1: trend. Avoid double-counting EMA/SMA as separate votes.
  let trend = "Neutral";
  if (main.ema9 > main.ema21 &&
      main.ema21 > main.ema50 &&
      main.price > main.ema21) trend = "Bullish";
  else if (main.ema9 < main.ema21 &&
           main.ema21 < main.ema50 &&
           main.price < main.ema21) trend = "Bearish";

  groups.push({ name: "Trend", direction: trend });

  // Group 2: momentum. RSI, MACD and oscillators are combined into one vote.
  let momentum = "Neutral";
  const bullishMomentum =
    main.macdHistogram > 0 &&
    main.previousMacdHistogram > 0 &&
    main.rsi >= 52 && main.rsi <= 68 &&
    main.rsi >= main.previousRsi &&
    main.stochasticK > main.stochasticD &&
    main.cci > 0;

  const bearishMomentum =
    main.macdHistogram < 0 &&
    main.previousMacdHistogram < 0 &&
    main.rsi >= 32 && main.rsi <= 48 &&
    main.rsi <= main.previousRsi &&
    main.stochasticK < main.stochasticD &&
    main.cci < 0;

  if (bullishMomentum) momentum = "Bullish";
  if (bearishMomentum) momentum = "Bearish";

  groups.push({ name: "Momentum", direction: momentum });

  // Group 3: trend strength / volatility.
  let strength = "Neutral";
  if (main.adx !== null && main.adx >= 20) {
    if (main.plusDI > main.minusDI) strength = "Bullish";
    else if (main.minusDI > main.plusDI) strength = "Bearish";
  }
  groups.push({ name: "Trend strength", direction: strength });

  // Group 4: price structure and candle confirmation.
  let structure = "Neutral";
  const last = main.price;
  const prev = main.previousCandle;

  const bullishBreakout =
    main.resistance !== null &&
    last > main.resistance &&
    prev.close <= main.resistance;

  const bearishBreakout =
    main.support !== null &&
    last < main.support &&
    prev.close >= main.support;

  const bullishPullback =
    main.ema9 > main.ema21 &&
    last > main.ema21 &&
    prev.low <= main.ema21 &&
    last > prev.high;

  const bearishPullback =
    main.ema9 < main.ema21 &&
    last < main.ema21 &&
    prev.high >= main.ema21 &&
    last < prev.low;

  if (
    bullishBreakout ||
    bullishPullback ||
    main.candlePattern === "Bullish Engulfing" ||
    main.candlePattern === "Bullish Pin Bar" ||
    main.divergence === "Bullish"
  ) structure = "Bullish";

  if (
    bearishBreakout ||
    bearishPullback ||
    main.candlePattern === "Bearish Engulfing" ||
    main.candlePattern === "Bearish Pin Bar" ||
    main.divergence === "Bearish"
  ) {
    structure = structure === "Bullish" ? "Conflict" : "Bearish";
  }

  groups.push({ name: "Price structure", direction: structure });

  // Group 5: higher timeframe confirmation.
  let higherTimeframe = "Neutral";
  if (
    tf5.ema9 > tf5.ema21 &&
    tf15.ema9 > tf15.ema21 &&
    tf5.price > tf5.ema21 &&
    tf15.price > tf15.ema21
  ) higherTimeframe = "Bullish";
  else if (
    tf5.ema9 < tf5.ema21 &&
    tf15.ema9 < tf15.ema21 &&
    tf5.price < tf5.ema21 &&
    tf15.price < tf15.ema21
  ) higherTimeframe = "Bearish";

  groups.push({ name: "Higher timeframe", direction: higherTimeframe });

  // Ichimoku + Supertrend are additional confirmation filters,
  // not extra independent votes.
  const ichimokuReady =
    main.ichimokuSpanA !== null &&
    main.ichimokuSpanB !== null;

  const ichiBullish = ichimokuReady &&
    last > Math.max(main.ichimokuSpanA, main.ichimokuSpanB) &&
    main.ichimokuConversion > main.ichimokuBase;

  const ichiBearish = ichimokuReady &&
    last < Math.min(main.ichimokuSpanA, main.ichimokuSpanB) &&
    main.ichimokuConversion < main.ichimokuBase;

  const volatilityReady =
    main.atr !== null && main.atr > 0 &&
    main.bbUpper > main.bbLower &&
    last < main.bbUpper && last > main.bbLower;

  const bullishVotes = groups.filter(
    g => g.direction === "Bullish"
  ).length;
  const bearishVotes = groups.filter(
    g => g.direction === "Bearish"
  ).length;

  const conflict = groups.some(g => g.direction === "Conflict");

  let signal = "WAIT";
  let trendLabel = "Neutral";
  let confidence = 0;
  let reason = "WAIT: all required strategy groups are not aligned.";

  const buyReady =
    bullishVotes >= 5 &&
    bearishVotes === 0 &&
    !conflict &&
    ichiBullish &&
    main.supertrendTrend === "Bullish" &&
    volatilityReady;

  const sellReady =
    bearishVotes >= 5 &&
    bullishVotes === 0 &&
    !conflict &&
    ichiBearish &&
    main.supertrendTrend === "Bearish" &&
    volatilityReady;

  if (buyReady) {
    signal = "BUY";
    trendLabel = "Bullish";
    confidence = Math.min(95, 80 + bullishVotes * 2);
    reason =
      "BUY: all five strategy groups align and Ichimoku, " +
      "Supertrend and volatility filters confirm the setup. " +
      "Analysis score is not a win probability.";
  } else if (sellReady) {
    signal = "SELL";
    trendLabel = "Bearish";
    confidence = Math.min(95, 80 + bearishVotes * 2);
    reason =
      "SELL: all five strategy groups align and Ichimoku, " +
      "Supertrend and volatility filters confirm the setup. " +
      "Analysis score is not a win probability.";
  }

  if (signal === "WAIT") {
    const dirs = groups.map(g => `${g.name}: ${g.direction}`).join("; ");
    reason = `WAIT: strict filters were not all satisfied. ${dirs}.`;
  }

  return {
    signal,
    trend: trendLabel,
    confidence,
    reason,
    groups,
    indicators: {
      sma20: main.sma20,
      sma50: main.sma50,
      sma200: main.sma200,
      ema9: main.ema9,
      ema21: main.ema21,
      ema50: main.ema50,
      rsi: main.rsi,
      macd: main.macd,
      macdSignal: main.macdSignal,
      macdHistogram: main.macdHistogram,
      adx: main.adx,
      plusDI: main.plusDI,
      minusDI: main.minusDI,
      stochasticK: main.stochasticK,
      stochasticD: main.stochasticD,
      cci: main.cci,
      williamsR: main.williamsR,
      bollingerUpper: main.bbUpper,
      bollingerMiddle: main.bbMiddle,
      bollingerLower: main.bbLower,
      atr: main.atr,
      supertrend: main.supertrend,
      supertrendTrend: main.supertrendTrend,
      ichimokuConversion: main.ichimokuConversion,
      ichimokuBase: main.ichimokuBase,
      ichimokuSpanA: main.ichimokuSpanA,
      ichimokuSpanB: main.ichimokuSpanB,
      support: main.support,
      resistance: main.resistance,
      divergence: main.divergence,
      candlePattern: main.candlePattern,
      timeframe5mTrend:
        tf5.ema9 > tf5.ema21 ? "Bullish" :
        tf5.ema9 < tf5.ema21 ? "Bearish" : "Neutral",
      timeframe15mTrend:
        tf15.ema9 > tf15.ema21 ? "Bullish" :
        tf15.ema9 < tf15.ema21 ? "Bearish" : "Neutral"
    }
  };
}

app.get("/api/analyze", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(503).json({
        error: "TWELVE_DATA_API_KEY is missing in Render Environment."
      });
    }

    const symbol = String(req.query.symbol || "EUR/USD");
    if (!ALLOWED_SYMBOLS.includes(symbol)) {
      return res.status(400).json({
        error: "Unsupported currency pair."
      });
    }

    // Three API calls per analysis. Check your Twelve Data quota.
    const [candles1m, candles5m, candles15m] = await Promise.all([
      fetchCandles(symbol, "1min", 250),
      fetchCandles(symbol, "5min", 150),
      fetchCandles(symbol, "15min", 150)
    ]);

    if (
      candles1m.length < MIN_CANDLES ||
      candles5m.length < 60 ||
      candles15m.length < 60
    ) {
      return res.status(502).json({
        error: "Insufficient closed candles for multi-timeframe analysis."
      });
    }

    const main = calculate(candles1m);
    const tf5 = calculate(candles5m);
    const tf15 = calculate(candles15m);

    // Refuse analysis if the newest closed 1-minute candle is too old.
    const age = Date.now() - main.candleTimestamp;
    if (age > 3 * INTERVAL_MS) {
      return res.status(502).json({
        error: "Market data is stale. No signal generated."
      });
    }

    const result = evaluate(main, tf5, tf15);

    return res.json({
      // Existing dashboard fields
      symbol,
      price: main.price,
      rsi: Number(main.rsi.toFixed(2)),
      emaTrend:
        main.ema9 > main.ema21 ? "Bullish" :
        main.ema9 < main.ema21 ? "Bearish" : "Neutral",
      macdTrend:
        main.macdHistogram > 0 ? "Positive" :
        main.macdHistogram < 0 ? "Negative" : "Neutral",
      trend: result.trend,
      rsiStatus:
        main.rsi < 30 ? "Oversold" :
        main.rsi > 70 ? "Overbought" : "Neutral",
      signal: result.signal,
      confidence: result.confidence,
      reason: result.reason,
      candleTime: main.candleTime,
      analyzedAt: new Date().toISOString(),

      // Additional details for future dashboard use
      analysis: {
        method: "Strict Multi-Strategy Engine",
        confidenceMeaning: "Analysis score, not win probability",
        minimumScore: MIN_SCORE,
        strategyGroups: result.groups,
        indicators: result.indicators,
        closedCandleOnly: true,
        timeframes: ["1min", "5min", "15min"]
      }
    });
  } catch (error) {
    console.error("Analysis error:", error.message);

    return res.status(502).json({
      error:
        "Analysis failed. Check Twelve Data API access, quota, " +
        "market data and Render logs."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Multi-Strategy Trading Engine running on port ${PORT}`);
});

