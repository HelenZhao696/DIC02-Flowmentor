// ================================================================
// AI Study Mentor — Emotion Detection Engine (runs in offscreen document)
//
// This file runs inside offscreen.html, which HAS DOM access and
// can use getUserMedia. It sends emotion/attention updates to
// background.js via chrome.runtime.sendMessage.
// ================================================================

const videoElement = document.getElementById("video");
const canvasElement = document.getElementById("canvas");
const canvasCtx = canvasElement.getContext("2d");

// ===============================
// Attention Detection State
// ===============================
let distractedFrames = 0;
let blinkTimes = [];
let lastBlinkTime = 0;
let lastGaze = 0;
let currentAttention = "focused";
let currentEmotion = "neutral";

// ===============================
// Utility
// ===============================
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function playBeep() {
  const AudioContextClass =
    globalThis.AudioContext || globalThis.webkitAudioContext;
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

// ===============================
// face-api.js — Emotion Detection
// ===============================
async function loadEmotionModel() {
  try {
    // FIX: Generate the absolute path to the extension's models folder
    // Change this:
    // const MODEL_URL = chrome.runtime.getURL('models');

    // To exactly this (notice the leading slash!):
    const MODEL_URL = '/models'; 

    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
    console.log("[Offscreen] Emotion models loaded.");
    return true;
  } catch (e) {
    console.error("[Offscreen] Model load error:", e);
    return false;
  }
}

async function detectEmotion() {
  // 1. Prevent face-api from crashing if the camera isn't fully awake yet
  if (!videoElement || videoElement.readyState < 2) return;

  try {
    // 2. Use the optimized options that used to work in your popup
    const detection = await faceapi
      .detectSingleFace(
        videoElement, 
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      )
      .withFaceExpressions();

    if (!detection) {
      currentEmotion = "neutral";
      return;
    }

    const expressions = detection.expressions;
    currentEmotion = Object.keys(expressions).reduce((a, b) =>
      expressions[a] > expressions[b] ? a : b
    );
  } catch (e) {
    console.error("[Offscreen] Emotion detection error:", e);
  }
}

// ===============================
// MediaPipe FaceMesh — Attention Detection
// ===============================
const faceMesh = new FaceMesh({
  locateFile: (file) => {
    // FIX: Use a root-relative path with a leading slash
    return `/lib/${file}`; 
  }
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,
});

faceMesh.onResults((results) => {
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  let attentionScore = 0;

  if (results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];
    attentionScore++;

    // Gaze detection
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const gaze = (leftEye.x + rightEye.x) / 2;
    if (gaze > 0.35 && gaze < 0.65) attentionScore++;

    // Gaze movement
    const gazeMovement = Math.abs(gaze - lastGaze);
    lastGaze = gaze;
    if (gazeMovement > 0.1) distractedFrames++;

    // Blink detection (EAR)
    const leftTop = landmarks[159];
    const leftBottom = landmarks[145];
    const rightTop = landmarks[386];
    const rightBottom = landmarks[374];
    const EAR =
      (distance(leftTop, leftBottom) + distance(rightTop, rightBottom)) / 2;

    const blink = EAR < 0.018;
    const now = Date.now();
    if (blink && now - lastBlinkTime > 300) {
      blinkTimes.push(now);
      lastBlinkTime = now;
    }

    // 10-second blink window
    blinkTimes = blinkTimes.filter((t) => now - t < 10000);
    const blinkRate = blinkTimes.length;
    if (blinkRate >= 2 && blinkRate <= 8) attentionScore++;
  } else {
    distractedFrames += 5;
  }

  // Update distracted frames
  if (attentionScore < 2) {
    distractedFrames++;
  } else {
    distractedFrames = Math.max(0, distractedFrames - 1);
  }

  // Determine attention
  if (distractedFrames > 40) {
    currentAttention = "distracted";
  } else {
    currentAttention = "focused";
  }
});

// ===============================
// Send updates to background.js
// ===============================
function sendUpdate() {
  try {
    chrome.runtime.sendMessage(
      {
        type: "EMOTION_UPDATE",
        emotion: currentEmotion,
        attention: currentAttention,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (_) {
    // Background may not be ready yet
  }
}

// ===============================
// Listen for messages from background
// ===============================
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PLAY_BEEP_OFFSCREEN") {
    playBeep();
  }
  if (message?.type === "START_EMOTION_DETECTION") {
    // Already started if init ran — this is a re-trigger
    console.log("[Offscreen] Received START_EMOTION_DETECTION.");
  }
});

// ===============================
// Initialization
// ===============================
// ===============================
// Initialization
// ===============================
async function init() {
  console.log("[Offscreen] Initializing emotion engine...");

  const modelsLoaded = await loadEmotionModel();
  if (!modelsLoaded) {
    console.error("[Offscreen] Models failed to load. Aborting.");
    return;
  }

  // FIX: Force FaceMesh to fully compile its WebAssembly before moving forward
  console.log("[Offscreen] Waking up FaceMesh WASM...");
  await faceMesh.initialize();
  console.log("[Offscreen] FaceMesh initialized successfully!");

  // Start camera
  try {
    const camera = new Camera(videoElement, {
      onFrame: async () => {
        await faceMesh.send({ image: videoElement });
      },
      width: 640,
      height: 480,
    });
    await camera.start();
    console.log("[Offscreen] Camera started.");
  } catch (e) {
    console.error("[Offscreen] Camera start error:", e);
    return;
  }

  // Emotion detection loop (every 2 seconds)
  setInterval(detectEmotion, 2000);

  // Send state updates to background (every 1 second)
  setInterval(sendUpdate, 1000);

  console.log("[Offscreen] Emotion engine running.");
}

init();
