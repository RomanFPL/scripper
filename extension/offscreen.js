chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (message.type === "CREATE_BLOB_URL") {
    const blob = new Blob(message.buffers, { type: message.mimeType });
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
