// ================================================================
// AI Study Mentor — Content Script (Page Sensor)
//
// Injected into every web page. Responsibilities:
//   1. Block distracting sites with a visual banner
//   2. Detect tab visibility changes (tab switching)
//   3. Detect mouse idle on the page
// ================================================================

// ── Distracting Site Blocklist ──
const DISTRACTING_SITES = [
  "youtube.com",
  "tiktok.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "reddit.com",
];

const currentSite = window.location.hostname;

for (const site of DISTRACTING_SITES) {
  if (currentSite.includes(site)) {
    showDistractingBanner();
    break;
  }
}

function showDistractingBanner() {
  const banner = document.createElement("div");
  banner.textContent = "Focus Reminder: You're on a distracting site! Get back to work!";
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    background: linear-gradient(90deg, #d8572a, #b8441d);
    color: white;
    text-align: center;
    padding: 12px 20px;
    font-size: 15px;
    font-weight: 600;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 2px 12px rgba(0,0,0,0.3);
    letter-spacing: 0.02em;
  `;
  document.body.appendChild(banner);
}

// ── Visibility Change → Tab Switch Detection ──
document.addEventListener("visibilitychange", () => {
  try {
    chrome.runtime.sendMessage(
      {
        type: "VISIBILITY_CHANGE",
        hidden: document.hidden,
        url: window.location.href,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (_) {
    // Extension context may be invalidated
  }
});

// ── Mouse Idle Detection (60 seconds on page) ──
let lastMouseMove = Date.now();

document.addEventListener(
  "mousemove",
  () => {
    lastMouseMove = Date.now();
  },
  { passive: true }
);

document.addEventListener(
  "keydown",
  () => {
    lastMouseMove = Date.now();
  },
  { passive: true }
);

setInterval(() => {
  const idleSeconds = Math.floor((Date.now() - lastMouseMove) / 1000);
  if (idleSeconds >= 60) {
    try {
      chrome.runtime.sendMessage(
        { type: "USER_IDLE", idleSeconds },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch (_) {
      // Extension context may be invalidated
    }
    // Reset so we don't spam
    lastMouseMove = Date.now();
  }
}, 10000);
