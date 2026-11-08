require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

const TIMEFRAME = "1min";
const CANDLE_LIMIT = 120;

let lastScan = null;
let scanInProgress = false;

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = [];
  const slow = [];

  for (let i = 0; i < values.length; i++) {
    const part = values.slice(0, i + 1);
    fast.push(ema(part, 12));
    slow.push(ema(part, 26));
  }

  const macdValues = fast.map((v, i) => v - slow[i]);
  const signal = ema(macdValues.slice(25), 9);

  const current = macdValues[macdValues.length - 1];

  return {
    value: current,
    signal,
    trend: current > signal ? "BULLISH" : "BEARISH"
  };
}

async function getMarketData(symbol) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error("Twelve Data API key is missing");
  }

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", TIMEFRAME);
  url.searchParams.set("outputsize", String(CANDLE_LIMIT));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", TWELVE_DATA_API_KEY);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Market API HTTP error: ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "Invalid market data");
  }

  const candles = data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close)
    )
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  if (candles.length < 40) {
    throw new Error("Not enough valid candles");
  }

  // Remove the currently forming candle.
  const latest = candles[candles.length - 1];
  const latestTime = new Date(latest.time).getTime();

  if (!Number.isFinite(latestTime)) {
    throw new Error("Invalid candle timestamp");
  }

  const now = Date.now();
  const currentMinute = Math.floor(now / 60000) * 60000;

  const closedCandles = candles.filter(c =>
    new Date(c.time).getTime() < currentMinute
  );

  if (closedCandles.length < 40) {
    throw new Error("Not enough closed candles");
  }

  const lastCandle = closedCandles[closedCandles.length - 1];
  const age = now - new Date(lastCandle.time).getTime();

  if (age > 5 * 60 * 1000 || age < 0) {
    throw new Error("Market data is stale");
  }

  return closedCandles.slice(-CANDLE_LIMIT);
}

function analyzeMarket(symbol, candles) {
  const closes = candles.map(c => c.close);

  const rsi = calculateRSI(closes, 14);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const macd = calculateMACD(closes);

  if (
    rsi === null ||
    ema9 === null ||
    ema21 === null ||
    !macd ||
    !Number.isFinite(rsi) ||
    !Number.isFinite(ema9) ||
    !Number.isFinite(ema21) ||
    !Number.isFinite(macd.signal)
  ) {
    throw new Error("Indicator calculation failed");
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const bullishEMA = ema9 > ema21;
  const bearishEMA = ema9 < ema21;

  const bullishMACD = macd.value > macd.signal;
  const bearishMACD = macd.value < macd.signal;

  const bullishCandle = last.close > last.open;
  const bearishCandle = last.close < last.open;

  let callScore = 0;
  let putScore = 0;

  if (bullishEMA) callScore += 2;
  if (bearishEMA) putScore += 2;

  if (bullishMACD) callScore += 2;
  if (bearishMACD) putScore += 2;

  if (rsi >= 50 && rsi <= 68) callScore += 1;
  if (rsi <= 50 && rsi >= 32) putScore += 1;

  if (bullishCandle) callScore += 1;
  if (bearishCandle) putScore += 1;

  if (last.close > previous.high) callScore += 1;
  if (last.close < previous.low) putScore += 1;

  let signal = "WAIT";
  let confidence = 0;
  let reason = "Market conditions are not strong enough.";

  if (callScore >= 6 && callScore - putScore >= 3) {
    signal = "CALL";
    confidence = Math.round((callScore / 8) * 100);
    reason = "Bullish EMA, MACD and price action alignment.";
  } else if (putScore >= 6 && putScore - callScore >= 3) {
    signal = "PUT";
    confidence = Math.round((putScore / 8) * 100);
    reason = "Bearish EMA, MACD and price action alignment.";
  }

  return {
    symbol,
    timeframe: TIMEFRAME,
    signal,
    confidence,
    price: last.close,
    trend: bullishEMA ? "BULLISH" : bearishEMA ? "BEARISH" : "SIDEWAYS",
    reason,
    indicators: {
      rsi: Number(rsi.toFixed(2)),
      ema9: Number(ema9.toFixed(6)),
      ema21: Number(ema21.toFixed(6)),
      macd: Number(macd.value.toFixed(6)),
      macdSignal: Number(macd.signal.toFixed(6)),
      macdTrend: macd.trend
    },
    candle: last,
    candleCount: candles.length,
    candleTime: last.time,
    dataStatus: "VALID",
    analysisTime: new Date().toISOString()
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Rule-Based Market Engine is running",
    twelveDataConfigured: Boolean(TWELVE_DATA_API_KEY),
    aiApiUsed: false,
    pairs: PAIRS,
    timeframe: TIMEFRAME,
    candleHistory: CANDLE_LIMIT
  });
});

app.get("/api/pairs", (req, res) => {
  res.json({ pairs: PAIRS });
});

app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = req.query.symbol || "EUR/USD";

    if (!PAIRS.includes(symbol)) {
      return res.status(400).json({
        success: false,
        error: "Unsupported trading pair"
      });
    }

    const candles = await getMarketData(symbol);
    const analysis = analyzeMarket(symbol, candles);

    res.json({
      success: true,
      analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/scan", async (req, res) => {
  if (scanInProgress) {
    return res.status(429).json({
      success: false,
      error: "Scan already in progress"
    });
  }

  scanInProgress = true;

  try {
    const results = await Promise.all(
      PAIRS.map(async symbol => {
        try {
          const candles = await getMarketData(symbol);
          return analyzeMarket(symbol, candles);
        } catch (error) {
          return {
            symbol,
            signal: "WAIT",
            confidence: 0,
            dataStatus: "ERROR",
            error: error.message
          };
        }
      })
    );

    const valid = results.filter(r => r.dataStatus === "VALID");

    const candidates = valid
      .filter(r => r.signal !== "WAIT")
      .sort((a, b) => b.confidence - a.confidence);

    const bestSignal = candidates[0] || null;

    lastScan = {
      success: true,
      analysisTime: new Date().toISOString(),
      pairs: results,
      bestSignal,
      totalPairs: PAIRS.length,
      validPairs: valid.length,
      aiApiUsed: false
    };

    res.json(lastScan);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    scanInProgress = false;
  }
});

app.get("/api/last-scan", (req, res) => {
  res.json(lastScan || {
    success: false,
    message: "No scan has been completed yet"
  });
});

app.listen(PORT, () => {
  console.log(`Real Market Signal Engine running on port ${PORT}`);
});
