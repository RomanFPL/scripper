chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Video Runner] Extension installed/updated. Reason: ${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Video Runner] Browser startup: service worker active.");
});

function broadcast(message) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "START_PIPELINE") {
    return undefined;
  }

  runPipelineFirstVideo(message.tabId, message.listScenario).catch((error) => {
    broadcast({ type: "PIPELINE_STATUS", stage: "error", error: error.message });
  });

  sendResponse({ started: true });
  return true;
});
