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

async function waitForTabComplete(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (tab.status === "complete") {
    return;
  }

  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runPipelineFirstVideo(listTabId, listScenario) {
  await chrome.storage.local.set({ progressLog: [] });
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

  const video = videos[0];

  broadcast({
    type: "PIPELINE_STATUS",
    stage: "opening",
    total: videos.length,
    title: video.title,
    url: video.url,
  });

  const newTab = await chrome.tabs.create({ url: video.url, active: false });
  await waitForTabComplete(newTab.id);

  broadcast({
    type: "PIPELINE_STATUS",
    stage: "downloading",
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
    broadcast({
      type: "PIPELINE_STATUS",
      stage: "error",
      title: video.title,
      error: (downloadResponse && downloadResponse.error) || "Download failed.",
      tabId: newTab.id,
    });
    return;
  }

  await chrome.tabs.remove(newTab.id);

  broadcast({
    type: "PIPELINE_STATUS",
    stage: "done",
    title: video.title,
    result: downloadResponse.variables.download,
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

async function saveFile(filename, mimeType, buffers) {
  await ensureOffscreenDocument();

  const created = await chrome.runtime.sendMessage({
    type: "CREATE_BLOB_URL",
    mimeType,
    buffers,
  });

  if (!created || !created.blobUrl) {
    throw new Error("Offscreen document failed to create a blob URL");
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

  if (message.type === "SAVE_FILE") {
    saveFile(message.filename, message.mimeType, message.buffers)
      .then((downloadId) => {
        sendResponse({ success: true, downloadId });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.type !== "START_PIPELINE") {
    return undefined;
  }

  runPipelineFirstVideo(message.tabId, message.listScenario).catch((error) => {
    broadcast({ type: "PIPELINE_STATUS", stage: "error", error: error.message });
  });

  sendResponse({ started: true });
  return true;
});
