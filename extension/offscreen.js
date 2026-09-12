const sessions = new Map();

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (message.type === "APPEND_CHUNK") {
    let chunks = sessions.get(message.sessionId);

    if (!chunks) {
      chunks = [];
      sessions.set(message.sessionId, chunks);
    }

    chunks[message.index] = base64ToUint8Array(message.base64);

    sendResponse({ success: true });
    return true;
  }

  if (message.type === "FINALIZE_BLOB") {
    const chunks = sessions.get(message.sessionId) || [];
    sessions.delete(message.sessionId);

    if (chunks.length === 0 || chunks.includes(undefined)) {
      sendResponse({ error: "Missing chunks — some parts never arrived" });
      return true;
    }

    const blob = new Blob(chunks, { type: message.mimeType });

    if (blob.size === 0) {
      sendResponse({ error: "Assembled blob is empty (0 bytes)" });
      return true;
    }

    const blobUrl = URL.createObjectURL(blob);

    sendResponse({ blobUrl, blobSize: blob.size });
    return true;
  }

  if (message.type === "ABORT_SESSION") {
    sessions.delete(message.sessionId);
    return undefined;
  }

  if (message.type === "REVOKE_BLOB_URL") {
    URL.revokeObjectURL(message.blobUrl);
    return undefined;
  }

  return undefined;
});
