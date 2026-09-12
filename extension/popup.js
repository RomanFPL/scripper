// popup.js — UI-логіка. Тут виконується fetch() лише за JSON-даними
// (список сценаріїв та сам сценарій). НІКОЛИ не завантажується та не
// виконується будь-який JS ззовні.

// Змінити на свій GitHub/GitLab raw URL для scenarios/index.json
// (див. README, розділ "Як змінити SCENARIOS_INDEX_URL").
const SCENARIOS_INDEX_URL =
  "https://raw.githubusercontent.com/<user>/<repo>/main/scenarios/index.json";

const indexUrlEl = document.getElementById("indexUrl");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refreshBtn");
const scenarioSelect = document.getElementById("scenarioSelect");
const loadBtn = document.getElementById("loadBtn");
const runBtn = document.getElementById("runBtn");

indexUrlEl.textContent = `SCENARIOS_INDEX_URL: ${SCENARIOS_INDEX_URL}`;

function log(message) {
  statusEl.textContent += `\n${message}`;
  statusEl.scrollTop = statusEl.scrollHeight;
}

function setStatus(message) {
  statusEl.textContent = message;
}

/**
 * Перетворює file (з index.json) на повний URL відносно розташування
 * самого index.json. Якщо file вже є абсолютним http(s)-посиланням,
 * використовується як є.
 */
function resolveScenarioUrl(indexUrl, file) {
  if (/^https?:\/\//i.test(file)) {
    return file;
  }
  return new URL(file, indexUrl).href;
}

/**
 * Валідація структури index.json:
 * - index має бути об'єктом;
 * - index.scenarios має бути масивом;
 * - кожен елемент має рядкові поля name та file.
 */
function validateIndex(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Scenarios index must be a JSON object.");
  }
  if (!Array.isArray(data.scenarios)) {
    throw new Error('Scenarios index must have a "scenarios" array.');
  }
  data.scenarios.forEach((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Index entry ${i + 1} must be an object.`);
    }
    if (typeof item.name !== "string" || item.name.length === 0) {
      throw new Error(`Index entry ${i + 1} must have a "name" string.`);
    }
    if (typeof item.file !== "string" || item.file.length === 0) {
      throw new Error(`Index entry ${i + 1} must have a "file" string.`);
    }
  });
  return data;
}

/**
 * Базова валідація структури сценарію (лише дані, без виконання коду):
 * - scenario має бути об'єктом;
 * - scenario.steps має бути масивом;
 * - кожен step має мати рядкове поле action.
 */
function validateScenario(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Scenario must be a JSON object.");
  }
  if (!Array.isArray(data.steps)) {
    throw new Error('Scenario must have a "steps" array.');
  }
  data.steps.forEach((step, i) => {
    if (typeof step !== "object" || step === null) {
      throw new Error(`Step ${i + 1} must be an object.`);
    }
    if (typeof step.action !== "string" || step.action.length === 0) {
      throw new Error(`Step ${i + 1} must have an "action" string.`);
    }
  });
  return data;
}

function populateSelect(scenarios) {
  scenarioSelect.innerHTML = "";
  scenarios.forEach((item, i) => {
    const option = document.createElement("option");
    option.value = item.file;
    option.textContent = item.name;
    if (i === 0) option.selected = true;
    scenarioSelect.appendChild(option);
  });
  scenarioSelect.disabled = scenarios.length === 0;
  loadBtn.disabled = scenarios.length === 0;
}

refreshBtn.addEventListener("click", async () => {
  setStatus(`Loading scenarios index from:\n${SCENARIOS_INDEX_URL}`);
  try {
    const response = await fetch(SCENARIOS_INDEX_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    validateIndex(data);

    await chrome.storage.local.set({ scenariosIndex: data });
    populateSelect(data.scenarios);

    setStatus(`✅ Loaded ${data.scenarios.length} scenario(s).`);
    log("Pick one in the dropdown and click \"Load scenario\".");
  } catch (err) {
    setStatus(`❌ Failed to load scenarios index:\n${err.message}`);
  }
});

loadBtn.addEventListener("click", async () => {
  const file = scenarioSelect.value;
  if (!file) {
    setStatus("No scenario selected.");
    return;
  }

  const scenarioUrl = resolveScenarioUrl(SCENARIOS_INDEX_URL, file);
  setStatus(`Loading scenario from:\n${scenarioUrl}`);

  try {
    const response = await fetch(scenarioUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    validateScenario(data);

    await chrome.storage.local.set({ scenario: data });

    setStatus(`✅ Scenario loaded: "${data.name || "(no name)"}"`);
    log(`Steps: ${data.steps.length}`);
    log(JSON.stringify(data, null, 2));
  } catch (err) {
    setStatus(`❌ Failed to load scenario:\n${err.message}`);
  }
});

runBtn.addEventListener("click", async () => {
  try {
    const { scenario } = await chrome.storage.local.get("scenario");
    if (!scenario) {
      setStatus('No scenario loaded. Click "Load scenario" first.');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      setStatus("❌ No active tab found.");
      return;
    }

    setStatus(`Running scenario "${scenario.name || "(no name)"}" on tab ${tab.id}...`);

    const response = await sendToContentScript(tab.id, scenario);

    if (response && response.success) {
      log("✅ Scenario finished successfully.");
      log(`Variables: ${JSON.stringify(response.variables, null, 2)}`);
    } else {
      log(`❌ ${response ? response.error : "No response from content script."}`);
    }
  } catch (err) {
    log(`❌ ${err.message}`);
  }
});

/**
 * Надсилає RUN_SCENARIO у content script активної вкладки.
 * Якщо content script ще не був інжектований (наприклад, вкладка була
 * відкрита до встановлення розширення), інжектуємо статичний content.js
 * через chrome.scripting і пробуємо ще раз. Жодного динамічного коду —
 * інжектується той самий файл, що вже лежить у розширенні.
 */
async function sendToContentScript(tabId, scenario) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "RUN_SCENARIO",
      scenario,
    });
  } catch (err) {
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

/**
 * При відкритті popup відновлюємо раніше завантажений index.json
 * (щоб не тиснути "Refresh list" щоразу заново).
 */
(async function restoreState() {
  const { scenariosIndex } = await chrome.storage.local.get("scenariosIndex");
  if (scenariosIndex && Array.isArray(scenariosIndex.scenarios)) {
    populateSelect(scenariosIndex.scenarios);
    setStatus(`Restored ${scenariosIndex.scenarios.length} scenario(s) from last load.`);
  }
})();
