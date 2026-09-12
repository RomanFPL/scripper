chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Video Runner] Extension installed/updated. Reason: ${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Video Runner] Browser startup: service worker active.");
});

const MAX_LOG_ENTRIES = 300;

async function persistProgress(message) {
  const stored = await chrome.storage.local.get("progressLog");
  const log = Array.isArray(stored.progressLog) ? stored.progressLog : [];

  log.push({ ...message, ts: Date.now() });

  if (log.length > MAX_LOG_ENTRIES) {
    log.splice(0, log.length - MAX_LOG_ENTRIES);
  }

  await chrome.storage.local.set({ progressLog: log });
}

function broadcast(message) {
  persistProgress(message);
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function setPipelineState(partial) {
  const stored = await chrome.storage.local.get("pipelineState");
  const current = stored.pipelineState || { running: false, paused: false };
  await chrome.storage.local.set({ pipelineState: { ...current, ...partial } });
}

async function sendToContentScript(tabId, scenario) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "RUN_SCENARIO",
      scenario,
    });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    return await chrome.tabs.sendMessage(tabId, {
      type: "RUN_SCENARIO",
      scenario,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const tab = await chrome.tabs.get(tabId);

  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve) => {
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    }

    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const pipelineControl = { paused: false, stopped: false, currentTabId: null };

function waitWhilePaused() {
  return new Promise((resolve) => {
    function check() {
      if (!pipelineControl.paused || pipelineControl.stopped) {
        resolve();
        return;
      }
      setTimeout(check, 300);
    }
    check();
  });
}

async function downloadOneVideo(video, index, total) {
  broadcast({
    type: "PIPELINE_STATUS",
    stage: "opening",
    index,
    total,
    title: video.title,
    url: video.url,
  });

  let newTab;

  try {
    newTab = await chrome.tabs.create({ url: video.url, active: false });
    pipelineControl.currentTabId = newTab.id;
    await waitForTabComplete(newTab.id);

    broadcast({
      type: "PIPELINE_STATUS",
      stage: "downloading",
      index,
      total,
      title: video.title,
    });

    const downloadScenario = {
      name: "Download HLS (pipeline)",
      steps: [
        { action: "downloadHLS", title: video.title, saveAs: "download" },
      ],
    };

    const downloadResponse = await sendToContentScript(
      newTab.id,
      downloadScenario
    );

    if (!downloadResponse || !downloadResponse.success) {
      throw new Error(
        (downloadResponse && downloadResponse.error) || "Download failed."
      );
    }

    broadcast({
      type: "PIPELINE_STATUS",
      stage: "video-done",
      index,
      total,
      title: video.title,
      result: downloadResponse.variables.download,
    });

    return { title: video.title, url: video.url, success: true };
  } catch (error) {
    broadcast({
      type: "PIPELINE_STATUS",
      stage: "video-error",
      index,
      total,
      title: video.title,
      error: error.message,
    });

    return { title: video.title, url: video.url, success: false, error: error.message };
  } finally {
    pipelineControl.currentTabId = null;
    if (newTab) {
      await chrome.tabs.remove(newTab.id).catch(() => {});
    }
  }
}

async function runPipelineAllVideos(listTabId, listScenario) {
  pipelineControl.paused = false;
  pipelineControl.stopped = false;
  pipelineControl.currentTabId = null;

  await chrome.storage.local.set({ progressLog: [] });
  await setPipelineState({ running: true, paused: false });
  broadcast({ type: "PIPELINE_STATUS", stage: "collecting" });

  const listResponse = await sendToContentScript(listTabId, listScenario);

  if (!listResponse || !listResponse.success) {
    throw new Error(
      (listResponse && listResponse.error) || "Failed to collect links."
    );
  }

  const videos = listResponse.variables.videos;

  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error("variables.videos is empty — nothing to download.");
  }

  broadcast({ type: "PIPELINE_STATUS", stage: "collected", total: videos.length });

  const results = [];
  let stoppedEarly = false;

  for (let i = 0; i < videos.length; i++) {
    if (pipelineControl.stopped) {
      stoppedEarly = true;
      break;
    }

    await waitWhilePaused();

    if (pipelineControl.stopped) {
      stoppedEarly = true;
      break;
    }

    const result = await downloadOneVideo(videos[i], i + 1, videos.length);
    results.push(result);

    if (i < videos.length - 1) {
      await sleep(1000);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  await setPipelineState({ running: false, paused: false });

  broadcast({
    type: "PIPELINE_STATUS",
    stage: stoppedEarly ? "stopped" : "done",
    total: videos.length,
    processed: results.length,
    succeeded,
    failed,
    results,
  });
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create blob URLs for HLS video downloads",
  });
}

async function appendChunk(sessionId, index, base64) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: "APPEND_CHUNK",
    sessionId,
    index,
    base64,
  });

  if (!response || !response.success) {
    throw new Error((response && response.error) || "Offscreen document failed to store a chunk");
  }
}

async function finalizeFile(sessionId, filename, mimeType) {
  const result = await chrome.runtime.sendMessage({
    type: "FINALIZE_BLOB",
    sessionId,
    filename,
    mimeType,
  });

  if (!result || typeof result.downloadId !== "number") {
    throw new Error((result && result.error) || "Offscreen document failed to save the file");
  }

  return result.downloadId;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (message.type === "HLS_PROGRESS") {
    persistProgress(message);
    return undefined;
  }

  if (message.type === "SAVE_CHUNK") {
    appendChunk(message.sessionId, message.index, message.base64)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === "SAVE_FILE_FINALIZE") {
    finalizeFile(message.sessionId, message.filename, message.mimeType)
      .then((downloadId) => {
        sendResponse({ success: true, downloadId });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type === "SAVE_FILE_ABORT") {
    chrome.runtime.sendMessage({ type: "ABORT_SESSION", sessionId: message.sessionId }).catch(() => {});
    return undefined;
  }

  if (message.type === "PIPELINE_PAUSE") {
    pipelineControl.paused = true;
    setPipelineState({ paused: true });
    broadcast({ type: "PIPELINE_STATUS", stage: "paused" });
    return undefined;
  }

  if (message.type === "PIPELINE_RESUME") {
    pipelineControl.paused = false;
    setPipelineState({ paused: false });
    broadcast({ type: "PIPELINE_STATUS", stage: "resumed" });
    return undefined;
  }

  if (message.type === "PIPELINE_STOP") {
    pipelineControl.stopped = true;
    pipelineControl.paused = false;
    setPipelineState({ paused: false });
    if (pipelineControl.currentTabId) {
      chrome.tabs.remove(pipelineControl.currentTabId).catch(() => {});
    }
    broadcast({ type: "PIPELINE_STATUS", stage: "stopping" });
    return undefined;
  }

  if (message.type !== "START_PIPELINE") {
    return undefined;
  }

  runPipelineAllVideos(message.tabId, message.listScenario).catch((error) => {
    setPipelineState({ running: false, paused: false });
    broadcast({ type: "PIPELINE_STATUS", stage: "error", error: error.message });
  });

  sendResponse({ started: true });
  return true;
});
