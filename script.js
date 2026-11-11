const $ = id => document.getElementById(id);

let running = false;
let selectedPair = null;
let countdownTimer = null;
let nextCheckTimer = null;
let requestController = null;
let currentAnalysis = null;

let weakCount = 0;
let errorCount = 0;
let excludedPair = null;
let scanBusy = false;

const MIN_PAYOUT = 70;

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
// API REQUEST
// -----------------------------

async function apiRequest(url, body = null) {
  const controller = new AbortController();
  requestController = controller;

  const timeout = setTimeout(
    () => controller.abort(),
    180000
  );

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const data = await response.json();

    if (!response.ok || data.success === false) {
      const error = new Error(
        data.message || "সার্ভারের সঙ্গে যোগাযোগ করা যায়নি।"
      );

      error.status = response.status;
      error.data = data;

      throw error;
    }

    return data;

  } finally {
    clearTimeout(timeout);

    if (requestController === controller) {
      requestController = null;
    }
  }
}


// -----------------------------
// PAYOUT DISPLAY
// -----------------------------

function updatePayoutDisplay() {
  $("payoutMarketLabel").textContent =
    "Selected Market: " + (selectedPair || "Waiting...");

  if (excludedPair) {
    $("payoutStatus").textContent =
      excludedPair +
      " বাদ দেওয়া হয়েছে। Reset না করা পর্যন্ত ফিরবে না।";
  } else {
    $("payoutStatus").textContent =
      "৭০% বা তার বেশি Payout থাকা মার্কেট ব্যবহার করা হবে।";
  }
}


// -----------------------------
// PAYOUT REQUIRED
// -----------------------------

function showPayoutRequired(result) {
  selectedPair = result.pair;
  currentAnalysis = result;

  $("selectedMarket").textContent = result.pair;

  $("marketPrice").textContent =
    formatPrice(result.price, result.pair);

  $("priceStatus").textContent =
    "শেষ সম্পন্ন ক্যান্ডেলের দাম";

  $("confidence").textContent = "--%";

  setSignal(
    "WAIT",
    "সিগন্যালের আগে Payout যাচাই করুন"
  );

  $("analysisReason").textContent =
    result.pair +
    " এর Quotex Payout এখনো দেওয়া হয়নি। Quotex দেখে Payout লিখে SAVE PAYOUT চাপুন।";

  $("analysisStatus").textContent =
    "Payout যাচাই প্রয়োজন";

  $("marketSelectionStatus").textContent =
    "Payout যাচাইয়ের জন্য নির্বাচিত: " + result.pair;

  updatePayoutDisplay();
}


// -----------------------------
// SHOW ANALYSIS
// -----------------------------

function showAnalysis(result) {
  if (!result || result.dataStatus !== "VALID") {
    setSignal("WAIT", "যাচাইকৃত বাজারের তথ্য পাওয়া যায়নি");

    $("marketPrice").textContent = "--";
    $("confidence").textContent = "--%";

    $("analysisReason").textContent =
      result?.reason || "বাজারের তথ্য পাওয়া যায়নি।";

    $("priceStatus").textContent =
      "সঠিক তথ্যের অপেক্ষায়";

    return;
  }

  selectedPair = result.pair;
  currentAnalysis = result;

  // Payout না থাকলে কোনো BUY/SELL দেখানো যাবে না।
  if (
    result.payoutRequired === true ||
    result.payout == null
  ) {
    showPayoutRequired(result);
    return;
  }

  if (Number(result.payout) < MIN_PAYOUT) {
    setSignal("WAIT", "Payout ৭০%-এর কম");

    $("analysisReason").textContent =
      "এই মার্কেটের Payout ৭০%-এর কম।";

    return;
  }

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

  updatePayoutDisplay();
}


// -----------------------------
// SHOW ERROR
// -----------------------------

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
// CHOOSE BEST MARKET
// -----------------------------

function chooseBestMarket(results) {
  const valid = (results || []).filter(item =>
    item.dataStatus === "VALID" &&
    item.pair !== excludedPair &&
    (item.signal === "BUY" || item.signal === "SELL")
  );

  valid.sort(
    (a, b) => b.technicalScore - a.technicalScore
  );

  return valid[0] || null;
}


// -----------------------------
// CLEAR SELECTED MARKET
// -----------------------------

function clearSelectedMarket(message) {
  selectedPair = null;
  currentAnalysis = null;

  $("selectedMarket").textContent =
    "কোনো উপযুক্ত মার্কেট নেই";

  $("marketPrice").textContent = "--";
  $("confidence").textContent = "--%";

  $("marketSelectionStatus").textContent =
    message;

  setSignal("WAIT", "ভালো সুযোগের অপেক্ষা চলছে");

  updatePayoutDisplay();
}


// -----------------------------
// SCAN ALL MARKETS
// -----------------------------

async function scanAllMarkets() {
  if (!running || scanBusy) return;

  scanBusy = true;

  weakCount = 0;
  errorCount = 0;

  $("analysisStatus").textContent =
    "মার্কেট স্ক্যান করা হচ্ছে...";

  $("marketSelectionStatus").textContent =
    "সেরা সুযোগ খোঁজা হচ্ছে";

  setSignal("WAIT", "ভালো মার্কেট খোঁজা হচ্ছে");

  setStatus("Scanning markets");

  try {
    const data = await apiRequest("/api/scan");

    if (!running) return;

    excludedPair = data.excludedPair || null;

    const best = chooseBestMarket(data.results);

    if (!best) {
      clearSelectedMarket(
        "সব যোগ্য মার্কেট পরীক্ষা করা হয়েছে"
      );

      const validCount = data.validMarkets || 0;

      $("analysisReason").textContent =
        validCount > 0
          ? "এখন কোনো শক্তিশালী BUY বা SELL সুযোগ নেই। অপেক্ষা করুন।"
          : "Payout যাচাই করুন এবং বাজারের তথ্যের অপেক্ষা করুন।";

      $("analysisStatus").textContent =
        `${validCount} টি যাচাইকৃত মার্কেট পাওয়া গেছে।`;

      setStatus("Waiting for opportunity", "yellow");

      scheduleNextCheck();

      return;
    }

    // Payout অজানা হলে শুধু WAIT দেখাবে।
    if (
      best.payoutRequired === true ||
      best.payout == null
    ) {
      showPayoutRequired(best);

      setStatus("Payout required", "yellow");

      $("analysisStatus").textContent =
        "সিগন্যালের আগে এই মার্কেটের Payout লিখুন।";

      scheduleNextCheck();

      return;
    }

    showAnalysis(best);

    setStatus("Best market selected", "green");

    $("analysisStatus").textContent =
      "সেরা উপযুক্ত মার্কেট নির্বাচন করা হয়েছে।";

    scheduleNextCheck();

  } catch (error) {
    if (!running) return;

    showError(error.message);

    setStatus("Connection error", "red");

    scheduleNextCheck();

  } finally {
    scanBusy = false;
  }
}


// -----------------------------
// RECHECK SELECTED MARKET
// -----------------------------

async function recheckSelectedMarket() {
  if (!running) return;

  if (!selectedPair) {
    await scanAllMarkets();
    return;
  }

  // Payout না দেওয়া পর্যন্ত /api/analyze কল নয়।
  if (
    !currentAnalysis ||
    currentAnalysis.payoutRequired === true ||
    currentAnalysis.payout == null
  ) {
    await scanAllMarkets();
    return;
  }

  const pairToCheck = selectedPair;

  $("analysisStatus").textContent =
    "নির্বাচিত মার্কেট আবার পরীক্ষা করা হচ্ছে...";

  try {
    const data = await apiRequest(
      "/api/analyze?pair=" +
      encodeURIComponent(pairToCheck)
    );

    if (!running || selectedPair !== pairToCheck) return;

    const result = data.result;

    if (!result || result.dataStatus !== "VALID") {
      throw new Error("যাচাইকৃত তথ্য পাওয়া যায়নি।");
    }

    if (
      result.payoutRequired === true ||
      result.payout == null ||
      Number(result.payout) < MIN_PAYOUT
    ) {
      await scanAllMarkets();
      return;
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
        "নির্বাচিত মার্কেটে সংকেত যাচাই হয়েছে";

    } else {
      weakCount++;

      setStatus("Market becoming weak", "yellow");

      $("analysisStatus").textContent =
        `মার্কেট দুর্বল পাওয়া গেছে (${weakCount}/2)।`;

      $("analysisReason").textContent =
        result.reason +
        " অন্য মার্কেটের সুযোগও পরীক্ষা করা হবে।";

      if (weakCount >= 2) {
        await scanAllMarkets();
        return;
      }
    }

  } catch (error) {
    if (!running) return;

    errorCount++;
    weakCount++;

    if (error.status === 403) {
      showError(error.message);

      await scanAllMarkets();
      return;
    }

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
// PAYOUT SAVE BUTTON
// -----------------------------

async function savePayout() {
  const pair = selectedPair;

  if (!pair) {
    $("payoutStatus").textContent =
      "প্রথমে একটি মার্কেট সিলেক্ট হতে দিন।";

    return;
  }

  const input = $("payoutInput");
  const payout = Number(input.value);

  if (
    input.value.trim() === "" ||
    !Number.isFinite(payout) ||
    payout < 0 ||
    payout > 100
  ) {
    $("payoutStatus").textContent =
      "সঠিক Payout শতাংশ লিখুন (০–১০০)।";

    return;
  }

  $("setPayoutButton").disabled = true;

  try {
    const data = await apiRequest("/api/payout", {
      pair,
      payout
    });

    excludedPair = data.excludedPair || null;

    $("payoutStatus").textContent =
      data.message;

    input.value = "";

    if (excludedPair === pair) {
      clearSelectedMarket(
        pair + " কম Payout-এর কারণে বাদ দেওয়া হয়েছে"
      );

      $("analysisReason").textContent =
        pair + " এর Payout " + payout +
        "%। তাই এই মার্কেট বাদ দিয়ে অন্য মার্কেট খোঁজা হচ্ছে।";
    }

    updatePayoutDisplay();

    if (running) {
      await scanAllMarkets();
    } else {
      $("analysisStatus").textContent =
        payout >= MIN_PAYOUT
          ? "Payout সংরক্ষিত। Start Analysis চাপুন।"
          : "কম Payout-এর মার্কেট বাদ দেওয়া হয়েছে।";
    }

  } catch (error) {
    $("payoutStatus").textContent =
      error.message;

  } finally {
    $("setPayoutButton").disabled = false;
  }
}


// -----------------------------
// RESET MARKETS BUTTON
// -----------------------------

async function resetMarkets() {
  const button = $("resetExcludedButton");

  button.disabled = true;

  try {
    const data = await apiRequest(
      "/api/reset-markets",
      {}
    );

    excludedPair = null;

    selectedPair = null;
    currentAnalysis = null;

    $("payoutInput").value = "";

    $("payoutStatus").textContent =
      data.message;

    $("selectedMarket").textContent =
      "Waiting...";

    $("marketPrice").textContent = "--";
    $("confidence").textContent = "--%";

    setSignal("WAIT", "Payout যাচাইয়ের অপেক্ষায়");

    $("analysisReason").textContent =
      "সব ছয়টি মার্কেট ফিরেছে। Quotex দেখে Payout যাচাই করুন।";

    $("analysisStatus").textContent =
      "সব মার্কেট Reset হয়েছে";

    updatePayoutDisplay();

    if (running) {
      await scanAllMarkets();
    }

  } catch (error) {
    $("payoutStatus").textContent =
      error.message;

  } finally {
    button.disabled = false;
  }
}


// -----------------------------
// COUNTDOWN
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

    excludedPair = data.excludedPair || null;

    if (data.twelveDataConfigured) {
      setStatus("Backend connected", "green");
    } else {
      setStatus("API key missing", "red");
    }

    updatePayoutDisplay();

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

$("setPayoutButton").addEventListener(
  "click",
  savePayout
);

$("resetExcludedButton").addEventListener(
  "click",
  resetMarkets
);

window.addEventListener("beforeunload", () => {
  stopAnalysis();
});


// -----------------------------
// INITIAL CONNECTION
// -----------------------------

updatePayoutDisplay();
checkHealth();
