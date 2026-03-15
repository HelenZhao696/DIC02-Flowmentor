const DEFAULT_WORK_SECONDS = 30;
const DEFAULT_BREAK_SECONDS = 30;

const timerEl = document.getElementById("timer");
const statusTextEl = document.getElementById("statusText");
const idleTextEl = document.getElementById("idleText");
const startPauseBtn = document.getElementById("startPauseBtn");
const resetBtn = document.getElementById("resetBtn");
const workBtn = document.getElementById("workBtn");
const breakBtn = document.getElementById("breakBtn");
const workMinutesInput = document.getElementById("workMinutesInput");
const breakMinutesInput = document.getElementById("breakMinutesInput");

let workSeconds = DEFAULT_WORK_SECONDS;
let breakSeconds = DEFAULT_BREAK_SECONDS;
let mode = "work";
let remainingSeconds = workSeconds;
let isRunning = false;
let endTimestamp = null;
let lastActivity = Date.now();
let hasIdleNotified = false;

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getModeDuration(targetMode) {
  return targetMode === "work" ? workSeconds : breakSeconds;
}

function computeDisplaySeconds() {
  if (!isRunning || !endTimestamp) return remainingSeconds;
  const msLeft = endTimestamp - Date.now();
  return Math.max(0, Math.ceil(msLeft / 1000));
}

function formatIdleText() {
  const idleSeconds = Math.floor((Date.now() - lastActivity) / 1000);
  if (idleSeconds < 1) return "活动中";
  return `已闲置 ${idleSeconds} 秒`;
}

function updateUI() {
  const displaySeconds = computeDisplaySeconds();
  timerEl.textContent = formatTime(displaySeconds);

  const modeText = mode === "work" ? "专注" : "休息";
  statusTextEl.textContent = `当前模式：${modeText}`;

  workBtn.classList.toggle("active", mode === "work");
  breakBtn.classList.toggle("active", mode === "break");

  workBtn.textContent = `专注 ${formatMinutes(workSeconds)} 分钟`;
  breakBtn.textContent = `休息 ${formatMinutes(breakSeconds)} 分钟`;

  idleTextEl.textContent = formatIdleText();

  startPauseBtn.textContent = isRunning ? "暂停" : "开始";
  document.title = `${timerEl.textContent} - ${modeText}`;
}

function playBeep() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  const audioCtx = new AudioContextClass();
  const oscillator = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gainNode.gain.value = 0.1;

  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  oscillator.start();
  oscillator.stop(audioCtx.currentTime + 0.25);
}

function formatMinutes(seconds) {
  const minutes = seconds / 60;
  return Number.isInteger(minutes) ? `${minutes}` : `${minutes.toFixed(1)}`;
}

function applyState(state) {
  mode = state?.mode === "break" ? "break" : "work";

  workSeconds = Number.isFinite(state?.workSeconds)
    ? Math.max(1, Math.floor(state.workSeconds))
    : DEFAULT_WORK_SECONDS;
  breakSeconds = Number.isFinite(state?.breakSeconds)
    ? Math.max(1, Math.floor(state.breakSeconds))
    : DEFAULT_BREAK_SECONDS;

  remainingSeconds = Number.isFinite(state?.remainingSeconds)
    ? Math.max(0, Math.floor(state.remainingSeconds))
    : getModeDuration(mode);
  isRunning = Boolean(state?.isRunning);
  endTimestamp = Number.isFinite(state?.endTimestamp) ? state.endTimestamp : null;
  if (!isRunning) endTimestamp = null;

  workMinutesInput.value = (workSeconds / 60).toString();
  breakMinutesInput.value = (breakSeconds / 60).toString();

  // 只要有交互就认为“活动中”
  lastActivity = Date.now();
  hasIdleNotified = false;

  updateUI();
}

function sendMessage(message) {
  return new Promise((resolve) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve({ ok: false, error: "Extension runtime unavailable." });
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response." });
    });
  });
}

async function refreshState() {
  const result = await sendMessage({ type: "GET_STATE" });
  if (!result?.ok || !result.state) return;
  applyState(result.state);
}

async function toggleStartPause() {
  const result = await sendMessage({ type: "TOGGLE_START_PAUSE" });
  if (!result?.ok || !result.state) return;
  applyState(result.state);
}

async function setMode(nextMode) {
  const result = await sendMessage({ type: "SET_MODE", mode: nextMode });
  if (!result?.ok || !result.state) return;
  applyState(result.state);
}

async function resetCurrentMode() {
  const result = await sendMessage({ type: "RESET" });
  if (!result?.ok || !result.state) return;
  applyState(result.state);
}

startPauseBtn.addEventListener("click", () => {
  void toggleStartPause();
});
resetBtn.addEventListener("click", () => {
  void resetCurrentMode();
});
workBtn.addEventListener("click", () => {
  void setMode("work");
});
breakBtn.addEventListener("click", () => {
  void setMode("break");
});

function setDurations(workMinutes, breakMinutes) {
  return sendMessage({
    type: "SET_DURATIONS",
    workMinutes,
    breakMinutes,
  });
}

workMinutesInput.addEventListener("change", () => {
  const value = parseFloat(workMinutesInput.value);
  if (Number.isFinite(value) && value > 0) {
    void setDurations(value, breakSeconds / 60).then((result) => {
      if (result?.ok && result.state) {
        applyState(result.state);
      } else {
        workMinutesInput.value = (workSeconds / 60).toString();
      }
    });
  } else {
    workMinutesInput.value = (workSeconds / 60).toString();
  }
});

breakMinutesInput.addEventListener("change", () => {
  const value = parseFloat(breakMinutesInput.value);
  if (Number.isFinite(value) && value > 0) {
    void setDurations(workSeconds / 60, value).then((result) => {
      if (result?.ok && result.state) {
        applyState(result.state);
      } else {
        breakMinutesInput.value = (breakSeconds / 60).toString();
      }
    });
  } else {
    breakMinutesInput.value = (breakSeconds / 60).toString();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TIMER_COMPLETED") {
    void refreshState();
  }
  if (message?.type === "PLAY_BEEP_POPUP") {
    playBeep();
  }
});

setInterval(() => {
  updateUI();
  if (isRunning && computeDisplaySeconds() <= 0) {
    void refreshState();
  }
}, 500);

function markActivity() {
  lastActivity = Date.now();
  hasIdleNotified = false;
}

function refreshIdleState() {
  const idleSeconds = Math.floor((Date.now() - lastActivity) / 1000);
  if (idleSeconds >= 60 && !hasIdleNotified) {
    hasIdleNotified = true;
    playBeep();
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "番茄钟提醒",
        message: "检测到你已闲置 1 分钟，记得继续保持专注或适时休息。",
      });
    }
  }
}

setInterval(() => {
  refreshIdleState();
}, 1000);

["mousemove", "mousedown", "keydown", "touchstart", "wheel"].forEach((event) => {
  window.addEventListener(event, markActivity, { passive: true });
});

void refreshState();
