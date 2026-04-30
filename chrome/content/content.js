/**
 * content.js
 * Clipboard Modifier – Content Script
 *
 * Intercepts the "copy" event and applies regex rules to page-originated copy
 * actions. This covers both standard page selections and text selected inside
 * editable controls.
 */

let cachedRules = [];

function isIgnorableExtensionError(error) {
  return Boolean(error && /Extension context invalidated|Receiving end does not exist/i.test(String(error.message || error)));
}

function safeSendMessage(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        if (!isIgnorableExtensionError(error)) {
          console.warn("[Clipboard Modifier] Runtime message failed:", error);
        }
      });
    }
  } catch (error) {
    if (!isIgnorableExtensionError(error)) {
      console.warn("[Clipboard Modifier] Runtime message failed:", error);
    }
  }
}

try {
  chrome.storage.local.get("rules").then((stored) => {
    cachedRules = stored.rules || [];
  }).catch((error) => {
    if (!isIgnorableExtensionError(error)) {
      console.warn("[Clipboard Modifier] Failed to load rules:", error);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.rules) {
      cachedRules = changes.rules.newValue || [];
    }
  });
} catch (error) {
  if (!isIgnorableExtensionError(error)) {
    console.warn("[Clipboard Modifier] Storage wiring failed:", error);
  }
}

safeSendMessage({ type: "ensure-poller" });

function applyRules(text) {
  let result = text;
  for (const rule of cachedRules) {
    if (!rule.enabled) continue;
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "");
      result = result.replace(regex, rule.replacement);
    } catch (error) {
      console.warn(`[Clipboard Modifier] Bad regex in rule "${rule.name}": ${error.message}`);
    }
  }
  return result;
}

function notifyBackgroundOfHandledCopy(text, original) {
  safeSendMessage({
    type: "content-copy-applied",
    text,
    original,
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

function selectionContainsRichMarkup() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }

  const fragment = selection.getRangeAt(0).cloneContents();
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  return Boolean(walker.nextNode());
}

function notifyBackgroundOfUnmodifiedCopy(event) {
  setTimeout(() => {
    if (!event.defaultPrevented) {
      safeSendMessage({ type: "content-copy-unmodified" });
    }
  }, 0);
}

document.addEventListener(
  "copy",
  (event) => {
    const selectedText = getSelectedText(event);
    if (!selectedText) return;

    const modified = applyRules(selectedText);
    if (modified === selectedText) {
      notifyBackgroundOfUnmodifiedCopy(event);
      return;
    }

    if (selectionContainsRichMarkup()) {
      console.info("[Clipboard Modifier] Skipping rich-text copy transform to preserve clipboard formats.");
      notifyBackgroundOfUnmodifiedCopy(event);
      return;
    }

    if (!event.clipboardData) return;

    event.preventDefault();
    event.clipboardData.setData("text/plain", modified);
    notifyBackgroundOfHandledCopy(modified, selectedText);
  },
  true
);


