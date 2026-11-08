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

// Adjust these according to your Twelve Data plan.
const CACHE_TTL = 50000;
const REQUEST_GAP = Number(process.env.REQUEST_GAP_MS || 8000);

const marketCache = new Map();
const pendingRequests = new Map();

let requestQueue = Promise.resolve();
let lastApiRequestAt = 0;
let lastScan = null;

// -----------------------------
// BASIC HELPERS
// -----------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDateUTC(value) {
  return new Date(value.replace(" ", "T") + "Z");
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
// API REQUEST QUEUE
// -----------------------------

function queuedFetch(url) {
  const task = requestQueue.then(async () => {
    const waitTime = Math.max(
      0,
      REQUEST_GAP - (Date.now() - lastApiRequestAt)
    );

    if (waitTime > 0) {
      await sleep(waitTime);
    }

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
    throw new Error("TWELVE_DATA_API_KEY is missing.");
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

    const rateLimited =
      response.status === 429 ||
      (data && Number(data.code) === 429);

    if (!rateLimited) break;

    if (attempt === 1) {
      throw new Error("Twelve Data API rate limit (429).");
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
      data?.message || `Market API HTTP error: ${response?.status}`
    );
  }

  if (!data || !Array.isArray(data.values)) {
    throw new Error(
      data?.message || "Market candle data unavailable."
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

  // Only use fully closed candles.
  const currentMinute = getCurrentMinuteStart();

  const closedCandles = candles.filter(
    candle => candle.time < currentMinute
  );

  if (closedCandles.length < 40) {
    throw new Error("Not enough closed candles for analysis.");
  }

  const lastCandle =
    closedCandles[closedCandles.length - 1];

  const candleCloseTime =
    lastCandle.time.getTime() + 60000;

  const candleAge = Date.now() - candleCloseTime;

  if (candleAge > 180000 || candleAge < -60000) {
    throw new Error("Market data is stale or time is invalid.");
  }

  return {
    pair,
    candles: closedCandles,
    price: lastCandle.close,
    lastCandleTime: lastCandle.time.toISOString(),
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

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
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

  if (!macdLine.length || !signalLine.length) {
    return null;
  }

  const macd = macdLine[macdLine.length - 1];
  const signal = signalLine[signalLine.length - 1];

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// -----------------------------
// MARKET ANALYSIS
// -----------------------------

function analyzeCandles(market) {
  const candles = market.candles;
  const closes = candles.map(c => c.close);

  const ema9Series = emaSeries(closes, 9);
  const ema21Series = emaSeries(closes, 21);

  const ema9 = ema9Series.at(-1);
  const ema21 = ema21Series.at(-1);

  const previousEMA9 = ema9Series.at(-2);
  const previousEMA21 = ema21Series.at(-2);

  const rsi = calculateRSI(closes, 14);
  const macdData = calculateMACD(closes);

  if (
    ema9 == null ||
    ema21 == null ||
    rsi == null ||
    !macdData
  ) {
    throw new Error("Indicator calculation unavailable.");
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  let callScore = 0;
  let putScore = 0;

  // EMA direction and alignment
  if (ema9 > ema21 && ema9 >= previousEMA9) {
    callScore += 2;
  }

  if (ema9 < ema21 && ema9 <= previousEMA9) {
    putScore += 2;
  }

  // MACD confirmation
  if (
    macdData.macd > macdData.signal &&
    macdData.histogram > 0
  ) {
    callScore += 2;
  }

  if (
    macdData.macd < macdData.signal &&
    macdData.histogram < 0
  ) {
    putScore += 2;
  }

  // RSI confirmation
  if (rsi >= 50 && rsi <= 68) {
    callScore += 1;
  }

  if (rsi <= 50 && rsi >= 32) {
    putScore += 1;
  }

  // Candle direction
  if (last.close > last.open) callScore += 1;
  if (last.close < last.open) putScore += 1;

  // Breakout confirmation
  if (last.close > previous.high) callScore += 1;
  if (last.close < previous.low) putScore += 1;

  let signal = "WAIT";

  if (
    callScore >= 5 &&
    callScore - putScore >= 2
  ) {
    signal = "CALL";
  } else if (
    putScore >= 5 &&
    putScore - callScore >= 2
  ) {
    signal = "PUT";
  }

  const score = Math.max(callScore, putScore);

  return {
    pair: market.pair,
    price: market.price,
    signal,
    technicalScore: Math.round((score / 7) * 100),
    trend: ema9 > ema21 ? "BULLISH" : "BEARISH",

    indicators: {
      rsi: round(rsi, 2),
      ema9: round(ema9, pairDigits(market.pair)),
      ema21: round(ema21, pairDigits(market.pair)),
      macd: round(macdData.macd, 8),
      macdSignal: round(macdData.signal, 8),
      macdHistogram: round(macdData.histogram, 8)
    },

    candle: {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      time: market.lastCandleTime
    },

    dataStatus: "VALID",
    reason:
      signal === "WAIT"
        ? "Conditions are not strong enough for a trade signal."
        : `${signal} setup confirmed by technical indicators.`
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
// AUTOMATIC BEST MARKET SCAN
// -----------------------------

app.post("/api/scan", async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(503).json({
      success: false,
      message: "Twelve Data API key is not configured."
    });
  }

  const results = [];
  let rateLimited = false;

  for (const pair of PAIRS) {
    try {
      const market = await getMarketData(pair, true);
      const analysis = analyzeCandles(market);

      results.push(analysis);
    } catch (error) {
      const message = error.message || "Market analysis failed.";

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

  // Mark pairs not checked after a rate limit.
  for (const pair of PAIRS) {
    if (!results.some(item => item.pair === pair)) {
      results.push({
        pair,
        signal: "WAIT",
        technicalScore: null,
        dataStatus: "NOT_CHECKED",
        reason: "Scan paused because of API rate limit."
      });
    }
  }

  const validResults = results
    .filter(item => item.dataStatus === "VALID")
    .sort((a, b) => b.technicalScore - a.technicalScore);

  const selected = validResults[0] || null;

  lastScan = {
    scannedAt: new Date().toISOString(),
    selected,
    results
  };

  res.json({
    success: true,
    selected,
    results,
    validMarkets: validResults.length,
    rateLimited,
    message: selected
      ? "Best available market selected."
      : "No verified market data available."
  });
});

// -----------------------------
// ANALYZE SELECTED MARKET
// -----------------------------

app.post("/api/analyze", async (req, res) => {
  try {
    const pair = String(req.body?.pair || "").toUpperCase();

    if (!PAIRS.includes(pair)) {
      return res.status(400).json({
        success: false,
        message: "Invalid market pair."
      });
    }

    // Force fresh data for the selected market.
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
      message: error.message || "Analysis failed."
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
