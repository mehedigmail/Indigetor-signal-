require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

const MIN_PAYOUT = 70;
const INTERVAL = "1min";
const OUTPUT_SIZE = 250;
const CACHE_TTL = 45000;
const REQUEST_GAP = Number(process.env.REQUEST_GAP_MS || 8000);

const PAYOUTS = Object.fromEntries(PAIRS.map(p => [p, null]));

let excludedPair = null;
let lastScan = null;
let scanInProgress = false;
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

const cache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPayout(pair) {
  const value = PAYOUTS[pair];
  return value === null || value === undefined
    ? null
    : Number(value);
}


// -----------------------------
// TWELVE DATA REQUEST
// -----------------------------

function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const wait = REQUEST_GAP - (Date.now() - lastRequestAt);

    if (wait > 0) await sleep(wait);

    lastRequestAt = Date.now();

    let response = await fetch(url);

    if (response.status === 429) {
      await sleep(15000);
      lastRequestAt = Date.now();
      response = await fetch(url);
    }

    const data = await response.json();

    if (!response.ok || data.status === "error" || data.code) {
      const error = new Error(
        data.message || `Twelve Data Error: ${response.status}`
      );

      error.status = data.code === 429 || response.status === 429
        ? 429
        : response.status;

      throw error;
    }

    return data;
  });

  requestQueue = task.catch(() => {});
  return task;
}


// -----------------------------
// MARKET DATA
// -----------------------------

async function getMarketData(pair, force = false) {
  if (!API_KEY) {
    throw new Error("Twelve Data API Key সেট করা নেই।");
  }

  const cached = cache.get(pair);

  if (
    !force &&
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {
    return cached.candles;
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(pair)}` +
    `&interval=${INTERVAL}` +
    `&outputsize=${OUTPUT_SIZE}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  const data = await queuedFetch(url);

  if (!Array.isArray(data.values)) {
    throw new Error("Twelve Data থেকে ক্যান্ডেল পাওয়া যায়নি।");
  }

  const now = Date.now();

  const candles = data.values
    .map(item => ({
      time: Date.parse(item.datetime + " UTC"),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.time + 60000 <= now
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw new Error("পর্যাপ্ত বন্ধ ক্যান্ডেল পাওয়া যায়নি।");
  }

  const latest = candles[candles.length - 1];

  if (now - (latest.time + 60000) > 5 * 60000) {
    throw new Error("মার্কেট ডাটা পুরোনো।");
  }

  cache.set(pair, {
    time: Date.now(),
    candles
  });

  return candles;
}


// -----------------------------
// INDICATORS
// -----------------------------

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;

  const rs = (gains / period) / (losses / period);

  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (values.length < 35) return null;

  const macdValues = [];

  for (let i = 25; i < values.length; i++) {
    const slice = values.slice(0, i + 1);

    const shortEMA = calculateEMA(slice, 12);
    const longEMA = calculateEMA(slice, 26);

    macdValues.push(shortEMA - longEMA);
  }

  if (macdValues.length < 9) return null;

  const value = macdValues[macdValues.length - 1];
  const signal = calculateEMA(macdValues, 9);

  return {
    value,
    signal,
    histogram: value - signal
  };
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return trs.reduce((a, b) => a + b, 0) / period;
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const up = c.high - p.high;
    const down = p.low - c.low;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);

    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const dx = [];

  for (let i = period - 1; i < trs.length; i++) {
    const start = i - period + 1;

    const tr = trs.slice(start, i + 1).reduce((a, b) => a + b, 0);
    const plus = plusDM.slice(start, i + 1).reduce((a, b) => a + b, 0);
    const minus = minusDM.slice(start, i + 1).reduce((a, b) => a + b, 0);

    if (tr === 0) continue;

    const plusDI = 100 * plus / tr;
    const minusDI = 100 * minus / tr;
    const denominator = plusDI + minusDI;

    if (denominator === 0) continue;

    dx.push(100 * Math.abs(plusDI - minusDI) / denominator);
  }

  if (dx.length < period) return null;

  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}


// -----------------------------
// FIVE MINUTE TREND
// -----------------------------

function buildFiveMinuteCandles(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / 300000) * 300000;

    if (!groups.has(bucket)) groups.set(bucket, []);

    groups.get(bucket).push(candle);
  }

  const result = [];

  for (const [time, group] of groups) {
    group.sort((a, b) => a.time - b.time);

    if (group.length !== 5) continue;

    let consecutive = true;

    for (let i = 1; i < group.length; i++) {
      if (group[i].time - group[i - 1].time !== 60000) {
        consecutive = false;
        break;
      }
    }

    if (!consecutive) continue;

    result.push({
      time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[4].close
    });
  }

  return result.sort((a, b) => a.time - b.time);
}


// -----------------------------
// MARKET ANALYSIS
// -----------------------------

function analyzeCandles(pair, candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(candles);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles);
  const adx = calculateADX(candles);

  const fiveCandles = buildFiveMinuteCandles(candles);
  const fiveCloses = fiveCandles.map(c => c.close);

  const fiveEMA9 = calculateEMA(fiveCloses, 9);
  const fiveEMA21 = calculateEMA(fiveCloses, 21);

  if (
    ema9 === null || ema21 === null ||
    rsi === null || !macd ||
    atr === null || adx === null
  ) {
    throw new Error("ইন্ডিকেটর হিসাব করার মতো ডাটা নেই।");
  }

  const higherTrendBuy =
    fiveEMA9 !== null && fiveEMA21 !== null && fiveEMA9 > fiveEMA21;

  const higherTrendSell =
    fiveEMA9 !== null && fiveEMA21 !== null && fiveEMA9 < fiveEMA21;

  const support = Math.min(...candles.slice(-30).map(c => c.low));
  const resistance = Math.max(...candles.slice(-30).map(c => c.high));

  const emaBuy = ema9 > ema21;
  const emaSell = ema9 < ema21;

  const macdBuy = macd.histogram > 0;
  const macdSell = macd.histogram < 0;

  const candleBuy = last.close > last.open;
  const candleSell = last.close < last.open;

  const buyHasRoom = resistance - last.close > atr * 0.5;
  const sellHasRoom = last.close - support > atr * 0.5;

  let buyScore = 0;
  let sellScore = 0;

  if (emaBuy) buyScore += 2;
  if (emaSell) sellScore += 2;

  if (macdBuy) buyScore += 2;
  if (macdSell) sellScore += 2;

  if (rsi >= 50 && rsi <= 68) buyScore += 1;
  if (rsi >= 32 && rsi <= 50) sellScore += 1;

  if (candleBuy) buyScore += 1;
  if (candleSell) sellScore += 1;

  if (higherTrendBuy) buyScore += 1;
  if (higherTrendSell) sellScore += 1;

  if (adx >= 14) {
    buyScore += 1;
    sellScore += 1;
  }

  if (buyHasRoom) buyScore += 1;
  if (sellHasRoom) sellScore += 1;

  let signal = "WAIT";
  let reason = "এখনো যথেষ্ট শক্তিশালী সেটআপ নেই।";

  // আগের তুলনায় কিছুটা নমনীয় BUY শর্ত
  if (
    adx >= 14 &&
    buyScore >= 6 &&
    buyScore - sellScore >= 2 &&
    emaBuy &&
    macdBuy &&
    rsi >= 50 &&
    rsi <= 68 &&
    candleBuy &&
    buyHasRoom &&
    (!higherTrendSell)
  ) {
    signal = "BUY";
    reason =
      "EMA ও MACD ঊর্ধ্বমুখী, RSI অনুকূলে এবং ক্যান্ডেল BUY-এর পক্ষে।";
  }

  // আগের তুলনায় কিছুটা নমনীয় SELL শর্ত
  else if (
    adx >= 14 &&
    sellScore >= 6 &&
    sellScore - buyScore >= 2 &&
    emaSell &&
    macdSell &&
    rsi >= 32 &&
    rsi <= 50 &&
    candleSell &&
    sellHasRoom &&
    (!higherTrendBuy)
  ) {
    signal = "SELL";
    reason =
      "EMA ও MACD নিম্নমুখী, RSI অনুকূলে এবং ক্যান্ডেল SELL-এর পক্ষে।";
  }

  return {
    pair,
    signal,
    reason,
    technicalScore: Math.max(buyScore, sellScore),
    buyScore,
    sellScore,
    dataStatus: "VALID",
    price: last.close,

    indicators: {
      rsi: Number(rsi.toFixed(2)),
      ema9: Number(ema9.toFixed(6)),
      ema21: Number(ema21.toFixed(6)),
      macd: Number(macd.value.toFixed(6)),
      macdSignal: Number(macd.signal.toFixed(6)),
      macdHistogram: Number(macd.histogram.toFixed(6)),
      adx: Number(adx.toFixed(2)),
      atr: Number(atr.toFixed(6)),
      support: Number(support.toFixed(6)),
      resistance: Number(resistance.toFixed(6)),
      fiveMinuteTrend: higherTrendBuy
        ? "UP"
        : higherTrendSell
          ? "DOWN"
          : "SIDEWAYS"
    },

    analysisTime: new Date().toISOString(),
    expiry: "1 Minute"
  };
}


// -----------------------------
// SCAN ONE PAIR
// -----------------------------

async function scanPair(pair) {
  if (pair === excludedPair) {
    return {
      pair,
      payout: getPayout(pair),
      signal: "WAIT",
      technicalScore: null,
      dataStatus: "PAYOUT_BLOCKED",
      reason: "এই মার্কেটটি বাদ দেওয়া হয়েছে।"
    };
  }

  const payout = getPayout(pair);

  // গুরুত্বপূর্ণ পরিবর্তন:
  // Payout অজানা হলেও মার্কেটের ডাটা বিশ্লেষণ হবে।
  if (payout !== null && payout < MIN_PAYOUT) {
    return {
      pair,
      payout,
      signal: "WAIT",
      technicalScore: null,
      dataStatus: "PAYOUT_BLOCKED",
      reason: "Payout ৭০%-এর নিচে।"
    };
  }

  const candles = await getMarketData(pair);
  const analysis = analyzeCandles(pair, candles);

  analysis.payout = payout;
  analysis.payoutRequired = payout === null;

  return analysis;
}


// -----------------------------
// HEALTH
// -----------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Auto Best Market Signal Engine running",
    twelveDataConfigured: Boolean(API_KEY),
    analysisEngine: "Rule-Based JavaScript",
    aiApiUsed: false,
    pairs: PAIRS,
    timeframe: "1 Minute",
    minimumPayout: MIN_PAYOUT,
    payouts: PAYOUTS,
    excludedPair,
    requestGapMs: REQUEST_GAP
  });
});


// -----------------------------
// SAVE PAYOUT
// -----------------------------

app.post("/api/payout", (req, res) => {
  const { pair, payout } = req.body || {};

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      success: false,
      message: "সঠিক মার্কেট নির্বাচন করুন।"
    });
  }

  const value = Number(payout);

  if (
    payout === "" ||
    payout === null ||
    payout === undefined ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "০ থেকে ১০০-এর মধ্যে Payout লিখুন।"
    });
  }

  if (
    value < MIN_PAYOUT &&
    excludedPair &&
    excludedPair !== pair
  ) {
    return res.status(409).json({
      success: false,
      message: "একটি মার্কেট আগে থেকেই বাদ আছে। আগে Reset করুন।",
      excludedPair
    });
  }

  if (excludedPair === pair && value >= MIN_PAYOUT) {
    return res.status(409).json({
      success: false,
      message: "এই মার্কেট ফিরিয়ে আনতে RESET MARKETS চাপুন।",
      excludedPair
    });
  }

  PAYOUTS[pair] = value;

  if (value < MIN_PAYOUT) {
    excludedPair = pair;
  }

  cache.delete(pair);
  lastScan = null;

  res.json({
    success: true,
    pair,
    payout: value,
    excludedPair,
    minimumPayout: MIN_PAYOUT,
    message: value < MIN_PAYOUT
      ? `${pair} বাদ দেওয়া হয়েছে। অন্য মার্কেট খোঁজা হবে।`
      : `${pair} এর Payout সংরক্ষণ হয়েছে।`
  });
});


// -----------------------------
// RESET MARKETS
// -----------------------------

app.post("/api/reset-markets", (req, res) => {
  excludedPair = null;

  for (const pair of PAIRS) {
    PAYOUTS[pair] = null;
    cache.delete(pair);
  }

  lastScan = null;

  res.json({
    success: true,
    message: "সব মার্কেট আবার চালু হয়েছে।",
    excludedPair: null,
    payouts: PAYOUTS
  });
});


// -----------------------------
// SCAN ALL MARKETS
// -----------------------------

app.get("/api/scan", async (req, res) => {
  if (scanInProgress) {
    return res.status(429).json({
      success: false,
      message: "আগের স্ক্যান চলছে। একটু অপেক্ষা করুন।"
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "Twelve Data API Key সেট করা নেই।"
    });
  }

  scanInProgress = true;

  try {
    const results = [];
    let rateLimited = false;

    for (const pair of PAIRS) {
      try {
        const result = await scanPair(pair);
        results.push(result);
      } catch (error) {
        if (error.status === 429) rateLimited = true;

        results.push({
          pair,
          signal: "WAIT",
          technicalScore: null,
          dataStatus: error.status === 429
            ? "RATE_LIMITED"
            : "ERROR",
          reason: error.message || "মার্কেট বিশ্লেষণ করা যায়নি।"
        });

        if (rateLimited) break;
      }
    }

    const checked = new Set(results.map(r => r.pair));

    for (const pair of PAIRS) {
      if (!checked.has(pair)) {
        results.push({
          pair,
          signal: "WAIT",
          technicalScore: null,
          dataStatus: "NOT_CHECKED",
          reason: "API সীমার কারণে পরীক্ষা করা যায়নি।"
        });
      }
    }

    const validMarkets = results.filter(
      r => r.dataStatus === "VALID"
    ).length;

    const candidates = results
      .filter(r =>
        r.dataStatus === "VALID" &&
        (r.signal === "BUY" || r.signal === "SELL")
      )
      .sort((a, b) =>
        b.technicalScore - a.technicalScore ||
        Math.abs(b.buyScore - b.sellScore) -
        Math.abs(a.buyScore - a.sellScore) ||
        b.indicators.adx - a.indicators.adx
      );

    const selected = candidates.length ? candidates[0] : null;

    lastScan = {
      success: true,
      selected,
      results,
      validMarkets,
      rateLimited,
      excludedPair,
      payouts: PAYOUTS,
      scanTime: new Date().toISOString(),

      message: selected
        ? selected.payoutRequired
          ? "সেরা সেটআপ পাওয়া গেছে। এবার এই মার্কেটের Payout লিখুন।"
          : "সেরা উপযুক্ত সিগন্যাল পাওয়া গেছে।"
        : "এখন উপযুক্ত সেটআপ নেই। WAIT করুন।"
    };

    res.json(lastScan);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "স্ক্যান ব্যর্থ হয়েছে।"
    });
  } finally {
    scanInProgress = false;
  }
});


// -----------------------------
// ANALYZE SELECTED MARKET
// -----------------------------

app.get("/api/analyze", async (req, res) => {
  const pair = req.query.pair;

  if (!PAIRS.includes(pair)) {
    return res.status(400).json({
      success: false,
      message: "সঠিক Forex pair নির্বাচন করুন।"
    });
  }

  if (pair === excludedPair) {
    return res.status(403).json({
      success: false,
      message: "এই মার্কেটটি বাদ দেওয়া হয়েছে।"
    });
  }

  const payout = getPayout(pair);

  if (payout === null) {
    return res.status(403).json({
      success: false,
      message: "এই মার্কেটের Payout আগে লিখুন।",
      payoutRequired: true
    });
  }

  if (payout < MIN_PAYOUT) {
    return res.status(403).json({
      success: false,
      message: "Payout ৭০%-এর নিচে।",
      payout
    });
  }

  try {
    const candles = await getMarketData(pair, true);
    const result = analyzeCandles(pair, candles);

    result.payout = payout;
    result.payoutRequired = false;

    res.json({
      success: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || "বিশ্লেষণ করা যায়নি।"
    });
  }
});


// -----------------------------
// LAST SCAN
// -----------------------------

app.get("/api/last-scan", (req, res) => {
  res.json(lastScan || {
    success: true,
    selected: null,
    results: [],
    message: "এখনো কোনো স্ক্যান করা হয়নি।"
  });
});


// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {
  console.log(`Auto Best Market Signal running on port ${PORT}`);
});
