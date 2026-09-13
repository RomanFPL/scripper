const SCENARIOS_INDEX_URL =
  "https://raw.githubusercontent.com/RomanFPL/scripper/main/scenarios/index.json";

let scenarios = [];
let loadedScenario = null;
let sessions = [];
let activeSessionId = null;
let activeSessionRunning = false;
let selectorHistory = [];

const scenarioSelect = document.getElementById("scenario");
const loadButton = document.getElementById("load");
const refreshButton = document.getElementById("refreshBtn");
const collectButton = document.getElementById("collect");
const itemSelectorInput = document.getElementById("itemSelector");
const linkSelectorInput = document.getElementById("linkSelector");
const pickItemButton = document.getElementById("pickItem");
const pickLinkButton = document.getElementById("pickLink");
const selectorHistorySelect = document.getElementById("selectorHistory");
const sessionTabsEl = document.getElementById("sessionTabs");
const sessionBlockEl = document.getElementById("sessionBlock");
const videoListEl = document.getElementById("videoList");
const selectAllButton = document.getElementById("selectAll");
const selectNoneButton = document.getElementById("selectNone");
const closeSessionButton = document.getElementById("closeSession");
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

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getActiveSession() {
  return sessions.find((session) => session.id === activeSessionId) || null;
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
  if (message.stage === "collected") {
    return `[Pipeline] Starting downloads for ${message.total} video(s)...`;
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

function applyPipelineState(state) {
  const running = Boolean(state && state.running);
  const paused = Boolean(state && state.paused);

  activeSessionRunning = running;

  pauseButton.disabled = !running;
  stopButton.disabled = !running;
  pauseButton.textContent = paused ? "Resume" : "Pause";
  closeSessionButton.disabled = running;
  selectAllButton.disabled = running;
  selectNoneButton.disabled = running;

  renderVideoList();
}

function updatePipelineButtonState() {
  const session = getActiveSession();
  const hasSelection = Boolean(session && session.videos.some((video) => video.selected));
  pipelineButton.disabled = !hasSelection || activeSessionRunning;
}

function renderVideoList() {
  const session = getActiveSession();
  videoListEl.innerHTML = "";

  if (!session) {
    updatePipelineButtonState();
    return;
  }

  session.videos.forEach((video, i) => {
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = video.selected;
    checkbox.disabled = activeSessionRunning;
    checkbox.addEventListener("change", () => {
      session.videos[i].selected = checkbox.checked;
      if (checkbox.checked) {
        session.videos[i].progress = null;
      }
      persistSessions();
      renderVideoList();
    });

    const span = document.createElement("span");
    span.textContent = video.title;
    span.title = video.url;

    const bar = document.createElement("div");
    bar.className = "video-progress-bar";

    const fill = document.createElement("div");
    fill.className = "video-progress-fill";
    const percent = (video.progress && video.progress.percent) || 0;
    fill.style.width = `${percent}%`;
    if (video.progress && video.progress.done) {
      fill.classList.add("done");
    }
    if (video.progress && video.progress.error) {
      fill.classList.add("error");
    }
    bar.appendChild(fill);

    label.appendChild(checkbox);
    label.appendChild(span);
    label.appendChild(bar);
    videoListEl.appendChild(label);
  });

  updatePipelineButtonState();
}

function applyProgressToSession(session, log) {
  if (!session || !Array.isArray(log)) {
    return false;
  }

  const byUrl = {};
  session.videos.forEach((video) => {
    byUrl[video.url] = video;
  });

  let changed = false;

  for (const entry of log) {
    if (entry.type === "HLS_PROGRESS" && entry.videoUrl && byUrl[entry.videoUrl]) {
      const video = byUrl[entry.videoUrl];

      if (entry.stage === "segment" && entry.totalSegments > 0) {
        const percent = Math.min(
          100,
          Math.round((entry.segment / entry.totalSegments) * 100)
        );
        if (!video.progress || video.progress.percent !== percent) {
          video.progress = { percent, done: false };
          changed = true;
        }
      }

      if (entry.stage === "done") {
        video.progress = { percent: 100, done: true };
        if (video.selected) {
          video.selected = false;
        }
        changed = true;
      }
    }

    if (entry.type === "PIPELINE_STATUS" && entry.url && byUrl[entry.url]) {
      const video = byUrl[entry.url];

      if (entry.stage === "video-done") {
        video.progress = { percent: 100, done: true };
        if (video.selected) {
          video.selected = false;
        }
        changed = true;
      }

      if (entry.stage === "video-error") {
        video.progress = {
          percent: (video.progress && video.progress.percent) || 0,
          done: false,
          error: true,
        };
        changed = true;
      }
    }
  }

  return changed;
}

function renderSessionTabs() {
  sessionTabsEl.innerHTML = "";

  sessions.forEach((session) => {
    const tab = document.createElement("div");
    tab.className = "session-tab" + (session.id === activeSessionId ? " active" : "");

    const label = document.createElement("span");
    label.textContent = session.label;
    label.addEventListener("click", () => {
      activeSessionId = session.id;
      persistSessions();
      renderSessionTabs();
      renderActiveSession();
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "session-tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close this tab";
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSession(session.id);
    });

    tab.appendChild(label);
    tab.appendChild(closeBtn);
    sessionTabsEl.appendChild(tab);
  });

  sessionBlockEl.hidden = sessions.length === 0;
}

async function renderActiveSession() {
  const session = getActiveSession();

  if (!session) {
    renderVideoList();
    renderProgressLog(null);
    applyPipelineState(null);
    return;
  }

  const stored = await chrome.storage.local.get(["sessionPipelineState", "sessionProgress"]);
  const state = (stored.sessionPipelineState || {})[session.id];
  const log = (stored.sessionProgress || {})[session.id];

  if (applyProgressToSession(session, log)) {
    await persistSessions();
  }

  renderVideoList();
  applyPipelineState(state);
  renderProgressLog(log);
}

async function persistSessions() {
  await chrome.storage.local.set({ sessions, activeSessionId });
}

async function restoreSessions() {
  const stored = await chrome.storage.local.get(["sessions", "activeSessionId"]);

  if (Array.isArray(stored.sessions)) {
    sessions = stored.sessions;
  }

  if (stored.activeSessionId && sessions.some((session) => session.id === stored.activeSessionId)) {
    activeSessionId = stored.activeSessionId;
  } else if (sessions.length > 0) {
    activeSessionId = sessions[0].id;
  }

  renderSessionTabs();
  await renderActiveSession();
}

async function closeSession(sessionId) {
  const stored = await chrome.storage.local.get("sessionPipelineState");
  const state = (stored.sessionPipelineState || {})[sessionId];

  if (state && state.running) {
    show("Stop the pipeline in this tab before closing it.");
    return;
  }

  sessions = sessions.filter((session) => session.id !== sessionId);

  if (activeSessionId === sessionId) {
    activeSessionId = sessions.length > 0 ? sessions[0].id : null;
  }

  await persistSessions();
  renderSessionTabs();
  await renderActiveSession();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  const session = getActiveSession();
  if (!session) {
    return;
  }

  if (changes.sessionProgress) {
    const log = (changes.sessionProgress.newValue || {})[session.id];

    if (applyProgressToSession(session, log)) {
      persistSessions();
      renderVideoList();
    }

    renderProgressLog(log);
  }

  if (changes.sessionPipelineState) {
    const state = (changes.sessionPipelineState.newValue || {})[session.id];
    applyPipelineState(state);
  }
});

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

    show(loadedScenario);

    await persistScenarioState();
  } catch (error) {
    loadedScenario = null;

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

function buildCollectScenario() {
  if (!loadedScenario) {
    return null;
  }

  const selector = itemSelectorInput.value.trim();
  const linkSelector = linkSelectorInput.value.trim();

  const scenario = JSON.parse(JSON.stringify(loadedScenario));

  scenario.steps = scenario.steps.map((step) => {
    if (step.action !== "collectLinks") {
      return step;
    }
    return {
      ...step,
      selector: selector || step.selector,
      linkSelector: linkSelector || step.linkSelector,
    };
  });

  return scenario;
}

async function saveSelectorToHistory(selector, linkSelector, hostname) {
  const exists = selectorHistory.some(
    (entry) => entry.selector === selector && entry.linkSelector === linkSelector
  );

  if (!exists) {
    selectorHistory.unshift({ selector, linkSelector, hostname, ts: Date.now() });
    selectorHistory = selectorHistory.slice(0, 20);
    await chrome.storage.local.set({ selectorHistory });
    renderSelectorHistory();
  }
}

function renderSelectorHistory() {
  selectorHistorySelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent =
    selectorHistory.length === 0 ? "— none saved —" : "— pick a saved selector —";
  selectorHistorySelect.appendChild(placeholder);

  selectorHistory.forEach((entry, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `${entry.hostname}: ${entry.selector} / ${entry.linkSelector}`;
    selectorHistorySelect.appendChild(option);
  });
}

async function restoreSelectorHistory() {
  const stored = await chrome.storage.local.get("selectorHistory");
  if (Array.isArray(stored.selectorHistory)) {
    selectorHistory = stored.selectorHistory;
  }
  renderSelectorHistory();
}

async function persistSelectorFields() {
  await chrome.storage.local.set({
    selectorFields: {
      selector: itemSelectorInput.value,
      linkSelector: linkSelectorInput.value,
    },
  });
}

async function restoreSelectorFields() {
  const stored = await chrome.storage.local.get("selectorFields");
  if (stored.selectorFields) {
    itemSelectorInput.value = stored.selectorFields.selector || "";
    linkSelectorInput.value = stored.selectorFields.linkSelector || "";
  }
}

async function sendPickerStart(tabId, kind) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "START_ELEMENT_PICKER", kind });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "START_ELEMENT_PICKER", kind });
  }
}

async function pickOnPage(kind) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("No active tab.");
    }

    await sendPickerStart(tab.id, kind);

    show(
      `Click an element on the page to use as the ${kind === "item" ? "item" : "link"} selector (Esc to cancel).`
    );
  } catch (error) {
    show(`ERROR:\n${error.message}`);
    console.error("[Video Runner]", error);
  }
}

async function applyPendingPickerResult() {
  const stored = await chrome.storage.local.get("pickerResult");
  const result = stored.pickerResult;

  if (!result) {
    return;
  }

  await chrome.storage.local.remove("pickerResult");

  if (result.cancelled || !result.selector) {
    return;
  }

  if (result.kind === "item") {
    itemSelectorInput.value = result.selector;
  } else if (result.kind === "link") {
    linkSelectorInput.value = result.selector;
  }

  await persistSelectorFields();
  show(`Picked ${result.kind} selector: ${result.selector}`);
}

async function collectVideos() {
  if (!loadedScenario) {
    show('No scenario loaded. Load "Collect Video Links" first.');
    return;
  }

  const scenario = buildCollectScenario();

  if (!scenario.steps.some((step) => step.action === "collectLinks")) {
    show('Loaded scenario has no "collectLinks" step.');
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

    const response = await sendToContentScript(tab.id, scenario);

    if (!response || !response.success) {
      throw new Error((response && response.error) || "Failed to collect links.");
    }

    const videos = response.variables.videos;

    if (!Array.isArray(videos) || videos.length === 0) {
      throw new Error("variables.videos is empty — nothing found on this page.");
    }

    let label = "Page";
    let hostname = "page";
    try {
      hostname = new URL(tab.url).hostname;
      label = tab.title || hostname || "Page";
    } catch (e) {}
    label = label.slice(0, 24);

    const collectStep = scenario.steps.find((step) => step.action === "collectLinks");
    await saveSelectorToHistory(collectStep.selector, collectStep.linkSelector, hostname);

    const session = {
      id: generateSessionId(),
      label,
      videos: videos.map((video) => ({ ...video, selected: true })),
    };

    sessions.push(session);
    activeSessionId = session.id;

    await persistSessions();
    renderSessionTabs();
    await renderActiveSession();

    show(
      `Collected ${session.videos.length} video(s) into tab "${label}". Review the list and click "Download selected".`
    );
  } catch (error) {
    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  } finally {
    collectButton.disabled = false;
  }
}

async function startPipelineSelected() {
  const session = getActiveSession();

  if (!session) {
    show("No tab selected.");
    return;
  }

  const selected = session.videos.filter((video) => video.selected);

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
      pipelineSessionId: session.id,
      videos: selected,
      concurrency,
    });

    show(
      `Pipeline started for ${selected.length} video(s) in tab "${session.label}" — it keeps running even if this popup closes.`
    );
  } catch (error) {
    show(`ERROR:\n${error.message}`);

    console.error("[Video Runner]", error);
  }
}

async function togglePause() {
  const session = getActiveSession();
  if (!session) {
    return;
  }

  const stored = await chrome.storage.local.get("sessionPipelineState");
  const state = (stored.sessionPipelineState || {})[session.id];
  const paused = Boolean(state && state.paused);

  await chrome.runtime.sendMessage({
    type: paused ? "PIPELINE_RESUME" : "PIPELINE_PAUSE",
    pipelineSessionId: session.id,
  });
}

async function stopPipeline() {
  const session = getActiveSession();
  if (!session) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "PIPELINE_STOP",
    pipelineSessionId: session.id,
  });
}

async function restoreConcurrency() {
  const stored = await chrome.storage.local.get("pipelineConcurrency");
  if (stored.pipelineConcurrency) {
    concurrencyInput.value = stored.pipelineConcurrency;
  }
}

scenarioSelect.addEventListener("change", () => {
  loadedScenario = null;

  output.textContent =
    'No scenario loaded. Click "Load scenario" first.';

  persistScenarioState();
});

loadButton.addEventListener("click", loadSelectedScenario);

refreshButton.addEventListener("click", loadScenarioList);

collectButton.addEventListener("click", collectVideos);

selectAllButton.addEventListener("click", () => {
  const session = getActiveSession();
  if (!session) return;
  session.videos.forEach((video) => (video.selected = true));
  persistSessions();
  renderVideoList();
});

selectNoneButton.addEventListener("click", () => {
  const session = getActiveSession();
  if (!session) return;
  session.videos.forEach((video) => (video.selected = false));
  persistSessions();
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

itemSelectorInput.addEventListener("change", persistSelectorFields);
linkSelectorInput.addEventListener("change", persistSelectorFields);

pickItemButton.addEventListener("click", () => pickOnPage("item"));
pickLinkButton.addEventListener("click", () => pickOnPage("link"));

selectorHistorySelect.addEventListener("change", () => {
  const index = Number(selectorHistorySelect.value);
  const entry = selectorHistory[index];
  if (!entry) {
    return;
  }
  itemSelectorInput.value = entry.selector;
  linkSelectorInput.value = entry.linkSelector;
  persistSelectorFields();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pickerResult && changes.pickerResult.newValue) {
    applyPendingPickerResult();
  }
});

restoreConcurrency();
restoreSessions();
restoreSelectorFields();
restoreSelectorHistory();
applyPendingPickerResult();

loadScenarioList();
