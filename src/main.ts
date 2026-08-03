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
      <span>${message} <button type="button" class="banner-link" id="banner-config-link">Go to Knowledge API</button></span>
    </div>
  `;
  document.querySelector<HTMLButtonElement>("#banner-config-link")?.addEventListener("click", () => {
    switchToView("knowledge-api");
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
  // Client Secret is never re-populated from storage — it's write-only, matching how
  // knowledge-api itself only ever shows a secret once, at issuance.
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
        return;
      }
      showToast("Connection saved.");
    } else {
      showToast("Connection saved.");
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
    librariesList.innerHTML = "";
    renderBanner("Not connected — configure your API connection first.");
    showToast("Disconnected.");
  } catch (error) {
    showToast(`Error disconnecting: ${parseError(error).message}`, "error");
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

// The two states this distinguishes: (1) no local connection configured at all, (2) connection
// configured but rag-api rejects the credentials (401).
async function checkStatusAndLoad() {
  const config = await invoke<AppConfig>("get_config");
  if (!hasCredentials(config)) {
    setConnectionBadge("not_configured");
    renderBanner("Not connected — configure your API connection first.");
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
      renderBanner("Your client credentials look invalid or expired — update them in Knowledge API.");
    } else {
      setConnectionBadge("unreachable");
      renderBanner(`Error loading libraries: ${error.message}`);
    }
    librariesList.innerHTML = "";
    sidebarLibraryTree.innerHTML = "";
    return;
  }

  setConnectionBadge("configured");
  clearBanner();
  renderLibraryList();
  renderSidebarLibraryTree();
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

connectionRefreshButton.addEventListener("click", async () => {
  connectionRefreshButton.disabled = true;
  connectionRefreshIcon.classList.add("spinning");
  try {
    await checkStatusAndLoad();
  } finally {
    connectionRefreshButton.disabled = false;
    connectionRefreshIcon.classList.remove("spinning");
  }
});

// Dispatched by shell.ts on every sidebar nav switch — re-check the connection whenever the
// Knowledge API settings view is opened, so the common case (start the API container, then come
// look at settings) self-heals without needing the manual refresh button.
document.addEventListener("view-changed", (event) => {
  const view = (event as CustomEvent<{ view: string }>).detail.view;
  if (view === "knowledge-api") {
    checkStatusAndLoad();
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
  await loadSettingsIntoForm();
  await checkStatusAndLoad();
}

init();
