const distractingSites = [
  "youtube.com",
  "tiktok.com",
  "facebook.com",
  "instagram.com"
];

const currentSite = window.location.hostname;

for (let site of distractingSites) {

  if (currentSite.includes(site)) {

    showReminder();

  }

}

function showReminder() {

  const reminder = document.createElement("div");

  reminder.innerText = "⚠️ Focus Reminder: Stay focused!";

  reminder.style.position = "fixed";
  reminder.style.top = "20px";
  reminder.style.right = "20px";
  reminder.style.background = "yellow";
  reminder.style.padding = "15px";
  reminder.style.fontSize = "16px";
  reminder.style.borderRadius = "8px";
  reminder.style.zIndex = "9999";

  document.body.appendChild(reminder);

}