/**
 * popup.js
 * Clipboard Modifier – Popup Logic
 *
 * Manages the list of regex rules stored in browser.storage.local.
 * Each rule object:
 * {
 *   id:          string  (uuid-like, generated on creation)
 *   name:        string
 *   pattern:     string  (regex source)
 *   flags:       string  (e.g. "gi")
 *   replacement: string
 *   enabled:     boolean
 * }
 */

const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 4000;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const rulesList           = document.getElementById("rules-list");
const noRulesMsg          = document.getElementById("no-rules-msg");
const formTitle           = document.getElementById("form-title");
const inputName           = document.getElementById("rule-name");
const inputPattern        = document.getElementById("rule-pattern");
const inputFlags          = document.getElementById("rule-flags");
const inputReplace        = document.getElementById("rule-replacement");
const formError           = document.getElementById("form-error");
const btnSave             = document.getElementById("btn-save");
const btnCancel           = document.getElementById("btn-cancel");
const inputPollInterval   = document.getElementById("poll-interval");
const inputPollingEnabled = document.getElementById("polling-enabled");
const btnPollingHelp      = document.getElementById("btn-polling-help");
const pollingHelp         = document.getElementById("polling-help");
const settingsError       = document.getElementById("settings-error");
const settingsStatus      = document.getElementById("settings-status");
const btnSaveSettings     = document.getElementById("btn-save-settings");
const btnOpenImportExport = document.getElementById("btn-open-import-export");

// ── State ─────────────────────────────────────────────────────────────────────
let rules = [];
let editingId = null; // null = adding new rule
let pollingEnabled = true;
let pollingHelpOpen = false;

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadState() {
  const result = await browser.storage.local.get(["rules", "pollIntervalMs", "pollingEnabled"]);
  rules = result.rules || [];
  inputPollInterval.value = normalizePollInterval(result.pollIntervalMs);
  pollingEnabled = result.pollingEnabled !== false;
  inputPollingEnabled.checked = pollingEnabled;
  syncPollingControls();
}

async function saveRules() {
  await browser.storage.local.set({ rules });
}

async function savePollInterval(pollIntervalMs) {
  await browser.storage.local.set({ pollIntervalMs });
}

async function savePollingEnabled(enabled) {
  await browser.storage.local.set({ pollingEnabled: enabled });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function normalizePollInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const rounded = Math.round(numeric);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rounded));
}

function showSettingsError(msg) {
  settingsError.textContent = msg;
  settingsError.classList.remove("hidden");
}

function clearSettingsError() {
  settingsError.textContent = "";
  settingsError.classList.add("hidden");
}

function showSettingsStatus(msg) {
  settingsStatus.textContent = msg;
  settingsStatus.classList.remove("hidden");
}

function clearSettingsStatus() {
  settingsStatus.textContent = "";
  settingsStatus.classList.add("hidden");
}

function syncPollingControls() {
  inputPollInterval.disabled = !pollingEnabled;
}

function setPollingHelpOpen(isOpen) {
  pollingHelpOpen = isOpen;
  pollingHelp.classList.toggle("hidden", !isOpen);
  btnPollingHelp.setAttribute("aria-expanded", String(isOpen));
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  rulesList.innerHTML = "";
  noRulesMsg.classList.toggle("hidden", rules.length > 0);

  for (const rule of rules) {
    const card = document.createElement("div");
    card.className = "rule-card" + (rule.enabled ? "" : " disabled");
    card.dataset.id = rule.id;

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "rule-toggle";
    toggle.checked = rule.enabled;
    toggle.title = rule.enabled ? "Disable rule" : "Enable rule";
    toggle.addEventListener("change", () => toggleRule(rule.id, toggle.checked));

    const info = document.createElement("div");
    info.className = "rule-info";

    const nameEl = document.createElement("div");
    nameEl.className = "rule-name";
    nameEl.textContent = rule.name || "(unnamed)";

    const patEl = document.createElement("div");
    patEl.className = "rule-pattern";
    patEl.textContent = `/${rule.pattern}/${rule.flags}  →  ${rule.replacement || "«empty»"}`;

    info.append(nameEl, patEl);

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn-icon";
    editBtn.title = "Edit";
    editBtn.textContent = "✏️";
    editBtn.addEventListener("click", () => startEdit(rule.id));

    const upBtn = document.createElement("button");
    upBtn.className = "btn-icon";
    upBtn.title = "Move up";
    upBtn.textContent = "⬆️";
    upBtn.addEventListener("click", () => moveRule(rule.id, -1));

    const downBtn = document.createElement("button");
    downBtn.className = "btn-icon";
    downBtn.title = "Move down";
    downBtn.textContent = "⬇️";
    downBtn.addEventListener("click", () => moveRule(rule.id, +1));

    const delBtn = document.createElement("button");
    delBtn.className = "btn-icon delete";
    delBtn.title = "Delete";
    delBtn.textContent = "🗑️";
    delBtn.addEventListener("click", () => deleteRule(rule.id));

    actions.append(editBtn, upBtn, downBtn, delBtn);
    card.append(toggle, info, actions);
    rulesList.appendChild(card);
  }
}

// ── Rule operations ───────────────────────────────────────────────────────────
async function toggleRule(id, enabled) {
  const rule = rules.find((r) => r.id === id);
  if (rule) {
    rule.enabled = enabled;
    await saveRules();
    render();
  }
}

async function deleteRule(id) {
  rules = rules.filter((r) => r.id !== id);
  if (editingId === id) cancelEdit();
  await saveRules();
  render();
}

async function moveRule(id, direction) {
  const idx = rules.findIndex((r) => r.id === id);
  const target = idx + direction;
  if (target < 0 || target >= rules.length) return;
  [rules[idx], rules[target]] = [rules[target], rules[idx]];
  await saveRules();
  render();
}

// ── Form logic ────────────────────────────────────────────────────────────────
function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove("hidden");
}

function clearError() {
  formError.textContent = "";
  formError.classList.add("hidden");
}

function startEdit(id) {
  editingId = id;
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;

  formTitle.textContent = "Edit Rule";
  inputName.value = rule.name;
  inputPattern.value = rule.pattern;
  inputFlags.value = rule.flags;
  inputReplace.value = rule.replacement;
  btnSave.textContent = "Update Rule";
  btnCancel.classList.remove("hidden");
  clearError();
  inputName.focus();
}

function cancelEdit() {
  editingId = null;
  formTitle.textContent = "Add Rule";
  inputName.value = inputPattern.value = inputFlags.value = inputReplace.value = "";
  btnSave.textContent = "Save Rule";
  btnCancel.classList.add("hidden");
  clearError();
}

btnCancel.addEventListener("click", cancelEdit);

btnSave.addEventListener("click", async () => {
  clearError();

  const name = inputName.value.trim();
  const pattern = inputPattern.value.trim();
  const flags = inputFlags.value.trim();
  const replace = inputReplace.value;

  if (!pattern) {
    showError("Pattern is required.");
    return;
  }

  try {
    new RegExp(pattern, flags);
  } catch (e) {
    showError(`Invalid regex: ${e.message}`);
    return;
  }

  if (editingId) {
    const rule = rules.find((r) => r.id === editingId);
    if (rule) {
      rule.name = name || pattern;
      rule.pattern = pattern;
      rule.flags = flags;
      rule.replacement = replace;
    }
    cancelEdit();
  } else {
    rules.push({
      id: uid(),
      name: name || pattern,
      pattern,
      flags,
      replacement: replace,
      enabled: true,
    });
    inputName.value = inputPattern.value = inputFlags.value = inputReplace.value = "";
  }

  await saveRules();
  render();
});

btnSaveSettings.addEventListener("click", async () => {
  clearSettingsError();
  clearSettingsStatus();

  if (!pollingEnabled) {
    showSettingsStatus("Clipboard polling is disabled.");
    return;
  }

  const rawValue = inputPollInterval.value.trim();
  const numeric = Number(rawValue);

  if (!rawValue) {
    showSettingsError("Polling interval is required.");
    return;
  }

  if (!Number.isFinite(numeric) || numeric < MIN_POLL_INTERVAL_MS || numeric > MAX_POLL_INTERVAL_MS) {
    showSettingsError(`Enter a value from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS} ms.`);
    return;
  }

  const pollIntervalMs = normalizePollInterval(numeric);
  inputPollInterval.value = pollIntervalMs;
  await savePollInterval(pollIntervalMs);
  showSettingsStatus("Polling interval saved.");
});

inputPollingEnabled.addEventListener("change", async () => {
  pollingEnabled = inputPollingEnabled.checked;
  clearSettingsError();
  clearSettingsStatus();
  syncPollingControls();
  await savePollingEnabled(pollingEnabled);
  showSettingsStatus(
    pollingEnabled ? "Clipboard polling enabled." : "Clipboard polling disabled."
  );
});

btnPollingHelp.addEventListener("click", () => {
  setPollingHelpOpen(!pollingHelpOpen);
});

// ── Custom spin buttons ───────────────────────────────────────────────────────
const spinUp   = document.getElementById("spin-up");
const spinDown = document.getElementById("spin-down");

function stepInput(direction) {
  if (inputPollInterval.disabled) return;
  const step = Number(inputPollInterval.step) || 1;
  const current = Number(inputPollInterval.value) || normalizePollInterval(null);
  const next = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, current + direction * step));
  inputPollInterval.value = next;
  inputPollInterval.dispatchEvent(new Event("input"));
}

spinUp.addEventListener("click",   () => stepInput(+1));
spinDown.addEventListener("click", () => stepInput(-1));

btnOpenImportExport.addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadState();
  setPollingHelpOpen(false);
  render();
})();
