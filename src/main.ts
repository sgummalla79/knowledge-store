import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface AppConfig {
  api_base_url: string;
  api_key: string;
}

interface Library {
  id: string;
  name: string;
  description: string | null;
  embedding_provider: string;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  document_count: number;
  chunk_count: number;
}

interface EmbeddingOptions {
  providers: { name: string; models: string[] }[];
  default_provider: string;
  default_model: string;
  default_chunk_size: number;
  default_chunk_overlap: number;
}

const settingsForm = document.querySelector<HTMLFormElement>("#settings-form")!;
const apiBaseUrlInput = document.querySelector<HTMLInputElement>("#api-base-url")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const settingsStatus = document.querySelector<HTMLParagraphElement>("#settings-status")!;

const createLibraryForm = document.querySelector<HTMLFormElement>("#create-library-form")!;
const nameInput = document.querySelector<HTMLInputElement>("#lib-name")!;
const descriptionInput = document.querySelector<HTMLInputElement>("#lib-description")!;
const modelSelect = document.querySelector<HTMLSelectElement>("#lib-embedding-model")!;
const chunkSizeInput = document.querySelector<HTMLInputElement>("#lib-chunk-size")!;
const chunkOverlapInput = document.querySelector<HTMLInputElement>("#lib-chunk-overlap")!;
const createLibraryStatus = document.querySelector<HTMLParagraphElement>("#create-library-status")!;

const librariesBody = document.querySelector<HTMLTableSectionElement>("#libraries-body")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-libraries")!;

async function loadSettingsIntoForm() {
  const config = await invoke<AppConfig>("get_config");
  apiBaseUrlInput.value = config.api_base_url;
  apiKeyInput.value = config.api_key;
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config: AppConfig = {
    api_base_url: apiBaseUrlInput.value,
    api_key: apiKeyInput.value,
  };
  try {
    await invoke("save_config", { config });
    settingsStatus.textContent = "Saved.";
    await loadEmbeddingOptions();
    await refreshLibraries();
  } catch (error) {
    settingsStatus.textContent = `Error: ${error}`;
  }
});

async function loadEmbeddingOptions() {
  try {
    const options = await invoke<EmbeddingOptions>("get_embedding_options");
    modelSelect.innerHTML = "";
    for (const provider of options.providers) {
      for (const model of provider.models) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = `${provider.name} / ${model}`;
        modelSelect.appendChild(option);
      }
    }
    chunkSizeInput.value = String(options.default_chunk_size);
    chunkOverlapInput.value = String(options.default_chunk_overlap);
  } catch (error) {
    createLibraryStatus.textContent = `Could not load embedding options: ${error}`;
  }
}

createLibraryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke("create_library", {
      payload: {
        name: nameInput.value,
        description: descriptionInput.value || null,
        embedding_model: modelSelect.value,
        chunk_size: Number(chunkSizeInput.value),
        chunk_overlap: Number(chunkOverlapInput.value),
      },
    });
    createLibraryStatus.textContent = "Created.";
    nameInput.value = "";
    descriptionInput.value = "";
    await refreshLibraries();
  } catch (error) {
    createLibraryStatus.textContent = `Error: ${error}`;
  }
});

async function refreshLibraries() {
  librariesBody.innerHTML = "";
  let libraries: Library[];
  try {
    libraries = await invoke<Library[]>("list_libraries");
  } catch (error) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6">Error loading libraries: ${error}</td>`;
    librariesBody.appendChild(row);
    return;
  }

  for (const library of libraries) {
    const row = document.createElement("tr");

    const uploadStatus = document.createElement("span");
    uploadStatus.className = "upload-status";

    const uploadButton = document.createElement("button");
    uploadButton.textContent = "Upload";
    uploadButton.addEventListener("click", async () => {
      const filePath = await open({ multiple: false });
      if (!filePath) return;
      uploadStatus.textContent = "Uploading...";
      try {
        const job = await invoke<{ job_id: string }>("upload_document", {
          libraryId: library.id,
          filePath,
        });
        pollJob(library.id, job.job_id, uploadStatus);
      } catch (error) {
        uploadStatus.textContent = `Error: ${error}`;
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", async () => {
      try {
        await invoke("delete_library", { libraryId: library.id });
        await refreshLibraries();
      } catch (error) {
        uploadStatus.textContent = `Error: ${error}`;
      }
    });

    row.innerHTML = `
      <td>${library.name}</td>
      <td>${library.description ?? ""}</td>
      <td>${library.embedding_provider}/${library.embedding_model}</td>
      <td>${library.document_count}</td>
      <td>${library.chunk_count}</td>
    `;
    const actionsCell = document.createElement("td");
    actionsCell.appendChild(uploadButton);
    actionsCell.appendChild(deleteButton);
    actionsCell.appendChild(uploadStatus);
    row.appendChild(actionsCell);

    librariesBody.appendChild(row);
  }
}

function pollJob(libraryId: string, jobId: string, statusEl: HTMLSpanElement) {
  const interval = setInterval(async () => {
    try {
      const job = await invoke<{ status: string; error: string | null }>("get_job_status", {
        libraryId,
        jobId,
      });
      statusEl.textContent = job.status;
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(interval);
        if (job.status === "failed") statusEl.textContent = `failed: ${job.error}`;
        await refreshLibraries();
      }
    } catch (error) {
      statusEl.textContent = `Error: ${error}`;
      clearInterval(interval);
    }
  }, 1500);
}

refreshButton.addEventListener("click", refreshLibraries);

async function init() {
  await loadSettingsIntoForm();
  await loadEmbeddingOptions();
  await refreshLibraries();
}

init();
