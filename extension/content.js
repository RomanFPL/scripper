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

  async downloadHLS(step, variables) {
    const titleValue = step.title || variables[step.titleVar || "title"];
    const videoLabel = titleValue || step.url || "video";
    let playlistUrl = step.url || variables[step.urlVar || "url"];

    reportHLSProgress({ stage: "start", video: videoLabel });

    if (!playlistUrl) {
      reportHLSProgress({ stage: "detect-m3u8", video: videoLabel });
      const found = await findM3U8Urls();
      if (found.length === 0) {
        throw new Error("m3u8 playlist not found on the page");
      }
      reportHLSProgress({ stage: "candidates", video: videoLabel, candidates: found });
      playlistUrl = found[0];
    }

    reportHLSProgress({ stage: "playlist", video: videoLabel, url: playlistUrl });

    let playlistText = await fetchWithRetry(playlistUrl, {
      label: "playlist",
      video: videoLabel,
      as: "text",
    });

    reportHLSProgress({
      stage: "playlist-preview",
      video: videoLabel,
      url: playlistUrl,
      preview: playlistText.slice(0, 600),
    });

    if (!playlistText.includes("#EXTM3U")) {
      throw new Error(
        `Not an HLS playlist (missing #EXTM3U):\n${playlistText.slice(0, 300)}`
      );
    }

    let playlistBase = new URL("./", playlistUrl);

    if (playlistText.includes("#EXT-X-STREAM-INF")) {
      reportHLSProgress({ stage: "master-playlist", video: videoLabel });

      const lines = playlistText.split(/\r?\n/);
      let bestBandwidth = -1;
      let bestUri = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
        const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) : 0;

        let uriLine = null;
        for (let j = i + 1; j < lines.length; j++) {
          const candidate = lines[j].trim();
          if (!candidate || candidate.startsWith("#")) continue;
          uriLine = candidate;
          break;
        }

        if (uriLine && bandwidth >= bestBandwidth) {
          bestBandwidth = bandwidth;
          bestUri = uriLine;
        }
      }

      if (!bestUri) {
        throw new Error("Master playlist has no variant streams");
      }

      playlistUrl = new URL(bestUri, playlistBase).href;

      reportHLSProgress({
        stage: "variant-selected",
        video: videoLabel,
        url: playlistUrl,
        bandwidth: bestBandwidth,
      });

      playlistText = await fetchWithRetry(playlistUrl, {
        label: "media playlist",
        video: videoLabel,
        as: "text",
      });
      playlistBase = new URL("./", playlistUrl);

      if (!playlistText.includes("#EXTM3U")) {
        throw new Error("Selected variant is not a valid HLS playlist");
      }
    }

    const mapMatch = playlistText.match(/#EXT-X-MAP:.*?URI="([^"]+)"/i);

    const segmentUrls = playlistText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => new URL(line, playlistBase).href);

    if (segmentUrls.length === 0) {
      throw new Error("No media segments found in playlist");
    }

    let bytesDownloaded = 0;
    let outputExt = "mp4";
    let mimeType = "video/mp4";
    let partIndex = 0;

    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      if (mapMatch) {
        const initUrl = new URL(mapMatch[1], playlistBase).href;

        reportHLSProgress({ stage: "init", video: videoLabel, url: initUrl });

        const initBuffer = await fetchWithRetry(initUrl, {
          label: "init segment",
          video: videoLabel,
        });

        await sendChunk(sessionId, partIndex, initBuffer);
        partIndex++;
        bytesDownloaded += initBuffer.byteLength;
      } else {
        outputExt = "ts";
        mimeType = "video/mp2t";

        reportHLSProgress({
          stage: "no-init",
          video: videoLabel,
          message: "No #EXT-X-MAP — treating segments as plain MPEG-TS",
        });
      }

      reportHLSProgress({
        stage: "segment",
        video: videoLabel,
        segment: 0,
        totalSegments: segmentUrls.length,
        bytesDownloaded,
      });

      for (let i = 0; i < segmentUrls.length; i++) {
        const buffer = await fetchWithRetry(segmentUrls[i], {
          label: `segment ${i + 1}/${segmentUrls.length}`,
          video: videoLabel,
        });

        await sendChunk(sessionId, partIndex, buffer);
        partIndex++;
        bytesDownloaded += buffer.byteLength;

        reportHLSProgress({
          stage: "segment",
          video: videoLabel,
          segment: i + 1,
          totalSegments: segmentUrls.length,
          bytesDownloaded,
        });
      }

      const filename = sanitizeHLSFilename(
        step.filename || titleValue || document.title,
        outputExt
      );

      reportHLSProgress({
        stage: "saving",
        video: videoLabel,
        filename,
        bytes: bytesDownloaded,
      });

      const saveResponse = await chrome.runtime.sendMessage({
        type: "SAVE_FILE_FINALIZE",
        sessionId,
        filename,
        mimeType,
      });

      if (!saveResponse || !saveResponse.success) {
        throw new Error(
          (saveResponse && saveResponse.error) || "chrome.downloads.download failed"
        );
      }

      reportHLSProgress({
        stage: "done",
        video: videoLabel,
        filename,
        bytes: bytesDownloaded,
        downloadId: saveResponse.downloadId,
      });

      return {
        filename,
        bytes: bytesDownloaded,
        segments: segmentUrls.length,
        url: playlistUrl,
        downloadId: saveResponse.downloadId,
      };
    } catch (err) {
      chrome.runtime.sendMessage({ type: "SAVE_FILE_ABORT", sessionId }).catch(() => {});
      throw err;
    }
  },
};

function requireSelector(step) {
  if (typeof step.selector !== "string" || step.selector.length === 0) {
    throw new Error('Step is missing a valid "selector" string.');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeHLSFilename(name, ext = "mp4") {
  let clean = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\/\\:*?"<>|]/g, "_");

  if (!clean) {
    clean = "video";
  }
  if (!/\.(mp4|ts)$/i.test(clean)) {
    clean += `.${ext}`;
  }
  return clean;
}

function reportHLSProgress(data) {
  console.log("[Video Runner][HLS]", data);
  try {
    chrome.runtime.sendMessage({ type: "HLS_PROGRESS", ...data });
  } catch (err) {}
}

async function findM3U8Urls() {
  const collect = () => {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /\.m3u8(?:[?#]|$)/i.test(url));
    return [...new Set(urls)];
  };

  let urls = collect();
  for (let i = 0; i < 20 && urls.length === 0; i++) {
    await sleep(500);
    urls = collect();
  }
  return urls;
}

async function fetchWithRetry(url, {
  label = "",
  video = "",
  retries = 3,
  delayMs = 1000,
  timeoutMs = 30000,
  as = "arraybuffer",
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = as === "text" ? await response.text() : await response.arrayBuffer();
      clearTimeout(timer);
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === "AbortError"
        ? new Error(`Timed out after ${timeoutMs}ms`)
        : err;

      reportHLSProgress({
        stage: "retry",
        video,
        label,
        attempt,
        retries,
        error: lastError.message,
      });
      if (attempt < retries) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw new Error(`${label} failed after ${retries} attempts: ${lastError.message}`);
}

async function sendChunk(sessionId, index, buffer) {
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_CHUNK",
    sessionId,
    index,
    base64: arrayBufferToBase64(buffer),
  });

  if (!response || !response.success) {
    throw new Error(
      (response && response.error) || "Failed to send a downloaded chunk to background.js"
    );
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
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