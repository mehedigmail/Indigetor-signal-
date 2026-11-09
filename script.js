const $ = id => document.getElementById(id);

let running = false;
let selectedPair = null;
let countdownTimer = null;
let nextCheckTimer = null;
let requestController = null;
let currentAnalysis = null;

let weakCount = 0;
let errorCount = 0;

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
      color === "red" ? "#ff6178" :
      "#ffbd59";
  }
}

function setSignal(signal, subtitle = "") {
  const el = $("signal");

  el.textContent = signal || "WAIT";

  // Keep existing CSS classes.
  el.className = "signal-value " +
    (signal === "BUY" ? "call" :
     signal === "SELL" ? "put" : "wait");

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

// -----------------------------
// DISPLAY ANALYSIS
// -----------------------------

function showAnalysis(result) {
  if (!result || result.dataStatus !== "VALID") {
    setSignal("WAIT", "যাচাইকৃত বাজারের তথ্য পাওয়া যায়নি");

    $("marketPrice").textContent = "--";
    $("confidence").textContent = "--%";

    $("analysisReason").textContent =
      result?.reason || "বাজারের তথ্য পাওয়া যায়নি।";

    $("priceStatus").textContent = "সঠিক তথ্যের অপেক্ষায়";

    return;
  }

  selectedPair = result.pair;
  currentAnalysis = result;

  $("selectedMarket").textContent = result.pair;

  $("marketPrice").textContent =
    formatPrice(result.price, result.pair);

  $("priceStatus").textContent =
    "শেষ সম্পন্ন ক্যান্ডেলের দাম";

  let subtitle = "বাজার বিশ্লেষণ সম্পন্ন";

  if (result.signal === "BUY") {
    subtitle = "দাম বাড়ার পক্ষে সংকেত";
  } else if (result.signal === "SELL") {
    subtitle = "দাম কমার পক্ষে সংকেত";
  } else {
    subtitle = "এখন ভালো সুযোগ নেই";
  }

  setSignal(result.signal, subtitle);

  $("confidence").textContent =
    result.technicalScore + "%";

  $("analysisReason").textContent =
    result.reason || "বিশ্লেষণ সম্পন্ন হয়েছে।";

  $("analysisStatus").textContent =
    "বিশ্লেষণ সফলভাবে সম্পন্ন হয়েছে";

  $("lastAnalysisTime").textContent =
    formatTime(new Date());

  $("marketSelectionStatus").textContent =
    "স্বয়ংক্রিয়ভাবে নির্বাচিত: " + result.pair;
}

function showError(message) {
  setSignal("WAIT", "সংকেত যাচাই করা যায়নি");

  $("analysisReason").textContent = message;

  $("analysisStatus").textContent =
    "বিশ্লেষণ করা যায়নি";

  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";

  $("priceStatus").textContent =
    "সঠিক তথ্যের অপেক্ষায়";
}

// -----------------------------
// API REQUEST
// -----------------------------

async function apiRequest(url, body = null) {
  requestController = new AbortController();

  const timeout = setTimeout(
    () => requestController?.abort(),
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
      throw new Error(
        data.message || "সার্ভারের সঙ্গে যোগাযোগ করা যায়নি।"
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
    requestController = null;
  }
}

// -----------------------------
// BEST MARKET SELECTION
// -----------------------------

function chooseBestMarket(results) {
  const valid = (results || []).filter(item =>
    item.dataStatus === "VALID" &&
    (item.signal === "BUY" || item.signal === "SELL")
  );

  valid.sort(
    (a, b) => b.technicalScore - a.technicalScore
  );

  return valid[0] || null;
}

// -----------------------------
// SCAN ALL SIX PAIRS
// -----------------------------

async function scanAllMarkets() {
  if (!running) return;

  weakCount = 0;
  errorCount = 0;

  $("analysisStatus").textContent =
    "ছয়টি মার্কেট পরীক্ষা করা হচ্ছে...";

  $("marketSelectionStatus").textContent =
    "সেরা সুযোগ খোঁজা হচ্ছে";

  setSignal("WAIT", "ভালো মার্কেট খোঁজা হচ্ছে");

  setStatus("Scanning markets");

  try {
    const data = await apiRequest("/api/scan", {});

    if (!running) return;

    const best = chooseBestMarket(data.results);

    if (!best) {
      selectedPair = null;
      currentAnalysis = null;

      $("selectedMarket").textContent =
        "কোনো উপযুক্ত মার্কেট নেই";

      $("marketSelectionStatus").textContent =
        "সব পেয়ার পরীক্ষা করা হয়েছে";

      $("marketPrice").textContent = "--";
      $("confidence").textContent = "--%";

      const validCount = data.validMarkets || 0;

      $("analysisReason").textContent =
        validCount > 0
          ? "সব মার্কেট পরীক্ষা করা হয়েছে, কিন্তু এখনো BUY বা SELL-এর উপযুক্ত সুযোগ নেই।"
          : "যাচাইকৃত মার্কেট ডাটা পাওয়া যায়নি। কিছুক্ষণ পর আবার পরীক্ষা করা হবে।";

      $("analysisStatus").textContent =
        `${validCount} / 6 টি মার্কেটের তথ্য যাচাই হয়েছে`;

      setSignal("WAIT", "ভালো সুযোগের অপেক্ষা চলছে");

      setStatus("Waiting for opportunity", "yellow");

      scheduleNextCheck();

      return;
    }

    showAnalysis(best);

    setStatus("Best market selected", "green");

    $("analysisStatus").textContent =
      `${data.validMarkets} টি যাচাইকৃত মার্কেটের মধ্যে সেরা সুযোগ নির্বাচন করা হয়েছে`;

    scheduleNextCheck();

  } catch (error) {
    if (!running) return;

    showError(
      error.name === "AbortError"
        ? "অনুরোধের সময় শেষ হয়েছে। আবার চেষ্টা করা হবে।"
        : error.message
    );

    setStatus("Connection error", "red");

    selectedPair = null;

    scheduleNextCheck();
  }
}

// -----------------------------
// RECHECK SELECTED PAIR
// -----------------------------

async function recheckSelectedMarket() {
  if (!running) return;

  // If no pair is selected, scan all pairs again.
  if (!selectedPair) {
    await scanAllMarkets();
    return;
  }

  const pairToCheck = selectedPair;

  $("analysisStatus").textContent =
    "নির্বাচিত মার্কেট আবার পরীক্ষা করা হচ্ছে...";

  try {
    const data = await apiRequest("/api/analyze", {
      pair: pairToCheck
    });

    if (!running || selectedPair !== pairToCheck) return;

    const result = data.result;

    if (!result || result.dataStatus !== "VALID") {
      throw new Error("যাচাইকৃত তথ্য পাওয়া যায়নি।");
    }

    errorCount = 0;

    showAnalysis(result);

    if (
      result.signal === "BUY" ||
      result.signal === "SELL"
    ) {
      weakCount = 0;

      setStatus("Market signal verified", "green");

      $("analysisStatus").textContent =
        "নির্বাচিত মার্কেটে নতুন সংকেত যাচাই হয়েছে";

    } else {
      weakCount++;

      setStatus("Market becoming weak", "yellow");

      $("analysisStatus").textContent =
        `মার্কেট দুর্বল পাওয়া গেছে (${weakCount}/2)।`;

      $("analysisReason").textContent =
        result.reason +
        " অন্য মার্কেটের সুযোগও পরীক্ষা করা হবে।";

      // After two consecutive weak checks,
      // search all six markets again.
      if (weakCount >= 2) {
        $("analysisStatus").textContent =
          "নির্বাচিত মার্কেট দুর্বল। নতুন মার্কেট খোঁজা হচ্ছে...";

        await scanAllMarkets();
        return;
      }
    }

  } catch (error) {
    if (!running) return;

    errorCount++;
    weakCount++;

    setSignal("WAIT", "সংকেত যাচাই করা যায়নি");

    $("analysisReason").textContent =
      "নির্বাচিত মার্কেটের নতুন তথ্য পাওয়া যায়নি। আবার পরীক্ষা করা হবে।";

    $("analysisStatus").textContent =
      "মার্কেট ডাটা যাচাই ব্যর্থ";

    setStatus("Recheck error", "red");

    if (errorCount >= 2 || weakCount >= 2) {
      await scanAllMarkets();
      return;
    }
  }

  if (running) {
    scheduleNextCheck();
  }
}

// -----------------------------
// NEXT CHECK COUNTDOWN
// -----------------------------

function getSecondsUntilCheck() {
  const now = new Date();

  const target = new Date(now);

  target.setMinutes(now.getMinutes() + 1);
  target.setSeconds(50, 0);

  return Math.max(
    0,
    target.getTime() - now.getTime()
  );
}

function updateCountdown() {
  if (!running) return;

  const remaining = getSecondsUntilCheck();

  const totalSeconds = Math.ceil(remaining / 1000);

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  $("nextSignalCheck").textContent =
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0");
}

function scheduleNextCheck() {
  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (!running) return;

  updateCountdown();

  countdownTimer = setInterval(
    updateCountdown,
    250
  );

  const delay = getSecondsUntilCheck();

  nextCheckTimer = setTimeout(async () => {
    if (!running) return;

    clearInterval(countdownTimer);

    await recheckSelectedMarket();

  }, delay);
}

// -----------------------------
// START
// -----------------------------

async function startAnalysis() {
  if (running) return;

  running = true;

  weakCount = 0;
  errorCount = 0;

  $("startAnalysis").disabled = true;
  $("stopAnalysis").disabled = false;

  selectedPair = null;
  currentAnalysis = null;

  $("selectedMarket").textContent = "Searching...";
  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";

  setSignal("WAIT", "সেরা মার্কেট খোঁজা হচ্ছে");

  $("analysisReason").textContent =
    "ছয়টি Forex পেয়ার পরীক্ষা করা হচ্ছে...";

  $("analysisStatus").textContent =
    "মার্কেট স্ক্যান চলছে";

  await scanAllMarkets();

  if (running) {
    $("startAnalysis").disabled = false;
  }
}

// -----------------------------
// STOP
// -----------------------------

function stopAnalysis() {
  running = false;

  clearInterval(countdownTimer);
  clearTimeout(nextCheckTimer);

  if (requestController) {
    requestController.abort();
  }

  $("startAnalysis").disabled = false;
  $("stopAnalysis").disabled = true;

  $("analysisStatus").textContent =
    "বিশ্লেষণ বন্ধ করা হয়েছে";

  $("nextSignalCheck").textContent = "--";

  setStatus("Stopped");
}

// -----------------------------
// BACKEND HEALTH
// -----------------------------

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

// -----------------------------
// BUTTON EVENTS
// -----------------------------

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

// Initial connection check
checkHealth();
