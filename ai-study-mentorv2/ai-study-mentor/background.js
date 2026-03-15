// ================================================================
// AI Study Mentor — Background Service Worker (Hub)
// Single source of truth for all state:
//   - Pomodoro timer
//   - Emotion / attention (received from offscreen document)
//   - Idle detection
//   - Tab-switch counting (received from content script)
// ================================================================

const DEFAULT_WORK_SECONDS = 25 * 60;
const DEFAULT_BREAK_SECONDS = 5 * 60;
const STORAGE_KEY = "aiStudyMentorState";
const ALARM_NAME = "pomodoro-alarm";
const OFFSCREEN_PATH = "offscreen.html";

let creatingOffscreenDocument = null;

// ================================================================
// Central studentState — updated by offscreen + content scripts
// ================================================================
let studentState = {
  emotion: "neutral",
  attention: "focused",
  mentalStatus: "focused",
  tabSwitchCount: 0,
};

// ================================================================
// Pomodoro State Helpers
// ================================================================
function getModeDuration(mode, state) {
  const workSeconds = Number.isFinite(state?.workSeconds)
    ? state.workSeconds
    : DEFAULT_WORK_SECONDS;
  const breakSeconds = Number.isFinite(state?.breakSeconds)
    ? state.breakSeconds
    : DEFAULT_BREAK_SECONDS;
  return mode === "work" ? workSeconds : breakSeconds;
}

function getDefaultState() {
  return {
    mode: "work",
    remainingSeconds: DEFAULT_WORK_SECONDS,
    isRunning: false,
    endTimestamp: null,
    workSeconds: DEFAULT_WORK_SECONDS,
    breakSeconds: DEFAULT_BREAK_SECONDS,
    idleState: "active",
    idleSince: null,
  };
}

function normalizeState(raw) {
  if (!raw) return getDefaultState();

  const mode = raw.mode === "break" ? "break" : "work";

  const workSeconds = Number.isFinite(raw.workSeconds)
    ? Math.max(1, Math.floor(raw.workSeconds))
    : DEFAULT_WORK_SECONDS;
  const breakSeconds = Number.isFinite(raw.breakSeconds)
    ? Math.max(1, Math.floor(raw.breakSeconds))
    : DEFAULT_BREAK_SECONDS;

  const fallbackDuration = getModeDuration(mode, { workSeconds, breakSeconds });
  const remainingSeconds = Number.isFinite(raw.remainingSeconds)
    ? Math.max(0, Math.floor(raw.remainingSeconds))
    : fallbackDuration;
  const isRunning = Boolean(raw.isRunning);
  const endTimestamp =
    isRunning && Number.isFinite(raw.endTimestamp) ? raw.endTimestamp : null;

  const idleState =
    raw.idleState === "idle" || raw.idleState === "locked"
      ? raw.idleState
      : "active";
  const idleSince = Number.isFinite(raw.idleSince) ? raw.idleSince : null;

  return {
    mode,
    remainingSeconds,
    isRunning,
    endTimestamp,
    workSeconds,
    breakSeconds,
    idleState,
    idleSince,
  };
}

function syncStateFromClock(state) {
  if (!state.isRunning || !state.endTimestamp) return state;
  const msLeft = state.endTimestamp - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  return { ...state, remainingSeconds };
}

// ================================================================
// chrome.storage Helpers
// ================================================================
function storageGetState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(normalizeState(result?.[STORAGE_KEY]));
    });
  });
}

function storageSetState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, () => resolve());
  });
}

// ================================================================
// chrome.alarms Helpers
// ================================================================
function clearAlarm() {
  return new Promise((resolve) => {
    chrome.alarms.clear(ALARM_NAME, () => resolve());
  });
}

async function scheduleAlarmIfNeeded(state) {
  await clearAlarm();
  if (!state.isRunning || !state.endTimestamp) return;
  chrome.alarms.create(ALARM_NAME, { when: state.endTimestamp });
}

// ================================================================
// Safe message broadcast (ignores errors when no listener)
// ================================================================
function sendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // No active receiver
  }
}

// ================================================================
// Offscreen Document (for audio playback when popup is closed)
// ================================================================
async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) return false;

  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) return true;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play timer completion beep when popup is closed.",
      })
      .catch((error) => {
        if (!String(error).includes("Only a single offscreen document")) {
          throw error;
        }
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  try {
    await creatingOffscreenDocument;
    return true;
  } catch (_) {
    return false;
  }
}

async function playCompletionSound() {
  const hasOffscreen = await ensureOffscreenDocument();
  if (hasOffscreen) {
    sendRuntimeMessage({ type: "PLAY_BEEP_OFFSCREEN" });
    return;
  }
  // Fallback: let popup play if it's open
  sendRuntimeMessage({ type: "PLAY_BEEP_POPUP" });
}

// ================================================================
// Timer Completion Handler
// ================================================================
async function handleTimerComplete(state, { playSound }) {
  const finishedMode = state.mode;
  const nextMode = finishedMode === "work" ? "break" : "work";

  const nextState = {
    mode: nextMode,
    remainingSeconds: getModeDuration(nextMode, state),
    isRunning: false,
    endTimestamp: null,
    workSeconds: state.workSeconds,
    breakSeconds: state.breakSeconds,
  };

  await clearAlarm();
  await storageSetState(nextState);

  if (playSound) {
    await playCompletionSound();
  }

  sendRuntimeMessage({ type: "TIMER_COMPLETED", finishedMode });

  if (chrome.notifications) {
    const title =
      finishedMode === "work" ? "Focus session complete!" : "Break is over!";
    const message =
      finishedMode === "work"
        ? "Time for a break. Great work!"
        : "Ready to focus again?";
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  }

  return nextState;
}

// ================================================================
// Get authoritative current state (syncs clock + handles expiry)
// ================================================================
async function getCurrentState() {
  let state = syncStateFromClock(await storageGetState());

  if (state.isRunning && state.remainingSeconds <= 0) {
    state = await handleTimerComplete(state, { playSound: true });
    return state;
  }

  if (state.isRunning) {
    await storageSetState(state);
    await scheduleAlarmIfNeeded(state);
  }

  return state;
}
async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: offscreenUrl,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'], // Needs camera AND audio permissions
    justification: 'Running background facial recognition and alarms'
  });
}

// Call this when the extension starts

// ================================================================
// Initialization
// ================================================================
async function initializeState() {
  await getCurrentState();

  // Offscreen is audio-only; camera/detection live in popup.js
  await ensureOffscreenDocument();

  if (chrome.idle?.setDetectionInterval) {
    chrome.idle.setDetectionInterval(15);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeState();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeState();
});

// ================================================================
// Alarm Listener (timer expiry)
// ================================================================
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void getCurrentState();
});

// ================================================================
// Idle Detection
// ================================================================
chrome.idle?.onStateChanged.addListener(async (state) => {
  if (state === "idle") {
    playCompletionSound();
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "AI Study Mentor",
        message: "You've been idle for a minute. Stay focused or take a proper break!",
      });
    }
  }

  const current = normalizeState(await storageGetState());
  const nextState = {
    ...current,
    idleState: state,
    idleSince: state === "idle" ? Date.now() : null,
  };
  await storageSetState(nextState);
});

// ================================================================
// Mental Status Mapping (emotion + attention → psychological state)
// ================================================================
const EMOTION_TO_MENTAL_MAP = {
  angry: "struggling",
  sad: "fatigued",
  fearful: "anxious",
  disgusted: "frustrated",
  neutral: "focused",
  happy: "engaged",
  surprised: "engaged",
};

function updateMentalStatus() {
  if (studentState.attention === "distracted") {
    studentState.mentalStatus = "lost_focus";
    return;
  }
  studentState.mentalStatus =
    EMOTION_TO_MENTAL_MAP[studentState.emotion] || "focused";
}

// ================================================================
// Focus Reminder Logic
// ================================================================
let lastReminderTime = 0;
const REMINDER_COOLDOWN_MS = 10000;

const WARNING_STATES = new Set([
  "lost_focus",
  "struggling",
  "fatigued",
  "anxious",
  "frustrated",
]);

async function checkAndRemind() {
  const now = Date.now();
  if (now - lastReminderTime < REMINDER_COOLDOWN_MS) return;

  const timerState = syncStateFromClock(await storageGetState());
  if (timerState.mode !== "work" || !timerState.isRunning) return;

  const { mentalStatus, attention } = studentState;

  if (attention === "distracted" || WARNING_STATES.has(mentalStatus)) {
    lastReminderTime = now;

    // Broadcast reminder to popup
    sendRuntimeMessage({
      type: "FOCUS_REMINDER",
      mentalStatus,
      attention,
    });

    // System notification as backup
    if (chrome.notifications) {
      const messages = {
        lost_focus: "Your attention seems to be drifting! Look at the screen.",
        struggling: "You seem frustrated. Take a deep breath and try again.",
        fatigued: "Feeling tired? Maybe take a short break soon.",
        anxious: "You seem anxious. Relax, you've got this!",
        frustrated: "Feeling stuck? Step back and think about it differently.",
      };

      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Focus Check",
        message: messages[mentalStatus] || messages.lost_focus,
      });
    }
  }
}

// ================================================================
// Central Message Handler (Hub)
// ================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  (async () => {
    // ── Popup requests ──

    if (type === "GET_STATE") {
      const state = await getCurrentState();
      sendResponse({
        ok: true,
        state,
        studentState, // Include emotion/attention for popup display
      });
      return;
    }
    if (message.type === "START_SESSION") {
        console.log("Received START_SESSION command. Waking up AI...");
        setupOffscreenDocument(); // This boots up emotion.js!
        sendResponse({ ok: true });
        return;
    }
    if (type === "TOGGLE_START_PAUSE") {
      let state = syncStateFromClock(await storageGetState());

      if (state.isRunning) {
        state = { ...state, isRunning: false, endTimestamp: null };
        await clearAlarm();
      } else {
        const remainingSeconds =
          state.remainingSeconds > 0
            ? state.remainingSeconds
            : getModeDuration(state.mode, state);
        const endTimestamp = Date.now() + remainingSeconds * 1000;
        state = { ...state, remainingSeconds, isRunning: true, endTimestamp };
        await scheduleAlarmIfNeeded(state);
      }

      await storageSetState(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (type === "SET_MODE") {
      const mode = message?.mode === "break" ? "break" : "work";
      const current = normalizeState(await storageGetState());
      const state = {
        mode,
        remainingSeconds: getModeDuration(mode, current),
        isRunning: false,
        endTimestamp: null,
        workSeconds: current.workSeconds,
        breakSeconds: current.breakSeconds,
      };
      await clearAlarm();
      await storageSetState(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (type === "SET_DURATIONS") {
      const workMinutes = Number(message?.workMinutes);
      const breakMinutes = Number(message?.breakMinutes);

      if (!Number.isFinite(workMinutes) || workMinutes <= 0) {
        sendResponse({ ok: false, error: "Invalid work duration" });
        return;
      }
      if (!Number.isFinite(breakMinutes) || breakMinutes <= 0) {
        sendResponse({ ok: false, error: "Invalid break duration" });
        return;
      }

      const workSeconds = Math.max(1, Math.floor(workMinutes * 60));
      const breakSeconds = Math.max(1, Math.floor(breakMinutes * 60));

      const current = normalizeState(await storageGetState());
      let state = { ...current, workSeconds, breakSeconds };

      if (!state.isRunning) {
        state = {
          ...state,
          remainingSeconds: getModeDuration(state.mode, state),
          endTimestamp: null,
        };
      }

      await storageSetState(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (type === "RESET") {
      const current = normalizeState(await storageGetState());
      const state = {
        mode: current.mode,
        remainingSeconds: getModeDuration(current.mode, current),
        isRunning: false,
        endTimestamp: null,
        workSeconds: current.workSeconds,
        breakSeconds: current.breakSeconds,
      };
      await clearAlarm();
      await storageSetState(state);
      sendResponse({ ok: true, state });
      return;
    }

    // ── Messages from Offscreen (emotion detection) ──

    if (type === "EMOTION_UPDATE") {
      studentState.emotion = message.emotion || "neutral";
      studentState.attention = message.attention || "focused";
      updateMentalStatus();

      // Check if we need to send a focus reminder
      await checkAndRemind();

      sendResponse({ ok: true });
      return;
    }

    // ── Messages from Content Script (tab switches, visibility, idle) ──

    if (type === "TAB_SWITCH") {
      studentState.tabSwitchCount = (studentState.tabSwitchCount || 0) + 1;
      sendResponse({ ok: true, count: studentState.tabSwitchCount });
      return;
    }

    if (type === "VISIBILITY_CHANGE") {
      // If user switched away from their tab during work, count as distraction
      if (message.hidden) {
        studentState.tabSwitchCount = (studentState.tabSwitchCount || 0) + 1;
      }
      sendResponse({ ok: true });
      return;
    }

    if (type === "USER_IDLE") {
      // Content script reports mouse idle on the page
      const current = normalizeState(await storageGetState());
      if (current.isRunning && current.mode === "work") {
        sendRuntimeMessage({
          type: "FOCUS_REMINDER",
          mentalStatus: "lost_focus",
          attention: "distracted",
        });
      }
      sendResponse({ ok: true });
      return;
    }

    // ── Ollama proxy — avoids chrome-extension:// origin 403 ──
    // Background service workers with host_permissions can reach
    // localhost Ollama without triggering the origin block.
    if (type === "OLLAMA_REQUEST") {
      try {
        const res = await fetch(message.url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model:       message.model,
            prompt:      message.prompt,
            stream:      false,
            temperature: 0.7,
            max_tokens:  200,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status} ${res.statusText}` });
          return;
        }
        const data = await res.json();
        sendResponse({ ok: true, response: data.response?.trim() || "" });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message) });
      }
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true; // Keep sendResponse channel open for async
});

// ================================================================
// Boot
// ================================================================
void initializeState();
