require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

const MIN_PAYOUT = 70;

const PAYOUTS = {
  "EUR/USD": null,
  "GBP/USD": null,
  "USD/JPY": null,
  "AUD/USD": null,
  "USD/CAD": null,
  "EUR/GBP": null
};

// একবারে শুধু একটি মার্কেট বাদ থাকবে।
let excludedPair = null;

const INTERVAL = "1min";
const OUTPUT_SIZE = 250;
const CACHE_TTL = 45000;
const REQUEST_GAP = Number(process.env.REQUEST_GAP_MS || 8000);

const cache = new Map();

let lastRequestAt = 0;
let requestQueue = Promise.resolve();
let lastScan = null;
let scanInProgress = false;


// -----------------------------
// BASIC FUNCTIONS
// -----------------------------

function getPayout(pair) {
  const value = PAYOUTS[pair];

  if (
    value === null ||
    value === undefined ||
    value === "" ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  return Number(value);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// -----------------------------
// TWELVE DATA REQUEST QUEUE
// -----------------------------

function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const wait = REQUEST_GAP - (Date.now() - lastRequestAt);

    if (wait > 0) {
      await sleep(wait);
    }

    lastRequestAt = Date.now();

    let response = await fetch(url);

    if (response.status === 429) {
      await sleep(15000);
      lastRequestAt = Date.now();
      response = await fetch(url);
    }

    if (!response.ok) {
      const error = new Error(
        `Twelve Data HTTP Error: ${response.status}`
      );

      error.status = response.status;
      throw error;
    }

    const data = await response.json();

    if (data.status === "error" || data.code) {
      const error = new Error(
        data.message || "Twelve Data API Error"
      );

      error.status = data.code === 429 ? 429 : 400;
      throw error;
    }

    return data;
  });

  requestQueue = task.catch(() => {});

  return task;
}


// -----------------------------
// FETCH MARKET CANDLES
// -----------------------------

async function getMarketData(pair, force = false) {
  if (!TWELVE_DATA_API_KEY) {
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
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  const data = await queuedFetch(url);

  if (!Array.isArray(data.values) || data.values.length < 60) {
    throw new Error("পর্যাপ্ত ক্যান্ডেল ডাটা পাওয়া যায়নি।");
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
    throw new Error("বন্ধ হওয়া ক্যান্ডেল পর্যাপ্ত নেই।");
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
// EMA
// -----------------------------

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}


// -----------------------------
// RSI
// -----------------------------

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  const start = candles.length - period;

  for (let i = start; i < candles.length; i++) {
    const change =
      candles[i].close - candles[i - 1].close;

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}


// -----------------------------
// MACD
// -----------------------------

function calculateMACD(values) {
  if (values.length < 35) return null;

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    if (i < 25) continue;

    const shortEMA = calculateEMA(
      values.slice(0, i + 1),
      12
    );

    const longEMA = calculateEMA(
      values.slice(0, i + 1),
      26
    );

    macdValues.push(shortEMA - longEMA);
  }

  if (macdValues.length < 9) return null;

  const macd = macdValues[macdValues.length - 1];
  const signal = calculateEMA(macdValues, 9);

  return {
    value: macd,
    signal,
    histogram: macd - signal
  };
}


// -----------------------------
// ATR
// -----------------------------

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previous = candles[i - 1];

    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  return trs.reduce((a, b) => a + b, 0) / period;
}


// -----------------------------
// ADX
// -----------------------------

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    plusDM.push(
      upMove > downMove && upMove > 0 ? upMove : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0 ? downMove : 0
    );

    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const dxValues = [];

  for (let i = period - 1; i < trs.length; i++) {
    const start = i - period + 1;

    const trSum = trs
      .slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const plusSum = plusDM
      .slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    const minusSum = minusDM
      .slice(start, i + 1)
      .reduce((a, b) => a + b, 0);

    if (trSum === 0) continue;

    const plusDI = 100 * plusSum / trSum;
    const minusDI = 100 * minusSum / trSum;

    const denominator = plusDI + minusDI;

    if (denominator === 0) continue;

    dxValues.push(
      100 * Math.abs(plusDI - minusDI) / denominator
    );
  }

  if (dxValues.length < period) return null;

  return dxValues
    .slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}


// -----------------------------
// BUILD 5-MINUTE CANDLES
// -----------------------------

function buildFiveMinuteCandles(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket =
      Math.floor(candle.time / 300000) * 300000;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(candle);
  }

  const result = [];

  for (const [time, group] of groups) {
    group.sort((a, b) => a.time - b.time);

    if (group.length !== 5) continue;

    let consecutive = true;

    for (let i = 1; i < group.length; i++) {
      if (
        group[i].time - group[i - 1].time !== 60000
      ) {
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
// ANALYZE ONE MARKET
// -----------------------------

function analyzeCandles(pair, candles) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(candles, 14);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, 14);
  const adx = calculateADX(candles, 14);

  const fiveCandles =
    buildFiveMinuteCandles(candles);

  const fiveCloses =
    fiveCandles.map(c => c.close);

  const fiveEMA9 = calculateEMA(fiveCloses, 9);
  const fiveEMA21 = calculateEMA(fiveCloses, 21);

  if (
    ema9 === null ||
    ema21 === null ||
    rsi === null ||
    !macd ||
    atr === null ||
    adx === null ||
    fiveEMA9 === null ||
    fiveEMA21 === null
  ) {
    throw new Error("ইন্ডিকেটর হিসাব করার মতো ডাটা নেই।");
  }

  const support = Math.min(
    ...candles.slice(-30).map(c => c.low)
  );

  const resistance = Math.max(
    ...candles.slice(-30).map(c => c.high)
  );

  const higherTrendBuy = fiveEMA9 > fiveEMA21;
  const higherTrendSell = fiveEMA9 < fiveEMA21;

  const emaBuy = ema9 > ema21;
  const emaSell = ema9 < ema21;

  const macdBuy = macd.histogram > 0;
  const macdSell = macd.histogram < 0;

  const candleBuy = last.close > last.open;
  const candleSell = last.close < last.open;

  const buyHasRoom =
    resistance - last.close > atr * 1.2;

  const sellHasRoom =
    last.close - support > atr * 1.2;

  let buyScore = 0;
  let sellScore = 0;

  if (emaBuy) buyScore += 2;
  if (emaSell) sellScore += 2;

  if (macdBuy) buyScore += 2;
  if (macdSell) sellScore += 2;

  if (rsi >= 50 && rsi <= 65) buyScore += 1;
  if (rsi >= 35 && rsi <= 50) sellScore += 1;

  if (candleBuy) buyScore += 1;
  if (candleSell) sellScore += 1;

  if (higherTrendBuy) buyScore += 2;
  if (higherTrendSell) sellScore += 2;

  if (adx >= 18) {
    buyScore += 1;
    sellScore += 1;
  }

  if (buyHasRoom) buyScore += 1;
  if (sellHasRoom) sellScore += 1;

  let signal = "WAIT";
  let reason =
    "শক্তিশালী সেটআপ পাওয়া যায়নি। অপেক্ষা করুন।";

  if (
    adx >= 18 &&
    buyScore >= 8 &&
    buyScore - sellScore >= 2 &&
    higherTrendBuy &&
    buyHasRoom &&
    ema9 > ema21 &&
    macd.histogram > 0 &&
    rsi >= 52 &&
    rsi <= 65 &&
    candleBuy
  ) {
    signal = "BUY";

    reason =
      "EMA ঊর্ধ্বমুখী, MACD পজিটিভ, RSI অনুকূলে এবং ৫ মিনিটের ট্রেন্ড BUY-এর পক্ষে।";
  }

  else if (
    adx >= 18 &&
    sellScore >= 8 &&
    sellScore - buyScore >= 2 &&
    higherTrendSell &&
    sellHasRoom &&
    ema9 < ema21 &&
    macd.histogram < 0 &&
    rsi >= 35 &&
    rsi <= 48 &&
    candleSell
  ) {
    signal = "SELL";

    reason =
      "EMA নিম্নমুখী, MACD নেগেটিভ, RSI অনুকূলে এবং ৫ মিনিটের ট্রেন্ড SELL-এর পক্ষে।";
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

  // বাদ দেওয়া মার্কেট আর স্ক্যান হবে না।
  if (pair === excludedPair) {
    return {
      pair,
      payout: getPayout(pair),
      signal: "WAIT",
      technicalScore: null,
      dataStatus: "PAYOUT_BLOCKED",
      reason:
        "এই মার্কেটটি বাদ দেওয়া হয়েছে। Reset না করা পর্যন্ত আসবে না।"
    };
  }

  const payout = getPayout(pair);

  if (payout === null) {
    return {
      pair,
      payout: null,
      signal: "WAIT",
      technicalScore: null,
      dataStatus: "PAYOUT_UNKNOWN",
      reason:
        "এই পেয়ারের প্রকৃত Payout যাচাই করা হয়নি।"
    };
  }

  if (payout < MIN_PAYOUT) {
    return {
      pair,
      payout,
      signal: "WAIT",
      technicalScore: null,
      dataStatus: "PAYOUT_BLOCKED",
      reason: "Payout ৭০%-এর নিচে, তাই পেয়ার বাদ।"
    };
  }

  const candles = await getMarketData(pair);

  const analysis = analyzeCandles(pair, candles);

  analysis.payout = payout;

  return analysis;
}


// -----------------------------
// HEALTH
// -----------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Auto Best Market Signal Engine running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
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
      message: "০ থেকে ১০০-এর মধ্যে সঠিক Payout লিখুন।"
    });
  }

  // আগে থেকেই অন্য একটি মার্কেট বাদ থাকলে
  // দ্বিতীয় মার্কেট বাদ দেওয়া যাবে না।
  if (
    value < MIN_PAYOUT &&
    excludedPair &&
    excludedPair !== pair
  ) {
    return res.status(409).json({
      success: false,
      message:
        "ইতিমধ্যে একটি মার্কেট বাদ আছে। নতুন মার্কেট বাদ দিতে হলে আগে Reset করুন।",
      excludedPair
    });
  }

  // বাদ দেওয়া মার্কেট Reset ছাড়া ফিরবে না।
  if (excludedPair === pair && value >= MIN_PAYOUT) {
    return res.status(409).json({
      success: false,
      message:
        "এই মার্কেটটি বাদ দেওয়া আছে। ফিরিয়ে আনতে RESET MARKETS চাপুন।",
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
      : `${pair} Payout সংরক্ষণ হয়েছে।`
  });
});


// -----------------------------
// RESET MARKETS
// -----------------------------

app.post("/api/reset-markets", (req, res) => {
  excludedPair = null;

  // Reset-এর পর সব Payout আবার যাচাই করতে হবে।
  for (const pair of PAIRS) {
    PAYOUTS[pair] = null;
    cache.delete(pair);
  }

  lastScan = null;

  res.json({
    success: true,
    message:
      "সব মার্কেট আবার চালু হয়েছে। Payout পুনরায় যাচাই করুন।",
    excludedPair: null,
    payouts: PAYOUTS
  });
});


// -----------------------------
// SCAN ALL SIX PAIRS
// -----------------------------

app.get("/api/scan", async (req, res) => {
  if (scanInProgress) {
    return res.status(429).json({
      success: false,
      message:
        "আগের স্ক্যানটি এখনো চলছে। একটু অপেক্ষা করুন।"
    });
  }

  if (!TWELVE_DATA_API_KEY) {
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
        if (error.status === 429) {
          rateLimited = true;
        }

        results.push({
          pair,
          signal: "WAIT",
          technicalScore: null,

          dataStatus: error.status === 429
            ? "RATE_LIMITED"
            : "ERROR",

          reason:
            error.message ||
            "ডাটা বিশ্লেষণ করা যায়নি।"
        });

        if (rateLimited) {
          break;
        }
      }
    }

    const checkedPairs = new Set(
      results.map(r => r.pair)
    );

    for (const pair of PAIRS) {
      if (!checkedPairs.has(pair)) {
        results.push({
          pair,
          signal: "WAIT",
          technicalScore: null,
          dataStatus: "NOT_CHECKED",
          reason:
            "API সীমার কারণে এই পেয়ার পরীক্ষা করা যায়নি।"
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

    const selected =
      candidates.length > 0 ? candidates[0] : null;

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
        ? "সেরা উপযুক্ত সিগন্যাল পাওয়া গেছে।"
        : "এখন উপযুক্ত সিগন্যাল নেই। WAIT করুন।"
    };

    res.json(lastScan);

  } catch (error) {
    res.status(500).json({
      success: false,
      message:
        error.message || "স্ক্যান ব্যর্থ হয়েছে।"
    });

  } finally {
    scanInProgress = false;
  }
});


// -----------------------------
// ANALYZE ONE SELECTED PAIR
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
      message:
        "এই মার্কেটটি বাদ দেওয়া হয়েছে। Reset না করা পর্যন্ত ব্যবহার করা যাবে না।"
    });
  }

  const payout = getPayout(pair);

  if (payout === null || payout < MIN_PAYOUT) {
    return res.status(403).json({
      success: false,
      message:
        "এই পেয়ারের প্রকৃত Payout ৭০% বা তার বেশি নয়।",
      payout
    });
  }

  try {
    const candles = await getMarketData(pair, true);

    const result = analyzeCandles(pair, candles);

    result.payout = payout;

    res.json({
      success: true,
      result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message:
        error.message || "বিশ্লেষণ করা যায়নি।"
    });
  }
});


// -----------------------------
// LAST SCAN
// -----------------------------

app.get("/api/last-scan", (req, res) => {
  res.json({
    success: true,
    scan: lastScan
  });
});


// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {
  console.log(
    `Auto Best Market Signal running on port ${PORT}`
  );
});
