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
 *    This means the copy handler is fully synchronous - no async/await, so
 *    event.preventDefault() is guaranteed to fire in the same tick as the
 *    user gesture, which is required for clipboardData to be writable.
 *  - On load we do one async fetch to prime the cache.
 *  - When Firefox is preserving rich clipboard formats, the content script
 *    defers matching copies to the background poller instead of overwriting
 *    the clipboard with plain text.
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

function applyRules(text) {
  let result = text;
  let matched = false;

  for (const rule of cachedRules) {
    if (!rule.enabled) continue;
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

function notifyBackgroundOfHandledCopy(text, original) {
  browser.runtime.sendMessage({
    type: "content-copy-applied",
    text,
    original,
  }).catch(() => {});
}

function notifyBackgroundOfDeferredCopy() {
  browser.runtime.sendMessage({
    type: "content-copy-deferred",
  }).catch(() => {});
}

function notifyBackgroundOfUnmodifiedCopy(event) {
  setTimeout(() => {
    if (!event.defaultPrevented) {
      browser.runtime.sendMessage({
        type: "content-copy-unmodified",
      }).catch(() => {});
    }
  }, 0);
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

function selectionContainsRichMarkup() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  // Any element node means Firefox is likely building rich clipboard formats
  // that we should leave intact and handle via background polling instead.
  const fragment = selection.getRangeAt(0).cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  return Boolean(walker.nextNode());
}

document.addEventListener(
  "copy",
  (event) => {
    const selectedText = getSelectedText(event);
    if (!selectedText) return;

    const { result: modified, matched } = applyRules(selectedText);
    if (!matched || modified === selectedText) {
      notifyBackgroundOfUnmodifiedCopy(event);
      return;
    }

    if (selectionContainsRichMarkup()) {
      console.info("[Clipboard Modifier] Skipping rich-text copy transform to preserve clipboard formats.");
      notifyBackgroundOfDeferredCopy();
      return;
    }

    if (!event.clipboardData) {
      notifyBackgroundOfDeferredCopy();
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", modified);
    notifyBackgroundOfHandledCopy(modified, selectedText);
  },
  true
);
