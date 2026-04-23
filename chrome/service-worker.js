const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 4000;
const OFFSCREEN_URL = "offscreen.html";
const BADGE_TEXT = "✓";
const BADGE_COLOR = "#89b4fa";

let cachedState = {
  rules: [],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  pollingEnabled: true,
  browserHasFocus: true,
};

let creatingOffscreen = null;
let initializing = null;
let badgeActive = false;

function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rounded));
}

async function loadState() {
  const stored = await chrome.storage.local.get(["rules", "pollIntervalMs", "pollingEnabled"]);
  cachedState.rules = stored.rules || [];
  cachedState.pollIntervalMs = normalizePollInterval(stored.pollIntervalMs);
  cachedState.pollingEnabled = stored.pollingEnabled !== false;
}

async function updateBrowserFocus() {
  try {
    const focusedWindow = await chrome.windows.getLastFocused();
    cachedState.browserHasFocus = Boolean(focusedWindow?.focused);
  } catch {
    cachedState.browserHasFocus = true;
  }
}

async function hasOffscreenDocument(offscreenUrl) {
  if ("getContexts" in chrome.runtime) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });

    return existingContexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const hasDocument = await hasOffscreenDocument(offscreenUrl);

  if (hasDocument) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["CLIPBOARD"],
    justification: "Poll the clipboard for browser UI copy sources such as the URL bar.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function sendOffscreenMessage(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message);
}

async function syncOffscreenState() {
  await sendOffscreenMessage({
    type: "offscreen-sync-state",
    state: cachedState,
  });
}

async function updateBadge(active) {
  if (badgeActive === active) {
    return;
  }

  badgeActive = active;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: active ? BADGE_TEXT : "" });
}

async function initialize() {
  if (initializing) {
    await initializing;
    return;
  }

  initializing = (async () => {
    await loadState();
    await updateBrowserFocus();
    await updateBadge(false);
    await syncOffscreenState();
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => {
    console.error("[Clipboard Modifier] Failed to initialize on install:", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => {
    console.error("[Clipboard Modifier] Failed to initialize on startup:", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  let shouldSync = false;

  if (changes.rules) {
    cachedState.rules = changes.rules.newValue || [];
    shouldSync = true;
  }

  if (changes.pollIntervalMs) {
    cachedState.pollIntervalMs = normalizePollInterval(changes.pollIntervalMs.newValue);
    shouldSync = true;
  }

  if (changes.pollingEnabled) {
    cachedState.pollingEnabled = changes.pollingEnabled.newValue !== false;
    shouldSync = true;
  }

  if (shouldSync) {
    syncOffscreenState().catch((error) => {
      console.error("[Clipboard Modifier] Failed to sync storage changes:", error);
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  cachedState.browserHasFocus = windowId !== chrome.windows.WINDOW_ID_NONE;
  syncOffscreenState().catch((error) => {
    console.error("[Clipboard Modifier] Failed to sync focus change:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ensure-poller") {
    initialize()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[Clipboard Modifier] Failed to ensure poller:", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === "content-copy-applied") {
    sendOffscreenMessage(message)
      .then(() => updateBadge(Boolean(message.text)))
      .then(() => syncOffscreenState())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[Clipboard Modifier] Failed to forward content copy:", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === "clipboard-modified") {
    updateBadge(true)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "clipboard-cleared") {
    updateBadge(false)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "offscreen-ready") {
    sendResponse({ ok: true, state: cachedState });
    return false;
  }

  if (message?.type === "offscreen-sync-request") {
    sendResponse({ ok: true, state: cachedState });
    return false;
  }

  return undefined;
});

initialize().catch((error) => {
  console.error("[Clipboard Modifier] Initial startup failed:", error);
});

