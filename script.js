const API_BASE = "";

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

let selectedPair = "EUR/USD";
let latestResults = [];
let scanning = false;

const $ = id => document.getElementById(id);

function setMessage(message) {
  $("messageBox").textContent = message;
}

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "--";
  }

  return Number(value).toFixed(6);
}

function formatTime(value) {
  if (!value) return "--";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "--";

  return date.toLocaleString();
}

function signalClass(signal) {
  if (signal === "CALL") return "call-text";
  if (signal === "PUT") return "put-text";
  return "wait-text";
}

function showSignal(result) {
  const box = $("signalBox");

  if (!result || result.dataStatus !== "VALID") {
    box.className = "signal-box waiting";
    $("signalValue").textContent = "WAIT";
    $("signalPair").textContent = selectedPair;
    $("signalConfidence").textContent = "--";
    $("signalStatus").textContent = "Data unavailable";
    $("signalReason").textContent =
      result?.error || "Valid market data is not available.";
    return;
  }

  const signal = result.signal || "WAIT";

  box.className = "signal-box " +
    (signal === "CALL" ? "call" :
     signal === "PUT" ? "put" : "waiting");

  $("signalValue").textContent = signal;
  $("signalPair").textContent = result.symbol;
  $("signalConfidence").textContent =
    result.confidence + "/100";
  $("signalStatus").textContent = "Analyzed";
  $("signalReason").textContent = result.reason || "No reason supplied.";

  $("marketPrice").textContent = formatPrice(result.price);
  $("marketTrend").textContent = result.trend || "--";
  $("analysisScore").textContent =
    result.confidence + "/100";
  $("selectedPairLabel").textContent = result.symbol;

  const indicators = result.indicators || {};

  $("rsiValue").textContent =
    indicators.rsi !== undefined ? indicators.rsi : "--";

  $("rsiStatus").textContent =
    indicators.rsi > 70 ? "Overbought" :
    indicators.rsi < 30 ? "Oversold" :
    indicators.rsi !== undefined ? "Normal range" : "Waiting";

  $("ema9Value").textContent = formatPrice(indicators.ema9);
  $("ema21Value").textContent = formatPrice(indicators.ema21);

  $("macdValue").textContent =
    indicators.macd !== undefined ? indicators.macd : "--";

  $("macdStatus").textContent =
    indicators.macdTrend || "Waiting";

  const candle = result.candle || {};

  $("candleOpen").textContent = formatPrice(candle.open);
  $("candleHigh").textContent = formatPrice(candle.high);
  $("candleLow").textContent = formatPrice(candle.low);
  $("candleClose").textContent = formatPrice(candle.close);

  $("candleTime").textContent =
    "Last closed candle: " + formatTime(result.candleTime);

  $("lastAnalysis").textContent =
    formatTime(result.analysisTime);
}

function renderTable(results) {
  const tbody = $("marketTable");

  if (!Array.isArray(results) || results.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-row">
          No market results available.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = results.map(result => {
    const valid = result.dataStatus === "VALID";
    const signal = valid ? result.signal : "WAIT";
    const indicators = result.indicators || {};

    return `
      <tr>
        <td><strong>${result.symbol}</strong></td>
        <td>${valid ? formatPrice(result.price) : "--"}</td>
        <td>${valid ? result.trend : "--"}</td>
        <td>${valid ? indicators.rsi : "--"}</td>
        <td class="${signalClass(signal)}">${signal}</td>
        <td>${valid ? "VALID" : "ERROR"}</td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("tr").forEach((row, index) => {
    const result = results[index];

    row.style.cursor = "pointer";

    row.addEventListener("click", () => {
      if (!result) return;
      selectPair(result.symbol);
    });
  });
}

function updateValidMarkets(results) {
  const valid = results.filter(
    result => result.dataStatus === "VALID"
  ).length;

  $("validMarkets").textContent = valid + "/" + PAIRS.length;
}

function selectPair(pair) {
  if (!PAIRS.includes(pair)) return;

  selectedPair = pair;

  document.querySelectorAll(".pair-button").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.pair === pair
    );
  });

  $("selectedPairLabel").textContent = pair;
  $("signalPair").textContent = pair;

  const result = latestResults.find(
    item => item.symbol === pair
  );

  if (result) {
    showSignal(result);
  } else {
    showSignal(null);
    setMessage("No analysis available for " + pair + ".");
  }
}

async function checkHealth() {
  try {
    const response = await fetch(API_BASE + "/api/health", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Backend HTTP " + response.status);
    }

    const data = await response.json();

    if (data.status !== "ok") {
      throw new Error(data.message || "Backend is not ready");
    }

    $("connectionStatus").textContent = "Backend Connected";
    $("statusDot").className = "status-dot online";

    $("backendStatus").textContent = "Connected";
    $("apiStatus").textContent =
      data.twelveDataConfigured ? "Configured" : "API key missing";

    if (!data.twelveDataConfigured) {
      setMessage("Backend connected, but Twelve Data API key is missing.");
      return false;
    }

    setMessage("Backend and Twelve Data configuration verified.");
    return true;

  } catch (error) {
    $("connectionStatus").textContent = "Backend Offline";
    $("statusDot").className = "status-dot offline";
    $("backendStatus").textContent = "Disconnected";
    $("apiStatus").textContent = "Unavailable";

    setMessage("Backend connection error: " + error.message);
    return false;
  }
}

async function scanMarkets() {
  if (scanning) return;

  scanning = true;

  const button = $("scanButton");
  button.disabled = true;
  button.textContent = "Analyzing markets...";

  setMessage("Collecting real market data for all six pairs...");

  try {
    const response = await fetch(API_BASE + "/api/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      cache: "no-store"
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Market scan failed");
    }

    if (!Array.isArray(data.pairs)) {
      throw new Error("Invalid scan response from backend");
    }

    latestResults = data.pairs;

    renderTable(latestResults);
    updateValidMarkets(latestResults);

    const selectedResult = latestResults.find(
      result => result.symbol === selectedPair
    );

    if (selectedResult) {
      showSignal(selectedResult);
    } else {
      showSignal(null);
    }

    const valid = latestResults.filter(
      result => result.dataStatus === "VALID"
    ).length;

    const signals = latestResults.filter(
      result => result.dataStatus === "VALID" &&
      result.signal !== "WAIT"
    );

    if (valid === 0) {
      setMessage("No valid market data received. Check Twelve Data API and Render logs.");
    } else {
      setMessage(
        "Analysis complete. " + valid +
        " of 6 markets verified. " +
        signals.length + " active signal(s) found."
      );
    }

    $("lastAnalysis").textContent = formatTime(data.analysisTime);

  } catch (error) {
    setMessage("Analysis error: " + error.message);
  } finally {
    scanning = false;
    button.disabled = false;
    button.innerHTML = "<span>↻</span> Analyze All Markets";
  }
}

function setupPairButtons() {
  document.querySelectorAll(".pair-button").forEach(button => {
    button.addEventListener("click", () => {
      selectPair(button.dataset.pair);
    });
  });
}

async function initialize() {
  setupPairButtons();

  const connected = await checkHealth();

  if (connected) {
    await scanMarkets();
  }
}

$("scanButton").addEventListener("click", scanMarkets);

initialize();

