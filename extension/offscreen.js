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

  if (message.type === "CREATE_BLOB_URL") {
    const parts = message.base64Parts.map(base64ToUint8Array);
    const blob = new Blob(parts, { type: message.mimeType });
    const blobUrl = URL.createObjectURL(blob);
    sendResponse({ blobUrl });
    return true;
  }

  if (message.type === "REVOKE_BLOB_URL") {
    URL.revokeObjectURL(message.blobUrl);
    return undefined;
  }

  return undefined;
});
