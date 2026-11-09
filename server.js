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

const INTERVAL = "1min";
const OUTPUT_SIZE = 120;
const CACHE_TTL = 50000;
const REQUEST_GAP = Number(process.env.REQUEST_GAP_MS || 8000);

const marketCache = new Map();
const pendingRequests = new Map();

let requestQueue = Promise.resolve();
let lastApiRequestAt = 0;
let lastScan = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDateUTC(value) {
  const text = String(value);

  if (/Z$|[+-]\d{2}:\d{2}$/.test(text)) {
    return new Date(text);
  }

  return new Date(text.replace(" ", "T") + "Z");
}

function getCurrentMinuteStart() {
  const now = new Date();
  now.setUTCSeconds(0, 0);
  return now;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function pairDigits(pair) {
  return pair.includes("JPY") ? 3 : 6;
}

// -----------------------------
// API QUEUE
// -----------------------------

function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const waitTime = Math.max(
      0,
      REQUEST_GAP - (Date.now() - lastApiRequestAt)
    );

    if (waitTime > 0) await sleep(waitTime);

    lastApiRequestAt = Date.now();

    return fetch(url, {
      signal: AbortSignal.timeout(20000)
    });
  });

  requestQueue = task.catch(() => {});
  return task;
}

// -----------------------------
// TWELVE DATA
// -----------------------------

async function fetchCandles(pair) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("Twelve Data API Key সেট করা নেই।");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", INTERVAL);
  url.searchParams.set("outputsize", String(OUTPUT_SIZE));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  let response;
  let data;

  for (let attempt = 0; attempt < 2; attempt++) {
    response = await queuedFetch(url.toString());
    data = await response.json().catch(() => null);

    const limited =
      response.status === 429 ||
      Number(data?.code) === 429;

    if (!limited) break;

    if (attempt === 1) {
      throw new Error("Twelve Data API সীমা অতিক্রম হয়েছে (429)।");
    }

    const retryAfter = Number(
      response.headers.get("retry-after")
    );

    await sleep(
      retryAfter > 0 ? retryAfter * 1000 : 20000
    );
  }

  if (!response || !response.ok) {
    throw new Error(
      data?.message || `Market API error: ${response?.status}`
    );
  }

  if (!data || !Array.isArray(data.values)) {
    throw new Error(
      data?.message || "মার্কেটের ক্যান্ডেল ডাটা পাওয়া যায়নি।"
    );
  }

  const candles = data.values
    .map(item => ({
      time: parseDateUTC(item.datetime),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .filter(c =>
      Number.isFinite(c.time.getTime()) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
    )
    .sort((a, b) => a.time - b.time);

  const currentMinute = getCurrentMinuteStart();

  const closedCandles = candles.filter(
    c => c.time < currentMinute
  );

  if (closedCandles.length < 60) {
    throw new Error("বিশ্লেষণের জন্য পর্যাপ্ত সম্পন্ন ক্যান্ডেল নেই।");
  }

  const last = closedCandles.at(-1);
  const candleCloseTime = last.time.getTime() + 60000;
  const candleAge = Date.now() - candleCloseTime;

  if (candleAge > 180000 || candleAge < -60000) {
    throw new Error("মার্কেট ডাটা পুরোনো বা সময়ের সঙ্গে মিলছে না।");
  }

  return {
    pair,
    candles: closedCandles,
    price: last.close,
    lastCandleTime: last.time.toISOString(),
    fetchedAt: new Date().toISOString()
  };
}

// -----------------------------
// CACHE
// -----------------------------

async function getMarketData(pair, force = false) {
  const cached = marketCache.get(pair);

  if (
    !force &&
    cached &&
    Date.now() - cached.savedAt < CACHE_TTL
  ) {
    return cached.data;
  }

  if (pendingRequests.has(pair)) {
    return pendingRequests.get(pair);
  }

  const request = fetchCandles(pair)
    .then(data => {
      marketCache.set(pair, {
        data,
        savedAt: Date.now()
      });

      return data;
    })
    .finally(() => {
      pendingRequests.delete(pair);
    });

  pendingRequests.set(pair, request);

  return request;
}

// -----------------------------
// EMA
// -----------------------------

function emaSeries(values, period) {
  if (values.length < period) return [];

  const result = [];
  const multiplier = 2 / (period + 1);

  let previous =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  result[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous =
      values[i] * multiplier +
      previous * (1 - multiplier);

    result[i] = previous;
  }

  return result;
}

// -----------------------------
// RSI
// -----------------------------

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// -----------------------------
// MACD
// -----------------------------

function calculateMACD(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);

  const macdLine = [];

  for (let i = 0; i < values.length; i++) {
    if (fast[i] !== undefined && slow[i] !== undefined) {
      macdLine.push(fast[i] - slow[i]);
    }
  }

  const signalLine = emaSeries(macdLine, 9);

  if (!signalLine.length) return null;

  const macd = macdLine.at(-1);
  const signal = signalLine.at(-1);

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// -----------------------------
// ATR AND ADX
// -----------------------------

function trueRange(candles, i) {
  const current = candles[i];
  const previous = candles[i - 1];

  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close)
  );
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    ranges.push(trueRange(candles, i));
  }

  const recent = ranges.slice(-period);

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 2) return null;

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    trs.push(trueRange(candles, i));

    plusDM.push(
      upMove > downMove && upMove > 0 ? upMove : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0 ? downMove : 0
    );
  }

  let trSum = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let plusSum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusSum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues = [];

  for (let i = period; i < trs.length; i++) {
    if (i > period) {
      trSum = trSum - trSum / period + trs[i];
      plusSum = plusSum - plusSum / period + plusDM[i];
      minusSum = minusSum - minusSum / period + minusDM[i];
    }

    if (trSum <= 0) continue;

    const plusDI = 100 * plusSum / trSum;
    const minusDI = 100 * minusSum / trSum;

    const denominator = plusDI + minusDI;

    if (denominator === 0) {
      dxValues.push(0);
    } else {
      dxValues.push(
        100 * Math.abs(plusDI - minusDI) / denominator
      );
    }
  }

  if (dxValues.length < period) return null;

  let adx =
    dxValues.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period;
  }

  return adx;
}

// -----------------------------
// BUILD 5-MINUTE CANDLES
// From existing 1-minute data
// -----------------------------

function buildFiveMinuteCandles(candles) {
  const groups = new Map();
  const currentMinute = getCurrentMinuteStart().getTime();

  for (const candle of candles) {
    const bucket = Math.floor(
      candle.time.getTime() / 300000
    ) * 300000;

    // Only fully completed 5-minute periods.
    if (bucket + 300000 > currentMinute) continue;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(candle);
  }

  const result = [];

  for (const [bucket, items] of groups) {
    items.sort((a, b) => a.time - b.time);

    if (items.length !== 5) continue;

    let complete = true;

    for (let i = 0; i < 5; i++) {
      if (
        items[i].time.getTime() !== bucket + i * 60000
      ) {
        complete = false;
        break;
      }
    }

    if (!complete) continue;

    result.push({
      time: new Date(bucket),
      open: items[0].open,
      high: Math.max(...items.map(c => c.high)),
      low: Math.min(...items.map(c => c.low)),
      close: items[4].close
    });
  }

  return result.sort((a, b) => a.time - b.time);
}

// -----------------------------
// SUPPORT AND RESISTANCE
// -----------------------------

function calculateLevels(candles) {
  const history = candles.slice(-21, -1);

  if (history.length < 10) return null;

  return {
    resistance: Math.max(...history.map(c => c.high)),
    support: Math.min(...history.map(c => c.low))
  };
}

// -----------------------------
// COMPLETE MARKET ANALYSIS
// -----------------------------

function analyzeCandles(market) {
  const candles = market.candles;
  const closes = candles.map(c => c.close);

  const ema9Values = emaSeries(closes, 9);
  const ema21Values = emaSeries(closes, 21);

  const ema9 = ema9Values.at(-1);
  const ema21 = ema21Values.at(-1);

  const previousEMA9 = ema9Values.at(-2);

  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const atr = calculateATR(candles, 14);
  const adx = calculateADX(candles, 14);

  const fiveMinuteCandles =
    buildFiveMinuteCandles(candles);

  const fiveMinuteCloses =
    fiveMinuteCandles.map(c => c.close);

  const fiveEMA9Values =
    emaSeries(fiveMinuteCloses, 9);

  const fiveEMA21Values =
    emaSeries(fiveMinuteCloses, 21);

  const fiveEMA9 = fiveEMA9Values.at(-1);
  const fiveEMA21 = fiveEMA21Values.at(-1);

  if (
    ema9 == null ||
    ema21 == null ||
    rsi == null ||
    !macd ||
    atr == null ||
    adx == null ||
    fiveEMA9 == null ||
    fiveEMA21 == null
  ) {
    throw new Error("পর্যাপ্ত তথ্য না থাকায় বিশ্লেষণ সম্পন্ন হয়নি।");
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const levels = calculateLevels(candles);

  if (!levels || atr <= 0) {
    throw new Error("Support/Resistance বিশ্লেষণ করা যায়নি।");
  }

  const averageATRValues = [];

  for (let i = candles.length - 50; i < candles.length; i++) {
    if (i > 0) {
      averageATRValues.push(trueRange(candles, i));
    }
  }

  const averageATR =
    averageATRValues.reduce((a, b) => a + b, 0) /
    averageATRValues.length;

  const abnormalVolatility =
    averageATR > 0 && atr > averageATR * 2.5;

  const buyReasons = [];
  const sellReasons = [];

  let buyScore = 0;
  let sellScore = 0;

  // EMA direction
  if (ema9 > ema21 && ema9 > previousEMA9) {
    buyScore += 2;
    buyReasons.push("বাজার ঊর্ধ্বমুখী");
  }

  if (ema9 < ema21 && ema9 < previousEMA9) {
    sellScore += 2;
    sellReasons.push("বাজার নিম্নমুখী");
  }

  // MACD
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    buyScore += 2;
    buyReasons.push("ক্রেতাদের গতি শক্তিশালী");
  }

  if (macd.histogram < 0 && macd.macd < macd.signal) {
    sellScore += 2;
    sellReasons.push("বিক্রেতাদের গতি শক্তিশালী");
  }

  // RSI
  if (rsi >= 52 && rsi <= 68) {
    buyScore += 1;
    buyReasons.push("RSI ক্রেতাদের সমর্থন করছে");
  }

  if (rsi <= 48 && rsi >= 32) {
    sellScore += 1;
    sellReasons.push("RSI বিক্রেতাদের সমর্থন করছে");
  }

  // Candle direction
  if (last.close > last.open) {
    buyScore += 1;
  }

  if (last.close < last.open) {
    sellScore += 1;
  }

  // 5-minute trend confirmation
  const fiveMinuteBuy =
    fiveEMA9 > fiveEMA21;

  const fiveMinuteSell =
    fiveEMA9 < fiveEMA21;

  if (fiveMinuteBuy) {
    buyScore += 2;
    buyReasons.push("৫ মিনিটের প্রবণতা ঊর্ধ্বমুখী");
  }

  if (fiveMinuteSell) {
    sellScore += 2;
    sellReasons.push("৫ মিনিটের প্রবণতা নিম্নমুখী");
  }

  // ADX trend strength
  if (adx >= 18) {
    if (buyScore > sellScore) {
      buyScore += 1;
      buyReasons.push("বাজারের প্রবণতা যথেষ্ট শক্তিশালী");
    } else if (sellScore > buyScore) {
      sellScore += 1;
      sellReasons.push("বাজারের প্রবণতা যথেষ্ট শক্তিশালী");
    }
  }

  // Support / Resistance room
  const resistanceDistance = levels.resistance - last.close;
  const supportDistance = last.close - levels.support;

  const buyHasRoom =
    resistanceDistance > atr * 0.35;

  const sellHasRoom =
    supportDistance > atr * 0.35;

  if (buyHasRoom) {
    buyScore += 1;
    buyReasons.push("সামনে বাধার জায়গা তুলনামূলক দূরে");
  }

  if (sellHasRoom) {
    sellScore += 1;
    sellReasons.push("নিচের বাধার জায়গা তুলনামূলক দূরে");
  }

  let signal = "WAIT";
  let reason = "বাজারে এখনো পরিষ্কার সুযোগ পাওয়া যায়নি।";

  const higherTrendBuy = fiveMinuteBuy;
  const higherTrendSell = fiveMinuteSell;

  if (!abnormalVolatility && adx >= 15) {
    if (
      buyScore >= 7 &&
      buyScore - sellScore >= 2 &&
      higherTrendBuy &&
      buyHasRoom
    ) {
      signal = "BUY";
      reason = buyReasons.slice(0, 3).join("। ") + "।";
    } else if (
      sellScore >= 7 &&
      sellScore - buyScore >= 2 &&
      higherTrendSell &&
      sellHasRoom
    ) {
      signal = "SELL";
      reason = sellReasons.slice(0, 3).join("। ") + "।";
    }
  }

  if (abnormalVolatility) {
    reason = "বাজারে অস্বাভাবিক ওঠানামা হচ্ছে, তাই অপেক্ষা করা হচ্ছে।";
  } else if (adx < 15) {
    reason = "বাজারের প্রবণতা দুর্বল, তাই এখন অপেক্ষা করা হচ্ছে।";
  } else if (
    signal === "WAIT" &&
    fiveMinuteBuy !== fiveMinuteSell
  ) {
    reason = "এক মিনিট ও পাঁচ মিনিটের বিশ্লেষণে যথেষ্ট মিল পাওয়া যায়নি।";
  }

  const bestScore = Math.max(buyScore, sellScore);

  return {
    pair: market.pair,
    price: market.price,
    signal,

    technicalScore: Math.min(
      100,
      Math.round((bestScore / 10) * 100)
    ),

    trend: fiveMinuteBuy
      ? "BULLISH"
      : fiveMinuteSell
        ? "BEARISH"
        : "SIDEWAYS",

    indicators: {
      rsi: round(rsi, 2),
      ema9: round(ema9, pairDigits(market.pair)),
      ema21: round(ema21, pairDigits(market.pair)),
      macd: round(macd.macd, 8),
      macdSignal: round(macd.signal, 8),
      macdHistogram: round(macd.histogram, 8),
      adx: round(adx, 2),
      atr: round(atr, pairDigits(market.pair)),
      fiveMinuteEMA9: round(fiveEMA9, pairDigits(market.pair)),
      fiveMinuteEMA21: round(fiveEMA21, pairDigits(market.pair))
    },

    levels: {
      support: round(levels.support, pairDigits(market.pair)),
      resistance: round(levels.resistance, pairDigits(market.pair))
    },

    candle: {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      time: market.lastCandleTime
    },

    dataStatus: "VALID",
    reason
  };
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
    timeframe: INTERVAL,
    requestGapMs: REQUEST_GAP
  });
});

// -----------------------------
// SCAN ALL MARKETS
// -----------------------------

app.post("/api/scan", async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(503).json({
      success: false,
      message: "Twelve Data API Key সেট করা নেই।"
    });
  }

  const results = [];
  let rateLimited = false;

  for (const pair of PAIRS) {
    try {
      // Reuse recent data when available.
      const market = await getMarketData(pair, false);
      const analysis = analyzeCandles(market);

      results.push(analysis);

    } catch (error) {
      const message = error.message || "বিশ্লেষণ ব্যর্থ হয়েছে।";

      results.push({
        pair,
        signal: "WAIT",
        technicalScore: null,
        dataStatus: "ERROR",
        reason: message
      });

      if (message.includes("429")) {
        rateLimited = true;
        break;
      }
    }
  }

  for (const pair of PAIRS) {
    if (!results.some(item => item.pair === pair)) {
      results.push({
        pair,
        signal: "WAIT",
        technicalScore: null,
        dataStatus: "NOT_CHECKED",
        reason: "API সীমার কারণে এই পেয়ার পরীক্ষা করা যায়নি।"
      });
    }
  }

  const validSignals = results
    .filter(item =>
      item.dataStatus === "VALID" &&
      (item.signal === "BUY" || item.signal === "SELL")
    )
    .sort((a, b) => b.technicalScore - a.technicalScore);

  const selected = validSignals[0] || null;

  lastScan = {
    scannedAt: new Date().toISOString(),
    selected,
    results
  };

  res.json({
    success: true,
    selected,
    results,
    validMarkets: results.filter(
      item => item.dataStatus === "VALID"
    ).length,
    rateLimited,
    message: selected
      ? "সেরা উপযুক্ত মার্কেট নির্বাচন করা হয়েছে।"
      : "এখন কোনো উপযুক্ত সিগন্যাল পাওয়া যায়নি।"
  });
});

// -----------------------------
// RECHECK SELECTED PAIR
// -----------------------------

app.post("/api/analyze", async (req, res) => {
  try {
    const pair = String(
      req.body?.pair || ""
    ).toUpperCase();

    if (!PAIRS.includes(pair)) {
      return res.status(400).json({
        success: false,
        message: "ভুল মার্কেট পেয়ার।"
      });
    }

    const market = await getMarketData(pair, true);
    const analysis = analyzeCandles(market);

    res.json({
      success: true,
      result: analysis,
      analyzedAt: new Date().toISOString()
    });

  } catch (error) {
    res.status(503).json({
      success: false,
      message: error.message || "বিশ্লেষণ করা যায়নি।"
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
