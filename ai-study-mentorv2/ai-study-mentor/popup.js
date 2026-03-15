// ================================================================
// AI Study Mentor — Popup Script
//
// Architecture:
//   - Nothing starts automatically on popup open.
//   - User clicks "Start Session" → camera, detection, AI, and timer begin.
//   - Pomodoro timer state is authoritative in background.js (chrome.storage + chrome.alarms).
//   - This popup handles camera display, FaceMesh, face-api, and Ollama AI.
//   - Sends EMOTION_UPDATE to background.js whenever state changes.
// ================================================================

// ================================================================
// DOM References
// ================================================================
const launchBtn        = document.getElementById("launchBtn");
const startScreen      = document.getElementById("startScreen");
const mainShell        = document.getElementById("mainShell");

const videoEl          = document.getElementById("video");
const canvasEl         = document.getElementById("canvas");
const camMsg           = document.getElementById("camMsg");
const emotionChip      = document.getElementById("emotionChip");
const attentionChip    = document.getElementById("attentionChip");
const statusLine       = document.getElementById("statusLine");
const tabCount         = document.getElementById("tabCount");
const blinkRateVal     = document.getElementById("blinkRateVal");

const timerEl          = document.getElementById("timer");
const statusTextEl     = document.getElementById("statusText");
const idleTextEl       = document.getElementById("idleText");
const startPauseBtn    = document.getElementById("startPauseBtn");
const resetBtn         = document.getElementById("resetBtn");
const workBtn          = document.getElementById("workBtn");
const breakBtn         = document.getElementById("breakBtn");
const workMinutesInput = document.getElementById("workMinutesInput");
const breakMinutesInput= document.getElementById("breakMinutesInput");

const mentalStateBox   = document.getElementById("mentalStateBox");
const mentalIcon       = document.getElementById("mentalIcon");
const mentalLabel      = document.getElementById("mentalLabel");

const adviceBox        = document.getElementById("adviceBox");
const predictionBox    = document.getElementById("predictionBox");
const aiRawResponseBox = document.getElementById("aiRawResponseBox");
const analyticsBox     = document.getElementById("analyticsBox");
const aiLogBox         = document.getElementById("aiLogBox");
const adviceLoading    = document.getElementById("adviceLoading");
const predLoading      = document.getElementById("predLoading");
const analyticsLoading = document.getElementById("analyticsLoading");

const ollamaBadge      = document.getElementById("ollamaBadge");
const badgeDot         = document.getElementById("badgeDot");
const badgeLabel       = document.getElementById("badgeLabel");
const settingsToggle   = document.getElementById("settingsToggle");
const settingsPanel    = document.getElementById("settingsPanel");
const ollamaHostInput  = document.getElementById("ollamaHost");
const ollamaPortInput  = document.getElementById("ollamaPort");
const ollamaModelInput = document.getElementById("ollamaModel");
const testOllamaBtn    = document.getElementById("testOllamaBtn");
const saveOllamaBtn    = document.getElementById("saveOllamaBtn");
const ollamaTestResult = document.getElementById("ollamaTestResult");

const toastContainer   = document.getElementById("toastContainer");

let canvasCtx = null; // set after camera starts

// ================================================================
// Ollama Config (loaded from chrome.storage or defaults)
// ================================================================
let OLLAMA = {
  baseUrl: "http://127.0.0.1:11434",
  model:   "gemma3:4b",
  timeout: 20000,
};

// ================================================================
// Central Student State
// ================================================================
let studentState = {
  emotion:     "neutral",
  attention:   "focused",
  mentalStatus:"focused",
};

let stateHistory    = [];
let adaptiveParams  = {
  distractedThreshold: 40,
  reminderInterval:    30000,
  reminderType:        "text",
  blinkRateNormalRange:[2, 8],
};

// ================================================================
// Attention Detection Variables
// ================================================================
let distractedFrames = 0;
let blinkTimes       = [];
let lastBlinkTime    = 0;
let lastGaze         = 0;
let lastAICallState  = { emotion: "", attention: "" };
let lastState        = { emotion: "", attention: "" };
let stateStableTimer = null;

// ================================================================
// Timer State (local mirror of background.js)
// ================================================================
let mode             = "work";
let workSeconds      = 25 * 60;
let breakSeconds     = 5 * 60;
let remainingSeconds = workSeconds;
let isRunning        = false;
let endTimestamp     = null;

// ================================================================
// Low-poly Mask Rendering Variables
// ================================================================
let meshTriangles = null;

// (palette definitions below replace the old single MASK_COLORS)

const LEFT_EYE_SET = new Set([
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  468, 469, 470, 471, 472
]);
const RIGHT_EYE_SET = new Set([
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
  473, 474, 475, 476, 477
]);

// ================================================================
// Helpers
// ================================================================
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMinutes(secs) {
  const m = secs / 60;
  return Number.isInteger(m) ? `${m}` : `${m.toFixed(1)}`;
}

function computeDisplaySeconds() {
  if (!isRunning || !endTimestamp) return remainingSeconds;
  return Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
}

// ================================================================
// Toast Notifications
// ================================================================
function showToast(text, type = "info", duration = 4000) {
  const t = document.createElement("div");
  t.classList.add("toast", type);
  t.textContent = text;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ================================================================
// Audio Beep
// ================================================================
function playBeep() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx  = new AC();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.value = 0.1;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
}

// ================================================================
// AI Log
// ================================================================
function logAIEvent(type, input, output) {
  const time = new Date().toLocaleTimeString();
  const ins  = typeof input  === "object" ? JSON.stringify(input).slice(0, 60)  : String(input);
  const outs = typeof output === "object" ? JSON.stringify(output).slice(0, 100) : String(output);
  const entry = `[${time}] ${type}\n  in: ${ins}…\n  out: ${outs}…\n---\n`;
  aiLogBox.innerHTML = entry + aiLogBox.innerHTML;
}

// ================================================================
// Ollama Badge
// ================================================================
function setOllamaBadge(online) {
  badgeDot.className = "badge-dot " + (online ? "online" : "offline");
  badgeLabel.textContent = online ? "Ollama ✓" : "Ollama ✗";
}

// ================================================================
// Ollama Core API Call — routed through background.js to bypass
// the chrome-extension:// origin block that Ollama returns 403 for.
// Background service workers use a different fetch origin that
// Ollama accepts when host_permissions are granted.
// ================================================================
async function callOllamaAPI(prompt) {
  try {
    const res = await sendMessage({
      type:   "OLLAMA_REQUEST",
      url:    `${OLLAMA.baseUrl}/api/generate`,
      model:  OLLAMA.model,
      prompt,
    });

    if (!res?.ok) {
      const errMsg = res?.error || "Unknown error";
      // If 403: show setup instruction
      if (errMsg.includes("403") || errMsg.includes("forbidden")) {
        aiRawResponseBox.textContent =
          "403 Forbidden — restart Ollama with:\n  OLLAMA_ORIGINS=* ollama serve";
      } else {
        aiRawResponseBox.textContent = `Error: ${errMsg}`;
      }
      setOllamaBadge(false);
      return getFallbackAdvice(studentState);
    }

    aiRawResponseBox.textContent = res.response;
    setOllamaBadge(true);
    return res.response;
  } catch (err) {
    aiRawResponseBox.textContent = `Error: ${err.message}`;
    setOllamaBadge(false);
    return getFallbackAdvice(studentState);
  }
}

// ================================================================
// Fallback when Ollama is offline
// ================================================================
function getFallbackAdvice(state) {
  const MAP = {
    angry_distracted:   "Take a deep breath — you seem tense.",
    sad_distracted:     "Don't give up! Rest for 1 minute then continue.",
    sad_focused:        "Try stretching — it helps with fatigue.",
    neutral_distracted: "Come on! Get back into focus mode.",
    happy_distracted:   "Great mood — channel it into focus!",
    neutral_focused:    "Stay focused, you're doing great!",
    happy_focused:      "Excellent! Keep up the momentum.",
  };
  return MAP[`${state.emotion}_${state.attention}`] || "Keep going!";
}

// ================================================================
// AI Function 1: Immediate Feedback (on state change)
// ================================================================
async function getImmediateFeedback() {
  adviceLoading.style.display = "inline";
  const prompt = `
You are a study focus AI assistant. Give a concise, friendly English tip (≤20 words).
Current state: emotion=${studentState.emotion}, attention=${studentState.attention}
Rules:
- Negative emotion (angry/sad/fearful/disgusted) + distracted → suggest relaxing
- sad + focused → suggest a 1-minute stretch
- neutral/happy/surprised + distracted → encourage refocusing
- neutral/happy + focused → brief praise
Return ONLY the tip text, nothing else.
`.trim();

  logAIEvent("Immediate Feedback", studentState, "requesting…");
  const advice = await callOllamaAPI(prompt);
  adviceLoading.style.display = "none";

  if (advice) {
    logAIEvent("Immediate Feedback", studentState, advice);
    const isWarning =
      studentState.attention === "distracted" &&
      ["angry","sad","fearful","disgusted"].includes(studentState.emotion);
    adviceBox.textContent = advice;
    adviceBox.style.color  = isWarning ? "#e36565" : "#4ecb71";
  }
}

// ================================================================
// AI Function 2: Update Adaptive Parameters (every 1 min)
// ================================================================
async function updateAdaptiveParameters() {
  const recent = stateHistory.slice(-50);
  if (recent.length < 5) return;

  const prompt = `
You are a learning-state AI optimizer. Update detection parameters based on history.
Return ONLY a JSON object, no other text.

History (last ${recent.length}): ${JSON.stringify(recent)}
Current params: ${JSON.stringify(adaptiveParams)}

Rules:
1. distracted > 60% → raise distractedThreshold (+10) or lower reminderInterval (-5000)
2. insensitive to reminders → escalate reminderType: text→voice→popup
3. blink rate > 8/10s avg → adjust blinkRateNormalRange upper bound
Return: {"distractedThreshold":N,"reminderInterval":N,"reminderType":"text","blinkRateNormalRange":[2,8]}
`.trim();

  logAIEvent("Adaptive Params", { len: recent.length }, "requesting…");
  const raw = await callOllamaAPI(prompt);

  try {
    const p = JSON.parse(raw);
    if (Number.isFinite(p.distractedThreshold))       adaptiveParams.distractedThreshold = p.distractedThreshold;
    if (Number.isFinite(p.reminderInterval))          adaptiveParams.reminderInterval    = p.reminderInterval;
    if (p.reminderType)                               adaptiveParams.reminderType        = p.reminderType;
    if (Array.isArray(p.blinkRateNormalRange))        adaptiveParams.blinkRateNormalRange= p.blinkRateNormalRange;
    logAIEvent("Adaptive Params", adaptiveParams, "updated");
    adviceBox.textContent = "🔧 Detection parameters optimised by AI.";
  } catch (_) {
    logAIEvent("Adaptive Params", "parse error", raw.slice(0, 100));
  }
}

// ================================================================
// AI Function 3: Predict Emotional Trend (every 30 s)
// ================================================================
async function predictEmotionalTrend() {
  predLoading.style.display = "inline";
  const recent = stateHistory.slice(-5).length
    ? stateHistory.slice(-5)
    : [{ ...studentState, timestamp: new Date().toISOString() }];

  const prompt = `
You are an emotion-prediction AI. Predict the user's state over the next 5 minutes.
Answer in ≤30 words in English. Be specific and actionable.
Current: ${JSON.stringify(studentState)}
Recent history: ${JSON.stringify(recent)}
Return ONLY the prediction text.
`.trim();

  const prediction = await callOllamaAPI(prompt);
  predLoading.style.display = "none";

  if (prediction) {
    predictionBox.textContent = prediction;
    logAIEvent("Prediction", studentState, prediction);
    if (/distract|fatigue|tired/i.test(prediction)) {
      distractedFrames = Math.max(0, distractedFrames - 10);
    }
  }
}

// ================================================================
// AI Function 4: Personalised Advice (every 2 min)
// ================================================================
async function generatePersonalizedAdvice() {
  const recent = stateHistory.slice(-10);
  if (recent.length < 3) return;

  analyticsLoading.style.display = "inline";

  const hourStats = recent.reduce((acc, item) => {
    const h = new Date(item.timestamp).getHours();
    acc[h] = acc[h] || { distracted: 0, total: 0 };
    acc[h].total++;
    if (item.attention === "distracted") acc[h].distracted++;
    return acc;
  }, {});

  const prompt = `
You are a personalised study coach. Give 3 practical tips separated by newlines (each ≤30 words).
Data: ${recent.length} records, distraction by hour: ${JSON.stringify(hourStats)}, primary issue: ${getMostFrequentEmotion()}
Focus on: time management, emotion regulation, attention improvement.
Return ONLY the 3 tips, newline-separated.
`.trim();

  const advice = await callOllamaAPI(prompt);
  analyticsLoading.style.display = "none";
  if (advice) {
    analyticsBox.textContent = `💡 Personalised tips:\n${advice}`;
    logAIEvent("Personalised Advice", {}, advice);
  }
}

// ================================================================
// AI Function 5: Data Analysis (every 3 min)
// ================================================================
async function analyzeDataOptimization() {
  if (stateHistory.length < 5) return;

  const distractedRate = (
    (stateHistory.filter(s => s.attention === "distracted").length / stateHistory.length) * 100
  ).toFixed(1);

  const prompt = `
You are a data analyst. Summarise the user's study session in ≤80 words.
Stats: ${stateHistory.length} records, distraction rate ${distractedRate}%, main negative emotion: ${getMostFrequentEmotion()}
Identify 1 key problem and give 1–2 concrete suggestions.
`.trim();

  const analysis = await callOllamaAPI(prompt);
  if (analysis) {
    analyticsBox.textContent += `\n\n📊 Analysis:\n${analysis}`;
    logAIEvent("Data Analysis", { distractedRate }, analysis);
  }
}

// ================================================================
// AI Function 6: AI-Driven Mental Status (on state change, deduped)
// ================================================================
async function generateAIDrivenMentalStatus() {
  const key     = `${studentState.emotion}_${studentState.attention}`;
  const lastKey = `${lastAICallState.emotion}_${lastAICallState.attention}`;
  if (key === lastKey) return;
  lastAICallState = { ...studentState };

  const prompt = `
Return ONLY one of these keywords (no other text):
lost_focus, struggling, fatigued, anxious, frustrated, focused, engaged

Input — emotion: ${studentState.emotion}, attention: ${studentState.attention}
`.trim();

  const result = await callOllamaAPI(prompt);
  const VALID  = new Set(["lost_focus","struggling","fatigued","anxious","frustrated","focused","engaged"]);
  studentState.mentalStatus = VALID.has(result) ? result : staticMentalStatus();
  updateMentalStateUI(studentState.mentalStatus);
}

function staticMentalStatus() {
  if (studentState.attention === "distracted") return "lost_focus";
  return ({ angry:"struggling", sad:"fatigued", fearful:"anxious",
            disgusted:"frustrated", neutral:"focused", happy:"engaged",
            surprised:"engaged" })[studentState.emotion] || "focused";
}

function getMostFrequentEmotion() {
  const neg = stateHistory.map(s => s.emotion).filter(e =>
    ["angry","sad","fearful","disgusted"].includes(e)
  );
  if (!neg.length) return "none";
  const counts = neg.reduce((a, e) => { a[e] = (a[e] || 0) + 1; return a; }, {});
  return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

// ================================================================
// Mental State UI
// ================================================================
const MENTAL_ICONS = {
  focused:"😊", engaged:"🤩", lost_focus:"😵",
  struggling:"😣", fatigued:"😴", anxious:"😰", frustrated:"😤",
};

function updateMentalStateUI(status) {
  mentalStateBox.className = "mental-state " + (status || "focused");
  mentalIcon.textContent   = MENTAL_ICONS[status] || "😊";
  mentalLabel.textContent  = (status || "focused").replace("_", " ");
}

// ================================================================
// Low-poly Mask: Triangle Extraction from FACEMESH_TESSELATION
// ================================================================
function extractTriangles(connections) {
  const adj = new Map();
  for (const [a, b] of connections) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  }
  const triangles = [];
  const seen      = new Set();
  for (const [a, b] of connections) {
    const nA = adj.get(a), nB = adj.get(b);
    if (!nA || !nB) continue;
    for (const c of nA) {
      if (c !== b && nB.has(c)) {
        const tri = [a, b, c].sort((x, y) => x - y);
        const key = (tri[0] << 20) | (tri[1] << 10) | tri[2];
        if (!seen.has(key)) { seen.add(key); triangles.push(tri); }
      }
    }
  }
  return triangles;
}

function getTriangleColor(landmarks, tri) {
  return getTriangleColorFromPalette(landmarks, tri, activePalette());
}

function getTriangleColorFromPalette(landmarks, tri, palette) {
  const a = landmarks[tri[0]], b = landmarks[tri[1]], c = landmarks[tri[2]];
  if (!a || !b || !c) return null;
  const abx = b.x-a.x, aby = b.y-a.y, abz = (b.z||0)-(a.z||0);
  const acx = c.x-a.x, acy = c.y-a.y, acz = (c.z||0)-(a.z||0);
  const nx  = aby*acz - abz*acy;
  const ny  = abz*acx - abx*acz;
  const nz  = abx*acy - aby*acx;
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  let dot   = (nx/len)*(-0.3) + (ny/len)*(-0.5) + (nz/len)*(0.8);
  dot = Math.abs(dot);
  const C = dot > 0.75 ? palette.lightest
          : dot > 0.55 ? palette.bright
          : dot > 0.35 ? palette.mid
          : dot > 0.15 ? palette.dark
          :               palette.darkest;
  return `rgb(${C[0]},${C[1]},${C[2]})`;
}

function isEyeTriangle(tri) {
  return tri.every(v => LEFT_EYE_SET.has(v)) || tri.every(v => RIGHT_EYE_SET.has(v));
}

// ================================================================
// Mask color palette — shifts based on mental status
// ================================================================
const PALETTE_FOCUSED = {
  darkest:  [140, 65,  10],
  dark:     [193, 89,  15],
  mid:      [227, 119, 31],
  bright:   [241, 163, 59],
  lightest: [246, 194, 96],
};
const PALETTE_DISTRACTED = {   // red-orange shift
  darkest:  [120, 20,  10],
  dark:     [180, 35,  20],
  mid:      [220, 60,  40],
  bright:   [240, 90,  60],
  lightest: [255, 130, 100],
};
const PALETTE_CALM = {         // cool blue-silver for engaged/focused+happy
  darkest:  [20,  60,  110],
  dark:     [30,  90,  160],
  mid:      [50,  130, 200],
  bright:   [80,  170, 230],
  lightest: [140, 210, 255],
};

function activePalette() {
  const s = studentState.mentalStatus;
  if (s === "lost_focus" || s === "struggling" || s === "frustrated") return PALETTE_DISTRACTED;
  if (s === "engaged") return PALETTE_CALM;
  return PALETTE_FOCUSED;
}

// ================================================================
// FaceMesh Setup
// ================================================================
function setupFaceMesh() {
  // Sync canvas pixel dimensions to camera resolution
  canvasEl.width  = 480;
  canvasEl.height = 360;

  // Use extension-local files — CDN scripts are blocked by MV3 CSP
  const faceMesh = new FaceMesh({
    locateFile: f => chrome.runtime.getURL(`lib/${f}`)
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  faceMesh.onResults(results => {
    if (!canvasCtx) return;
    const W = canvasEl.width, H = canvasEl.height;
    canvasCtx.clearRect(0, 0, W, H);

    // Mirror transform (matches the CSS scaleX(-1) on video)
    canvasCtx.save();
    canvasCtx.translate(W, 0);
    canvasCtx.scale(-1, 1);

    // Draw raw video frame behind mask
    canvasCtx.drawImage(results.image, 0, 0, W, H);

    let attentionScore = 0;

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      const lm = results.multiFaceLandmarks[0];
      attentionScore++;

      // Extract triangles once from the global FACEMESH_TESSELATION
      if (!meshTriangles) {
        const tess = (typeof FACEMESH_TESSELATION !== "undefined")
          ? FACEMESH_TESSELATION
          : window.FACEMESH_TESSELATION;
        if (tess) meshTriangles = extractTriangles(tess);
      }

      const palette = activePalette();

      // ── Draw filled low-poly triangles ──
      if (meshTriangles) {
        for (const tri of meshTriangles) {
          if (isEyeTriangle(tri)) continue;
          const a = lm[tri[0]], b = lm[tri[1]], c = lm[tri[2]];
          if (!a || !b || !c) continue;
          const color = getTriangleColorFromPalette(lm, tri, palette);
          if (!color) continue;
          canvasCtx.beginPath();
          canvasCtx.moveTo(a.x * W, a.y * H);
          canvasCtx.lineTo(b.x * W, b.y * H);
          canvasCtx.lineTo(c.x * W, c.y * H);
          canvasCtx.closePath();
          canvasCtx.fillStyle   = color;
          canvasCtx.fill();
          canvasCtx.strokeStyle = "rgba(0,0,0,0.15)";
          canvasCtx.lineWidth   = 0.4;
          canvasCtx.stroke();
        }
      }

      // ── Face oval glow outline ──
      const ovalConn = (typeof FACEMESH_FACE_OVAL !== "undefined")
        ? FACEMESH_FACE_OVAL : window.FACEMESH_FACE_OVAL;
      if (ovalConn) {
        const glowColor = studentState.attention === "distracted"
          ? "rgba(255,60,60,0.85)"
          : studentState.mentalStatus === "engaged"
          ? "rgba(80,180,255,0.85)"
          : "rgba(255,160,50,0.75)";
        canvasCtx.save();
        canvasCtx.strokeStyle = glowColor;
        canvasCtx.lineWidth   = 2.5;
        canvasCtx.shadowColor = glowColor;
        canvasCtx.shadowBlur  = 18;
        canvasCtx.beginPath();
        let first = true;
        for (const [i] of ovalConn) {
          const p = lm[i];
          if (!p) continue;
          first ? canvasCtx.moveTo(p.x * W, p.y * H)
                : canvasCtx.lineTo(p.x * W, p.y * H);
          first = false;
        }
        canvasCtx.closePath();
        canvasCtx.stroke();
        canvasCtx.restore();
      }

      // ── Eye outlines ──
      const LEFT_EYE_CONTOUR  = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246,33];
      const RIGHT_EYE_CONTOUR = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398,362];
      canvasCtx.save();
      canvasCtx.strokeStyle = "#f8f0e0";
      canvasCtx.lineWidth   = 1.8;
      canvasCtx.shadowColor = "rgba(255,220,120,0.7)";
      canvasCtx.shadowBlur  = 8;
      for (const contour of [LEFT_EYE_CONTOUR, RIGHT_EYE_CONTOUR]) {
        canvasCtx.beginPath();
        contour.forEach((idx, i) => {
          const p = lm[idx];
          if (!p) return;
          i === 0 ? canvasCtx.moveTo(p.x * W, p.y * H)
                  : canvasCtx.lineTo(p.x * W, p.y * H);
        });
        canvasCtx.stroke();
      }
      canvasCtx.restore();

      // ── Lip outline ──
      const lipsConn = (typeof FACEMESH_LIPS !== "undefined")
        ? FACEMESH_LIPS : window.FACEMESH_LIPS;
      if (lipsConn) {
        canvasCtx.save();
        canvasCtx.strokeStyle = "rgba(255,100,80,0.9)";
        canvasCtx.lineWidth   = 1.5;
        canvasCtx.shadowColor = "rgba(255,80,60,0.6)";
        canvasCtx.shadowBlur  = 6;
        for (const [i, j] of lipsConn) {
          const p1 = lm[i], p2 = lm[j];
          if (!p1 || !p2) continue;
          canvasCtx.beginPath();
          canvasCtx.moveTo(p1.x * W, p1.y * H);
          canvasCtx.lineTo(p2.x * W, p2.y * H);
          canvasCtx.stroke();
        }
        canvasCtx.restore();
      }

      // ── Attention logic ──
      const gaze    = (lm[33].x + lm[263].x) / 2;
      if (gaze > 0.35 && gaze < 0.65) attentionScore++;
      const gazeMove = Math.abs(gaze - lastGaze);
      lastGaze = gaze;
      if (gazeMove > 0.1) distractedFrames++;

      const EAR = (distance(lm[159], lm[145]) + distance(lm[386], lm[374])) / 2;
      const now = Date.now();
      if (EAR < 0.018 && now - lastBlinkTime > 300) {
        blinkTimes.push(now);
        lastBlinkTime = now;
      }
      blinkTimes = blinkTimes.filter(t => now - t < 10000);
      const br = blinkTimes.length;
      blinkRateVal.textContent = `${br}/10s`;
      const [bMin, bMax] = adaptiveParams.blinkRateNormalRange;
      if (br >= bMin && br <= bMax) attentionScore++;

    } else {
      // No face detected
      distractedFrames += 5;
    }

    canvasCtx.restore(); // end mirror transform

    // Update distracted counter
    if (attentionScore < 2) distractedFrames++;
    else distractedFrames = Math.max(0, distractedFrames - 1);

    // ── Distraction warning text overlay ──
    if (distractedFrames > adaptiveParams.distractedThreshold) {
      studentState.attention = "distracted";
      canvasCtx.save();
      canvasCtx.font        = "bold 15px -apple-system, sans-serif";
      canvasCtx.fillStyle   = "#ff5555";
      canvasCtx.shadowColor = "#ff0000";
      canvasCtx.shadowBlur  = 16;
      canvasCtx.fillText("⚠ Attention drifting!", 12, 26);
      canvasCtx.restore();
    } else {
      studentState.attention = "focused";
    }

    // ── Update status chips ──
    const EMOTION_ICONS = {
      happy:"😄", sad:"😢", angry:"😠", fearful:"😨",
      disgusted:"🤢", surprised:"😲", neutral:"😐",
    };
    emotionChip.textContent   = `${EMOTION_ICONS[studentState.emotion] || "😐"} ${studentState.emotion}`;
    attentionChip.textContent = studentState.attention === "focused" ? "👁 focused" : "🔴 distracted";
    attentionChip.className   = `chip attn-chip ${studentState.attention}`;

    updateMentalStatusAndNotify();
  });

  return faceMesh;
}

// ================================================================
// Update Mental Status & Send to Background
// ================================================================
function updateMentalStatusAndNotify() {
  // Push to history
  stateHistory.push({ ...studentState, timestamp: new Date().toISOString() });
  if (stateHistory.length > 100) stateHistory = stateHistory.slice(-100);

  // AI-driven mental status (deduped)
  generateAIDrivenMentalStatus();

  // Trigger immediate feedback on state change
  const key     = `${studentState.emotion}_${studentState.attention}`;
  const lastKey = `${lastState.emotion}_${lastState.attention}`;
  if (key !== lastKey) {
    lastState = { ...studentState };
    clearTimeout(stateStableTimer);
    stateStableTimer = setTimeout(getImmediateFeedback, 1000);
  }

  // Notify background
  sendMessage({ type: "EMOTION_UPDATE", emotion: studentState.emotion, attention: studentState.attention });

  // Focus reminder during work mode
  checkFocusReminder();
}

// ================================================================
// Focus Reminder in Popup
// ================================================================
let lastReminderTime = 0;

const WARN_MESSAGES = {
  lost_focus:  "⚠️ Your attention is drifting — look at the screen.",
  struggling:  "😟 You seem frustrated. Take a deep breath.",
  fatigued:    "😴 Feeling tired? Short break coming up?",
  anxious:     "😰 You seem anxious. Relax, you've got this!",
  frustrated:  "😤 Feeling stuck? Step back and rethink.",
};
const ENCOURAGE = [
  "💪 You can do it! Stay focused!",
  "🌟 Keep going — you're doing great!",
  "🎯 One step at a time. You've got this!",
  "🔥 Keep pushing — almost there!",
  "📚 Deep breath, then refocus.",
];

function checkFocusReminder() {
  const now = Date.now();
  if (now - lastReminderTime < adaptiveParams.reminderInterval) return;
  if (mode !== "work" || !isRunning) return;
  const { mentalStatus, attention } = studentState;
  if (attention !== "distracted" && !WARN_MESSAGES[mentalStatus]) return;

  lastReminderTime = now;
  const warnText   = WARN_MESSAGES[mentalStatus] || WARN_MESSAGES.lost_focus;
  showToast(warnText, "warning", 5000);
  setTimeout(() => {
    showToast(ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)], "encourage", 4000);
  }, 2000);
  playBeep();
}

// ================================================================
// face-api.js Model Loading — with per-step status + toast feedback
// ================================================================
const MODEL_STEPS = [
  {
    key:   "tinyFaceDetector",
    label: "Tiny Face Detector",
    net:   () => faceapi.nets.tinyFaceDetector,
    stepEl:  () => document.getElementById("stepDetector"),
    iconEl:  () => document.getElementById("iconDetector"),
  },
  {
    key:   "faceExpressionNet",
    label: "Face Expression Net",
    net:   () => faceapi.nets.faceExpressionNet,
    stepEl:  () => document.getElementById("stepExpression"),
    iconEl:  () => document.getElementById("iconExpression"),
  },
];



async function detectEmotion() {
  if (!videoEl || videoEl.paused) return;
  try {
    const det = await faceapi
      .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceExpressions();
    if (det?.expressions) {
      studentState.emotion = Object.keys(det.expressions)
        .reduce((a, b) => det.expressions[a] > det.expressions[b] ? a : b);
    } else {
      studentState.emotion = "neutral";
    }
  } catch (_) {
    studentState.emotion = "neutral";
  }
}

// ================================================================
// Timer UI
// ================================================================
function updateTimerUI() {
  const secs = computeDisplaySeconds();
  timerEl.textContent      = formatTime(secs);
  const modeText           = mode === "work" ? "Focus" : "Break";
  statusTextEl.textContent = `Mode: ${modeText}`;
  workBtn.classList.toggle("active", mode === "work");
  breakBtn.classList.toggle("active", mode === "break");
  workBtn.textContent      = `Focus ${formatMinutes(workSeconds)} min`;
  breakBtn.textContent     = `Break ${formatMinutes(breakSeconds)} min`;
  startPauseBtn.textContent= isRunning ? "Pause" : "Start";
  document.title           = `${timerEl.textContent} — ${modeText}`;
}

function applyTimerState(state) {
  if (!state) return;
  mode             = state.mode === "break" ? "break" : "work";
  workSeconds      = Number.isFinite(state.workSeconds)      ? Math.max(1, state.workSeconds)      : 25*60;
  breakSeconds     = Number.isFinite(state.breakSeconds)     ? Math.max(1, state.breakSeconds)     : 5*60;
  remainingSeconds = Number.isFinite(state.remainingSeconds) ? Math.max(0, state.remainingSeconds) : workSeconds;
  isRunning        = Boolean(state.isRunning);
  endTimestamp     = isRunning && Number.isFinite(state.endTimestamp) ? state.endTimestamp : null;

  workMinutesInput.value  = (workSeconds  / 60).toString();
  breakMinutesInput.value = (breakSeconds / 60).toString();

  if (state.idleState === "idle" && state.idleSince) {
    const s = Math.floor((Date.now() - state.idleSince) / 1000);
    idleTextEl.textContent = s >= 1 ? `Idle: ${s}s` : "Active";
  } else {
    idleTextEl.textContent = "Active";
  }

  updateTimerUI();
}

// ================================================================
// Background Messaging
// ================================================================
function sendMessage(msg) {
  return new Promise(resolve => {
    if (!chrome?.runtime?.sendMessage) { resolve({ ok: false }); return; }
    chrome.runtime.sendMessage(msg, res => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false });
    });
  });
}
// ================================================================
// Popup Video Mirror (Visual only, AI runs in background)
// ================================================================
async function startPopupMirror() {
  try {
    // Request the camera just for the popup UI
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { width: 640, height: 480 } 
    });
    
    if (videoEl) {
      videoEl.srcObject = stream;
      // Mirror the video so it feels natural
      videoEl.style.transform = "scaleX(-1)"; 
      await videoEl.play();
    }
    
    // Hide the "initializing" text
    if (camMsg) camMsg.style.display = "none"; 
    
  } catch (err) {
    console.error("Popup camera error:", err);
    // If it fails (sometimes Chrome restricts dual-camera access), gracefully fallback
    if (camMsg) camMsg.textContent = "👁️ AI Vision running in background";
  }
}
async function refreshTimerState() {
  const res = await sendMessage({ type: "GET_STATE" });
  if (res?.ok && res.state) {
    applyTimerState(res.state); // Updates the timer logic

    // Sync the AI vision data from the background!
    if (res.studentState) {
      studentState = res.studentState;

      // Push to history so the Ollama Analytics have data to read
      stateHistory.push({ ...studentState, timestamp: new Date().toISOString() });
      if (stateHistory.length > 100) stateHistory = stateHistory.slice(-100);

      // Update the UI Chips visually
      const EMOTION_ICONS = { happy:"😄", sad:"😢", angry:"😠", fearful:"😨", disgusted:"🤢", surprised:"😲", neutral:"😐" };
      emotionChip.textContent = `${EMOTION_ICONS[studentState.emotion] || "😐"} ${studentState.emotion}`;
      attentionChip.textContent = studentState.attention === "focused" ? "👁 focused" : "🔴 distracted";
      attentionChip.className = `chip attn-chip ${studentState.attention}`;
      updateMentalStateUI(studentState.mentalStatus);
      tabCount.textContent = studentState.tabSwitchCount || 0;
    }
  }
}

// ================================================================
// Timer Control Handlers
// ================================================================
startPauseBtn.addEventListener("click", async () => {
  const r = await sendMessage({ type: "TOGGLE_START_PAUSE" });
  if (r?.ok && r.state) applyTimerState(r.state);
});
resetBtn.addEventListener("click", async () => {
  const r = await sendMessage({ type: "RESET" });
  if (r?.ok && r.state) applyTimerState(r.state);
});
workBtn.addEventListener("click", async () => {
  const r = await sendMessage({ type: "SET_MODE", mode: "work" });
  if (r?.ok && r.state) applyTimerState(r.state);
});
breakBtn.addEventListener("click", async () => {
  const r = await sendMessage({ type: "SET_MODE", mode: "break" });
  if (r?.ok && r.state) applyTimerState(r.state);
});

workMinutesInput.addEventListener("change", async () => {
  const v = parseFloat(workMinutesInput.value);
  if (!Number.isFinite(v) || v <= 0) { workMinutesInput.value = (workSeconds/60).toString(); return; }
  const r = await sendMessage({ type: "SET_DURATIONS", workMinutes: v, breakMinutes: breakSeconds/60 });
  if (r?.ok && r.state) applyTimerState(r.state);
  else workMinutesInput.value = (workSeconds/60).toString();
});

breakMinutesInput.addEventListener("change", async () => {
  const v = parseFloat(breakMinutesInput.value);
  if (!Number.isFinite(v) || v <= 0) { breakMinutesInput.value = (breakSeconds/60).toString(); return; }
  const r = await sendMessage({ type: "SET_DURATIONS", workMinutes: workSeconds/60, breakMinutes: v });
  if (r?.ok && r.state) applyTimerState(r.state);
  else breakMinutesInput.value = (breakSeconds/60).toString();
});

// ================================================================
// Ollama Settings Panel
// ================================================================
settingsToggle.addEventListener("click", () => {
  settingsPanel.style.display = settingsPanel.style.display === "none" ? "block" : "none";
});

testOllamaBtn.addEventListener("click", async () => {
  const host  = ollamaHostInput.value.trim();
  const port  = ollamaPortInput.value.trim();
  const model = ollamaModelInput.value.trim();
  ollamaTestResult.textContent = "Testing…";
  const res = await sendMessage({
    type:   "OLLAMA_REQUEST",
    url:    `http://${host}:${port}/api/generate`,
    model,
    prompt: "Say: ok",
  });
  if (res?.ok) {
    ollamaTestResult.textContent = "✅ Connected successfully!";
    setOllamaBadge(true);
  } else {
    const msg = res?.error || "No response";
    ollamaTestResult.textContent = msg.includes("403")
      ? "❌ 403 — restart Ollama with: OLLAMA_ORIGINS=* ollama serve"
      : `❌ ${msg}`;
    setOllamaBadge(false);
  }
});

saveOllamaBtn.addEventListener("click", () => {
  OLLAMA.baseUrl = `http://${ollamaHostInput.value.trim()}:${ollamaPortInput.value.trim()}`;
  OLLAMA.model   = ollamaModelInput.value.trim();
  chrome.storage.local.set({ ollamaConfig: OLLAMA });
  ollamaTestResult.textContent = "Saved!";
});

// ================================================================
// Background Message Listener
// ================================================================
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "TIMER_COMPLETED") {
    playBeep();
    showToast(
      msg.finishedMode === "work" ? "🍅 Focus session done! Take a break." : "☕ Break over — back to focus!",
      "info", 5000
    );
    void refreshTimerState();
  }
  if (msg?.type === "PLAY_BEEP_POPUP") playBeep();
  if (msg?.type === "FOCUS_REMINDER") {
    showToast(WARN_MESSAGES[msg.mentalStatus] || WARN_MESSAGES.lost_focus, "warning", 5000);
    setTimeout(() => showToast(ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)], "encourage", 4000), 2000);
    playBeep();
  }
});

// ================================================================
// Main Launch (triggered by Start button only)
// ================================================================


// ================================================================
// Launch Button
// ================================================================
// ================================================================
// Launch Button (Wired to Background)
// ================================================================
// ================================================================
// Launch Button (Wired to Background + Heartbeat)
// ================================================================
launchBtn.addEventListener("click", async () => {
  console.log("Start button clicked. Asking for camera permission first...");
  
  // 1. Swap the UI
  if (startScreen) startScreen.style.display = "none";
  if (mainShell) mainShell.style.display = "block";

  // 2. GET CAMERA PERMISSION FIRST (This ensures the AI won't crash!)
  await startPopupMirror(); 

  // 3. NOW wake up the AI vision offscreen
  await sendMessage({ type: "START_SESSION" });

  // 4. FORCE the Pomodoro timer to actually start
  const stateRes = await sendMessage({ type: "GET_STATE" });
  if (stateRes?.state && !stateRes.state.isRunning) {
     await sendMessage({ type: "TOGGLE_START_PAUSE" });
  }

  // 5. Start the UI Heartbeat loops
  setInterval(() => { updateTimerUI(); }, 1000);
  setInterval(refreshTimerState, 2000);
  setInterval(predictEmotionalTrend, 30000);       
  setInterval(generatePersonalizedAdvice, 120000); 
  setInterval(analyzeDataOptimization, 180000);    

  predictEmotionalTrend();
});
