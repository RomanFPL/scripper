const SCENARIOS_INDEX_URL =
  "https://raw.githubusercontent.com/RomanFPL/scripper/main/scenarios/index.json";

let scenarios = [];
let loadedScenario = null;
let collectedVideos = [];

const scenarioSelect = document.getElementById("scenario");
const loadButton = document.getElementById("load");
const runButton = document.getElementById("run");
const refreshButton = document.getElementById("refreshBtn");
const collectButton = document.getElementById("collect");
const videoListWrap = document.getElementById("videoListWrap");
const videoListEl = document.getElementById("videoList");
const selectAllButton = document.getElementById("selectAll");
const selectNoneButton = document.getElementById("selectNone");
const pipelineButton = document.getElementById("pipeline");
const pauseButton = document.getElementById("pause");
const stopButton = document.getElementById("stop");
const concurrencyInput = document.getElementById("concurrency");
const output = document.getElementById("output");
const progress = document.getElementById("progress");
const indexUrl = document.getElementById("index-url");

if (indexUrl) {
  indexUrl.textContent = `SCENARIOS_INDEX_URL: ${SCENARIOS_INDEX_URL}`;
}

function show(message) {
  output.textContent =
    typeof message === "string"
      ? message
      : JSON.stringify(message, null, 2);
}

function formatHLSProgress(message) {
  const video = message.video || "video";

  if (message.stage === "segment") {
    const mb = (message.bytesDownloaded / 1024 / 1024).toFixed(2);
    return `[HLS] ${video}: segment ${message.segment}/${message.totalSegments} (${mb} MB)`;
  }

  if (message.stage === "retry") {
    return `[HLS] ${video}: retry ${message.attempt}/${message.retries} for ${message.label} (${message.error})`;
  }

  if (message.stage === "done") {
    const mb = (message.bytes / 1024 / 1024).toFixed(2);
    return `[HLS] ${video}: saved "${message.filename}" (${mb} MB)`;
  }

  return `[HLS] ${video}: ${message.stage}`;
}

function formatPipelineStatus(message) {
  if (message.stage === "collecting") {
    return "[Pipeline] Collecting links...";
  }

  if (message.stage === "collected") {
    return `[Pipeline] Collected ${message.total} video(s). Starting downloads...`;
  }

  if (message.stage === "opening") {
    return `[Pipeline] (${message.index}/${message.total}) Opening: ${message.title}`;
  }

  if (message.stage === "downloading") {
    return `[Pipeline] (${message.index}/${message.total}) Page loaded, downloading: ${message.title}`;
  }

  if (message.stage === "video-done") {
    return `[Pipeline] (${message.index}/${message.total}) ✅ ${message.title}`;
  }

  if (message.stage === "video-error") {
    return `[Pipeline] (${message.index}/${message.total}) ❌ ${message.title}: ${message.error}`;
  }

  if (message.stage === "done") {
    return `[Pipeline] All done: ${message.succeeded}/${message.total} succeeded, ${message.failed} failed.`;
  }

  if (message.stage === "stopped") {
    return `[Pipeline] Stopped after ${message.processed}/${message.total} video(s): ${message.succeeded} succeeded, ${message.failed} failed.`;
  }

  if (message.stage === "paused") {
    return "[Pipeline] ⏸ Paused (will finish the current video, then wait).";
  }

  if (message.stage === "resumed") {
    return "[Pipeline] ▶ Resumed.";
  }

  if (message.stage === "stopping") {
    return "[Pipeline] ⏹ Stopping...";
  }

  if (message.stage === "error") {
    return `[Pipeline] ERROR: ${message.error}`;
  }

  return `[Pipeline] ${message.stage}`;
}

function formatLogEntry(entry) {
  if (entry.type === "HLS_PROGRESS") {
    return formatHLSProgress(entry);
  }

  if (entry.type === "PIPELINE_STATUS") {
    return formatPipelineStatus(entry);
  }

  return JSON.stringify(entry);
}

function renderProgressLog(log) {
  if (!Array.isArray(log) || log.length === 0) {
    progress.textContent = "No pipeline runs yet.";
    return;
  }

  progress.textContent = log.map(formatLogEntry).join("\n");
  progress.scrollTop = progress.scrollHeight;
}

async function restoreProgressLog() {
  const stored = await chrome.storage.local.get("progressLog");
  renderProgressLog(stored.progressLog);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.progressLog) {
    return;
  }

  renderProgressLog(changes.progressLog.newValue);
});

restoreProgressLog();

async function persistScenarioState() {
  await chrome.storage.local.set({
    scenarioState: {
      selectedFile: scenarioSelect.value,
      loadedScenario,
    },
  });
}

async function restoreScenarioState() {
  const stored = await chrome.storage.local.get("scenarioState");
  return stored.scenarioState || null;
}

async function loadScenarioList() {
  show("Loading scenarios...");

  try {
    const response = await fetch(SCENARIOS_INDEX_URL);

    if (!response.ok) {
      throw new Error(
        `Failed to load scenario index: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    if (!Array.isArray(data.scenarios)) {
      throw new Error("index.json must contain a scenarios array.");
    }

    scenarios = data.scenarios;

    scenarioSelect.innerHTML = "";

    for (const scenario of scenarios) {
      const option = document.createElement("option");

      option.value = scenario.file;
      option.textContent = scenario.name;

      scenarioSelect.appendChild(option);
    }

    scenarioSelect.disabled = scenarios.length === 0;
    loadButton.disabled = scenarios.length === 0;

    const savedState = await restoreScenarioState();

    if (
      savedState &&
      savedState.selectedFile &&
      scenarios.some((scenario) => scenario.file === savedState.selectedFile)
    ) {
      scenarioSelect.value = savedState.selectedFile;

      if (
        savedState.loadedScenario &&
        savedState.loadedScenario.__file === savedState.selectedFile
      ) {
        loadedScenario = savedState.loadedScenario;
        runButton.disabled = false;
      }
    }

    if (loadedScenario) {
      show(loadedScenario);
    } else {
      show(`Loaded ${scenarios.length} scenario(s).`);
    }
  } catch (error) {
    scenarios = [];

    scenarioSelect.innerHTML = "";
    scenarioSelect.disabled = true;
    loadButton.disabled = true;

    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  }
}

async function loadSelectedScenario() {
  const file = scenarioSelect.value;

  if (!file) {
    show("Select a scenario first.");
    return;
  }

  const scenario = scenarios.find((item) => item.file === file);

  if (!scenario) {
    show("Scenario not found in index.");
    return;
  }

  const baseUrl =
    SCENARIOS_INDEX_URL.substring(
      0,
      SCENARIOS_INDEX_URL.lastIndexOf("/") + 1
    );

  const scenarioUrl = new URL(file, baseUrl).href;

  show(`Loading scenario...\n${scenarioUrl}`);

  try {
    const response = await fetch(scenarioUrl);

    if (!response.ok) {
      throw new Error(
        `Failed to load scenario: ${response.status} ${response.statusText}`
      );
    }

    loadedScenario = await response.json();

    if (!Array.isArray(loadedScenario.steps)) {
      throw new Error("Scenario must contain a steps array.");
    }

    loadedScenario.__file = file;

    runButton.disabled = false;

    show(loadedScenario);

    await persistScenarioState();
  } catch (error) {
    loadedScenario = null;
    runButton.disabled = true;

    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  }
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

async function runSelectedScenario() {
  if (!loadedScenario) {
    show('No scenario loaded. Click "Load scenario" first.');
    return;
  }

  runButton.disabled = true;

  show("Running scenario...");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.id) {
      throw new Error("No active tab.");
    }

    const response = await sendToContentScript(tab.id, loadedScenario);

    if (!response) {
      throw new Error("No response from content script.");
    }

    if (!response.success) {
      throw new Error(response.error || "Scenario failed.");
    }

    show(response.variables);
  } catch (error) {
    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  } finally {
    runButton.disabled = false;
  }
}

function updatePipelineButtonState() {
  pipelineButton.disabled = !collectedVideos.some((video) => video.selected);
}

async function persistCollectedVideos() {
  await chrome.storage.local.set({ collectedVideos });
}

function renderVideoList() {
  videoListEl.innerHTML = "";

  collectedVideos.forEach((video, i) => {
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = video.selected;
    checkbox.addEventListener("change", () => {
      collectedVideos[i].selected = checkbox.checked;
      persistCollectedVideos();
      updatePipelineButtonState();
    });

    const span = document.createElement("span");
    span.textContent = video.title;
    span.title = video.url;

    label.appendChild(checkbox);
    label.appendChild(span);
    videoListEl.appendChild(label);
  });

  videoListWrap.hidden = collectedVideos.length === 0;
  updatePipelineButtonState();
}

async function restoreCollectedVideos() {
  const stored = await chrome.storage.local.get("collectedVideos");
  if (Array.isArray(stored.collectedVideos)) {
    collectedVideos = stored.collectedVideos;
    renderVideoList();
  }
}

async function collectVideos() {
  if (!loadedScenario) {
    show('No scenario loaded. Load "Collect Video Links" first.');
    return;
  }

  collectButton.disabled = true;
  show("Collecting links...");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.id) {
      throw new Error("No active tab.");
    }

    const response = await sendToContentScript(tab.id, loadedScenario);

    if (!response || !response.success) {
      throw new Error((response && response.error) || "Failed to collect links.");
    }

    const videos = response.variables.videos;

    if (!Array.isArray(videos) || videos.length === 0) {
      throw new Error("variables.videos is empty — nothing found on this page.");
    }

    collectedVideos = videos.map((video) => ({ ...video, selected: true }));
    await persistCollectedVideos();
    renderVideoList();

    show(
      `Collected ${collectedVideos.length} video(s). Review the list and click "Download selected".`
    );
  } catch (error) {
    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  } finally {
    collectButton.disabled = false;
  }
}

async function startPipelineSelected() {
  const selected = collectedVideos.filter((video) => video.selected);

  if (selected.length === 0) {
    show("No videos selected.");
    return;
  }

  try {
    const concurrency = Math.max(1, Math.min(10, Number(concurrencyInput.value) || 3));
    concurrencyInput.value = concurrency;
    await chrome.storage.local.set({ pipelineConcurrency: concurrency });

    await chrome.runtime.sendMessage({
      type: "START_PIPELINE",
      videos: selected,
      concurrency,
    });

    await applyPipelineState({ running: true, paused: false });

    show(
      `Pipeline started for ${selected.length} video(s) in background.js — it keeps running even if this popup closes.\nReopen the popup to see progress while it's still running.`
    );
  } catch (error) {
    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  }
}

function applyPipelineState(state) {
  const running = Boolean(state && state.running);
  const paused = Boolean(state && state.paused);

  pauseButton.disabled = !running;
  stopButton.disabled = !running;
  pauseButton.textContent = paused ? "Resume" : "Pause";
}

async function togglePause() {
  const stored = await chrome.storage.local.get("pipelineState");
  const paused = Boolean(stored.pipelineState && stored.pipelineState.paused);

  await chrome.runtime.sendMessage({
    type: paused ? "PIPELINE_RESUME" : "PIPELINE_PAUSE",
  });
}

async function stopPipeline() {
  await chrome.runtime.sendMessage({ type: "PIPELINE_STOP" });
}

async function restorePipelineState() {
  const stored = await chrome.storage.local.get("pipelineState");
  applyPipelineState(stored.pipelineState);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.pipelineState) {
    return;
  }

  applyPipelineState(changes.pipelineState.newValue);
});

restorePipelineState();

scenarioSelect.addEventListener("change", () => {
  loadedScenario = null;
  runButton.disabled = true;

  output.textContent =
    'No scenario loaded. Click "Load scenario" first.';

  persistScenarioState();
});

loadButton.addEventListener("click", loadSelectedScenario);

runButton.addEventListener("click", runSelectedScenario);

refreshButton.addEventListener("click", loadScenarioList);

collectButton.addEventListener("click", collectVideos);

selectAllButton.addEventListener("click", () => {
  collectedVideos.forEach((video) => (video.selected = true));
  persistCollectedVideos();
  renderVideoList();
});

selectNoneButton.addEventListener("click", () => {
  collectedVideos.forEach((video) => (video.selected = false));
  persistCollectedVideos();
  renderVideoList();
});

pipelineButton.addEventListener("click", startPipelineSelected);

pauseButton.addEventListener("click", togglePause);

stopButton.addEventListener("click", stopPipeline);

concurrencyInput.addEventListener("change", () => {
  const concurrency = Math.max(1, Math.min(10, Number(concurrencyInput.value) || 3));
  concurrencyInput.value = concurrency;
  chrome.storage.local.set({ pipelineConcurrency: concurrency });
});

async function restoreConcurrency() {
  const stored = await chrome.storage.local.get("pipelineConcurrency");
  if (stored.pipelineConcurrency) {
    concurrencyInput.value = stored.pipelineConcurrency;
  }
}

restoreConcurrency();
restoreCollectedVideos();

loadScenarioList();