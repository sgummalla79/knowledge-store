import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { initShell } from "./shell";

interface AppConfig {
  api_base_url: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

interface Library {
  id: string;
  name: string;
  description: string | null;
  document_count: number;
  chunk_count: number;
}

interface LibraryDocument {
  id: string;
  library_id: string;
  source_filename: string;
  file_type: string;
  status: string;
  ingested_at: string | null;
  created_at: string;
}

interface EmbeddingOptions {
  providers: { name: string; models: string[] }[];
  default_provider: string;
  default_model: string;
  dimensions: number;
}

interface EmbeddingSettingsStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
  chunk_size: number;
  chunk_overlap: number;
  updated_at: string | null;
}

interface RerankOptions {
  providers: { name: string; models: string[] }[];
  default_provider: string;
  default_model: string;
}

interface SearchSettingsStatus {
  rerank_enabled: boolean;
  rerank_provider: string;
  rerank_model: string;
  dense_k: number;
  sparse_k: number;
  rerank_candidates: number;
  rrf_k: number;
  updated_at: string | null;
}

interface AppError {
  code: string;
  message: string;
}

// Rust's map_response serializes invoke() rejections as a JSON string ({"code","message"}),
// not a plain message — so we can branch on `code` (e.g. "unauthorized") instead of scraping text.
function parseError(error: unknown): AppError {
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed.code === "string" && typeof parsed.message === "string") {
        return parsed;
      }
    } catch {
      // not JSON — fall through to the generic shape below
    }
  }
  return { code: "unknown_error", message: String(error) };
}

const ICONS = {
  chevronRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  fileText:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
  upload:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  alertTriangle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  eye:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.636-7 10-7 10 7 10 7-3.636 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.364 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.636 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
};

const connectionBadge = document.querySelector<HTMLSpanElement>("#connection-badge")!;
const connectionRefreshButton = document.querySelector<HTMLButtonElement>("#connection-refresh-btn")!;
const connectionRefreshIcon = document.querySelector<HTMLSpanElement>("#connection-refresh-icon")!;
const settingsForm = document.querySelector<HTMLFormElement>("#settings-form")!;
const apiBaseUrlInput = document.querySelector<HTMLInputElement>("#api-base-url")!;
const clientIdInput = document.querySelector<HTMLInputElement>("#client-id")!;
const clientSecretField = document.querySelector<HTMLLabelElement>("#client-secret-field")!;
const clientSecretInput = document.querySelector<HTMLInputElement>("#client-secret")!;
const settingsSaveButton = document.querySelector<HTMLButtonElement>("#settings-save-btn")!;
const disconnectButton = document.querySelector<HTMLButtonElement>("#disconnect-btn")!;
const settingsStatus = document.querySelector<HTMLParagraphElement>("#settings-status")!;

// refresh_token isn't edited via any form field — it's obtained/persisted by the Rust side once
// an OAuth2 client_credentials exchange succeeds. Tracked here purely so saving the Connection
// form (e.g. just to change the API base URL) round-trips it instead of silently wiping it out.
let currentRefreshToken = "";

const embeddingsBadge = document.querySelector<HTMLSpanElement>("#embeddings-badge")!;
const embeddingsForm = document.querySelector<HTMLFormElement>("#embeddings-form")!;
const embedSettingsModelSelect = document.querySelector<HTMLSelectElement>("#embed-settings-model")!;
const embedSettingsChunkSizeInput = document.querySelector<HTMLInputElement>("#embed-settings-chunk-size")!;
const embedSettingsChunkOverlapInput = document.querySelector<HTMLInputElement>("#embed-settings-chunk-overlap")!;
const embedSettingsApiKeyInput = document.querySelector<HTMLInputElement>("#embed-settings-api-key")!;
const embedSettingsApiKeyToggle = document.querySelector<HTMLButtonElement>("#embed-settings-api-key-toggle")!;
const embedSettingsApiKeyLabel = document.querySelector<HTMLSpanElement>("#embed-settings-api-key-label")!;
const embeddingsSaveButton = document.querySelector<HTMLButtonElement>("#embeddings-save-btn")!;
const embeddingsRemoveButton = document.querySelector<HTMLButtonElement>("#embeddings-remove-btn")!;
const embeddingsFormStatus = document.querySelector<HTMLParagraphElement>("#embeddings-form-status")!;
const embeddingsDisabledHint = document.querySelector<HTMLParagraphElement>("#embeddings-disabled-hint")!;
const embedSettingsDimensions = document.querySelector<HTMLSpanElement>("#embed-settings-dimensions")!;

const searchSettingsForm = document.querySelector<HTMLFormElement>("#search-settings-form")!;
const rerankEnabledCheckbox = document.querySelector<HTMLInputElement>("#rerank-enabled")!;
const rerankModelSelect = document.querySelector<HTMLSelectElement>("#rerank-model")!;
const denseKInput = document.querySelector<HTMLInputElement>("#dense-k")!;
const sparseKInput = document.querySelector<HTMLInputElement>("#sparse-k")!;
const rerankCandidatesInput = document.querySelector<HTMLInputElement>("#rerank-candidates")!;
const rrfKInput = document.querySelector<HTMLInputElement>("#rrf-k")!;
const searchSettingsSaveButton = document.querySelector<HTMLButtonElement>("#search-settings-save-btn")!;
const searchSettingsStatus = document.querySelector<HTMLParagraphElement>("#search-settings-status")!;

const voyageInstructionsButton = document.querySelector<HTMLButtonElement>("#voyage-instructions-btn")!;
const voyageInstructionsOverlay = document.querySelector<HTMLDivElement>("#voyage-instructions-overlay")!;
const voyageInstructionsClose = document.querySelector<HTMLButtonElement>("#voyage-instructions-close")!;

const statusBanner = document.querySelector<HTMLDivElement>("#status-banner")!;

const newLibraryButton = document.querySelector<HTMLButtonElement>("#new-library-btn")!;
const createLibraryCard = document.querySelector<HTMLDivElement>("#create-library-card")!;
const createLibraryForm = document.querySelector<HTMLFormElement>("#create-library-form")!;
const cancelCreateLibraryButton = document.querySelector<HTMLButtonElement>("#cancel-create-library")!;
const nameInput = document.querySelector<HTMLInputElement>("#lib-name")!;
const descriptionInput = document.querySelector<HTMLInputElement>("#lib-description")!;
const createLibraryStatus = document.querySelector<HTMLParagraphElement>("#create-library-status")!;

const librariesList = document.querySelector<HTMLDivElement>("#libraries-list")!;

const expandedLibraryIds = new Set<string>();
let cachedLibraries: Library[] = [];
let defaultEmbeddingProvider = "";
let defaultRerankProvider = "";

function setExpanded(el: HTMLElement, chevronEl: HTMLElement, expanded: boolean) {
  el.hidden = !expanded;
  chevronEl.classList.toggle("open", expanded);
}

function initAccordion(headerId: string, bodyId: string, chevronId: string) {
  const header = document.querySelector<HTMLButtonElement>(`#${headerId}`)!;
  const body = document.querySelector<HTMLElement>(`#${bodyId}`)!;
  const chevron = document.querySelector<HTMLElement>(`#${chevronId}`)!;
  header.addEventListener("click", () => setExpanded(body, chevron, body.hidden));
}

// Mirrors pragna2's PasswordInput: an eye icon inside the field that toggles the
// input between password/text and swaps its own icon + aria-label to match.
function initPasswordToggle(inputId: string, toggleId: string) {
  const input = document.querySelector<HTMLInputElement>(`#${inputId}`)!;
  const toggle = document.querySelector<HTMLButtonElement>(`#${toggleId}`)!;
  toggle.innerHTML = ICONS.eye;
  toggle.addEventListener("click", () => {
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    toggle.innerHTML = visible ? ICONS.eye : ICONS.eyeOff;
    const label = visible ? "Show password" : "Hide password";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  });
}

// .flyout-overlay animates via opacity/visibility (see styles.css), not display — but the overlay
// starts with the `hidden` attribute, which forces display:none regardless of the .open class.
// Toggling only the class (as this used to do) left it permanently display:none, so nothing ever
// showed. Removing `hidden` on open (before adding .open, via double rAF so the browser registers
// the pre-transition state first) and restoring it after the close transition finishes keeps the
// slide/fade animation working correctly in both directions.
const FLYOUT_TRANSITION_MS = 200;

function initFlyout(buttonEl: HTMLButtonElement, overlayEl: HTMLDivElement, closeEl: HTMLButtonElement) {
  const open = () => {
    overlayEl.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => overlayEl.classList.add("open")));
  };
  const close = () => {
    overlayEl.classList.remove("open");
    setTimeout(() => { overlayEl.hidden = true; }, FLYOUT_TRANSITION_MS);
  };
  buttonEl.addEventListener("click", open);
  closeEl.addEventListener("click", close);
  overlayEl.addEventListener("click", (event) => {
    if (event.target === overlayEl) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function renderBanner(message: string) {
  statusBanner.innerHTML = `
    <div class="banner banner-warning">
      <span class="banner-icon">${ICONS.alertTriangle}</span>
      <span>${message} <button type="button" class="banner-link" id="banner-config-link">Go to Configuration</button></span>
    </div>
  `;
  document.querySelector<HTMLButtonElement>("#banner-config-link")?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>('.sidebar-item[data-view="configuration"]')?.click();
  });
}

function clearBanner() {
  statusBanner.innerHTML = "";
}

// The badge reflects a VERIFIED connection (a real round-trip to rag-api), not just "a non-empty
// key string is saved locally" — "configured" only once list_libraries() actually succeeds.
type ConnectionState = "not_configured" | "checking" | "invalid" | "unreachable" | "configured";

const CONNECTION_BADGE_LABELS: Record<ConnectionState, string> = {
  not_configured: "Not configured",
  checking: "Checking...",
  invalid: "Invalid credentials",
  unreachable: "Unreachable",
  configured: "Configured",
};

// Once configured (a token has actually been requested and verified against the API, not just
// "credentials were typed in"), the Client Secret is write-only from here on — the field hides
// entirely and editing is only possible again after an explicit Disconnect, matching how the
// Client Secret is treated server-side (shown once, at issuance, and never again).
function setConnectionConfiguredState(configured: boolean) {
  apiBaseUrlInput.disabled = configured;
  clientIdInput.disabled = configured;
  clientSecretField.hidden = configured;
  clientSecretInput.disabled = configured;
  if (configured) clientSecretInput.value = "";
  settingsSaveButton.hidden = configured;
  disconnectButton.hidden = !configured;
}

function setConnectionBadge(state: ConnectionState) {
  connectionBadge.textContent = CONNECTION_BADGE_LABELS[state];
  setConnectionConfiguredState(state === "configured");
}

function hasCredentials(config: Pick<AppConfig, "client_id" | "client_secret">): boolean {
  return Boolean(config.client_id && config.client_secret);
}

async function loadSettingsIntoForm(): Promise<AppConfig> {
  const config = await invoke<AppConfig>("get_config");
  apiBaseUrlInput.value = config.api_base_url;
  clientIdInput.value = config.client_id;
  // Client Secret is never re-populated from storage — same write-only convention as the
  // embeddings API key field.
  currentRefreshToken = config.refresh_token;
  setConnectionBadge(hasCredentials(config) ? "checking" : "not_configured");
  return config;
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config: AppConfig = {
    api_base_url: apiBaseUrlInput.value,
    client_id: clientIdInput.value,
    client_secret: clientSecretInput.value,
    refresh_token: currentRefreshToken,
  };
  try {
    await invoke("save_config", { config });
    settingsStatus.textContent = "Saved.";
    setConnectionBadge(hasCredentials(config) ? "checking" : "not_configured");
    if (hasCredentials(config)) {
      // Exchanges the new client_id/secret for an access token (and, since the requested scope
      // always includes offline_access, a refresh token) right now, rather than waiting for the
      // first data-loading call below to trigger it as a side effect.
      try {
        await invoke("authenticate");
        // authenticate() may have just persisted a new refresh_token to disk on the Rust side —
        // refetch so this stays in sync and the next save doesn't clobber it with a stale value.
        currentRefreshToken = (await invoke<AppConfig>("get_config")).refresh_token;
      } catch (authError) {
        settingsStatus.textContent = `Saved, but authentication failed: ${parseError(authError).message}`;
        setConnectionBadge("invalid");
        setEmbeddingsFormEnabled(false, "Configure your connection above first.");
        setSearchSettingsFormEnabled(false);
        return;
      }
      await loadEmbeddingOptions();
      await loadEmbeddingSettingsIntoForm();
      await loadRerankOptions();
      await loadSearchSettingsIntoForm();
    } else {
      setEmbeddingsFormEnabled(false, "Configure your connection above first.");
      setSearchSettingsFormEnabled(false);
    }
    await checkStatusAndLoad();
  } catch (error) {
    settingsStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

disconnectButton.addEventListener("click", async () => {
  if (!window.confirm("Disconnect from the Knowledge API? You'll need to re-enter Client ID and Client Secret to reconnect.")) return;
  try {
    await invoke("disconnect");
    clientIdInput.value = "";
    clientSecretInput.value = "";
    currentRefreshToken = "";
    settingsStatus.textContent = "Disconnected.";
    setConnectionBadge("not_configured");
    setEmbeddingsFormEnabled(false, "Configure your connection above first.");
    setSearchSettingsFormEnabled(false);
    librariesList.innerHTML = "";
    renderBanner("Not connected — configure your API connection first.");
  } catch (error) {
    settingsStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

async function loadEmbeddingOptions() {
  try {
    const options = await invoke<EmbeddingOptions>("get_embedding_options");
    defaultEmbeddingProvider = options.default_provider;

    embedSettingsModelSelect.innerHTML = "";
    for (const provider of options.providers) {
      for (const model of provider.models) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = `${provider.name} / ${model}`;
        embedSettingsModelSelect.appendChild(option);
      }
    }
    embedSettingsDimensions.textContent = String(options.dimensions);
  } catch (error) {
    embeddingsFormStatus.textContent = `Could not load embedding options: ${parseError(error).message}`;
  }
}

async function loadRerankOptions() {
  try {
    const options = await invoke<RerankOptions>("get_rerank_options");
    defaultRerankProvider = options.default_provider;
    rerankModelSelect.innerHTML = "";
    for (const provider of options.providers) {
      for (const model of provider.models) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = `${provider.name} / ${model}`;
        rerankModelSelect.appendChild(option);
      }
    }
  } catch (error) {
    searchSettingsStatus.textContent = `Could not load rerank options: ${parseError(error).message}`;
  }
}

// Same gating as the Embeddings form — only enabled once we've round-tripped to the API.
function setSearchSettingsFormEnabled(enabled: boolean) {
  rerankEnabledCheckbox.disabled = !enabled;
  rerankModelSelect.disabled = !enabled;
  denseKInput.disabled = !enabled;
  sparseKInput.disabled = !enabled;
  rerankCandidatesInput.disabled = !enabled;
  rrfKInput.disabled = !enabled;
  searchSettingsSaveButton.disabled = !enabled;
}

async function loadSearchSettingsIntoForm() {
  try {
    const settings = await invoke<SearchSettingsStatus>("get_search_settings");
    rerankEnabledCheckbox.checked = settings.rerank_enabled;
    rerankModelSelect.value = settings.rerank_model;
    denseKInput.value = String(settings.dense_k);
    sparseKInput.value = String(settings.sparse_k);
    rerankCandidatesInput.value = String(settings.rerank_candidates);
    rrfKInput.value = String(settings.rrf_k);
    setSearchSettingsFormEnabled(true);
  } catch (error) {
    searchSettingsStatus.textContent = `Could not reach the API: ${parseError(error).message}`;
    setSearchSettingsFormEnabled(false);
  }
}

searchSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke<SearchSettingsStatus>("save_search_settings", {
      payload: {
        rerank_enabled: rerankEnabledCheckbox.checked,
        rerank_provider: defaultRerankProvider,
        rerank_model: rerankModelSelect.value,
        dense_k: Number(denseKInput.value),
        sparse_k: Number(sparseKInput.value),
        rerank_candidates: Number(rerankCandidatesInput.value),
        rrf_k: Number(rrfKInput.value),
      },
    });
    searchSettingsStatus.textContent = "Saved.";
  } catch (error) {
    searchSettingsStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

// The Embeddings form is only enabled once we've actually round-tripped to the API and back —
// not just because a connection API key string exists locally, which could be stale/wrong.
function setEmbeddingsFormEnabled(enabled: boolean, hint?: string) {
  embedSettingsModelSelect.disabled = !enabled;
  embedSettingsChunkSizeInput.disabled = !enabled;
  embedSettingsChunkOverlapInput.disabled = !enabled;
  embedSettingsApiKeyInput.disabled = !enabled;
  embedSettingsApiKeyToggle.disabled = !enabled;
  embeddingsSaveButton.disabled = !enabled;
  embeddingsRemoveButton.disabled = !enabled;
  embeddingsDisabledHint.hidden = enabled;
  if (hint) embeddingsDisabledHint.textContent = hint;
}

// Mirrors pragna2's EmbeddingKeySection: once a key is already configured, the field
// label and submit button read "Replace key" instead of "API key"/"Save key", and a
// "Remove" action appears to clear it.
function setEmbeddingsConfiguredState(configured: boolean) {
  embedSettingsApiKeyLabel.textContent = configured ? "Replace key" : "API key";
  embeddingsSaveButton.textContent = configured ? "Replace key" : "Save key";
  embeddingsRemoveButton.hidden = !configured;
}

async function loadEmbeddingSettingsIntoForm() {
  try {
    const status = await invoke<EmbeddingSettingsStatus>("get_embedding_settings");
    embeddingsBadge.textContent = status.configured ? "Configured" : "Not configured";
    setEmbeddingsConfiguredState(status.configured);
    if (status.model) {
      embedSettingsModelSelect.value = status.model;
    }
    embedSettingsChunkSizeInput.value = String(status.chunk_size);
    embedSettingsChunkOverlapInput.value = String(status.chunk_overlap);
    setEmbeddingsFormEnabled(true);
  } catch (error) {
    embeddingsBadge.textContent = "Not configured";
    setEmbeddingsFormEnabled(false, `Could not reach the API: ${parseError(error).message}`);
  }
}

embeddingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const status = await invoke<EmbeddingSettingsStatus>("save_embedding_settings", {
      payload: {
        provider: defaultEmbeddingProvider,
        model: embedSettingsModelSelect.value,
        api_key: embedSettingsApiKeyInput.value,
        chunk_size: Number(embedSettingsChunkSizeInput.value),
        chunk_overlap: Number(embedSettingsChunkOverlapInput.value),
      },
    });
    embeddingsFormStatus.textContent = "Saved.";
    embeddingsBadge.textContent = status.configured ? "Configured" : "Not configured";
    setEmbeddingsConfiguredState(status.configured);
    embedSettingsChunkSizeInput.value = String(status.chunk_size);
    embedSettingsChunkOverlapInput.value = String(status.chunk_overlap);
    embedSettingsApiKeyInput.value = "";
    await checkStatusAndLoad();
  } catch (error) {
    embeddingsFormStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

embeddingsRemoveButton.addEventListener("click", async () => {
  if (!window.confirm("Remove the embedding key? Uploads and search will stop working until a new key is configured.")) return;
  try {
    const status = await invoke<EmbeddingSettingsStatus>("clear_embedding_settings");
    embeddingsFormStatus.textContent = "Removed.";
    embeddingsBadge.textContent = status.configured ? "Configured" : "Not configured";
    setEmbeddingsConfiguredState(status.configured);
    embedSettingsChunkSizeInput.value = String(status.chunk_size);
    embedSettingsChunkOverlapInput.value = String(status.chunk_overlap);
    embedSettingsApiKeyInput.value = "";
    await checkStatusAndLoad();
  } catch (error) {
    embeddingsFormStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

newLibraryButton.addEventListener("click", () => {
  createLibraryCard.hidden = !createLibraryCard.hidden;
});

cancelCreateLibraryButton.addEventListener("click", () => {
  createLibraryCard.hidden = true;
  createLibraryForm.reset();
  createLibraryStatus.textContent = "";
});

createLibraryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke("create_library", {
      payload: {
        name: nameInput.value,
        description: descriptionInput.value || null,
      },
    });
    createLibraryStatus.textContent = "";
    createLibraryForm.reset();
    createLibraryCard.hidden = true;
    await refreshLibraries();
  } catch (error) {
    createLibraryStatus.textContent = `Error: ${parseError(error).message}`;
  }
});

// The three states this distinguishes: (1) no local connection configured at all, (2) connection
// configured but rag-api rejects the credentials (401), (3) rag-api reachable but embeddings
// aren't configured there yet — libraries can still be listed/created, only ingestion/query need it.
async function checkStatusAndLoad() {
  const config = await invoke<AppConfig>("get_config");
  if (!hasCredentials(config)) {
    setConnectionBadge("not_configured");
    renderBanner("Not connected — configure your API connection first.");
    librariesList.innerHTML = "";
    return;
  }

  try {
    cachedLibraries = await invoke<Library[]>("list_libraries");
  } catch (rawError) {
    const error = parseError(rawError);
    if (error.code === "unauthorized") {
      setConnectionBadge("invalid");
      renderBanner("Your client credentials look invalid or expired — update them in Configuration.");
    } else {
      setConnectionBadge("unreachable");
      renderBanner(`Error loading libraries: ${error.message}`);
    }
    librariesList.innerHTML = "";
    return;
  }

  setConnectionBadge("configured");
  clearBanner();
  renderLibraryList();

  try {
    const embeddingStatus = await invoke<EmbeddingSettingsStatus>("get_embedding_settings");
    if (!embeddingStatus.configured) {
      renderBanner("Embeddings aren't configured — set an API key in Configuration to enable uploads and search.");
    }
  } catch {
    // Non-blocking check — if it fails, the library list already loaded fine, so just skip it.
  }
}

function renderLibraryList() {
  librariesList.innerHTML = "";
  if (cachedLibraries.length === 0) {
    librariesList.innerHTML = `<div class="empty-state">No libraries yet. Create one to get started.</div>`;
    return;
  }

  for (const library of cachedLibraries) {
    librariesList.appendChild(renderLibraryCard(library));
  }
}

async function refreshLibraries() {
  try {
    cachedLibraries = await invoke<Library[]>("list_libraries");
  } catch (error) {
    librariesList.innerHTML = `<p class="status-text">Error loading libraries: ${parseError(error).message}</p>`;
    return;
  }
  renderLibraryList();
}

function renderLibraryCard(library: Library): HTMLElement {
  const card = document.createElement("div");
  card.className = "card library-card";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "card-header";

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.innerHTML = ICONS.chevronRight;

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = library.name;

  const meta = document.createElement("span");
  meta.className = "library-meta";
  meta.innerHTML = `
    <span class="badge">${library.document_count} docs</span>
  `;

  const actions = document.createElement("span");
  actions.className = "library-actions";
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn btn-icon";
  deleteButton.title = "Delete library";
  deleteButton.innerHTML = ICONS.x;
  deleteButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!window.confirm(`Delete library "${library.name}"? This removes all its documents.`)) return;
    try {
      await invoke("delete_library", { libraryId: library.id });
      expandedLibraryIds.delete(library.id);
      await refreshLibraries();
    } catch (error) {
      window.alert(`Error deleting library: ${parseError(error).message}`);
    }
  });
  actions.appendChild(deleteButton);

  header.appendChild(chevron);
  header.appendChild(title);
  header.appendChild(meta);
  header.appendChild(actions);

  const body = document.createElement("div");
  body.className = "card-body";
  body.hidden = true;

  const isExpanded = expandedLibraryIds.has(library.id);
  setExpanded(body, chevron, isExpanded);
  if (isExpanded) {
    loadDocuments(library, body);
  }

  header.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".library-actions")) return;
    const expanding = body.hidden;
    setExpanded(body, chevron, expanding);
    if (expanding) {
      expandedLibraryIds.add(library.id);
      loadDocuments(library, body);
    } else {
      expandedLibraryIds.delete(library.id);
    }
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

async function loadDocuments(library: Library, body: HTMLElement) {
  body.innerHTML = `<p class="status-text">Loading documents...</p>`;

  let documents: LibraryDocument[];
  try {
    documents = await invoke<LibraryDocument[]>("list_documents", { libraryId: library.id });
  } catch (error) {
    body.innerHTML = `<p class="status-text">Error loading documents: ${parseError(error).message}</p>`;
    return;
  }

  body.innerHTML = "";

  if (documents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No documents yet.";
    body.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "doc-list";
    for (const doc of documents) {
      list.appendChild(renderDocRow(doc));
    }
    body.appendChild(list);
  }

  body.appendChild(renderUploadRow(library, body));
}

function renderDocRow(doc: LibraryDocument): HTMLElement {
  const row = document.createElement("li");
  row.className = "doc-row";

  const icon = document.createElement("span");
  icon.className = "doc-icon";
  icon.innerHTML = ICONS.fileText;

  const info = document.createElement("span");
  info.className = "doc-info";
  const statusSuffix = doc.status === "completed" ? "" : ` · ${doc.status}`;
  info.innerHTML = `
    <div class="doc-name">${doc.source_filename}</div>
    <div class="doc-sub">${doc.file_type}${statusSuffix}</div>
  `;

  row.appendChild(icon);
  row.appendChild(info);
  return row;
}

function renderUploadRow(library: Library, body: HTMLElement): HTMLElement {
  const wrapper = document.createElement("div");

  const dropzone = document.createElement("button");
  dropzone.type = "button";
  dropzone.className = "dropzone";
  dropzone.innerHTML = `<span class="dropzone-icon">${ICONS.upload}</span><span>Click to choose a file to upload</span>`;

  const status = document.createElement("p");
  status.className = "status-text";

  dropzone.addEventListener("click", async () => {
    const filePath = await open({ multiple: false });
    if (!filePath) return;
    status.textContent = "Uploading...";
    try {
      const job = await invoke<{ job_id: string }>("upload_document", {
        libraryId: library.id,
        filePath,
      });
      pollJob(library, job.job_id, status, body);
    } catch (error) {
      status.textContent = `Error: ${parseError(error).message}`;
    }
  });

  wrapper.appendChild(dropzone);
  wrapper.appendChild(status);
  return wrapper;
}

function pollJob(library: Library, jobId: string, statusEl: HTMLParagraphElement, body: HTMLElement) {
  const interval = setInterval(async () => {
    try {
      const job = await invoke<{ status: string; error: string | null }>("get_job_status", {
        libraryId: library.id,
        jobId,
      });
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(interval);
        statusEl.textContent = job.status === "failed" ? `Failed: ${job.error}` : "";
        await refreshLibraries();
        const updated = cachedLibraries.find((lib) => lib.id === library.id);
        if (updated && expandedLibraryIds.has(library.id)) {
          loadDocuments(updated, body);
        }
      } else {
        statusEl.textContent = job.status;
      }
    } catch (error) {
      statusEl.textContent = `Error: ${parseError(error).message}`;
      clearInterval(interval);
    }
  }, 1500);
}

// Re-runs the full connection/embeddings/search-settings load, same sequence as startup. Used
// by: the manual refresh button, opening the Configuration tab, and init() itself — there's
// otherwise no way to recover from "app started before the API container did" short of a
// restart, since everything below only ever ran once, at launch.
async function refreshConnection() {
  const config = await invoke<AppConfig>("get_config");
  // Skip embeddings-related calls entirely until the connection itself is configured — otherwise
  // they'd just fail with a confusing "Invalid or missing credentials" before the user has done anything.
  if (hasCredentials(config)) {
    await loadEmbeddingOptions();
    await loadEmbeddingSettingsIntoForm();
    await loadRerankOptions();
    await loadSearchSettingsIntoForm();
  }
  await checkStatusAndLoad();
}

connectionRefreshButton.addEventListener("click", async () => {
  connectionRefreshButton.disabled = true;
  connectionRefreshIcon.classList.add("spinning");
  try {
    await refreshConnection();
  } finally {
    connectionRefreshButton.disabled = false;
    connectionRefreshIcon.classList.remove("spinning");
  }
});

// Dispatched by shell.ts on every sidebar nav switch — re-check the connection whenever the
// Configuration tab is opened, so the common case (start the API container, then come look at
// Configuration) self-heals without needing the manual refresh button.
document.addEventListener("view-changed", (event) => {
  if ((event as CustomEvent<{ view: string }>).detail.view === "configuration") {
    refreshConnection();
  }
});

async function init() {
  initShell();
  initAccordion("connection-card-header", "connection-card-body", "connection-chevron");
  initAccordion("embeddings-card-header", "embeddings-card-body", "embeddings-chevron");
  initPasswordToggle("client-secret", "client-secret-toggle");
  initPasswordToggle("embed-settings-api-key", "embed-settings-api-key-toggle");
  initFlyout(voyageInstructionsButton, voyageInstructionsOverlay, voyageInstructionsClose);
  await loadSettingsIntoForm();
  await refreshConnection();
}

init();
