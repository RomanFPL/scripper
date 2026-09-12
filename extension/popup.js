const SCENARIOS_INDEX_URL =
  "https://raw.githubusercontent.com/RomanFPL/scripper/main/scenarios/index.json";

let scenarios = [];
let loadedScenario = null;

const scenarioSelect = document.getElementById("scenario");
const loadButton = document.getElementById("load");
const runButton = document.getElementById("run");
const output = document.getElementById("output");
const indexUrl = document.getElementById("index-url");

indexUrl.textContent = SCENARIOS_INDEX_URL;

function show(message) {
  output.textContent =
    typeof message === "string"
      ? message
      : JSON.stringify(message, null, 2);
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

    show(`Loaded ${scenarios.length} scenario(s).`);
  } catch (error) {
    scenarios = [];
    scenarioSelect.innerHTML = "";
    scenarioSelect.disabled = true;
    loadButton.disabled = true;

    show(`ERROR:\n${error.message}`);
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

  const baseUrl = SCENARIOS_INDEX_URL.substring(
    0,
    SCENARIOS_INDEX_URL.lastIndexOf("/") + 1
  );

  const scenarioUrl = new URL(file, baseUrl).href;

  show("Loading scenario...");

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

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_SCENARIO",
      scenario: loadedScenario,
    });

    if (!response) {
      throw new Error("No response from content script.");
    }

    if (!response.success) {
      throw new Error(response.error || "Scenario failed.");
    }

    show(response.variables);
  } catch (error) {
    show(`ERROR:\n${error.message}`);
  } finally {
    runButton.disabled = false;
  }
}

scenarioSelect.addEventListener("change", () => {
  loadedScenario = null;
  runButton.disabled = true;
  output.textContent = 'No scenario loaded. Click "Load scenario" first.';
});

loadButton.addEventListener("click", loadSelectedScenario);
runButton.addEventListener("click", runSelectedScenario);

loadScenarioList();