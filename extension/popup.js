const SCENARIOS_INDEX_URL =
  "https://raw.githubusercontent.com/RomanFPL/scripper/main/scenarios/index.json";

let scenarios = [];
let loadedScenario = null;

const scenarioSelect = document.getElementById("scenario");
const loadButton = document.getElementById("load");
const runButton = document.getElementById("run");
const refreshButton = document.getElementById("refreshBtn");
const output = document.getElementById("output");
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

function appendLine(line) {
  output.textContent += `\n${line}`;
  output.scrollTop = output.scrollHeight;
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

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "HLS_PROGRESS") {
    return undefined;
  }

  appendLine(formatHLSProgress(message));
});

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

    show(`Loaded ${scenarios.length} scenario(s).`);
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

    runButton.disabled = false;

    show(loadedScenario);
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

scenarioSelect.addEventListener("change", () => {
  loadedScenario = null;
  runButton.disabled = true;

  output.textContent =
    'No scenario loaded. Click "Load scenario" first.';
});

loadButton.addEventListener("click", loadSelectedScenario);

runButton.addEventListener("click", runSelectedScenario);

refreshButton.addEventListener("click", loadScenarioList);

loadScenarioList();