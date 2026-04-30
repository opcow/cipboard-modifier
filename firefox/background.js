/**
 * background.js
 * Clipboard Modifier – Background Script
 *
 * Polls the clipboard only while Firefox is the foreground app so browser UI
 * copies (for example the URL bar) can be transformed without touching the
 * clipboard while Firefox is in the background.
 *
 * Content scripts notify the background script when they already handled a copy,
 * when a copy was unchanged, or when the copy must be deferred to background
 * polling because Firefox is preserving rich clipboard formats.
 */

const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 4000;
const CONTENT_WRITE_GRACE_MS = 1500;
const BADGE_TEXT = "✓";
const BADGE_COLOR = "#89b4fa";

let lastClipboard = "";
let cachedRules = [];
let lastContentWrite = { text: "", expiresAt: 0 };
let pollInFlight = false;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let pollTimerId = null;
let pollingEnabled = true;
let browserHasFocus = false;
let badgeActive = false;
let lastOriginalText = "";

function getEnabledRules() {
  return cachedRules.filter((rule) => rule.enabled);
}

function shouldPollClipboard() {
  return pollingEnabled && browserHasFocus && getEnabledRules().length > 0;
}

function applyRules(text, rules) {
  let result = text;
  let matched = false;

  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      if (regex.test(text)) {
        matched = true;
      }
      result = result.replace(regex, rule.replacement);
    } catch (e) {
      console.warn(`[Clipboard Modifier] Bad regex in rule "${rule.name}": ${e.message}`);
    }
  }

  return { result, matched };
}

function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rounded));
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

function updateBadge(active) {
  badgeActive = active;
  browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  browser.browserAction.setBadgeText({ text: active ? BADGE_TEXT : "" }).catch(() => {});
}

function setMatchedState(modifiedText, originalText) {
  lastClipboard = modifiedText;
  lastOriginalText = originalText;
  updateBadge(true);
}

function clearMatchedState(currentClipboard = lastClipboard) {
  lastClipboard = currentClipboard;
  lastOriginalText = "";
  updateBadge(false);
}

function requestImmediatePoll() {
  lastClipboard = "";
  if (!shouldPollClipboard()) {
    return Promise.resolve({ ok: false });
  }

  // Force a fresh pass after deferred page copies so an unchanged clipboard
  // value from a prior browser-UI copy does not suppress rule evaluation.
  return poll().then(() => ({ ok: true })).catch(() => ({ ok: false }));
}

function restartPolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }

  if (!shouldPollClipboard()) {
    return;
  }

  void poll();
  pollTimerId = setInterval(poll, pollIntervalMs);
}

function handleWindowFocusChanged(windowId) {
  browserHasFocus = windowId !== browser.windows.WINDOW_ID_NONE;
  restartPolling();
}

async function primeBrowserFocus() {
  try {
    const focusedWindow = await browser.windows.getLastFocused();
    browserHasFocus = Boolean(focusedWindow?.focused);
  } catch {
    browserHasFocus = false;
  }

  restartPolling();
}

browser.storage.local.get(["rules", "pollIntervalMs", "pollingEnabled"]).then((stored) => {
  cachedRules = stored.rules || [];
  pollIntervalMs = normalizePollInterval(stored.pollIntervalMs);
  pollingEnabled = stored.pollingEnabled !== false;
  updateBadge(false);
  primeBrowserFocus();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.rules) {
    cachedRules = changes.rules.newValue || [];
    restartPolling();
  }

  if (changes.pollIntervalMs) {
    pollIntervalMs = normalizePollInterval(changes.pollIntervalMs.newValue);
    restartPolling();
  }

  if (changes.pollingEnabled) {
    pollingEnabled = changes.pollingEnabled.newValue !== false;
    restartPolling();
  }
});

browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);

async function forceApplyRules() {
  if (!shouldPollClipboard()) {
    return { ok: false };
  }

  let current;
  try {
    current = await readClipboardText();
  } catch {
    return { ok: false };
  }

  const { result: modified, matched } = applyRules(current, getEnabledRules());
  if (matched && modified !== current) {
    try {
      if (!shouldPollClipboard()) {
        lastClipboard = current;
        return { ok: false };
      }
      await writeClipboardText(modified);
      return { ok: true, modified: true, original: current, text: modified };
    } catch {
      lastClipboard = current;
      return { ok: false };
    }
  }

  lastClipboard = current;
  return { ok: true, modified: false };
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "content-copy-applied") {
    lastContentWrite = {
      text: message.text || "",
      expiresAt: Date.now() + CONTENT_WRITE_GRACE_MS,
    };

    if (lastContentWrite.text) {
      setMatchedState(lastContentWrite.text, message.original || "");
    }

    return undefined;
  }

  if (message?.type === "content-copy-unmodified") {
    clearMatchedState();
    return Promise.resolve({ ok: true });
  }

  if (message?.type === "content-copy-deferred") {
    clearMatchedState("");
    return requestImmediatePoll();
  }

  if (message?.type === "get-badge-state") {
    return Promise.resolve({ badgeActive, canUndo: !!lastOriginalText });
  }

  if (message?.type === "apply-rules-now") {
    return forceApplyRules().then((result) => {
      if (!result?.ok) {
        return { ok: false, modified: false };
      }

      if (result.modified && result.original) {
        setMatchedState(result.text || lastClipboard, result.original);
        return { ok: true, modified: true };
      }

      clearMatchedState(lastClipboard);
      return { ok: true, modified: false };
    }).catch(() => ({ ok: false, modified: false }));
  }

  if (message?.type === "undo-replacement") {
    if (!lastOriginalText) {
      return Promise.resolve({ ok: false });
    }

    const original = lastOriginalText;
    return writeClipboardText(original).then(() => {
      clearMatchedState(original);
      return { ok: true };
    }).catch(() => ({ ok: false }));
  }

  return undefined;
});

function wasHandledByContentScript(text) {
  if (!text) return false;
  if (Date.now() > lastContentWrite.expiresAt) return false;
  return text === lastContentWrite.text;
}

async function poll() {
  if (pollInFlight || !shouldPollClipboard()) return;
  pollInFlight = true;

  try {
    if (!shouldPollClipboard()) return;

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

    if (!shouldPollClipboard()) {
      return;
    }

    const { result: modified, matched } = applyRules(current, getEnabledRules());
    if (matched && modified !== current) {
      try {
        if (!shouldPollClipboard()) {
          lastClipboard = current;
          return;
        }
        await writeClipboardText(modified);
        setMatchedState(modified, current);
      } catch {
        clearMatchedState(current);
      }
    } else {
      clearMatchedState(current);
    }
  } finally {
    pollInFlight = false;
  }
}



