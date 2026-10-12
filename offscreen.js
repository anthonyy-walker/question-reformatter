// Hidden page that runs the on-device model. It stays open, so the model and its
// warm sessions stay loaded between rewrites (the service worker gets shut down when idle).
const jobs = new Map(); // jobId -> AbortController

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  let job = null;
  if (msg.type === "QR_LOCAL_STATUS") job = QRLocal.availability();
  else if (msg.type === "QR_LOCAL_WARM") job = QRLocal.warm(msg.payload.systems);
  else if (msg.type === "QR_LOCAL_ABORT") { const c = jobs.get(msg.payload.jobId); if (c) c.abort(); job = Promise.resolve(true); }
  else if (msg.type === "QR_LOCAL_RUN") {
    const ctrl = new AbortController();
    const { jobId, ...rest } = msg.payload;
    if (jobId) jobs.set(jobId, ctrl);
    job = QRLocal.run({ ...rest, signal: ctrl.signal }).finally(() => jobs.delete(jobId));
  }
  if (!job) return;
  job.then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e), aborted: !!(e && e.name === "AbortError") }));
  return true;
});
