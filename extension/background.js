// background.js — мінімальний Manifest V3 service worker.
// Жодної додаткової логіки: тільки базове логування запуску розширення.

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Video Runner] Extension installed/updated. Reason: ${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Video Runner] Browser startup: service worker active.");
});
