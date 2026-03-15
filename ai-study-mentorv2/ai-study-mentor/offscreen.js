// offscreen.js — Audio-only offscreen document for AI Study Mentor
// Camera and detection run in popup.js. This document only plays beeps.

function playBeep() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
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

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "PLAY_BEEP_OFFSCREEN") playBeep();
});
