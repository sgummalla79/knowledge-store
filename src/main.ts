import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
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
  error_message: string | null;
  ingested_at: string | null;
  created_at: string;
  // Not confirmed as part of the API's document object yet (see the ingestion-status API ask) —
  // optional so the grid degrades to "—" instead of breaking if the API doesn't send these.
  size_bytes?: number | null;
  chunk_count?: number | null;
}

interface EmbeddingProviderOption {
  name: string;
  api_key_required: boolean;
  base_url_required: boolean;
  base_url_supported: boolean;
  default_base_url: string | null;
  // Voyage has no model-listing capability at all (no adapter method) — this is false for it and
  // true for ollama/openai_compatible, per POST /embedding-options/models.
  supports_model_listing: boolean;
}

// Purely a convenience suggestion for the UI to offer as a one-click fill — never validated or
// enforced server-side, and NOT filtered to only the currently-enabled providers, so any use of
// this must cross-check `provider` against the actual (enabled) providers list before offering it.
interface EmbeddingModelPreset {
  provider: string;
  model: string;
  dimensions: number;
}

interface EmbeddingOptions {
  providers: EmbeddingProviderOption[];
  default_provider: string;
  default_model: string;
  suggested_models: EmbeddingModelPreset[];
}

interface EmbeddingSettingsStatus {
  provider: string | null;
  model: string | null;
  configured: boolean;
  base_url: string | null;
  dimensions: number | null;
  chunk_size: number;
  chunk_overlap: number;
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

// refresh_token isn't edited via any form field — it's obtained/persisted by the Rust side once
// an OAuth2 client_credentials exchange succeeds. Tracked here purely so saving the Connection
// form (e.g. just to change the API base URL) round-trips it instead of silently wiping it out.
let currentRefreshToken = "";

const embeddingsBadge = document.querySelector<HTMLSpanElement>("#embeddings-badge")!;
const embeddingsForm = document.querySelector<HTMLFormElement>("#embeddings-form")!;
const embedSettingsProviderSelect = document.querySelector<HTMLSelectElement>("#embed-settings-provider")!;
const embedSettingsModelInput = document.querySelector<HTMLInputElement>("#embed-settings-model")!;
const embedSettingsModelDatalist = document.querySelector<HTMLDataListElement>("#embed-settings-model-list")!;
const embedSettingsDimensionsSelect = document.querySelector<HTMLSelectElement>("#embed-settings-dimensions")!;
const embedSettingsChunkSizeInput = document.querySelector<HTMLInputElement>("#embed-settings-chunk-size")!;
const embedSettingsChunkOverlapInput = document.querySelector<HTMLInputElement>("#embed-settings-chunk-overlap")!;
const embedSettingsBaseUrlField = document.querySelector<HTMLLabelElement>("#embed-settings-base-url-field")!;
const embedSettingsBaseUrlInput = document.querySelector<HTMLInputElement>("#embed-settings-base-url")!;
const embedSettingsBaseUrlHint = document.querySelector<HTMLParagraphElement>("#embed-settings-base-url-hint")!;
const embedSettingsApiKeyField = document.querySelector<HTMLLabelElement>("#embed-settings-api-key-field")!;
const embedSettingsApiKeyInput = document.querySelector<HTMLInputElement>("#embed-settings-api-key")!;
const embedSettingsApiKeyToggle = document.querySelector<HTMLButtonElement>("#embed-settings-api-key-toggle")!;
const embeddingsSaveButton = document.querySelector<HTMLButtonElement>("#embeddings-save-btn")!;
const embeddingsRemoveButton = document.querySelector<HTMLButtonElement>("#embeddings-remove-btn")!;
const embeddingsFormStatus = document.querySelector<HTMLParagraphElement>("#embeddings-form-status")!;
const embeddingsDisabledHint = document.querySelector<HTMLParagraphElement>("#embeddings-disabled-hint")!;
const embeddingsLockedHint = document.querySelector<HTMLParagraphElement>("#embed-settings-locked-hint")!;
const embedSettingsModelFetchHint = document.querySelector<HTMLParagraphElement>("#embed-settings-model-fetch-hint")!;

const statusBanner = document.querySelector<HTMLDivElement>("#status-banner")!;

const newLibraryButton = document.querySelector<HTMLButtonElement>("#new-library-btn")!;
const createLibraryCard = document.querySelector<HTMLDivElement>("#create-library-card")!;
const createLibraryForm = document.querySelector<HTMLFormElement>("#create-library-form")!;
const cancelCreateLibraryButton = document.querySelector<HTMLButtonElement>("#cancel-create-library")!;
const nameInput = document.querySelector<HTMLInputElement>("#lib-name")!;
const descriptionInput = document.querySelector<HTMLInputElement>("#lib-description")!;

const librariesList = document.querySelector<HTMLDivElement>("#libraries-list")!;

const expandedLibraryIds = new Set<string>();
let cachedLibraries: Library[] = [];
// Tracks whatever card-body element is currently mounted for each expanded library, looked up
// fresh on every poll tick (never captured in a closure) — so an in-flight upload's progress
// keeps rendering into the right place even if the library card gets torn down and rebuilt in
// the meantime (collapse/re-expand, a library list refresh triggered elsewhere, etc.).
const libraryDocBodies = new Map<string, HTMLElement>();
const activeDocumentPolls = new Map<string, ReturnType<typeof setInterval>>();
// Last real document list fetched per library — lets an optimistic placeholder be re-rendered
// alongside real data without needing its own network round trip.
const lastKnownDocuments = new Map<string, LibraryDocument[]>();
// Filenames shown as "Uploading" placeholders before the server has a real document row for
// them yet — cleared once the corresponding filename shows up in a real fetch.
const pendingUploadFilenames = new Map<string, Set<string>>();
// Document ids currently being retried — shown as "Retrying" instead of their last-fetched
// "failed" status. Retry is async server-side (status flips to "processing" on a background
// thread after the POST already returned), so a poll right after clicking retry can still see
// the stale "failed" status; cleared once a fetch shows the document has actually moved off it.
const pendingRetryDocumentIds = new Map<string, Set<string>>();
// Cached in full so provider-select changes can be recomputed client-side without a network
// round trip.
let embeddingOptions: EmbeddingOptions | null = null;
// Mirrors setEmbeddingsFormEnabled's "enabled" input — tracked as state (not just read off a
// field's current .disabled) so refreshEmbeddingsGating can recompute from scratch every time.
let embeddingsConnectionOk = false;
// Mirrors applyEmbeddingLockState's "identityLocked" input, same reason.
let currentIdentityLocked = false;
// The provider a real, saved config currently exists for (null if unconfigured) — lets
// refreshEmbeddingsGating treat "already has a key saved server-side" as satisfying the
// api-key/base-url prerequisite without requiring it to be re-typed, but only while the selected
// provider hasn't changed out from under that saved config.
let currentConfiguredProvider: string | null = null;
// Last successful live model-listing result per provider — populateModelDatalist reads from this
// on every gating refresh (e.g. every keystroke) without re-fetching; only scheduleModelFetch's
// debounced call ever writes to it.
const liveModelsByProvider = new Map<string, string[]>();
let modelFetchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
// Bumped on every new fetch attempt so a slow, superseded request can recognize it's stale and
// discard its result instead of clobbering whatever a more recent request already rendered.
let modelFetchRequestToken = 0;

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

const toastContainer = document.querySelector<HTMLDivElement>("#toast-container")!;

// Non-blocking confirmation of a CRUD action's outcome — replaces the old pattern of writing
// "Saved."/"Deleted."/an error into a <p> that sat next to the button until the next action
// overwrote it. Errors linger longer than success, but everything is also click-to-dismiss.
function showToast(message: string, kind: "success" | "error" = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toast.addEventListener("click", () => dismissToast(toast));
  toastContainer.appendChild(toast);

  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("toast-visible")));
  setTimeout(() => dismissToast(toast), kind === "error" ? 6000 : 3500);
}

function dismissToast(toast: HTMLDivElement) {
  if (!toast.isConnected) return;
  toast.classList.remove("toast-visible");
  setTimeout(() => toast.remove(), 200);
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
        showToast(`Saved, but authentication failed: ${parseError(authError).message}`, "error");
        setConnectionBadge("invalid");
        setEmbeddingsFormEnabled(false, "Configure your connection above first.");
        return;
      }
      showToast("Connection saved.");
      await loadEmbeddingOptions();
      await loadEmbeddingSettingsIntoForm();
    } else {
      showToast("Connection saved.");
      setEmbeddingsFormEnabled(false, "Configure your connection above first.");
    }
    await checkStatusAndLoad();
  } catch (error) {
    showToast(`Error saving connection: ${parseError(error).message}`, "error");
  }
});

disconnectButton.addEventListener("click", async () => {
  const confirmed = await confirm(
    "Disconnect from the Knowledge API? You'll need to re-enter Client ID and Client Secret to reconnect.",
    { title: "Disconnect", kind: "warning" },
  );
  if (!confirmed) return;
  try {
    await invoke("disconnect");
    clientIdInput.value = "";
    clientSecretInput.value = "";
    currentRefreshToken = "";
    setConnectionBadge("not_configured");
    setEmbeddingsFormEnabled(false, "Configure your connection above first.");
    librariesList.innerHTML = "";
    renderBanner("Not connected — configure your API connection first.");
    showToast("Disconnected.");
  } catch (error) {
    showToast(`Error disconnecting: ${parseError(error).message}`, "error");
  }
});

function formatProviderLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Every provider-dependent bit of the form (base URL visibility/requiredness, whether an API key
// field even applies) is data-driven off this, never a hardcoded check against a specific
// provider name. Hiding a field also clears it and drops its `required` — switching providers
// must never leave a stale, invisible value able to sneak into the next save, and a hidden
// field must never stay `required` (relying on browsers skipping validation on non-rendered
// elements would work by accident, not by being correctly coded).
function applyProviderMeta(provider: EmbeddingProviderOption) {
  embedSettingsBaseUrlField.hidden = !provider.base_url_supported;
  embedSettingsBaseUrlHint.hidden = !provider.base_url_supported;
  embedSettingsBaseUrlInput.required = provider.base_url_supported && provider.base_url_required;
  if (!provider.base_url_supported) embedSettingsBaseUrlInput.value = "";
  // Only ollama has a default_base_url — the static HTML placeholder was written for it and
  // would otherwise stay stuck showing an Ollama-specific hint on a field that's actually
  // required for a different provider (e.g. openai_compatible, which has no universal default).
  embedSettingsBaseUrlInput.placeholder = provider.default_base_url ?? "https://your-endpoint.example.com";

  embedSettingsApiKeyField.hidden = !provider.api_key_required;
  embedSettingsApiKeyInput.required = provider.api_key_required;
  if (!provider.api_key_required) embedSettingsApiKeyInput.value = "";
}

// Common embedding vector sizes across widely-used models (MiniLM/nomic-embed-text at 384/768,
// OpenAI's text-embedding-3-small/large at 1536/3072, Voyage/Cohere-class models around 1024,
// etc.) — a picker over free-typing avoids a typo silently producing a broken embedding column,
// since knowledge-api takes this value as-given with no way to validate it against the model.
const STANDARD_EMBEDDING_DIMENSIONS = [256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096];

// Always includes the standard set, plus any dimensions the API's suggested_models presets use
// (in case one falls outside the standard list) and whatever is currently selected/configured —
// so loading an existing config never lands on a value that isn't actually in the list.
function populateDimensionsOptions(selectedValue: number | null) {
  const values = new Set(STANDARD_EMBEDDING_DIMENSIONS);
  for (const preset of embeddingOptions?.suggested_models ?? []) values.add(preset.dimensions);
  if (selectedValue != null) values.add(selectedValue);

  const previousValue = embedSettingsDimensionsSelect.value;
  embedSettingsDimensionsSelect.innerHTML = "";
  for (const dim of Array.from(values).sort((a, b) => a - b)) {
    const option = document.createElement("option");
    option.value = String(dim);
    option.textContent = String(dim);
    embedSettingsDimensionsSelect.appendChild(option);
  }
  embedSettingsDimensionsSelect.value = selectedValue != null ? String(selectedValue) : previousValue;
}

// Model is a free-text input with a <datalist> of suggestions, not a closed dropdown — the API
// explicitly accepts any model name for any provider (there's no validation against a fixed
// list), so restricting it to a picker would remove real capability, especially for Voyage where
// the only known name is one static preset and would otherwise never be able to move past it.
// Live models (from POST /embedding-options/models, cached in liveModelsByProvider) take priority
// when available for this provider; falls back to the static suggested_models preset otherwise
// (Voyage, which has no listing capability, or before a fetch has completed). This only refreshes
// the suggestion list — it never touches the input's current value, unlike a <select>'s options.
function populateModelDatalist(providerName: string) {
  const live = liveModelsByProvider.get(providerName);
  const names =
    live && live.length > 0
      ? live
      : (embeddingOptions?.suggested_models ?? []).filter((p) => p.provider === providerName).map((p) => p.model);

  embedSettingsModelDatalist.innerHTML = "";
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    embedSettingsModelDatalist.appendChild(option);
  }
}

// True once the currently-selected provider can actually be used: a provider is selected, and if
// it requires an API key and/or connection URL, one is either freshly typed in or already saved
// server-side for this exact provider (so re-opening an existing config doesn't demand the
// write-only key be re-entered just to keep editing chunk_size).
function embeddingPrerequisitesMet(): boolean {
  const meta = embeddingOptions?.providers.find((p) => p.name === embedSettingsProviderSelect.value);
  if (!meta) return false;
  const alreadyConfigured =
    currentConfiguredProvider !== null && currentConfiguredProvider === embedSettingsProviderSelect.value;
  const apiKeyOk = !meta.api_key_required || embedSettingsApiKeyInput.value.trim() !== "" || alreadyConfigured;
  const baseUrlOk = !meta.base_url_required || embedSettingsBaseUrlInput.value.trim() !== "" || alreadyConfigured;
  return apiKeyOk && baseUrlOk;
}

// Fetching needs the actual credential VALUES (the endpoint has nothing else to send them with)
// — unlike embeddingPrerequisitesMet, "already configured" doesn't count, since the real key is
// write-only and never re-sent from a blank input. Providers without listing capability (Voyage)
// never attempt this at all.
function canAttemptModelFetch(meta: EmbeddingProviderOption | undefined): boolean {
  if (!meta?.supports_model_listing) return false;
  if (meta.api_key_required && !embedSettingsApiKeyInput.value.trim()) return false;
  if (meta.base_url_required && !embedSettingsBaseUrlInput.value.trim()) return false;
  return true;
}

// Debounced (the server rate-limits this to 10/min) — fires at most once per pause in typing,
// not on every keystroke. Called from refreshEmbeddingsGating, so every place that already
// re-evaluates gating (provider switch, api-key/base-url typing, initial load) also considers a
// fetch, without needing its own separate wiring at each call site.
function scheduleModelFetch() {
  if (modelFetchDebounceTimer) clearTimeout(modelFetchDebounceTimer);
  modelFetchDebounceTimer = setTimeout(() => void fetchLiveModels(), 600);
}

async function fetchLiveModels() {
  const providerName = embedSettingsProviderSelect.value;
  const meta = embeddingOptions?.providers.find((p) => p.name === providerName);
  if (!embeddingsConnectionOk || !canAttemptModelFetch(meta)) return;

  const requestToken = ++modelFetchRequestToken;
  const payload: Record<string, unknown> = { provider: providerName };
  if (!embedSettingsApiKeyField.hidden && embedSettingsApiKeyInput.value) {
    payload.api_key = embedSettingsApiKeyInput.value;
  }
  if (!embedSettingsBaseUrlField.hidden && embedSettingsBaseUrlInput.value) {
    payload.base_url = embedSettingsBaseUrlInput.value;
  }

  embedSettingsModelFetchHint.hidden = false;
  embedSettingsModelFetchHint.textContent = "Fetching models…";
  try {
    const result = await invoke<{ models: string[] }>("list_embedding_models", { payload });
    if (requestToken !== modelFetchRequestToken) return; // superseded by a newer request
    liveModelsByProvider.set(providerName, result.models);
    populateModelDatalist(providerName);
    embedSettingsModelFetchHint.hidden = result.models.length > 0;
    if (result.models.length === 0) embedSettingsModelFetchHint.textContent = "No models returned by the provider.";
  } catch (error) {
    if (requestToken !== modelFetchRequestToken) return;
    embedSettingsModelFetchHint.hidden = false;
    embedSettingsModelFetchHint.textContent = `Could not fetch models: ${parseError(error).message}`;
  }
}

// Model, Dimensions, Chunk size/overlap, and Save all gate on this — recomputed fully from
// scratch on every relevant change (provider switch, api-key/base-url typing, connection status,
// chunk-existence lock), never just added to, since prerequisites can become newly *satisfied* as
// the user types, not just newly unsatisfied.
function refreshEmbeddingsGating() {
  populateModelDatalist(embedSettingsProviderSelect.value);

  const prereqsMet = embeddingPrerequisitesMet();
  const modelFieldsReady = embeddingsConnectionOk && prereqsMet && !currentIdentityLocked;
  const saveReady = embeddingsConnectionOk && prereqsMet;

  embedSettingsModelInput.disabled = !modelFieldsReady;
  embedSettingsDimensionsSelect.disabled = !modelFieldsReady;
  embedSettingsChunkSizeInput.disabled = !saveReady;
  embedSettingsChunkOverlapInput.disabled = !saveReady;
  embeddingsSaveButton.disabled = !saveReady;

  // A provider without listing capability (e.g. Voyage — no list_models() adapter method at all)
  // will never produce a live result no matter what's typed, so say so explicitly instead of
  // silently doing nothing when credentials are entered — that reads as broken, not "unsupported."
  const meta = embeddingOptions?.providers.find((p) => p.name === embedSettingsProviderSelect.value);
  if (meta && !meta.supports_model_listing) {
    embedSettingsModelFetchHint.hidden = false;
    embedSettingsModelFetchHint.textContent =
      "This provider doesn't support listing its own models — showing the suggested model only.";
    return;
  }
  embedSettingsModelFetchHint.hidden = true;

  scheduleModelFetch();
}

embedSettingsProviderSelect.addEventListener("change", () => {
  const meta = embeddingOptions?.providers.find((p) => p.name === embedSettingsProviderSelect.value);
  if (meta) applyProviderMeta(meta);
  refreshEmbeddingsGating();
});
embedSettingsApiKeyInput.addEventListener("input", refreshEmbeddingsGating);
embedSettingsBaseUrlInput.addEventListener("input", refreshEmbeddingsGating);

async function loadEmbeddingOptions() {
  try {
    const options = await invoke<EmbeddingOptions>("get_embedding_options");
    embeddingOptions = options;

    embedSettingsProviderSelect.innerHTML = "";
    for (const provider of options.providers) {
      const option = document.createElement("option");
      option.value = provider.name;
      option.textContent = formatProviderLabel(provider.name);
      embedSettingsProviderSelect.appendChild(option);
    }
    if (!embedSettingsProviderSelect.value) {
      embedSettingsProviderSelect.value = options.default_provider;
    }

    populateModelDatalist(embedSettingsProviderSelect.value);
    populateDimensionsOptions(null);

    const meta = options.providers.find((p) => p.name === embedSettingsProviderSelect.value);
    if (meta) applyProviderMeta(meta);
  } catch (error) {
    embeddingsFormStatus.textContent = `Could not load embedding options: ${parseError(error).message}`;
  }
}

// The Embeddings form is only enabled once we've actually round-tripped to the API and back —
// not just because a connection is locally saved, which could be stale/wrong. Model, Dimensions,
// Chunk size/overlap, and Save are owned by refreshEmbeddingsGating (they additionally depend on
// api-key/base-url prerequisites, not just connection status), so only recorded into
// embeddingsConnectionOk here and left to that function rather than set directly.
function setEmbeddingsFormEnabled(enabled: boolean, hint?: string) {
  embeddingsConnectionOk = enabled;
  embedSettingsProviderSelect.disabled = !enabled;
  embedSettingsBaseUrlInput.disabled = !enabled;
  embedSettingsApiKeyInput.disabled = !enabled;
  embedSettingsApiKeyToggle.disabled = !enabled;
  embeddingsRemoveButton.disabled = !enabled;
  embeddingsDisabledHint.hidden = enabled;
  if (hint) embeddingsDisabledHint.textContent = hint;
  refreshEmbeddingsGating();
}

// knowledge-api locks provider/model/base_url/dimensions together (its "model identity") the
// moment any chunk exists anywhere across every library — chunk_size, chunk_overlap, and api_key
// stay changeable regardless. There's no field on GET /embedding-settings that reports this
// directly, so it's inferred here from the same fact the server itself checks (a nonzero global
// chunk count) via the already-loaded library list.
function anyChunksExist(): boolean {
  return cachedLibraries.some((lib) => lib.chunk_count > 0);
}

// Applied on top of setEmbeddingsFormEnabled(true) — only re-disables provider/base_url here;
// Model/Dimensions are also identity-locked, but that's applied inside refreshEmbeddingsGating
// (via currentIdentityLocked) since they need to be recomputed alongside the api-key/base-url
// prerequisite check, not just this lock.
//
// identityLocked mirrors the server's own rule exactly (existing config + a real identity change
// + chunks>0), gating provider/model/dimensions/base_url.
function applyEmbeddingLockState(identityLocked: boolean) {
  currentIdentityLocked = identityLocked;
  embedSettingsProviderSelect.disabled ||= identityLocked;
  embedSettingsBaseUrlInput.disabled ||= identityLocked;
  embeddingsLockedHint.hidden = !identityLocked;
  refreshEmbeddingsGating();
}

// The delete button's hidden and disabled state are computed together, from the same two
// booleans, in exactly one place — hidden and disabled used to be set independently by different
// functions (setEmbeddingsFormEnabled unconditionally re-enabling it, a separate lock-state
// function only ever adding disabling back on top), which could leave it enabled while
// unconfigured since nothing re-derived "enabled" from "configured" after the fact. Delete only
// ever makes sense when there's something configured to delete AND no chunk exists anywhere to
// protect (matches applyEmbeddingLockState's rule against reset-as-a-loophole).
function applyEmbeddingDeleteButtonState(configured: boolean, chunksExist: boolean) {
  embeddingsRemoveButton.hidden = !configured;
  embeddingsRemoveButton.disabled = !configured || chunksExist;
}

function populateEmbeddingSettingsForm(status: EmbeddingSettingsStatus) {
  embeddingsBadge.textContent = status.configured ? "Configured" : "Not configured";
  currentConfiguredProvider = status.configured ? status.provider : null;

  // With exactly one enabled provider there's nothing to actually pick — default straight to it,
  // and to its suggested model/dimensions too, so a fresh single-provider deployment arrives
  // ready to just click Save instead of requiring the user to fill in a foregone conclusion.
  const soleProvider = embeddingOptions?.providers.length === 1 ? embeddingOptions.providers[0] : null;
  const soleProviderPreset = soleProvider
    ? (embeddingOptions?.suggested_models.find((p) => p.provider === soleProvider.name) ?? null)
    : null;

  const providerValue = status.provider ?? soleProvider?.name;
  if (providerValue) embedSettingsProviderSelect.value = providerValue;

  populateModelDatalist(embedSettingsProviderSelect.value);
  embedSettingsModelInput.value = status.model ?? (!status.configured ? (soleProviderPreset?.model ?? "") : "");
  populateDimensionsOptions(
    status.dimensions ?? (!status.configured ? soleProviderPreset?.dimensions : undefined) ?? null,
  );

  embedSettingsChunkSizeInput.value = String(status.chunk_size);
  embedSettingsChunkOverlapInput.value = String(status.chunk_overlap);
  embedSettingsBaseUrlInput.value = status.base_url ?? "";
  embedSettingsApiKeyInput.value = "";

  const meta = embeddingOptions?.providers.find((p) => p.name === embedSettingsProviderSelect.value);
  if (meta) applyProviderMeta(meta);
}

async function loadEmbeddingSettingsIntoForm() {
  try {
    const status = await invoke<EmbeddingSettingsStatus>("get_embedding_settings");
    populateEmbeddingSettingsForm(status);
    setEmbeddingsFormEnabled(true);
    const chunksExist = anyChunksExist();
    applyEmbeddingLockState(status.configured && chunksExist);
    applyEmbeddingDeleteButtonState(status.configured, chunksExist);
  } catch (error) {
    embeddingsBadge.textContent = "Not configured";
    setEmbeddingsFormEnabled(false, `Could not reach the API: ${parseError(error).message}`);
  }
}

embeddingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload: Record<string, unknown> = {
      provider: embedSettingsProviderSelect.value,
      model: embedSettingsModelInput.value,
      dimensions: Number(embedSettingsDimensionsSelect.value),
      chunk_size: Number(embedSettingsChunkSizeInput.value),
      chunk_overlap: Number(embedSettingsChunkOverlapInput.value),
    };
    // Guarded on the field's own hidden state, not just a truthy .value — applyProviderMeta
    // clears both when they're hidden, but checking hidden here too means a stale value can
    // never reach the payload even if that invariant were ever broken elsewhere.
    if (!embedSettingsApiKeyField.hidden && embedSettingsApiKeyInput.value) {
      payload.api_key = embedSettingsApiKeyInput.value;
    }
    if (!embedSettingsBaseUrlField.hidden && embedSettingsBaseUrlInput.value) {
      payload.base_url = embedSettingsBaseUrlInput.value;
    }
    const status = await invoke<EmbeddingSettingsStatus>("save_embedding_settings", { payload });
    showToast("Embedding configuration saved.");
    populateEmbeddingSettingsForm(status);
    const chunksExist = anyChunksExist();
    applyEmbeddingLockState(status.configured && chunksExist);
    applyEmbeddingDeleteButtonState(status.configured, chunksExist);
    await checkStatusAndLoad();
  } catch (error) {
    showToast(`Error saving embedding configuration: ${parseError(error).message}`, "error");
  }
});

embeddingsRemoveButton.addEventListener("click", async () => {
  const confirmed = await confirm(
    "Delete the embedding configuration? Uploads and search may be affected until reconfigured.",
    { title: "Delete configuration", kind: "warning" },
  );
  if (!confirmed) return;
  try {
    const status = await invoke<EmbeddingSettingsStatus>("clear_embedding_settings");
    showToast("Embedding configuration deleted.");
    populateEmbeddingSettingsForm(status);
    const chunksExist = anyChunksExist();
    applyEmbeddingLockState(status.configured && chunksExist);
    applyEmbeddingDeleteButtonState(status.configured, chunksExist);
    await checkStatusAndLoad();
  } catch (error) {
    showToast(`Error deleting embedding configuration: ${parseError(error).message}`, "error");
  }
});

newLibraryButton.addEventListener("click", () => {
  createLibraryCard.hidden = !createLibraryCard.hidden;
});

cancelCreateLibraryButton.addEventListener("click", () => {
  createLibraryCard.hidden = true;
  createLibraryForm.reset();
});

createLibraryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value;
  try {
    await invoke("create_library", {
      payload: {
        name,
        description: descriptionInput.value || null,
      },
    });
    createLibraryForm.reset();
    createLibraryCard.hidden = true;
    showToast(`Library "${name}" created.`);
    await refreshLibraries();
  } catch (error) {
    showToast(`Error creating library: ${parseError(error).message}`, "error");
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
      renderBanner("Embeddings aren't configured — check the Configuration tab to enable uploads and search.");
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
  deleteButton.className = "btn btn-danger btn-pill";
  deleteButton.title = "Delete library";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    const confirmed = await confirm(
      `Delete library "${library.name}"? This removes all its documents.`,
      { title: "Delete library", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await invoke("delete_library", { libraryId: library.id });
      expandedLibraryIds.delete(library.id);
      showToast(`Library "${library.name}" deleted.`);
      await refreshLibraries();
    } catch (error) {
      showToast(`Error deleting library: ${parseError(error).message}`, "error");
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

function isDocumentInProgress(doc: LibraryDocument): boolean {
  return doc.status !== "completed" && doc.status !== "failed";
}

function getPendingUploadSet(libraryId: string): Set<string> {
  let pending = pendingUploadFilenames.get(libraryId);
  if (!pending) {
    pending = new Set();
    pendingUploadFilenames.set(libraryId, pending);
  }
  return pending;
}

function getPendingRetrySet(libraryId: string): Set<string> {
  let retrying = pendingRetryDocumentIds.get(libraryId);
  if (!retrying) {
    retrying = new Set();
    pendingRetryDocumentIds.set(libraryId, retrying);
  }
  return retrying;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function renderDocumentsInto(
  body: HTMLElement,
  library: Library,
  documents: LibraryDocument[],
  pendingFilenames: string[],
  retryingIds: Set<string>,
) {
  body.innerHTML = "";
  body.appendChild(renderUploadRow(library));

  if (documents.length === 0 && pendingFilenames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No documents yet.";
    body.appendChild(empty);
  } else {
    body.appendChild(renderDocTable(documents, library, pendingFilenames, retryingIds));
  }
}

// Re-renders from whatever was last fetched (lastKnownDocuments) plus any outstanding upload
// placeholders/retries — no network round trip. Used right after a file is picked or a retry is
// clicked, so the grid updates immediately instead of waiting on the request or a later poll tick.
function rerenderLibraryFromCache(library: Library) {
  const body = libraryDocBodies.get(library.id);
  if (!body || !expandedLibraryIds.has(library.id)) return;
  const documents = lastKnownDocuments.get(library.id) ?? [];
  const pending = Array.from(pendingUploadFilenames.get(library.id) ?? []);
  const retrying = pendingRetryDocumentIds.get(library.id) ?? new Set<string>();
  renderDocumentsInto(body, library, documents, pending, retrying);
}

// Single source of truth for document progress: re-fetches the list and re-renders it into
// whichever body element is currently mounted for this library (via libraryDocBodies, not a
// captured reference), then starts or stops a background poll depending on whether anything in
// the list — or an outstanding upload/retry placeholder — is still non-terminal. Called on
// initial expand, right after an upload or retry, and by the poll's own interval — so progress
// survives collapsing/re-expanding the card, deleting a different library (which rebuilds every
// card), or just leaving the tab and coming back.
async function syncLibraryDocuments(library: Library) {
  const body = libraryDocBodies.get(library.id);
  if (!body || !expandedLibraryIds.has(library.id)) return;

  let documents: LibraryDocument[];
  try {
    documents = await invoke<LibraryDocument[]>("list_documents", { libraryId: library.id });
  } catch (error) {
    body.innerHTML = `<p class="status-text">Error loading documents: ${parseError(error).message}</p>`;
    return;
  }

  lastKnownDocuments.set(library.id, documents);

  // A placeholder's real document row has shown up server-side — the real row (real id, real
  // status) takes over from here, so drop the placeholder to avoid showing both.
  const pending = pendingUploadFilenames.get(library.id);
  if (pending) {
    for (const doc of documents) pending.delete(doc.source_filename);
  }
  const pendingList = Array.from(pending ?? []);

  // A retried document has actually moved off "failed" server-side — stop overriding its badge.
  const retrying = pendingRetryDocumentIds.get(library.id);
  if (retrying) {
    for (const doc of documents) {
      if (doc.status !== "failed") retrying.delete(doc.id);
    }
  }

  renderDocumentsInto(body, library, documents, pendingList, retrying ?? new Set());

  // Keep polling while a placeholder/retry is still outstanding too — otherwise, if the very
  // first fetch right after upload or retry lands before the server has persisted the change,
  // this list looks like nothing's in progress and the poll would never even start.
  const inProgress =
    documents.some(isDocumentInProgress) || pendingList.length > 0 || (retrying?.size ?? 0) > 0;
  const existingPoll = activeDocumentPolls.get(library.id);
  if (inProgress && !existingPoll) {
    activeDocumentPolls.set(
      library.id,
      setInterval(() => syncLibraryDocuments(library), 1500),
    );
  } else if (!inProgress && existingPoll) {
    clearInterval(existingPoll);
    activeDocumentPolls.delete(library.id);
    // Keeps the (possibly collapsed) card header's doc-count badge in sync now that
    // ingestion has settled, without waiting for the user to manually refresh.
    await refreshLibraries();
  }
}

async function loadDocuments(library: Library, body: HTMLElement) {
  libraryDocBodies.set(library.id, body);
  body.innerHTML = `<p class="status-text">Loading documents...</p>`;
  await syncLibraryDocuments(library);
}

function renderDocTable(
  documents: LibraryDocument[],
  library: Library,
  pendingFilenames: string[],
  retryingIds: Set<string>,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "doc-table-wrap";

  const table = document.createElement("table");
  table.className = "doc-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>File</th>
        <th>Size</th>
        <th>Chunks</th>
        <th>Status</th>
        <th></th>
      </tr>
    </thead>
  `;

  const tbody = document.createElement("tbody");
  for (const filename of pendingFilenames) {
    tbody.appendChild(renderPendingRow(filename));
  }
  for (const doc of documents) {
    tbody.appendChild(renderDocRow(doc, library, retryingIds.has(doc.id)));
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

function renderPendingRow(filename: string): HTMLElement {
  const row = document.createElement("tr");
  row.className = "doc-row";

  const fileCell = document.createElement("td");
  fileCell.className = "doc-file-cell";
  fileCell.innerHTML = `
    <span class="doc-icon">${ICONS.fileText}</span>
    <span class="doc-name-group">
      <span class="doc-name" title="${filename}">${filename}</span>
    </span>
  `;

  const sizeCell = document.createElement("td");
  sizeCell.className = "doc-muted-cell";
  sizeCell.textContent = "—";

  const chunksCell = document.createElement("td");
  chunksCell.className = "doc-muted-cell";
  chunksCell.textContent = "—";

  const statusCell = document.createElement("td");
  statusCell.appendChild(renderStatusBadge("uploading"));

  const actionsCell = document.createElement("td");
  actionsCell.className = "doc-actions-cell";

  row.appendChild(fileCell);
  row.appendChild(sizeCell);
  row.appendChild(chunksCell);
  row.appendChild(statusCell);
  row.appendChild(actionsCell);
  return row;
}

// knowledge-api enforces this via Flask's MAX_CONTENT_LENGTH (app/constants.py's MAX_UPLOAD_MB =
// 50) but doesn't expose the limit through any API response — there's no endpoint to read it from
// dynamically, so it's mirrored here as a named constant per the "inevitable exception" carve-out
// (can't be sourced from the API, so it lives here, clearly named, instead of an inline literal).
// If the server-side limit ever changes, this needs updating to match, or this client-side check
// could reject files the server would actually accept (or let through ones it would now reject).
const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

// bytes is speculative (see the size_bytes comment on LibraryDocument) — "—" until confirmed.
function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function renderStatusBadge(status: string): HTMLElement {
  const badge = document.createElement("span");
  if (status === "completed") {
    badge.className = "doc-status doc-status-completed";
    badge.textContent = "Completed";
  } else if (status === "failed") {
    badge.className = "doc-status doc-status-failed";
    badge.textContent = "Failed";
  } else {
    badge.className = "doc-status doc-status-progress";
    const spinner = document.createElement("span");
    spinner.className = "doc-status-spinner";
    const label = document.createElement("span");
    label.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    badge.appendChild(spinner);
    badge.appendChild(label);
  }
  return badge;
}

function renderDocRow(doc: LibraryDocument, library: Library, isRetrying: boolean): HTMLElement {
  const row = document.createElement("tr");
  row.className = "doc-row";

  const fileCell = document.createElement("td");
  fileCell.className = "doc-file-cell";
  fileCell.innerHTML = `
    <span class="doc-icon">${ICONS.fileText}</span>
    <span class="doc-name-group">
      <span class="doc-name" title="${doc.source_filename}">${doc.source_filename}</span>
      <span class="doc-sub">${doc.file_type}</span>
    </span>
  `;

  const sizeCell = document.createElement("td");
  sizeCell.className = "doc-muted-cell";
  sizeCell.textContent = formatFileSize(doc.size_bytes);

  const chunksCell = document.createElement("td");
  chunksCell.className = "doc-muted-cell";
  chunksCell.textContent = doc.chunk_count != null ? String(doc.chunk_count) : "—";

  const statusCell = document.createElement("td");
  // Retry is async server-side — the document's own status can still read "failed" for a moment
  // after retry is triggered, so override the badge here rather than wait for the real status.
  const badge = isRetrying ? renderStatusBadge("retrying") : renderStatusBadge(doc.status);
  if (!isRetrying && doc.status === "failed" && doc.error_message) {
    badge.title = doc.error_message;
  }
  statusCell.appendChild(badge);

  const actionsCell = document.createElement("td");
  actionsCell.className = "doc-actions-cell";
  const actions = document.createElement("span");
  actions.className = "doc-actions";

  if (!isRetrying && doc.status === "failed") {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "btn btn-sm btn-primary";
    retryButton.title = "Retry ingestion";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", async () => {
      getPendingRetrySet(library.id).add(doc.id);
      rerenderLibraryFromCache(library);
      try {
        await invoke("retry_document", { libraryId: library.id, documentId: doc.id });
        showToast(`Retrying "${doc.source_filename}"…`);
        await syncLibraryDocuments(library);
      } catch (error) {
        getPendingRetrySet(library.id).delete(doc.id);
        rerenderLibraryFromCache(library);
        showToast(`Error retrying "${doc.source_filename}": ${parseError(error).message}`, "error");
      }
    });
    actions.appendChild(retryButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn btn-danger btn-pill";
  deleteButton.title = "Delete document";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    const confirmed = await confirm(
      `Delete "${doc.source_filename}"? This removes it and its embeddings from this library.`,
      { title: "Delete document", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await invoke("delete_document", { libraryId: library.id, documentId: doc.id });
      showToast(`"${doc.source_filename}" deleted.`);
      await syncLibraryDocuments(library);
    } catch (error) {
      showToast(`Error deleting document: ${parseError(error).message}`, "error");
    }
  });
  actions.appendChild(deleteButton);
  actionsCell.appendChild(actions);

  row.appendChild(fileCell);
  row.appendChild(sizeCell);
  row.appendChild(chunksCell);
  row.appendChild(statusCell);
  row.appendChild(actionsCell);
  return row;
}

function renderUploadRow(library: Library): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "doc-upload-wrap";

  const dropzone = document.createElement("button");
  dropzone.type = "button";
  dropzone.className = "dropzone";
  dropzone.innerHTML = `<span class="dropzone-icon">${ICONS.upload}</span><span class="dropzone-title">Click to choose a file to upload</span><span class="dropzone-caption">Max file size: ${formatFileSize(MAX_UPLOAD_SIZE_BYTES)}</span>`;

  dropzone.addEventListener("click", async () => {
    const filePath = await open({ multiple: false });
    if (!filePath) return;
    const filename = basename(filePath);

    // Reject an oversized file before ever calling the API — knowledge-api enforces this via
    // Flask's MAX_CONTENT_LENGTH and would otherwise just reject the request after the whole file
    // is already read into memory and sent over the wire.
    let fileSize: number;
    try {
      fileSize = await invoke<number>("get_file_size", { filePath });
    } catch (error) {
      showToast(`Could not read "${filename}": ${parseError(error).message}`, "error");
      return;
    }
    if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
      showToast(
        `"${filename}" is ${formatFileSize(fileSize)}, which is over the ${formatFileSize(MAX_UPLOAD_SIZE_BYTES)} upload limit.`,
        "error",
      );
      return;
    }

    // Optimistic: show it in the grid as "Uploading" immediately, before the request even goes
    // out — this row (and this whole wrapper) is about to be torn down and rebuilt by that
    // re-render, so nothing here holds onto it afterwards.
    getPendingUploadSet(library.id).add(filename);
    rerenderLibraryFromCache(library);

    try {
      await invoke("upload_document", { libraryId: library.id, filePath });
      // From here on, the placeholder is cleared and progress is tracked by
      // syncLibraryDocuments's poll once the real document row shows up.
      await syncLibraryDocuments(library);
    } catch (error) {
      // The upload request itself failed outright — no document row will ever show up for this
      // filename, so drop the placeholder and surface the error via toast instead of a status
      // line, since there's no longer a row to attach one to.
      getPendingUploadSet(library.id).delete(filename);
      rerenderLibraryFromCache(library);
      showToast(`Error uploading ${filename}: ${parseError(error).message}`, "error");
    }
  });

  wrapper.appendChild(dropzone);
  return wrapper;
}

// Re-runs the full connection/embeddings load, same sequence as startup. Used by: the manual
// refresh button, opening the Configuration tab, and init() itself — there's otherwise no way to
// recover from "app started before the API container did" short of a restart, since everything
// below only ever ran once, at launch.
async function refreshConnection() {
  const config = await invoke<AppConfig>("get_config");
  // Skip embeddings-related calls entirely until the connection itself is configured — otherwise
  // they'd just fail with a confusing "Invalid or missing credentials" before the user has done anything.
  if (hasCredentials(config)) {
    await loadEmbeddingOptions();
    await loadEmbeddingSettingsIntoForm();
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
  await loadSettingsIntoForm();
  await refreshConnection();
}

init();
