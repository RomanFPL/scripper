const ACTIONS = {
  log(step) {
    console.log("[Video Runner]", step.message);
    return step.message;
  },

  wait(step) {
    const ms = Number(step.ms) || 0;
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  getPageTitle() {
    return document.title;
  },

  query(step) {
    requireSelector(step);
    const element = document.querySelector(step.selector);
    if (!element) {
      throw new Error(`Element not found: ${step.selector}`);
    }
    return element;
  },

  click(step) {
    requireSelector(step);
    const element = document.querySelector(step.selector);
    if (!element) {
      throw new Error(`Element not found: ${step.selector}`);
    }
    element.click();
    return true;
  },

  getText(step) {
    requireSelector(step);
    const element = document.querySelector(step.selector);
    if (!element) {
      throw new Error(`Element not found: ${step.selector}`);
    }
    return element.innerText;
  },

  collectLinks(step) {
    requireSelector(step);

    if (
      typeof step.linkSelector !== "string" ||
      step.linkSelector.length === 0
    ) {
      throw new Error('Step is missing a valid "linkSelector" string.');
    }

    const items = Array.from(document.querySelectorAll(step.selector));

    return items
      .map((item, index) => {
        const link =
          item.closest(step.linkSelector) ||
          item.querySelector(step.linkSelector);

        if (!link) {
          return null;
        }

        const url = link.href;

        const title =
          item.querySelector("[title]")?.getAttribute("title") ||
          item.innerText?.trim() ||
          link.innerText?.trim() ||
          `Video ${index + 1}`;

        return {
          index: index + 1,
          title,
          url,
        };
      })
      .filter(Boolean);
  },
};

function requireSelector(step) {
  if (typeof step.selector !== "string" || step.selector.length === 0) {
    throw new Error('Step is missing a valid "selector" string.');
  }
}

async function runScenario(scenario) {
  const variables = {};
  const steps = scenario.steps;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const action = ACTIONS[step.action];

    if (typeof action !== "function") {
      throw new Error(
        `Scenario failed at step ${i + 1}:\nUnknown action: "${step.action}"`
      );
    }

    try {
      const result = await action(step, variables);

      if (step.saveAs) {
        variables[step.saveAs] = result;
      }
    } catch (err) {
      throw new Error(
        `Scenario failed at step ${i + 1}:\nAction "${step.action}" failed:\n${err.message}`
      );
    }
  }

  return variables;
}

function serializeVariables(variables) {
  const result = {};

  for (const key of Object.keys(variables)) {
    const value = variables[key];

    if (value instanceof Element) {
      result[key] = `[Element: <${value.tagName.toLowerCase()}>]`;
    } else {
      result[key] = value;
    }
  }

  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "RUN_SCENARIO") {
    return undefined;
  }

  runScenario(message.scenario)
    .then((variables) => {
      sendResponse({
        success: true,
        variables: serializeVariables(variables),
      });
    })
    .catch((err) => {
      sendResponse({
        success: false,
        error: err.message,
      });
    });

  return true;
});