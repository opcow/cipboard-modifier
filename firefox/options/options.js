const btnExport        = document.getElementById("btn-export");
const btnImport        = document.getElementById("btn-import");
const importFileInput  = document.getElementById("import-file-input");
const ioError          = document.getElementById("io-error");
const ioStatus         = document.getElementById("io-status");
const importConfirm    = document.getElementById("import-confirm");
const importConfirmMsg = document.getElementById("import-confirm-msg");
const btnImportReplace = document.getElementById("btn-import-replace");
const btnImportAppend  = document.getElementById("btn-import-append");
const btnImportCancel  = document.getElementById("btn-import-cancel");

let rules = [];
let pendingImport = null;

async function loadRules() {
  const result = await browser.storage.local.get("rules");
  rules = result.rules || [];
}

async function saveRules() {
  await browser.storage.local.set({ rules });
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function showIoError(msg) {
  ioError.textContent = msg;
  ioError.classList.remove("hidden");
  ioStatus.classList.add("hidden");
}

function showIoStatus(msg) {
  ioStatus.textContent = msg;
  ioStatus.classList.remove("hidden");
  ioError.classList.add("hidden");
}

function clearIoMessages() {
  ioError.textContent = "";
  ioStatus.textContent = "";
  ioError.classList.add("hidden");
  ioStatus.classList.add("hidden");
}

function showImportConfirm(validated) {
  pendingImport = validated;
  importConfirmMsg.textContent =
    `Import ${validated.length} rule${validated.length !== 1 ? "s" : ""}. Replace all existing rules, or append?`;
  importConfirm.classList.remove("hidden");
}

function hideImportConfirm() {
  importConfirm.classList.add("hidden");
  pendingImport = null;
}

function validateImportedRule(raw, index) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Rule at index ${index} is not an object.`);
  }

  const pattern = raw.pattern;
  const flags = raw.flags ?? "";
  const name = raw.name ?? "";
  const replacement = raw.replacement ?? "";
  const enabled = raw.enabled !== false;

  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error(`Rule at index ${index} is missing a valid "pattern".`);
  }
  if (typeof flags !== "string") {
    throw new Error(`Rule at index ${index} has an invalid "flags" value.`);
  }

  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Rule at index ${index} has an invalid regex: ${error.message}`);
  }

  return {
    id: uid(),
    name: String(name).trim() || pattern,
    pattern,
    flags,
    replacement: String(replacement),
    enabled,
  };
}

btnImportCancel.addEventListener("click", () => {
  hideImportConfirm();
  showIoStatus("Import cancelled.");
});

btnImportReplace.addEventListener("click", async () => {
  if (!pendingImport) return;

  rules = pendingImport;
  hideImportConfirm();
  await saveRules();
  showIoStatus(`Imported ${rules.length} rule${rules.length !== 1 ? "s" : ""} (replaced existing).`);
});

btnImportAppend.addEventListener("click", async () => {
  if (!pendingImport) return;

  const validated = pendingImport;
  hideImportConfirm();

  const existingKeys = new Set(rules.map((rule) => `${rule.pattern}|${rule.flags}`));
  let skipped = 0;

  for (const rule of validated) {
    const key = `${rule.pattern}|${rule.flags}`;
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    rules.push(rule);
    existingKeys.add(key);
  }

  await saveRules();

  const added = validated.length - skipped;
  showIoStatus(
    `Added ${added} rule${added !== 1 ? "s" : ""}` +
    (skipped ? `, skipped ${skipped} duplicate${skipped !== 1 ? "s" : ""}.` : ".")
  );
});

btnExport.addEventListener("click", async () => {
  clearIoMessages();
  hideImportConfirm();
  await loadRules();

  if (rules.length === 0) {
    showIoError("No rules to export.");
    return;
  }

  const exportData = rules.map(({ id: _id, ...rest }) => rest);
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "clipboard-modifier-rules.json";
  anchor.click();
  URL.revokeObjectURL(url);

  showIoStatus(`Exported ${rules.length} rule${rules.length !== 1 ? "s" : ""}.`);
});

btnImport.addEventListener("click", () => {
  clearIoMessages();
  hideImportConfirm();
  importFileInput.value = "";
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.addEventListener("load", async () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      showIoError("Could not parse file. Make sure it is valid JSON.");
      return;
    }

    if (!Array.isArray(parsed)) {
      showIoError("Import file must contain a JSON array of rules.");
      return;
    }

    let validated;
    try {
      validated = parsed.map((raw, index) => validateImportedRule(raw, index));
    } catch (error) {
      showIoError(error.message);
      return;
    }

    if (validated.length === 0) {
      showIoError("The file contains no rules.");
      return;
    }

    await loadRules();

    if (rules.length === 0) {
      pendingImport = validated;
      btnImportReplace.click();
      return;
    }

    showImportConfirm(validated);
  });

  reader.addEventListener("error", () => {
    showIoError("Failed to read the file.");
  });

  reader.readAsText(file);
});

(async () => {
  await loadRules();
})();
