import { createSpectrumWorkerBridge } from "spectrum-ts/adapters/vercel-ai-sdk";

function getDemoUser(request: Request) {
  // Replace this demo identity with your real app auth/session lookup.
  // This id becomes part of the web space id: web:<userId>:<chatId>.
  return {
    id: request.headers.get("x-demo-user-id") ?? "local-browser-user",
  };
}

export const POST = createSpectrumWorkerBridge({
  apiKey: process.env.SPECTRUM_WORKER_API_KEY,
  getUser: getDemoUser,
  timeoutMs: 30_000,
  // The worker must be running with webBridge.config({ server: ... }) at this
  // URL. In local demos, examples/progressive-provider-worker owns it.
  workerUrl:
    process.env.SPECTRUM_WORKER_URL ??
    "http://127.0.0.1:8787/spectrum/web/messages",
});
