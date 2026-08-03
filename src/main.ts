import { invoke } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initShell, switchToView } from "./shell";

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

interface CrawlPageStatus {
  status: string;
  document_id: string | null;
  error: string | null;
}

interface CrawlJobStatus {
  status: string;
  seed_url: string;
  error: string | null;
  // Grows as the crawl discovers pages — never a fixed/known count upfront, so progress is shown
  // as "N pages so far," never a determinate percentage.
  pages: Record<string, CrawlPageStatus>;
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

// Re-ranking was removed entirely from knowledge-api (it was unreachable — an empty provider
// allow-list — and had a latent bug where enabling it would silently break for any deployment not
// using Voyage for embeddings). No "configured" boolean, unlike EmbeddingSettingsStatus — search
// settings always exist (with defaults) rather than being an optional resource.
interface SearchSettingsStatus {
  dense_k: number;
  sparse_k: number;
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
  // User-supplied "open folder with document" icon (svgrepo.com) — a solid-filled silhouette,
  // unlike this app's other stroke-only icons, so fill is currentColor (not the source's hardcoded
  // #000000) to invert correctly against the sidebar's dark background and light/dark themes alike.
  library:
    '<svg viewBox="0 0 198.084 198.084" fill="currentColor"><path d="M185.379,159.263L185.379,159.263l-3.452,16.918c-1.222,5.987-6.488,10.287-12.599,10.287H20.196c-8.135,0-14.225-7.458-12.599-15.429l14.342-70.291c1.001-4.904,4.577-8.725,9.141-10.196l0,0c0.325-0.105,0.656-0.198,0.99-0.279c0.017-0.004,0.034-0.007,0.051-0.011c0.314-0.075,0.631-0.14,0.952-0.193c0.101-0.016,0.203-0.026,0.305-0.04c0.247-0.035,0.495-0.07,0.746-0.091c0.368-0.03,0.739-0.049,1.114-0.049h5.842h117.735h10h16.563h6.236c1.79,0,3.383,0.718,4.54,1.861c1.157,1.143,1.879,2.712,1.926,4.414c0.013,0.486-0.028,0.983-0.13,1.484L185.379,159.263z M185.315,79.889c-0.6-5.713-5.445-10.181-11.314-10.181h-5.186v10.181H185.315z M12.142,98.749c1.947-9.543,9.603-16.799,18.939-18.486V52.719H13.35C5.989,52.719,0,58.708,0,66.068v92.185L12.142,98.749z M158.815,17.23v62.659H41.081V17.23c0-3.095,2.519-5.614,5.614-5.614h106.507C156.297,11.616,158.815,14.134,158.815,17.23z M144.425,61.507c0-2.761-2.238-5-5-5H60.471c-2.761,0-5,2.239-5,5c0,2.761,2.239,5,5,5h78.954C142.187,66.507,144.425,64.268,144.425,61.507z M144.425,35.69c0-2.761-2.238-5-5-5H60.471c-2.761,0-5,2.239-5,5s2.239,5,5,5h78.954C142.187,40.69,144.425,38.451,144.425,35.69z"/></svg>',
  fileText:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
  upload:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
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

const searchSettingsForm = document.querySelector<HTMLFormElement>("#search-settings-form")!;
const searchSettingsDenseKInput = document.querySelector<HTMLInputElement>("#search-settings-dense-k")!;
const searchSettingsSparseKInput = document.querySelector<HTMLInputElement>("#search-settings-sparse-k")!;
const searchSettingsRrfKInput = document.querySelector<HTMLInputElement>("#search-settings-rrf-k")!;
const searchSettingsFormStatus = document.querySelector<HTMLParagraphElement>("#search-settings-form-status")!;

const statusBanner = document.querySelector<HTMLDivElement>("#status-banner")!;

const newLibraryButton = document.querySelector<HTMLButtonElement>("#sidebar-new-library-btn")!;
const createLibraryCard = document.querySelector<HTMLDivElement>("#create-library-card")!;
const createLibraryForm = document.querySelector<HTMLFormElement>("#create-library-form")!;
const cancelCreateLibraryButton = document.querySelector<HTMLButtonElement>("#cancel-create-library")!;
const closeCreateLibraryButton = document.querySelector<HTMLButtonElement>("#close-create-library")!;
const nameInput = document.querySelector<HTMLInputElement>("#lib-name")!;
const descriptionInput = document.querySelector<HTMLInputElement>("#lib-description")!;

const editLibraryCard = document.querySelector<HTMLDivElement>("#edit-library-card")!;
const editLibraryForm = document.querySelector<HTMLFormElement>("#edit-library-form")!;
const cancelEditLibraryButton = document.querySelector<HTMLButtonElement>("#cancel-edit-library")!;
const closeEditLibraryButton = document.querySelector<HTMLButtonElement>("#close-edit-library")!;
const editNameInput = document.querySelector<HTMLInputElement>("#lib-edit-name")!;
const editDescriptionInput = document.querySelector<HTMLInputElement>("#lib-edit-description")!;

const librariesList = document.querySelector<HTMLDivElement>("#libraries-list")!;

const sidebarLibraryTree = document.querySelector<HTMLDivElement>("#sidebar-library-tree")!;
const libraryDetailBackButton = document.querySelector<HTMLButtonElement>("#library-detail-back-btn")!;
const libraryDetailName = document.querySelector<HTMLHeadingElement>("#library-detail-name")!;
const libraryDetailDescription = document.querySelector<HTMLParagraphElement>("#library-detail-description")!;
const libraryDetailDocCount = document.querySelector<HTMLSpanElement>("#library-detail-doc-count")!;
const libraryDetailBody = document.querySelector<HTMLDivElement>("#library-detail-body")!;

// The one library currently shown on #view-library, if any — unlike the old per-card design,
// #library-detail-body is a single shared element reused across libraries, so every poll/render
// path below must check this before touching it (see rerenderLibraryFromCache/syncLibraryDocuments)
// to stop a background poll for a library you've since navigated away from from clobbering
// whichever library's content is actually showing now.
let currentLibraryId: string | null = null;
let cachedLibraries: Library[] = [];
// Tracks whatever body element is currently mounted for the open library, looked up fresh on every
// poll tick (never captured in a closure) — so an in-flight upload's progress keeps rendering into
// the right place even if the detail view gets torn down and rebuilt in the meantime.
const libraryDocBodies = new Map<string, HTMLElement>();
const activeDocumentPolls = new Map<string, ReturnType<typeof setInterval>>();
// Last real document list fetched per library — lets an optimistic placeholder be re-rendered
// alongside real data without needing its own network round trip.
const lastKnownDocuments = new Map<string, LibraryDocument[]>();
// Filenames shown as "Uploading" placeholders before the server has a real document row for
// them yet — cleared once the corresponding filename shows up in a real fetch.
const pendingUploadFilenames = new Map<string, Set<string>>();
// job_id of each in-flight upload, keyed by filename — captured from upload_document's response
// so the placeholder's Cancel button has something to call cancel_upload_job with.
const pendingUploadJobIds = new Map<string, Map<string, string>>();
// Filenames whose upload Cancel button has been clicked — shown as "Cancelling…" instead of
// "Uploading" until the placeholder is cleared (see the cancellation is best-effort/not instant
// comment on the Rust cancel_upload_job command).
const cancelRequestedUploads = new Map<string, Set<string>>();
// Which upload method tab ("file" vs "url") is showing per library — purely a UI preference, not
// document data, but still needs to survive re-renders since renderUploadRow is rebuilt from
// scratch on every syncLibraryDocuments/rerenderLibraryFromCache call.
const activeUploadTab = new Map<string, "file" | "url">();
// Document ids currently being retried — shown as "Retrying" instead of their last-fetched
// "failed" status. Retry is async server-side (status flips to "processing" on a background
// thread after the POST already returned), so a poll right after clicking retry can still see
// the stale "failed" status; cleared once a fetch shows the document has actually moved off it.
const pendingRetryDocumentIds = new Map<string, Set<string>>();
// Document ids currently showing the inline rename editor in place of their normal name/actions.
const renamingDocumentIds = new Map<string, Set<string>>();
// Crawl jobs currently being polled, per library (libraryId -> jobId -> latest known status).
// Rendered as a placeholder row (like an upload) until the job resolves — a crawl can take a
// while and produce documents progressively, so this needs its own poll (crawl-jobs isn't part
// of list_documents), run alongside the regular document-list poll so completed pages surface as
// they land rather than only once the whole crawl finishes.
const activeCrawlJobs = new Map<string, Map<string, CrawlJobStatus>>();

function getCrawlJobsMap(libraryId: string): Map<string, CrawlJobStatus> {
  let jobs = activeCrawlJobs.get(libraryId);
  if (!jobs) {
    jobs = new Map();
    activeCrawlJobs.set(libraryId, jobs);
  }
  return jobs;
}

const DOCS_PER_PAGE = 10;
// Current page per library (1-indexed) — clamped to the valid range on every render rather than
// reset to 1 on every change, so background polling elsewhere doesn't yank the user off whatever
// page they're browsing.
const documentGridPage = new Map<string, number>();

function getCurrentDocumentPage(libraryId: string): number {
  return documentGridPage.get(libraryId) ?? 1;
}

// Selected document ids per library, for bulk delete.
const selectedDocumentIds = new Map<string, Set<string>>();

function getSelectedDocumentSet(libraryId: string): Set<string> {
  let selected = selectedDocumentIds.get(libraryId);
  if (!selected) {
    selected = new Set();
    selectedDocumentIds.set(libraryId, selected);
  }
  return selected;
}

// Keeps the grid's column widths stable regardless of how long a filename or crawled URL is —
// table-layout:fixed alone stops a wide cell from stealing space from other columns, but doesn't
// stop the text itself from wrapping/overflowing inside its own cell. The full, untruncated value
// is always still available on hover via the title attribute.
const MAX_FILENAME_DISPLAY_CHARS = 50;

function truncateText(text: string, maxChars: number = MAX_FILENAME_DISPLAY_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

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

// linkView picks which settings page the banner's link jumps to — "knowledge-api" for connection
// problems, "embeddings" for embeddings-provider problems — now that those used to be one
// combined Configuration tab and are two separate sidebar destinations.
function renderBanner(message: string, linkView: "knowledge-api" | "embeddings") {
  const linkLabel = linkView === "knowledge-api" ? "Go to Knowledge API" : "Go to Embeddings";
  statusBanner.innerHTML = `
    <div class="banner banner-warning">
      <span class="banner-icon">${ICONS.alertTriangle}</span>
      <span>${message} <button type="button" class="banner-link" id="banner-config-link">${linkLabel}</button></span>
    </div>
  `;
  document.querySelector<HTMLButtonElement>("#banner-config-link")?.addEventListener("click", () => {
    switchToView(linkView);
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
  // "checking" gets neither color — it's a transient, in-between state, not a subtle-green
  // "good" or subtle-red "bad" verdict on the connection.
  connectionBadge.classList.toggle("badge-success", state === "configured");
  connectionBadge.classList.toggle("badge-destructive", state === "not_configured" || state === "invalid" || state === "unreachable");
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
    renderBanner("Not connected — configure your API connection first.", "knowledge-api");
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

function setEmbeddingsBadge(configured: boolean) {
  embeddingsBadge.textContent = configured ? "Configured" : "Not configured";
  embeddingsBadge.classList.toggle("badge-success", configured);
  embeddingsBadge.classList.toggle("badge-destructive", !configured);
}

function populateEmbeddingSettingsForm(status: EmbeddingSettingsStatus) {
  setEmbeddingsBadge(status.configured);
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
    setEmbeddingsBadge(false);
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

function populateSearchSettingsForm(status: SearchSettingsStatus) {
  searchSettingsDenseKInput.value = String(status.dense_k);
  searchSettingsSparseKInput.value = String(status.sparse_k);
  searchSettingsRrfKInput.value = String(status.rrf_k);
}

async function loadSearchSettingsIntoForm() {
  try {
    const status = await invoke<SearchSettingsStatus>("get_search_settings");
    populateSearchSettingsForm(status);
  } catch (error) {
    searchSettingsFormStatus.textContent = `Could not reach the API: ${parseError(error).message}`;
  }
}

searchSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      dense_k: Number(searchSettingsDenseKInput.value),
      sparse_k: Number(searchSettingsSparseKInput.value),
      rrf_k: Number(searchSettingsRrfKInput.value),
    };
    const status = await invoke<SearchSettingsStatus>("save_search_settings", { payload });
    showToast("Search settings saved.");
    populateSearchSettingsForm(status);
  } catch (error) {
    showToast(`Error saving search settings: ${parseError(error).message}`, "error");
  }
});

function closeCreateLibraryModal() {
  createLibraryCard.hidden = true;
  createLibraryForm.reset();
}

// Lives in the sidebar now, next to the Knowledge nav item, rather than the Knowledge page's own
// header — so it may be clicked from any page, and needs to switch to the Knowledge view itself
// (same as clicking the sidebar item directly) before the create-library modal means anything.
newLibraryButton.addEventListener("click", () => {
  switchToView("knowledge");
  createLibraryCard.hidden = !createLibraryCard.hidden;
});

cancelCreateLibraryButton.addEventListener("click", closeCreateLibraryModal);
closeCreateLibraryButton.addEventListener("click", closeCreateLibraryModal);

// Closes on a click that lands on the backdrop itself, not one that bubbled up from inside the
// dialog box — event.target is only the overlay element for the former.
createLibraryCard.addEventListener("click", (event) => {
  if (event.target === createLibraryCard) closeCreateLibraryModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !createLibraryCard.hidden) closeCreateLibraryModal();
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
    showToast(`Library "${name}" created.`);
    closeCreateLibraryModal();
    await refreshLibraries();
  } catch (error) {
    showToast(`Error creating library: ${parseError(error).message}`, "error");
  }
});

// Which library the (single, shared) edit modal is currently open for — null when closed.
let libraryBeingEdited: Library | null = null;

function closeEditLibraryModal() {
  editLibraryCard.hidden = true;
  editLibraryForm.reset();
  libraryBeingEdited = null;
}

function openEditLibraryModal(library: Library) {
  libraryBeingEdited = library;
  editNameInput.value = library.name;
  editDescriptionInput.value = library.description ?? "";
  editLibraryCard.hidden = false;
}

cancelEditLibraryButton.addEventListener("click", closeEditLibraryModal);
closeEditLibraryButton.addEventListener("click", closeEditLibraryModal);

editLibraryCard.addEventListener("click", (event) => {
  if (event.target === editLibraryCard) closeEditLibraryModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !editLibraryCard.hidden) closeEditLibraryModal();
});

// knowledge-api has no PATCH/PUT /libraries/{id} yet (see update_library's comment on the Rust
// side) — this will fail with a 404-shaped error until the API team adds it. Wired up for real
// anyway, same as the re-ranking enable checkbox before its provider existed: the natural error
// toast communicates "not supported yet" without needing a separate disabled/placeholder state.
editLibraryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!libraryBeingEdited) return;
  const name = editNameInput.value;
  try {
    await invoke("update_library", {
      libraryId: libraryBeingEdited.id,
      payload: {
        name,
        description: editDescriptionInput.value || null,
      },
    });
    showToast(`Library "${name}" updated.`);
    closeEditLibraryModal();
    await refreshLibraries();
  } catch (error) {
    showToast(`Error updating library: ${parseError(error).message}`, "error");
  }
});

// The three states this distinguishes: (1) no local connection configured at all, (2) connection
// configured but rag-api rejects the credentials (401), (3) rag-api reachable but embeddings
// aren't configured there yet — libraries can still be listed/created, only ingestion/query need it.
async function checkStatusAndLoad() {
  const config = await invoke<AppConfig>("get_config");
  if (!hasCredentials(config)) {
    setConnectionBadge("not_configured");
    renderBanner("Not connected — configure your API connection first.", "knowledge-api");
    librariesList.innerHTML = "";
    sidebarLibraryTree.innerHTML = "";
    return;
  }

  try {
    cachedLibraries = await invoke<Library[]>("list_libraries");
  } catch (rawError) {
    const error = parseError(rawError);
    if (error.code === "unauthorized") {
      setConnectionBadge("invalid");
      renderBanner("Your client credentials look invalid or expired — update them in Knowledge API.", "knowledge-api");
    } else {
      setConnectionBadge("unreachable");
      renderBanner(`Error loading libraries: ${error.message}`, "knowledge-api");
    }
    librariesList.innerHTML = "";
    sidebarLibraryTree.innerHTML = "";
    return;
  }

  setConnectionBadge("configured");
  clearBanner();
  renderLibraryList();
  renderSidebarLibraryTree();

  try {
    const embeddingStatus = await invoke<EmbeddingSettingsStatus>("get_embedding_settings");
    if (!embeddingStatus.configured) {
      renderBanner("Embeddings aren't configured — set up your embeddings provider to enable uploads and search.", "embeddings");
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
    librariesList.appendChild(renderLibraryListRow(library));
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
  renderSidebarLibraryTree();
  // The open library's doc-count badge is drawn from cachedLibraries at open time — if ingestion
  // just finished (this is called from syncLibraryDocuments once a poll settles), refresh it too
  // so it doesn't sit stale until the user reopens the page.
  const current = currentLibraryId ? cachedLibraries.find((lib) => lib.id === currentLibraryId) : null;
  if (current) libraryDetailDocCount.textContent = `${current.document_count} docs`;
}

// Plain two-line row (name + description) — no expand/chevron, no inline document body. Clicking
// navigates to that library's own detail view (#view-library) instead of expanding in place.
function renderLibraryListRow(library: Library): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "library-list-row";

  const icon = document.createElement("span");
  icon.className = "library-list-icon";
  icon.innerHTML = ICONS.library;

  const text = document.createElement("span");
  text.className = "library-list-text";

  const name = document.createElement("span");
  name.className = "library-list-name";
  name.textContent = library.name;

  const description = document.createElement("span");
  description.className = "library-list-description";
  description.textContent = library.description || "No description";

  text.appendChild(name);
  text.appendChild(description);

  const docCount = document.createElement("span");
  docCount.className = "badge library-list-doc-count";
  docCount.textContent = `${library.document_count} docs`;

  row.appendChild(icon);
  row.appendChild(text);
  row.appendChild(docCount);
  row.addEventListener("click", () => openLibraryDetail(library));
  return row;
}

// Shared by the sidebar row's trash icon — the only place Delete lives now (moved off the
// library-detail page header, which only shows the doc-count badge these days).
async function deleteLibrary(library: Library) {
  const confirmed = await confirm(
    `Delete library "${library.name}"? This removes all its documents.`,
    { title: "Delete library", kind: "warning" },
  );
  if (!confirmed) return;
  try {
    await invoke("delete_library", { libraryId: library.id });
    showToast(`Library "${library.name}" deleted.`);
    if (currentLibraryId === library.id) {
      switchToView("knowledge");
      currentLibraryId = null;
    }
    await refreshLibraries();
  } catch (error) {
    showToast(`Error deleting library: ${parseError(error).message}`, "error");
  }
}

// Child rows nested under the Knowledge sidebar item, one per library — kept in sync with
// cachedLibraries on every refreshLibraries() call, mirroring the main list. Each row is a
// .sidebar-item-row (same "row carries the background" pattern as the Knowledge item itself) with
// three children: the library button, an Edit (pencil) action, and a Delete (trash) action — all
// siblings, never nested inside one another, since a <button> can't contain another <button>.
function renderSidebarLibraryTree() {
  sidebarLibraryTree.innerHTML = "";
  for (const library of cachedLibraries) {
    const row = document.createElement("div");
    row.className = "sidebar-item-row";

    const item = document.createElement("button");
    item.type = "button";
    item.className = "sidebar-library-item";
    item.classList.toggle("active", library.id === currentLibraryId);
    item.dataset.libraryId = library.id;

    const icon = document.createElement("span");
    icon.className = "sidebar-icon";
    icon.innerHTML = ICONS.library;

    const label = document.createElement("span");
    label.className = "sidebar-label";
    label.textContent = library.name;

    item.appendChild(icon);
    item.appendChild(label);
    item.addEventListener("click", () => openLibraryDetail(library));

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "sidebar-library-item-action";
    editButton.title = "Edit library";
    editButton.setAttribute("aria-label", "Edit library");
    editButton.innerHTML = `<span class="sidebar-icon">${ICONS.pencil}</span>`;
    editButton.addEventListener("click", () => openEditLibraryModal(library));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "sidebar-library-item-action sidebar-library-item-action-danger";
    deleteButton.title = "Delete library";
    deleteButton.setAttribute("aria-label", "Delete library");
    deleteButton.innerHTML = `<span class="sidebar-icon">${ICONS.trash}</span>`;
    deleteButton.addEventListener("click", () => deleteLibrary(library));

    row.appendChild(item);
    row.appendChild(editButton);
    row.appendChild(deleteButton);
    sidebarLibraryTree.appendChild(row);
  }
}

// Switches to #view-library and populates it for this specific library — the header (name,
// description, doc-count) plus the same upload/document-grid machinery that used to render inline
// inside an expanded library card, now mounted into the single shared #library-detail-body.
function openLibraryDetail(library: Library) {
  switchToView("library");
  currentLibraryId = library.id;

  libraryDetailName.textContent = library.name;
  libraryDetailDescription.textContent = library.description || "No description";
  libraryDetailDocCount.textContent = `${library.document_count} docs`;

  document.querySelectorAll<HTMLButtonElement>(".sidebar-library-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.libraryId === library.id);
  });

  loadDocuments(library, libraryDetailBody);
}

libraryDetailBackButton.addEventListener("click", () => {
  switchToView("knowledge");
});

function isDocumentInProgress(doc: LibraryDocument): boolean {
  return doc.status !== "completed" && doc.status !== "failed" && doc.status !== "cancelled";
}

function getPendingUploadSet(libraryId: string): Set<string> {
  let pending = pendingUploadFilenames.get(libraryId);
  if (!pending) {
    pending = new Set();
    pendingUploadFilenames.set(libraryId, pending);
  }
  return pending;
}

function getPendingUploadJobIds(libraryId: string): Map<string, string> {
  let jobIds = pendingUploadJobIds.get(libraryId);
  if (!jobIds) {
    jobIds = new Map();
    pendingUploadJobIds.set(libraryId, jobIds);
  }
  return jobIds;
}

function getCancelRequestedSet(libraryId: string): Set<string> {
  let cancelling = cancelRequestedUploads.get(libraryId);
  if (!cancelling) {
    cancelling = new Set();
    cancelRequestedUploads.set(libraryId, cancelling);
  }
  return cancelling;
}

function getPendingRetrySet(libraryId: string): Set<string> {
  let retrying = pendingRetryDocumentIds.get(libraryId);
  if (!retrying) {
    retrying = new Set();
    pendingRetryDocumentIds.set(libraryId, retrying);
  }
  return retrying;
}

function getRenamingSet(libraryId: string): Set<string> {
  let renaming = renamingDocumentIds.get(libraryId);
  if (!renaming) {
    renaming = new Set();
    renamingDocumentIds.set(libraryId, renaming);
  }
  return renaming;
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
  crawlJobs: CrawlJobStatus[],
) {
  body.innerHTML = "";
  body.appendChild(renderUploadRow(library));

  if (documents.length === 0 && pendingFilenames.length === 0 && crawlJobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No documents yet.";
    body.appendChild(empty);
  } else {
    body.appendChild(renderDocTable(documents, library, pendingFilenames, retryingIds, crawlJobs));
  }
}

// Re-renders from whatever was last fetched (lastKnownDocuments) plus any outstanding upload
// placeholders/retries/crawls — no network round trip. Used right after a file is picked, a
// retry is clicked, or a crawl job's status changes, so the grid updates immediately instead of
// waiting on the request or a later poll tick.
function rerenderLibraryFromCache(library: Library) {
  const body = libraryDocBodies.get(library.id);
  if (!body || currentLibraryId !== library.id) return;
  const documents = lastKnownDocuments.get(library.id) ?? [];
  const pending = Array.from(pendingUploadFilenames.get(library.id) ?? []);
  const retrying = pendingRetryDocumentIds.get(library.id) ?? new Set<string>();
  const crawlJobs = Array.from(activeCrawlJobs.get(library.id)?.values() ?? []);
  renderDocumentsInto(body, library, documents, pending, retrying, crawlJobs);
}

// Single source of truth for document progress: re-fetches the list and re-renders it into
// whichever body element is currently mounted for this library (via libraryDocBodies, not a
// captured reference), then starts or stops a background poll depending on whether anything in
// the list — or an outstanding upload/retry placeholder/crawl job — is still non-terminal.
// Called on initial open, right after an upload or retry, and by the poll's own interval — so
// progress survives navigating away and back, opening a different library (which reuses the same
// shared #library-detail-body), or just leaving the tab and coming back. Kept running alongside a
// crawl job's own poll (pollCrawlJob) so pages the crawl finishes show up here as real document
// rows progressively, not just once the whole crawl completes.
async function syncLibraryDocuments(library: Library) {
  const body = libraryDocBodies.get(library.id);
  if (!body || currentLibraryId !== library.id) return;

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
    const jobIds = pendingUploadJobIds.get(library.id);
    const cancelling = cancelRequestedUploads.get(library.id);
    for (const doc of documents) {
      pending.delete(doc.source_filename);
      jobIds?.delete(doc.source_filename);
      cancelling?.delete(doc.source_filename);
    }
  }
  const pendingList = Array.from(pending ?? []);

  // A retried document has actually moved off "failed"/"cancelled" server-side — stop overriding its badge.
  const retrying = pendingRetryDocumentIds.get(library.id);
  if (retrying) {
    for (const doc of documents) {
      if (doc.status !== "failed" && doc.status !== "cancelled") retrying.delete(doc.id);
    }
  }

  const crawlJobs = Array.from(activeCrawlJobs.get(library.id)?.values() ?? []);

  renderDocumentsInto(body, library, documents, pendingList, retrying ?? new Set(), crawlJobs);

  // Keep polling while a placeholder/retry/crawl is still outstanding too — otherwise, if the
  // very first fetch right after upload or retry lands before the server has persisted the
  // change, this list looks like nothing's in progress and the poll would never even start.
  const inProgress =
    documents.some(isDocumentInProgress) ||
    pendingList.length > 0 ||
    (retrying?.size ?? 0) > 0 ||
    crawlJobs.length > 0;
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
  crawlJobs: CrawlJobStatus[],
): HTMLElement {
  const container = document.createElement("div");

  const selected = getSelectedDocumentSet(library.id);
  // Drop any selected id that's no longer in the list (deleted elsewhere, etc.) so the bulk-action
  // bar and "select all" checkbox never reflect a stale/impossible selection.
  const currentIds = new Set(documents.map((d) => d.id));
  for (const id of selected) {
    if (!currentIds.has(id)) selected.delete(id);
  }
  if (selected.size > 0) {
    container.appendChild(renderBulkActionsBar(library, selected));
  }

  const totalPages = Math.max(1, Math.ceil(documents.length / DOCS_PER_PAGE));
  const currentPage = Math.min(getCurrentDocumentPage(library.id), totalPages);
  documentGridPage.set(library.id, currentPage);
  const pageStart = (currentPage - 1) * DOCS_PER_PAGE;
  const pageDocuments = documents.slice(pageStart, pageStart + DOCS_PER_PAGE);
  const pageIds = pageDocuments.map((d) => d.id);

  const wrap = document.createElement("div");
  wrap.className = "doc-table-wrap";

  const table = document.createElement("table");
  table.className = "doc-table";

  const headRow = document.createElement("tr");
  headRow.innerHTML = `
    <th>File</th>
    <th class="doc-col-size">Size</th>
    <th class="doc-col-chunks">Chunks</th>
    <th class="doc-col-status">Status</th>
    <th class="doc-col-actions"></th>
  `;
  const selectAllTh = document.createElement("th");
  selectAllTh.className = "doc-col-select";
  const selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.setAttribute("aria-label", "Select all documents on this page");
  selectAllCheckbox.checked = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  selectAllCheckbox.addEventListener("change", () => {
    for (const id of pageIds) {
      if (selectAllCheckbox.checked) selected.add(id);
      else selected.delete(id);
    }
    rerenderLibraryFromCache(library);
  });
  selectAllTh.appendChild(selectAllCheckbox);
  headRow.prepend(selectAllTh);

  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const job of crawlJobs) {
    tbody.appendChild(renderCrawlJobRow(job));
  }
  for (const filename of pendingFilenames) {
    tbody.appendChild(renderPendingRow(filename, library));
  }
  for (const doc of pageDocuments) {
    tbody.appendChild(renderDocRow(doc, library, retryingIds.has(doc.id), selected.has(doc.id)));
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  container.appendChild(wrap);

  if (totalPages > 1) {
    container.appendChild(renderPaginationControls(library, currentPage, totalPages));
  }

  return container;
}

function renderBulkActionsBar(library: Library, selected: Set<string>): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "doc-bulk-actions";

  const label = document.createElement("span");
  label.className = "doc-bulk-actions-label";
  label.textContent = `${selected.size} selected`;

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "btn btn-ghost btn-sm";
  clearButton.textContent = "Clear";
  clearButton.addEventListener("click", () => {
    selected.clear();
    rerenderLibraryFromCache(library);
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "btn btn-danger btn-sm";
  deleteButton.textContent = "Delete selected";
  deleteButton.addEventListener("click", async () => {
    const ids = Array.from(selected);
    const confirmed = await confirm(
      `Delete ${ids.length} document${ids.length === 1 ? "" : "s"}? This removes them and their embeddings from this library.`,
      { title: "Delete documents", kind: "warning" },
    );
    if (!confirmed) return;

    // No bulk-delete endpoint exists — this loops the existing single-document delete, same as
    // clicking Delete on each row individually, just without needing to do it one at a time.
    let succeeded = 0;
    let firstError: string | null = null;
    for (const id of ids) {
      try {
        await invoke("delete_document", { libraryId: library.id, documentId: id });
        selected.delete(id);
        succeeded += 1;
      } catch (error) {
        firstError ??= parseError(error).message;
      }
    }
    if (firstError) {
      showToast(`Deleted ${succeeded} of ${ids.length} document(s). First error: ${firstError}`, "error");
    } else {
      showToast(`${succeeded} document${succeeded === 1 ? "" : "s"} deleted.`);
    }
    await syncLibraryDocuments(library);
  });

  bar.appendChild(label);
  bar.appendChild(clearButton);
  bar.appendChild(deleteButton);
  return bar;
}

function renderPaginationControls(library: Library, currentPage: number, totalPages: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "doc-pagination";

  const prevButton = document.createElement("button");
  prevButton.type = "button";
  prevButton.className = "btn btn-ghost btn-sm";
  prevButton.textContent = "Previous";
  prevButton.disabled = currentPage <= 1;
  prevButton.addEventListener("click", () => {
    documentGridPage.set(library.id, currentPage - 1);
    rerenderLibraryFromCache(library);
  });

  const label = document.createElement("span");
  label.className = "doc-pagination-label";
  label.textContent = `Page ${currentPage} of ${totalPages}`;

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "btn btn-ghost btn-sm";
  nextButton.textContent = "Next";
  nextButton.disabled = currentPage >= totalPages;
  nextButton.addEventListener("click", () => {
    documentGridPage.set(library.id, currentPage + 1);
    rerenderLibraryFromCache(library);
  });

  bar.appendChild(prevButton);
  bar.appendChild(label);
  bar.appendChild(nextButton);
  return bar;
}

// No fixed page count is known upfront (see the CrawlJobStatus.pages comment) — shown as "N pages
// so far," never a determinate progress bar, matching the crawl API's own guidance. No actions
// (no way to cancel a crawl server-side); this row simply disappears once pollCrawlJob discovers
// the job has finished, at which point its pages already exist as normal document rows.
function renderCrawlJobRow(job: CrawlJobStatus): HTMLElement {
  const row = document.createElement("tr");
  row.className = "doc-row";

  const pageCount = Object.keys(job.pages).length;

  const selectCell = document.createElement("td");

  const fileCell = document.createElement("td");
  fileCell.className = "doc-file-cell";
  fileCell.innerHTML = `
    <span class="doc-icon">${ICONS.fileText}</span>
    <span class="doc-name-group">
      <span class="doc-name" title="${job.seed_url}">${truncateText(job.seed_url)}</span>
      <span class="doc-sub">${pageCount} page${pageCount === 1 ? "" : "s"} so far</span>
    </span>
  `;

  const sizeCell = document.createElement("td");
  sizeCell.className = "doc-muted-cell";
  sizeCell.textContent = "—";

  const chunksCell = document.createElement("td");
  chunksCell.className = "doc-muted-cell";
  chunksCell.textContent = "—";

  const statusCell = document.createElement("td");
  statusCell.appendChild(renderStatusBadge("crawling"));

  const actionsCell = document.createElement("td");
  actionsCell.className = "doc-actions-cell";

  row.appendChild(selectCell);
  row.appendChild(fileCell);
  row.appendChild(sizeCell);
  row.appendChild(chunksCell);
  row.appendChild(statusCell);
  row.appendChild(actionsCell);
  return row;
}

function renderPendingRow(filename: string, library: Library): HTMLElement {
  const row = document.createElement("tr");
  row.className = "doc-row";

  const selectCell = document.createElement("td");

  const fileCell = document.createElement("td");
  fileCell.className = "doc-file-cell";
  fileCell.innerHTML = `
    <span class="doc-icon">${ICONS.fileText}</span>
    <span class="doc-name-group">
      <span class="doc-name" title="${filename}">${truncateText(filename)}</span>
    </span>
  `;

  const sizeCell = document.createElement("td");
  sizeCell.className = "doc-muted-cell";
  sizeCell.textContent = "—";

  const chunksCell = document.createElement("td");
  chunksCell.className = "doc-muted-cell";
  chunksCell.textContent = "—";

  const isCancelling = cancelRequestedUploads.get(library.id)?.has(filename) ?? false;
  const statusCell = document.createElement("td");
  statusCell.appendChild(renderStatusBadge(isCancelling ? "cancelling" : "uploading"));

  const actionsCell = document.createElement("td");
  actionsCell.className = "doc-actions-cell";

  // job_id is only known once upload_document's response has come back — before that, there's
  // nothing to cancel yet, so no button is shown for the brief window between the optimistic
  // placeholder appearing and the request actually completing.
  const jobId = pendingUploadJobIds.get(library.id)?.get(filename);
  if (jobId && !isCancelling) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn btn-ghost btn-sm";
    cancelButton.title = "Cancel upload";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", async () => {
      getCancelRequestedSet(library.id).add(filename);
      rerenderLibraryFromCache(library);
      try {
        await invoke("cancel_upload_job", { libraryId: library.id, jobId });
        showToast(`Cancelling "${filename}"…`);
        await syncLibraryDocuments(library);
      } catch (error) {
        getCancelRequestedSet(library.id).delete(filename);
        rerenderLibraryFromCache(library);
        showToast(`Error cancelling "${filename}": ${parseError(error).message}`, "error");
      }
    });
    actionsCell.appendChild(cancelButton);
  }

  row.appendChild(selectCell);
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
  } else if (status === "cancelled") {
    badge.className = "doc-status doc-status-cancelled";
    badge.textContent = "Cancelled";
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

function renderDocRow(doc: LibraryDocument, library: Library, isRetrying: boolean, isSelected: boolean): HTMLElement {
  const row = document.createElement("tr");
  row.className = "doc-row";

  const selectCell = document.createElement("td");
  const selectCheckbox = document.createElement("input");
  selectCheckbox.type = "checkbox";
  selectCheckbox.checked = isSelected;
  selectCheckbox.setAttribute("aria-label", `Select ${doc.source_filename}`);
  selectCheckbox.addEventListener("change", () => {
    const selected = getSelectedDocumentSet(library.id);
    if (selectCheckbox.checked) selected.add(doc.id);
    else selected.delete(doc.id);
    rerenderLibraryFromCache(library);
  });
  selectCell.appendChild(selectCheckbox);

  const fileCell = document.createElement("td");
  fileCell.className = "doc-file-cell";
  const fileIcon = document.createElement("span");
  fileIcon.className = "doc-icon";
  fileIcon.innerHTML = ICONS.fileText;
  fileCell.appendChild(fileIcon);

  const nameGroup = document.createElement("span");
  nameGroup.className = "doc-name-group";

  const isRenaming = renamingDocumentIds.get(library.id)?.has(doc.id) ?? false;

  const commitRename = async (input: HTMLInputElement) => {
    const newName = input.value.trim();
    if (!newName) {
      showToast("Filename cannot be empty.", "error");
      return;
    }
    if (newName === doc.source_filename) {
      getRenamingSet(library.id).delete(doc.id);
      rerenderLibraryFromCache(library);
      return;
    }
    try {
      await invoke("rename_document", { libraryId: library.id, documentId: doc.id, sourceFilename: newName });
      getRenamingSet(library.id).delete(doc.id);
      showToast(`Renamed to "${newName}".`);
      await syncLibraryDocuments(library);
    } catch (error) {
      showToast(`Error renaming document: ${parseError(error).message}`, "error");
    }
  };
  const cancelRename = () => {
    getRenamingSet(library.id).delete(doc.id);
    rerenderLibraryFromCache(library);
  };

  if (isRenaming) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "doc-rename-input";
    input.value = doc.source_filename;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitRename(input);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    });
    nameGroup.appendChild(input);
    // The row isn't attached to the document yet at this point — defer focus until after the
    // caller has mounted it, otherwise .focus() is a no-op.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else if (doc.file_type === "html") {
    // Crawled pages store the full URL as source_filename (file_type "html"), not a filename — a
    // plain text label reads oddly for that, so make it an actual link to the original page
    // instead (opened in the system browser, never inside the app's own webview). Either way, the
    // displayed text is capped to a fixed character count so a very long filename/URL can never
    // blow out the column's fixed width — the full value is always still on the title tooltip.
    const link = document.createElement("a");
    link.href = "#";
    link.className = "doc-name doc-name-link";
    link.title = doc.source_filename;
    link.textContent = truncateText(doc.source_filename);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void openUrl(doc.source_filename);
    });
    nameGroup.appendChild(link);
  } else {
    const name = document.createElement("span");
    name.className = "doc-name";
    name.title = doc.source_filename;
    name.textContent = truncateText(doc.source_filename);
    nameGroup.appendChild(name);
  }

  if (!isRenaming) {
    const sub = document.createElement("span");
    sub.className = "doc-sub";
    sub.textContent = doc.file_type;
    nameGroup.appendChild(sub);
  }

  fileCell.appendChild(nameGroup);

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

  if (isRenaming) {
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "btn btn-sm btn-primary";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", () => {
      const input = nameGroup.querySelector<HTMLInputElement>(".doc-rename-input");
      if (input) void commitRename(input);
    });
    actions.appendChild(saveButton);

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn btn-ghost btn-sm";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", cancelRename);
    actions.appendChild(cancelButton);
  } else {
    if (!isRetrying && (doc.status === "failed" || doc.status === "cancelled")) {
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

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "btn btn-ghost btn-sm";
    renameButton.title = "Rename document";
    renameButton.textContent = "Rename";
    renameButton.addEventListener("click", () => {
      getRenamingSet(library.id).add(doc.id);
      rerenderLibraryFromCache(library);
    });
    actions.appendChild(renameButton);

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
  }
  actionsCell.appendChild(actions);

  row.appendChild(selectCell);
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

  const tabHeader = document.createElement("div");
  tabHeader.className = "doc-upload-tabs";

  const fileTabButton = document.createElement("button");
  fileTabButton.type = "button";
  fileTabButton.className = "doc-upload-tab";
  fileTabButton.textContent = "File";

  const urlTabButton = document.createElement("button");
  urlTabButton.type = "button";
  urlTabButton.className = "doc-upload-tab";
  urlTabButton.textContent = "URL";

  tabHeader.appendChild(fileTabButton);
  tabHeader.appendChild(urlTabButton);
  wrapper.appendChild(tabHeader);

  // A plain button, not a drag-and-drop styled dropzone — there's no dragover/drop handling here
  // (Tauri's open() dialog is the only way in), so a dashed drop-target box would promise a
  // capability that isn't actually there.
  const uploadControl = document.createElement("div");
  uploadControl.className = "upload-control";

  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "btn btn-sm btn-primary upload-file-btn";
  uploadButton.innerHTML = `<span class="btn-icon-inline">${ICONS.upload}</span> Choose file to upload`;

  const uploadCaption = document.createElement("p");
  uploadCaption.className = "status-text";
  uploadCaption.textContent = `Max file size: ${formatFileSize(MAX_UPLOAD_SIZE_BYTES)}`;

  uploadControl.appendChild(uploadButton);
  uploadControl.appendChild(uploadCaption);

  uploadButton.addEventListener("click", async () => {
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
      const result = await invoke<{ job_id: string }>("upload_document", { libraryId: library.id, filePath });
      getPendingUploadJobIds(library.id).set(filename, result.job_id);
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

  const urlForm = renderUrlIngestForm(library);

  wrapper.appendChild(uploadControl);
  wrapper.appendChild(urlForm);

  const applyActiveTab = (tab: "file" | "url") => {
    fileTabButton.classList.toggle("doc-upload-tab-active", tab === "file");
    urlTabButton.classList.toggle("doc-upload-tab-active", tab === "url");
    uploadControl.hidden = tab !== "file";
    urlForm.hidden = tab !== "url";
  };
  applyActiveTab(getActiveUploadTab(library.id));

  fileTabButton.addEventListener("click", () => {
    activeUploadTab.set(library.id, "file");
    applyActiveTab("file");
  });
  urlTabButton.addEventListener("click", () => {
    activeUploadTab.set(library.id, "url");
    applyActiveTab("url");
  });

  return wrapper;
}

function getActiveUploadTab(libraryId: string): "file" | "url" {
  return activeUploadTab.get(libraryId) ?? "file";
}

function renderUrlIngestForm(library: Library): HTMLElement {
  const urlForm = document.createElement("form");
  urlForm.className = "doc-url-ingest";

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://example.com/docs/page";
  urlInput.className = "doc-url-input";
  urlInput.required = true;

  const pagesInput = document.createElement("input");
  pagesInput.type = "number";
  pagesInput.min = "1";
  pagesInput.max = "100";
  pagesInput.placeholder = "1";
  pagesInput.className = "doc-url-pages-input";
  pagesInput.title = "Pages to crawl (1 = just this page, up to 100)";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "btn btn-sm btn-primary";
  submitButton.textContent = "Ingest URL";

  urlForm.appendChild(urlInput);
  urlForm.appendChild(pagesInput);
  urlForm.appendChild(submitButton);

  urlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    const maxPages = pagesInput.value.trim() ? Number(pagesInput.value) : 1;

    try {
      const result = await invoke<{ job_id: string }>("crawl_document", {
        libraryId: library.id,
        payload: { url, max_pages: maxPages },
      });
      urlInput.value = "";
      pagesInput.value = "";
      // Optimistic placeholder — pages start empty and fill in as pollCrawlJob discovers them.
      getCrawlJobsMap(library.id).set(result.job_id, { status: "pending", seed_url: url, error: null, pages: {} });
      rerenderLibraryFromCache(library);
      showToast(`Started ingesting ${url}`);
      void pollCrawlJob(library, result.job_id);
    } catch (error) {
      showToast(`Error starting crawl for "${url}": ${parseError(error).message}`, "error");
    }
  });

  return urlForm;
}

// Crawls have no fixed duration — page count grows as the crawl discovers links, there's a
// politeness delay between page fetches, and JS-rendered pages take a few extra seconds each to
// render headlessly — so this polls on a slower, fixed cadence rather than trying to predict
// completion, and reports progress as "N pages so far" (see CrawlJobStatus.pages) rather than a
// determinate percentage, matching the API's own guidance.
async function pollCrawlJob(library: Library, jobId: string) {
  const jobs = getCrawlJobsMap(library.id);
  let status: CrawlJobStatus;
  try {
    status = await invoke<CrawlJobStatus>("get_crawl_status", { libraryId: library.id, jobId });
  } catch (error) {
    jobs.delete(jobId);
    rerenderLibraryFromCache(library);
    showToast(`Error checking crawl status: ${parseError(error).message}`, "error");
    return;
  }

  if (status.status === "completed" || status.status === "failed") {
    jobs.delete(jobId);
    rerenderLibraryFromCache(library);

    if (status.status === "failed") {
      // The job itself broke (e.g. the seed URL was invalid) — distinct from a "completed" job
      // where every individual page failed (see below), which is a different failure mode with
      // its own message rather than this generic one.
      showToast(`Crawl of "${status.seed_url}" failed: ${status.error ?? "unknown error"}`, "error");
    } else {
      const pages = Object.values(status.pages);
      const succeeded = pages.filter((p) => p.status === "completed").length;
      const failed = pages.filter((p) => p.status === "failed");
      if (pages.length === 0) {
        // No pages recorded at all — e.g. everything was skipped by robots.txt with nothing
        // else attempted. Not really a failure the API can report on, so say so plainly.
        showToast(`Crawl of "${status.seed_url}" finished, but no pages were ingested.`, "error");
      } else if (succeeded === 0) {
        // "Completed" but every single page failed — reads exactly like a success ("N pages
        // processed") if not called out explicitly, which is the gap that prompted this: the
        // job status alone doesn't tell you whether "processed" meant "succeeded."
        showToast(
          `Crawl of "${status.seed_url}" finished, but all ${pages.length} page(s) failed. ` +
            `First error: ${failed[0]?.error ?? "unknown error"}`,
          "error",
        );
      } else if (failed.length > 0) {
        showToast(
          `Finished crawling "${status.seed_url}" — ${succeeded} of ${pages.length} page(s) ingested (${failed.length} failed).`,
        );
      } else {
        showToast(`Finished crawling "${status.seed_url}" — ${succeeded} page${succeeded === 1 ? "" : "s"} ingested.`);
      }
    }
    // One more sync to make sure the last completed page's document row is reflected —
    // syncLibraryDocuments's own poll may already be running, but this guarantees it happens.
    await syncLibraryDocuments(library);
    return;
  }

  jobs.set(jobId, status);
  rerenderLibraryFromCache(library);
  setTimeout(() => void pollCrawlJob(library, jobId), 2000);
}

// Re-runs the full connection/embeddings/search-settings load, same sequence as startup. Used by:
// the manual refresh button, opening either settings view, and init() itself — there's otherwise
// no way to recover from "app started before the API container did" short of a restart, since
// everything below only ever ran once, at launch.
async function refreshConnection() {
  const config = await invoke<AppConfig>("get_config");
  // Skip embeddings-related calls entirely until the connection itself is configured — otherwise
  // they'd just fail with a confusing "Invalid or missing credentials" before the user has done anything.
  if (hasCredentials(config)) {
    await loadEmbeddingOptions();
    await loadEmbeddingSettingsIntoForm();
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

// Dispatched by shell.ts on every sidebar nav switch — re-check the connection whenever either
// settings view (Knowledge API or Embeddings — Re-ranking lives inside Embeddings now, not its
// own view) is opened, so the common case (start the API container, then come look at settings)
// self-heals without needing the manual refresh button.
document.addEventListener("view-changed", (event) => {
  const view = (event as CustomEvent<{ view: string }>).detail.view;
  if (view === "knowledge-api" || view === "embeddings") {
    refreshConnection();
  }
  // Navigating away from the library detail view stops treating any library as "current" — this
  // is what rerenderLibraryFromCache/syncLibraryDocuments check before touching the shared
  // #library-detail-body, so a background poll for whatever library you just left won't keep
  // rendering into (now-hidden) content on every tick just because nothing else has claimed it yet.
  if (view !== "library") {
    currentLibraryId = null;
    document.querySelectorAll<HTMLButtonElement>(".sidebar-library-item").forEach((item) => {
      item.classList.remove("active");
    });
  }
});

async function init() {
  initShell();
  initPasswordToggle("client-secret", "client-secret-toggle");
  initPasswordToggle("embed-settings-api-key", "embed-settings-api-key-toggle");
  await loadSettingsIntoForm();
  await refreshConnection();
}

init();
