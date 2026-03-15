const DEFAULT_WORK_SECONDS = 30;
const DEFAULT_BREAK_SECONDS = 30;
const STORAGE_KEY = "pomodoroStateV1";
const ALARM_NAME = "pomodoro-alarm";
const OFFSCREEN_PATH = "offscreen.html";

let creatingOffscreenDocument = null;

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
    raw.idleState === "idle" || raw.idleState === "locked" ? raw.idleState : "active";
  const idleSince = Number.isFinite(raw.idleSince) ? raw.idleSince : null;

  return {
    mode,
    remainingSeconds,
    isRunning,
    endTimestamp,
    workSeconds,
    breakSeconds,
    idleState,
    idleSoon: null,
    idleSince,
  };
}

function syncStateFromClock(state) {
  if (!state.isRunning || !state.endTimestamp) return state;
  const msLeft = state.endTimestamp - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  return { ...state, remainingSeconds };
}

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

function sendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore if no active receivers (e.g., popup closed).
  }
}

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
        justification: "Play completion beep when popup is closed.",
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
  } catch (_error) {
    return false;
  }
}

async function playCompletionSound() {
  const hasOffscreen = await ensureOffscreenDocument();
  if (hasOffscreen) {
    sendRuntimeMessage({ type: "PLAY_BEEP_OFFSCREEN" });
    return;
  }
  // Fallback: if popup is currently open, let popup play a sound.
  sendRuntimeMessage({ type: "PLAY_BEEP_POPUP" });
}

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
  return nextState;
}

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

async function initializeState() {
  await getCurrentState();

  if (chrome.idle?.setDetectionInterval) {
    // idle.setDetectionInterval 要求最小 15 秒
    chrome.idle.setDetectionInterval(15);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeState();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void getCurrentState();
});

chrome.idle?.onStateChanged.addListener(async (state) => {
  // 当用户闲置超过设置时间（60s）时提醒，并让 popup 显示闲置时长。
  if (state === "idle") {
    playCompletionSound();
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "番茄钟提醒",
        message: "检测到你已闲置 1 分钟，记得继续保持专注或适时休息。",
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  (async () => {
    if (type === "GET_STATE") {
      const state = await getCurrentState();
      sendResponse({ ok: true, state });
      return;
    }

    if (type === "TOGGLE_START_PAUSE") {
      let state = syncStateFromClock(await storageGetState());

      if (state.isRunning) {
        state = {
          ...state,
          isRunning: false,
          endTimestamp: null,
        };
        await clearAlarm();
      } else {
        const remainingSeconds =
          state.remainingSeconds > 0
            ? state.remainingSeconds
            : getModeDuration(state.mode, state);
        const endTimestamp = Date.now() + remainingSeconds * 1000;
        state = {
          ...state,
          remainingSeconds,
          isRunning: true,
          endTimestamp,
        };
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
      let state = {
        ...current,
        workSeconds,
        breakSeconds,
      };

      // if timer isn't running, update remaining time to match current mode
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

    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});

void initializeState();
