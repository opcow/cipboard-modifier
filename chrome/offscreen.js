const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 4000;
const CONTENT_WRITE_GRACE_MS = 1500;
const STATE_REFRESH_MS = 15000;

let lastClipboard = "";
let lastContentWrite = { text: "", expiresAt: 0 };
let pollInFlight = false;
let pollTimerId = null;
let stateRefreshTimerId = null;
let currentState = {
  rules: [],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  pollingEnabled: true,
  browserHasFocus: true,
};

function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rounded));
}

function getEnabledRules() {
  return (currentState.rules || []).filter((rule) => rule.enabled);
}

function applyRules(text, rules) {
  let result = text;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      result = result.replace(regex, rule.replacement);
    } catch (error) {
      console.warn(`[Clipboard Modifier] Bad regex in rule "${rule.name}": ${error.message}`);
    }
  }
  return result;
}

function wasHandledByContentScript(text) {
  if (!text) return false;
  if (Date.now() > lastContentWrite.expiresAt) return false;
  return text === lastContentWrite.text;
}

function notifyClipboardState(type) {
  chrome.runtime.sendMessage({ type }).catch(() => {
    // Ignore transient badge-sync failures.
  });
}

function restartPolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }

  if (!currentState.pollingEnabled || !currentState.browserHasFocus) {
    return;
  }

  void poll();
  pollTimerId = setInterval(poll, currentState.pollIntervalMs);
}

function updateState(nextState) {
  currentState = {
    rules: nextState.rules || [],
    pollIntervalMs: normalizePollInterval(nextState.pollIntervalMs),
    pollingEnabled: nextState.pollingEnabled !== false,
    browserHasFocus: nextState.browserHasFocus !== false,
  };

  restartPolling();
}

function createClipboardTextarea(value = "") {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  return textarea;
}

async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    const textarea = createClipboardTextarea();
    textarea.focus();
    textarea.select();

    const pasted = document.execCommand("paste");
    const value = textarea.value;
    textarea.remove();

    if (!pasted && !value) {
      throw new Error("Clipboard paste command failed.");
    }

    return value;
  }
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = createClipboardTextarea(text);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    if (!copied) {
      throw new Error("Clipboard copy command failed.");
    }
  }
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    let current;
    try {
      current = await readClipboardText();
    } catch {
      return;
    }

    if (current === lastClipboard) return;

    if (wasHandledByContentScript(current)) {
      lastClipboard = current;
      return;
    }

    const modified = applyRules(current, getEnabledRules());
    if (modified !== current) {
      try {
        await writeClipboardText(modified);
        lastClipboard = modified;
        notifyClipboardState("clipboard-modified");
      } catch {
        lastClipboard = current;
        notifyClipboardState("clipboard-cleared");
      }
    } else {
      lastClipboard = current;
      notifyClipboardState("clipboard-cleared");
    }
  } finally {
    pollInFlight = false;
  }
}

async function refreshStateFromServiceWorker() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "offscreen-sync-request" });
    if (response?.state) {
      updateState(response.state);
    }
  } catch {
    // Ignore transient service worker wake/suspend races.
  }
}

function ensureStateRefreshLoop() {
  if (stateRefreshTimerId !== null) {
    return;
  }

  stateRefreshTimerId = setInterval(() => {
    void refreshStateFromServiceWorker();
  }, STATE_REFRESH_MS);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "offscreen-sync-state") {
    updateState(message.state || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "content-copy-applied") {
    lastContentWrite = {
      text: message.text || "",
      expiresAt: Date.now() + CONTENT_WRITE_GRACE_MS,
    };

    if (lastContentWrite.text) {
      lastClipboard = lastContentWrite.text;
    }

    sendResponse({ ok: true });
    return false;
  }

  return undefined;
});

chrome.runtime.sendMessage({ type: "offscreen-ready" }, (response) => {
  if (chrome.runtime.lastError) {
    console.warn("[Clipboard Modifier] Offscreen ready handshake failed:", chrome.runtime.lastError.message);
    return;
  }

  if (response?.state) {
    updateState(response.state);
  }
});

ensureStateRefreshLoop();
void refreshStateFromServiceWorker();
