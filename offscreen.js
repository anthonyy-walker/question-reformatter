// Hidden page that runs the on-device model when the service worker can't.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  const job = msg.type === "QR_LOCAL_STATUS" ? QRLocal.availability() : msg.type === "QR_LOCAL_RUN" ? QRLocal.run(msg.payload) : null;
  if (!job) return;
  job.then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
