/**
 * content.js
 * Clipboard Modifier – Content Script
 *
 * Intercepts the "copy" event and applies regex rules to page-originated copy
 * actions. This covers both standard page selections and text selected inside
 * editable controls.
 *
 * Key design decisions:
 *  - Rules are cached in memory and kept fresh via a storage change listener.
 *    This means the copy handler is fully synchronous — no async/await, so
 *    event.preventDefault() is guaranteed to fire in the same tick as the
 *    user gesture, which is required for clipboardData to be writable.
 *  - On load we do one async fetch to prime the cache.
 */

let cachedRules = [];

/** Prime the cache from storage on script load. */
browser.storage.local.get("rules").then((stored) => {
  cachedRules = stored.rules || [];
});

/** Keep the cache fresh whenever rules are changed in the popup. */
browser.storage.onChanged.addListener((changes) => {
  if (changes.rules) {
    cachedRules = changes.rules.newValue || [];
  }
});

/**
 * Apply all enabled regex rules to a string.
 * @param {string} text
 * @returns {string}
 */
function applyRules(text) {
  let result = text;
  for (const rule of cachedRules) {
    if (!rule.enabled) continue;
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      result = result.replace(regex, rule.replacement);
    } catch (e) {
      console.warn(`[Clipboard Modifier] Bad regex in rule "${rule.name}": ${e.message}`);
    }
  }
  return result;
}

function notifyBackgroundOfHandledCopy(text) {
  browser.runtime.sendMessage({
    type: "content-copy-applied",
    text,
  }).catch(() => {
    // Ignore transient messaging failures; the copy already succeeded.
  });
}

function getSelectionFromEditable(element) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return "";
  }

  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (typeof start !== "number" || typeof end !== "number" || start === end) {
    return "";
  }

  return element.value.slice(start, end);
}

function getSelectedText(event) {
  const activeElement = document.activeElement;
  const target = event.target;

  const editableSelection = getSelectionFromEditable(target) || getSelectionFromEditable(activeElement);
  if (editableSelection) {
    return editableSelection;
  }

  return window.getSelection()?.toString() || "";
}

/**
 * Synchronous copy handler.
 * event.preventDefault() MUST be called in the same tick as the event
 * for clipboardData.setData() to work — no async/await here.
 */
document.addEventListener(
  "copy",
  (event) => {
    const selectedText = getSelectedText(event);
    if (!selectedText) return;

    const modified = applyRules(selectedText);
    if (modified === selectedText) return;
    if (!event.clipboardData) return;

    event.preventDefault();
    event.clipboardData.setData("text/plain", modified);
    notifyBackgroundOfHandledCopy(modified);
  },
  true // Capture phase.
);