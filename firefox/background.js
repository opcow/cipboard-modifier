/**
 * background.js
 * Clipboard Modifier – Background Script
 *
 * Polls the clipboard for browser-level copy sources that content scripts
 * cannot intercept, such as the URL bar and browser chrome UI.
 *
 * Rules are cached in memory and kept fresh via storage.onChanged so the poll
 * loop avoids storage reads. Content scripts notify the background script when
 * they already handled a page copy, which prevents a second rule pass from the
 * poller.
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
let browserHasFocus = true;
let badgeActive = false;

function getEnabledRules() {
  return cachedRules.filter((r) => r.enabled);
}

function applyRules(text, rules) {
  let result = text;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      result = result.replace(regex, rule.replacement);
    } catch (e) {
      console.warn(`[Clipboard Modifier] Bad regex in rule "${rule.name}": ${e.message}`);
    }
  }
  return result;
}

function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rounded));
}

function updateBadge(active) {
  if (badgeActive === active) {
    return;
  }

  badgeActive = active;
  browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLOR }).catch(() => {});
  browser.browserAction.setBadgeText({ text: active ? BADGE_TEXT : "" }).catch(() => {});
}

function restartPolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }

  if (!pollingEnabled || !browserHasFocus) {
    return;
  }

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
    browserHasFocus = true;
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

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "content-copy-applied") {
    return undefined;
  }

  lastContentWrite = {
    text: message.text || "",
    expiresAt: Date.now() + CONTENT_WRITE_GRACE_MS,
  };

  if (lastContentWrite.text) {
    lastClipboard = lastContentWrite.text;
    updateBadge(true);
  }

  return undefined;
});

function wasHandledByContentScript(text) {
  if (!text) return false;
  if (Date.now() > lastContentWrite.expiresAt) return false;
  return text === lastContentWrite.text;
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    let current;
    try {
      current = await navigator.clipboard.readText();
    } catch {
      return;
    }

    if (current === lastClipboard) return;

    if (wasHandledByContentScript(current)) {
      lastClipboard = current;
      return;
    }

    const rules = getEnabledRules();
    const modified = applyRules(current, rules);

    if (modified !== current) {
      try {
        await navigator.clipboard.writeText(modified);
        lastClipboard = modified;
        updateBadge(true);
      } catch {
        lastClipboard = current;
        updateBadge(false);
      }
    } else {
      lastClipboard = current;
      updateBadge(false);
    }
  } finally {
    pollInFlight = false;
  }
}

