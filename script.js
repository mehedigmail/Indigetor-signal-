const $ = id => document.getElementById(id);

let running = false;
let selectedPair = null;
let countdownTimer = null;
let nextCheckTimer = null;
let requestController = null;
let currentAnalysis = null;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

function setStatus(text, color = "yellow") {
  $("statusText").textContent = text;
  const dot = document.querySelector(".status-dot");

  if (dot) {
    dot.style.background =
      color === "green" ? "#20d99a" :
      color === "red" ? "#ff6178" : "#ffbd59";
  }
}

function setSignal(signal, subtitle = "") {
  const el = $("signal");

  el.textContent = signal || "WAIT";
  el.className = "signal-value " +
    (signal === "CALL" ? "call" :
     signal === "PUT" ? "put" : "wait");

  $("signalSubtitle").textContent = subtitle;
}

function formatPrice(value, pair) {
  if (value == null || !Number.isFinite(Number(value))) {
    return "--";
  }

  const digits = pair && pair.includes("JPY") ? 3 : 6;
  return Number(value).toFixed(digits);
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString();
}

function showAnalysis(result) {
  if (!result || result.dataStatus !== "VALID") {
    setSignal("WAIT", "Verified market data unavailable");
    $("marketPrice").textContent = "--";
    $("confidence").textContent = "--%";
    $("analysisReason").textContent =
      result?.reason || "Market data unavailable.";
    $("priceStatus").textContent = "No verified price";
    return;
  }

  selectedPair = result.pair;
  currentAnalysis = result;

  $("selectedMarket").textContent = result.pair;
  $("marketSelectionStatus").textContent =
    "Automatically selected best market";

  $("marketPrice").textContent =
    formatPrice(result.price, result.pair);

  $("priceStatus").textContent =
    "Last closed candle price";

  setSignal(
    result.signal,
    result.signal === "WAIT"
      ? "No strong trading setup"
      : "Technical setup detected"
  );

  $("confidence").textContent =
    result.technicalScore + "%";

  $("analysisReason").textContent =
    result.reason || "Analysis completed.";

  $("analysisStatus").textContent =
    "Analysis completed successfully";

  $("lastAnalysisTime").textContent =
    formatTime(new Date());

  $("marketSelectionStatus").textContent =
    "Automatically selected: " + result.pair;
}

function showError(message) {
  setSignal("WAIT", "No verified signal available");

  $("analysisReason").textContent = message;
  $("analysisStatus").textContent = "Analysis unavailable";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";
  $("priceStatus").textContent = "Waiting for valid data";
}

async function apiRequest(url, body = null) {
  requestController = new AbortController();

  const timeout = setTimeout(
    () => requestController.abort(),
    180000
  );

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: requestController.signal
    });

    const data = await response.json();

    if (!response.ok || data.success === false) {
      throw new Error(data.message || "Server request failed.");
    }

    return data;
  } finally {
    clearTimeout(timeout);
    requestController = null;
  }
}

// Select the strongest actual CALL/PUT result.
// If no market qualifies, show WAIT instead.
function chooseBestMarket(results) {
  const valid = (results || []).filter(item =>
    item.dataStatus === "VALID" &&
    (item.signal === "CALL" || item.signal === "PUT")
  );

  valid.sort((a, b) =>
    b.technicalScore - a.technicalScore
  );

  return valid[0] || null;
}

async function startAnalysis() {
  if (running) return;

  running = true;

  $("startAnalysis").disabled = true;
  $("stopAnalysis").disabled = false;

  selectedPair = null;
  currentAnalysis = null;

  $("selectedMarket").textContent = "Searching...";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";

  setSignal("WAIT", "Searching for the best market");
  $("analysisReason").textContent =
    "Checking available Forex markets one by one...";
  $("analysisStatus").textContent = "Market scan running";

  setStatus("Scanning markets");

  try {
    const data = await apiRequest("/api/scan", {});

    if (!running) return;

    const best = chooseBestMarket(data.results);

    if (!best) {
      selectedPair = null;

      $("selectedMarket").textContent = "No suitable market";
      $("marketSelectionStatus").textContent =
        "No strong setup found";

      setSignal("WAIT", "No CALL or PUT setup confirmed");

      $("confidence").textContent = "--%";
      $("marketPrice").textContent = "--";

      const errors = (data.results || [])
        .filter(item => item.dataStatus !== "VALID")
        .map(item => item.pair + ": " + item.reason);

      $("analysisReason").textContent =
        errors.length
          ? "No suitable signal. " + errors.join(" | ")
          : "All verified markets are currently WAIT.";

      $("analysisStatus").textContent =
        `${data.validMarkets || 0} of 6 markets verified`;

      setStatus("No trade setup", "yellow");
      return;
    }

    showAnalysis(best);

    setStatus("Best market selected", "green");

    $("analysisStatus").textContent =
      `Best setup selected from ${data.validMarkets} verified markets`;

    scheduleNextCheck();

  } catch (error) {
    if (!running) return;

    showError(
      error.name === "AbortError"
        ? "Request timed out. Please try again."
        : error.message
    );

    setStatus("Connection error", "red");

  } finally {
    if (running) {
      $("startAnalysis").disabled = false;
    }
  }
}

// Recheck only the selected pair near candle close.
async function recheckSelectedMarket() {
  if (!running || !selectedPair) return;

  const pairToCheck = selectedPair;

  $("analysisStatus").textContent =
    "Rechecking selected market...";

  try {
    const data = await apiRequest("/api/analyze", {
      pair: pairToCheck
    });

    if (!running || selectedPair !== pairToCheck) return;

    const result = data.result;

    if (result && result.dataStatus === "VALID") {
      showAnalysis(result);

      if (result.signal === "WAIT") {
        $("analysisReason").textContent =
          "Selected market no longer has a strong setup. Start a new scan to find another market.";
      }

      setStatus("Market updated", "green");
    } else {
      showError("Selected market data is unavailable.");
      setStatus("Data unavailable", "red");
    }

  } catch (error) {
    if (!running) return;

    $("analysisReason").textContent =
      "Recheck failed: " + error.message;

    $("analysisStatus").textContent =
      "Waiting for next analysis cycle";

    setSignal("WAIT", "Signal not verified");
    setStatus("Recheck error", "red");
  }
}

// Next candle's 50th second.
function getSecondsUntilCheck() {
  const now = new Date();

  const target = new Date(now);
  target.setMinutes(now.getMinutes() + 1);
  target.setSeconds(50, 0);

  return Math.max(0, target.getTime() - now.getTime());
}

function updateCountdown() {
  if (!running) return;

  const now = new Date();
  const remaining = getSecondsUntilCheck();

  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  $("nextSignalCheck").textContent =
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0");
}

function scheduleNextCheck() {
  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (!running || !selectedPair) return;

  updateCountdown();

  countdownTimer = setInterval(updateCountdown, 250);

  const delay = getSecondsUntilCheck();

  nextCheckTimer = setTimeout(async () => {
    if (!running) return;

    await recheckSelectedMarket();

    if (running && selectedPair) {
      scheduleNextCheck();
    }
  }, delay);
}

function stopAnalysis() {
  running = false;

  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (requestController) {
    requestController.abort();
  }

  $("startAnalysis").disabled = false;
  $("stopAnalysis").disabled = true;

  $("analysisStatus").textContent = "Analysis stopped";
  $("nextSignalCheck").textContent = "--";

  setStatus("Stopped");
}

// Backend connection check
async function checkHealth() {
  try {
    const data = await apiRequest("/api/health");

    if (data.twelveDataConfigured) {
      setStatus("Backend connected", "green");
    } else {
      setStatus("API key missing", "red");
    }
  } catch (error) {
    setStatus("Backend disconnected", "red");
  }
}

$("startAnalysis").addEventListener(
  "click",
  startAnalysis
);

$("stopAnalysis").addEventListener(
  "click",
  stopAnalysis
);

window.addEventListener("beforeunload", () => {
  stopAnalysis();
});

checkHealth();
