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

const DEFAULT_PIPELINE_CONCURRENCY = 3;

const pipelineControl = { paused: false, stopped: false, currentTabIds: new Set() };

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
    pipelineControl.currentTabIds.add(newTab.id);
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
    if (newTab) {
      pipelineControl.currentTabIds.delete(newTab.id);
      await chrome.tabs.remove(newTab.id).catch(() => {});
    }
  }
}

async function runPipelineAllVideos(videos, concurrency) {
  pipelineControl.paused = false;
  pipelineControl.stopped = false;
  pipelineControl.currentTabIds.clear();

  await chrome.storage.local.set({ progressLog: [] });
  await setPipelineState({ running: true, paused: false });
  chrome.power.requestKeepAwake("system");
  broadcast({ type: "PIPELINE_STATUS", stage: "collected", total: videos.length });

  try {
    const results = new Array(videos.length);
    let nextIndex = 0;
    let stoppedEarly = false;

    async function worker() {
      while (true) {
        if (pipelineControl.stopped) {
          stoppedEarly = true;
          return;
        }

        await waitWhilePaused();

        if (pipelineControl.stopped) {
          stoppedEarly = true;
          return;
        }

        const i = nextIndex;
        nextIndex += 1;

        if (i >= videos.length) {
          return;
        }

        results[i] = await downloadOneVideo(videos[i], i + 1, videos.length);
      }
    }

    const workerCount = Math.min(
      Number(concurrency) || DEFAULT_PIPELINE_CONCURRENCY,
      videos.length
    );
    const workers = [];

    for (let w = 0; w < workerCount; w++) {
      workers.push(worker());
      await sleep(300);
    }

    await Promise.all(workers);

    const finishedResults = results.filter(Boolean);
    const succeeded = finishedResults.filter((r) => r.success).length;
    const failed = finishedResults.length - succeeded;

    await setPipelineState({ running: false, paused: false });

    broadcast({
      type: "PIPELINE_STATUS",
      stage: stoppedEarly ? "stopped" : "done",
      total: videos.length,
      processed: finishedResults.length,
      succeeded,
      failed,
      results: finishedResults,
    });
  } finally {
    chrome.power.releaseKeepAwake();
  }
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
  const created = await chrome.runtime.sendMessage({
    type: "FINALIZE_BLOB",
    sessionId,
    mimeType,
  });

  if (!created || !created.blobUrl) {
    throw new Error((created && created.error) || "Offscreen document failed to assemble the file");
  }

  const blobUrl = created.blobUrl;

  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename,
    saveAs: false,
  });

  function cleanup(delta) {
    if (delta.id !== downloadId || !delta.state) {
      return;
    }
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      chrome.downloads.onChanged.removeListener(cleanup);
      chrome.runtime.sendMessage({ type: "REVOKE_BLOB_URL", blobUrl }).catch(() => {});
    }
  }

  chrome.downloads.onChanged.addListener(cleanup);

  return downloadId;
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
    for (const tabId of pipelineControl.currentTabIds) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    broadcast({ type: "PIPELINE_STATUS", stage: "stopping" });
    return undefined;
  }

  if (message.type !== "START_PIPELINE") {
    return undefined;
  }

  runPipelineAllVideos(message.videos, message.concurrency).catch((error) => {
    setPipelineState({ running: false, paused: false });
    broadcast({ type: "PIPELINE_STATUS", stage: "error", error: error.message });
  });

  sendResponse({ started: true });
  return true;
});
