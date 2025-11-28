// public/app.js

let currentFolder = null;
let allTags = [];
let selectedTagSlugs = new Set();
let uploadState = {
  files: [],
};

// Small helpers
async function apiGet(url) {
  const res = await fetch(url);
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let parsed = text;
    try { parsed = JSON.parse(text); } catch (e) { /* keep raw text */ }
    const msg = parsed && parsed.error ? parsed.error : (typeof parsed === "string" ? parsed : JSON.stringify(parsed));
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} - ${msg}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} failed`);
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${url} failed`);
  return res.json();
}

// new helper: patch
async function apiPatch(url, body) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PATCH ${url} failed: ${txt}`);
  }
  return res.json();
}

function formatBytes(bytes) {
  if (bytes == null) return "";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${sizes[i]}`;
}

/* ============================================================
   INIT
============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  initApp().catch((err) => {
    console.error("init error", err);
    alert("Failed to initialize app");
  });
});

async function initApp() {
  try {
    await loadRoot();
    await loadTags();
    await loadFolders();
    await loadFiles();
    setupSearchEvents();
    setupUploadModal();
    setupFolderCreate();
    setupSettings();
    setupManualRefresh(); // <-- new
    startAutoRefresh(); // <-- new: start polling on init
  } catch (err) {
    console.error("Init error:", err);
    alert("Failed to initialize app: " + err.message);
  }
}

/* ============================================================
   ROOT / FOLDERS
============================================================ */
async function loadRoot() {
  const root = await apiGet("/api/root-folder");
  currentFolder = root;
  renderBreadcrumb();
}

async function loadFolders() {
  const folderList = document.getElementById("folderList");
  folderList.innerHTML = "";

  const parentId = currentFolder ? currentFolder.Id : null;
  const data = await apiGet(
    "/api/folders" + (parentId ? `?parentId=${parentId}` : "")
  );

  data.forEach((f) => {
    const li = document.createElement("li");
    li.className = "folder-item";
    li.textContent = f.Name;
    li.dataset.id = f.Id;
    li.addEventListener("click", () => {
      currentFolder = f;
      renderBreadcrumb();
      loadFolders().catch(console.error);
      loadFiles().catch(console.error);
    });
    folderList.appendChild(li);
  });
}

function renderBreadcrumb() {
  const el = document.getElementById("folderBreadcrumb");
  const backBtn = document.getElementById("btnBack");
  
  if (!currentFolder) {
    el.textContent = "/";
    backBtn.classList.add("hidden");
    return;
  }
  
  el.textContent = currentFolder.FullPath || "/root";
  
  // Show back button only if not at root
  if (currentFolder.ParentId != null) {
    backBtn.classList.remove("hidden");
  } else {
    backBtn.classList.add("hidden");
  }
}

// Setup back button
document.getElementById("btnBack").addEventListener("click", async () => {
  if (!currentFolder || currentFolder.ParentId == null) return;
  
  try {
    const parent = await apiGet(`/api/folder/${currentFolder.ParentId}`);
    currentFolder = parent;
    renderBreadcrumb();
    await loadFolders();
    await loadFiles();
  } catch (err) {
    console.error("navigate back", err);
    alert("Failed to navigate back");
  }
});

/* ============================================================
   TAGS
============================================================ */
async function loadTags() {
  allTags = await apiGet("/api/tags");
  renderTagFilters();
  renderUploadTagList();
}

function renderTagFilters() {
	const bar = document.getElementById("tagFilterBar");
	bar.innerHTML = "";

	allTags.forEach((tag) => {
		const bubble = document.createElement("label");
		bubble.className = "tag-bubble";

		const color = tag.ColorHex || "#888888";
		bubble.style.backgroundColor = color + "22";
		bubble.style.borderColor = color;

		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.className = "tag-filter-checkbox";
		cb.dataset.slug = tag.Slug;
		cb.checked = selectedTagSlugs.has(tag.Slug);

		// clicking the checkbox should toggle selection only
		cb.addEventListener("click", (e) => {
			e.stopPropagation();
			// toggle handled by checkbox default, then update filters
			// use setTimeout to allow the checked state to update before reading it
			setTimeout(() => {
				if (cb.checked) selectedTagSlugs.add(tag.Slug);
				else selectedTagSlugs.delete(tag.Slug);
				loadFiles().catch(console.error);
			}, 0);
		});

		const dot = document.createElement("span");
		dot.className = "tag-dot";
		dot.style.backgroundColor = color;

		const span = document.createElement("span");
		span.textContent = tag.Name;

		bubble.appendChild(cb);
		bubble.appendChild(dot);
		bubble.appendChild(span);

		// clicking bubble (not checkbox) opens tag editor — prevent label default toggle
		bubble.addEventListener("click", (e) => {
			if (e.target === cb) return;
			e.preventDefault(); // stop checkbox toggling
			e.stopPropagation();
			openTagEditor(tag);
		});

		bar.appendChild(bubble);
	});

	// append small create button at the end of filter bar
	const createBtn = document.createElement("button");
	createBtn.className = "tag-add-list";
	createBtn.title = "Create tag";
	createBtn.textContent = "+";
	createBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		openTagEditor(null); // open in create mode
	});
	bar.appendChild(createBtn);
}

function renderUploadTagList() {
	const container = document.getElementById("uploadTagList");
	container.innerHTML = "";

	allTags.forEach((tag) => {
		const wrapper = document.createElement("label");
		wrapper.className = "tag-bubble upload-tag";

		const color = tag.ColorHex || "#888888";
		wrapper.style.backgroundColor = color + "22";
		wrapper.style.borderColor = color;

		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.className = "upload-tag-checkbox";
		cb.dataset.slug = tag.Slug;
		cb.dataset.id = tag.Id;

		// clicking checkbox toggles selection only
		cb.addEventListener("click", (e) => {
			e.stopPropagation();
			// let the checkbox update then nothing else here (upload reads checked state)
		});

		const dot = document.createElement("span");
		dot.className = "tag-dot";
		dot.style.backgroundColor = color;

		const span = document.createElement("span");
		span.textContent = tag.Name;

		wrapper.appendChild(cb);
		wrapper.appendChild(dot);
		wrapper.appendChild(span);

		// clicking wrapper (not the checkbox) opens the tag editor — prevent checkbox toggle
		wrapper.addEventListener("click", (e) => {
			if (e.target === cb) return;
			e.preventDefault();
			e.stopPropagation();
			openTagEditor(tag);
		});

		container.appendChild(wrapper);
	});

	// append small create button next to upload tag list
	const createBtn = document.createElement("button");
	createBtn.className = "tag-add-list";
	createBtn.title = "Create tag";
	createBtn.textContent = "+";
	createBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		openTagEditor(null); // create mode
	});
	container.appendChild(createBtn);
}

/* ============================================================
   FILES
============================================================ */
async function loadFiles() {
  if (!currentFolder) return;

  const search = document.getElementById("searchInput").value.trim();
  const tagsParam =
    Array.from(selectedTagSlugs).length > 0
      ? "&tags=" + encodeURIComponent(Array.from(selectedTagSlugs).join(","))
      : "";

  const url =
    `/api/files?folderId=${currentFolder.Id}` +
    (search ? `&search=${encodeURIComponent(search)}` : "") +
    tagsParam;

  const files = await apiGet(url);
  
  // Load subfolders too
  let folders = await apiGet(`/api/folders?parentId=${currentFolder.Id}`);

  // If tag filters are active, filter folders to only those matching selected tag slugs
  if (selectedTagSlugs.size > 0) {
    const selected = Array.from(selectedTagSlugs).map(s => String(s).toLowerCase());
    folders = folders.filter(folder => {
      if (!folder.TagInfo) return false;
      // TagInfo may be "Name|Color" or "Name|Color|Slug" repeated with commas
      const segments = String(folder.TagInfo).split(",").map(p => p.trim()).filter(Boolean);
      const folderSlugs = new Set();

      for (const seg of segments) {
        const parts = seg.split("|").map(x => x.trim());
        if (parts.length >= 3 && parts[2]) {
          folderSlugs.add(parts[2].toLowerCase());
        } else if (parts.length >= 1 && parts[0]) {
          // fallback: derive slug from name if slug not provided
          const derived = parts[0].toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
          folderSlugs.add(derived);
        }
      }

      // require that folder contains all selected slugs
      return selected.every(s => folderSlugs.has(s));
    });
  }

  renderFiles(files, folders);
}

// Update folder tag rendering to accept 2- or 3-part TagInfo entries
function renderFiles(files, folders = []) {
  const body = document.getElementById("fileTableBody");
  body.innerHTML = "";

  // Show folders first
  folders.forEach((folder) => {
    const tr = document.createElement("tr");
    tr.className = "folder-row";

    const tdName = document.createElement("td");
    tdName.textContent = "📁 " + folder.Name;
    tdName.style.cursor = "pointer";

    const tdSize = document.createElement("td");
    tdSize.textContent = "—";

    const tdTags = document.createElement("td");
    tdTags.className = "file-tags-cell";
    
    // Show folder tags if any
    if (folder.TagInfo) {
      const pairs = folder.TagInfo.split(",");
      pairs.forEach((p) => {
        const parts = p.split("|").map(x => x.trim());
        const name = parts[0] || "";
        const color = parts[1] || "#888888";
        const slug = parts[2] || (name ? name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "") : null);

        if (!name) return;

        const wrapper = document.createElement("label");
        wrapper.className = "tag-bubble";
        const tagColor = color || "#888888";
        wrapper.style.backgroundColor = tagColor + "22";
        wrapper.style.borderColor = tagColor;

        const dot = document.createElement("span");
        dot.className = "tag-dot";
        dot.style.backgroundColor = tagColor;

        const span = document.createElement("span");
        span.textContent = name;

        wrapper.appendChild(dot);
        wrapper.appendChild(span);

        wrapper.addEventListener("click", () => {
          // prefer finding by slug if available, fallback to name
          let t = null;
          if (slug) t = allTags.find((tt) => tt.Slug === slug);
          if (!t) t = allTags.find((tt) => tt.Name === name);
          if (t) openTagEditor(t);
        });

        tdTags.appendChild(wrapper);
      });
    }

    // Add "plus" button to open folder tag sidebar
    const addTagBtn = document.createElement("button");
    addTagBtn.className = "tag-add";
    addTagBtn.title = "Add / remove tags";
    addTagBtn.innerHTML = "+";
    addTagBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderSidebar(folder);
    });
    tdTags.appendChild(addTagBtn);

    // Actions cell: download / rename / delete for folders
    const tdActions = document.createElement("td");

    const btnDownload = document.createElement("button");
    btnDownload.className = "btn-download";
    btnDownload.textContent = "⬇";
    btnDownload.title = "Download folder";
    btnDownload.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // use JS fetch to surface server errors (like missing archiver) and download blob
      downloadFolderZip(folder);
    });

    const btnRename = document.createElement("button");
    btnRename.className = "btn-rename";
    btnRename.textContent = "✏️";
    btnRename.title = "Rename folder";
    btnRename.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const newName = prompt("Rename folder:", folder.Name);
      if (newName == null) return;
      const trimmed = newName.trim();
      if (!trimmed) return;
      try {
        await apiPatch(`/api/folder/${folder.Id}`, { name: trimmed });
        // reload UI and breadcrumb (in case current folder was renamed)
        await loadFolders();
        await loadFiles();
        // refresh currentFolder if it was the one renamed
        if (currentFolder && currentFolder.Id === folder.Id) {
          const refreshed = await apiGet(`/api/folder/${folder.Id}`);
          currentFolder = refreshed;
          renderBreadcrumb();
        }
      } catch (err) {
        console.error("rename folder", err);
        alert("Failed to rename folder");
      }
    });

    const btnDelete = document.createElement("button");
    btnDelete.className = "btn-delete";
    btnDelete.textContent = "🗑";
    btnDelete.title = "Delete folder";
    btnDelete.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete folder "${folder.Name}" and ALL its contents?`)) return;
      try {
        await apiDelete(`/api/folder/${folder.Id}`);
        await loadFolders();
        await loadFiles();
      } catch (err) {
        console.error("delete folder", err);
        alert("Failed to delete folder");
      }
    });

    tdActions.appendChild(btnDownload);
    tdActions.appendChild(btnRename);
    tdActions.appendChild(btnDelete);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdTags);
    tr.appendChild(tdActions);

    tr.addEventListener("click", () => {
      currentFolder = folder;
      renderBreadcrumb();
      loadFolders().catch(console.error);
      loadFiles().catch(console.error);
    });

    body.appendChild(tr);
  });

  // Then show files
  files.forEach((f) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = f.Name;
    tdName.className = "file-name-cell";

    const tdSize = document.createElement("td");
    tdSize.textContent = formatBytes(f.SizeBytes);

    const tdTags = document.createElement("td");
    tdTags.className = "file-tags-cell";
    if (f.TagInfo) {
      const pairs = f.TagInfo.split(",");
      pairs.forEach((p) => {
        const parts = p.split("|").map(x => x.trim());
        const name = parts[0] || "";
        const color = parts[1] || "#888888";
        const slug = parts[2] || (name ? name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "") : null);
        if (!name) return;

        const wrapper = document.createElement("label");
        wrapper.className = "tag-bubble";
        const tagColor = color || "#888888";
        wrapper.style.backgroundColor = tagColor + "22";
        wrapper.style.borderColor = tagColor;

        const dot = document.createElement("span");
        dot.className = "tag-dot";
        dot.style.backgroundColor = tagColor;

        const span = document.createElement("span");
        span.textContent = name;

        wrapper.appendChild(dot);
        wrapper.appendChild(span);

        // clicking the tag opens the tag editor (prefer slug)
        wrapper.addEventListener("click", () => {
          let t = null;
          if (slug) t = allTags.find((tt) => tt.Slug === slug);
          if (!t) t = allTags.find((tt) => tt.Name === name);
          if (t) openTagEditor(t);
        });

        tdTags.appendChild(wrapper);
      });
    }

    // Add "plus in dotted circle" to open sidebar (add/remove tags)
    const addBtn = document.createElement("button");
    addBtn.className = "tag-add";
    addBtn.title = "Add / remove tags";
    addBtn.innerHTML = "+";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFileSidebar(f);
    });
    tdTags.appendChild(addBtn);

    const tdActions = document.createElement("td");
    const btnDownload = document.createElement("button");
    btnDownload.className = "btn-download"; // added class
    btnDownload.textContent = "⬇";
    btnDownload.title = "Download";
    btnDownload.addEventListener("click", () => {
      window.location.href = `/download/${f.Id}`;
    });

    // rename button between download and delete
    const btnRename = document.createElement("button");
    btnRename.className = "btn-rename";
    btnRename.textContent = "✏️"; // pen emoji instead of text
    btnRename.title = "Rename";
    btnRename.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await renameFile(f);
    });

    const btnDelete = document.createElement("button");
    btnDelete.className = "btn-delete"; // added class
    btnDelete.textContent = "🗑";
    btnDelete.title = "Delete";
    btnDelete.addEventListener("click", async () => {
      if (!confirm(`Delete "${f.Name}"?`)) return;
      try {
        await apiDelete(`/api/file/${f.Id}`);
        await loadFiles();
      } catch (err) {
        console.error("delete file", err);
        alert("Failed to delete file");
      }
    });

    // clicking file name opens sidebar for tag management
    tdName.addEventListener("click", () => {
      openFileSidebar(f);
    });

    tdActions.appendChild(btnDownload);
    tdActions.appendChild(btnRename);
    tdActions.appendChild(btnDelete);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdTags);
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
}

// add rename helper that calls PATCH /api/file/:id
async function renameFile(file) {
  // preserve extension, prompt only for base name
  const orig = file.Name || "";
  const lastDot = orig.lastIndexOf(".");
  const ext = lastDot > 0 ? orig.slice(lastDot) : "";
  const base = lastDot > 0 ? orig.slice(0, lastDot) : orig;

  const newBase = prompt("Rename file (extension will be kept):", base);
  if (newBase == null) return; // cancelled
  const trimmedBase = newBase.trim();
  if (!trimmedBase) return;
  const newFull = trimmedBase + ext;
  if (newFull === orig) return;

  try {
    await apiPatch(`/api/file/${file.Id}`, { name: newFull });
    // refresh file list and, if sidebar open for this file, refresh its tags/title
    await loadFiles();
    if (currentSidebarFile && currentSidebarFile.Id === file.Id) {
      // update sidebar title to new name
      currentSidebarFile.Name = newFull;
      document.getElementById("fileSidebarTitle").textContent = newFull;
    }
  } catch (err) {
    console.error("rename file", err);
    alert("Failed to rename file");
  }
}

/* ============================================================
   SEARCH
============================================================ */
function setupSearchEvents() {
  const searchInput = document.getElementById("searchInput");
  const btnSearch = document.getElementById("btnSearch");
  const btnClear = document.getElementById("btnClearSearch");

  btnSearch.addEventListener("click", () => {
    loadFiles().catch(console.error);
  });

  btnClear.addEventListener("click", () => {
    searchInput.value = "";
    loadFiles().catch(console.error);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadFiles().catch(console.error);
    }
  });
}

// Setup manual refresh button
function setupManualRefresh() {
  const btnRefresh = document.getElementById("btnRefresh");
  if (btnRefresh) {
    btnRefresh.addEventListener("click", () => {
      loadFiles().catch(console.error);
    });
  }
}

function setupFolderCreate() {
  const input = document.getElementById("newFolderName");
  const btn = document.getElementById("btnCreateFolder");

  btn.addEventListener("click", async () => {
    const name = (input.value || "").trim();
    if (!name) {
      alert("Folder name required");
      return;
    }
    try {
      await apiPost("/api/folders", {
        name,
        parentId: currentFolder ? currentFolder.Id : null,
      });
      input.value = "";
      await loadFolders();
      await loadFiles(); // <-- added: refresh files after creating folder
    } catch (err) {
      console.error("create folder", err);
      alert("Failed to create folder");
    }
  });
}

/* ============================================================
   UPLOAD POPUP
============================================================ */
function setupUploadModal() {
  const modal = document.getElementById("uploadModal");
  const btnOpen = document.getElementById("btnOpenUpload");
  const btnClose = document.getElementById("uploadClose");
  const btnChooseFiles = document.getElementById("btnChooseFiles");
  const btnChooseFolder = document.getElementById("btnChooseFolder");
  const fileInput = document.getElementById("fileInput");
  const folderInput = document.getElementById("folderInput");
  const btnStartUpload = document.getElementById("btnStartUpload");

  btnOpen.addEventListener("click", () => {
    uploadState.files = [];
    document.getElementById("uploadSelectedInfo").textContent =
      "No files selected";
    document.getElementById("uploadNewTags").value = "";
    renderUploadTagList();
    modal.classList.remove("hidden");
  });

  btnClose.addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  btnChooseFiles.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  btnChooseFolder.addEventListener("click", () => {
    folderInput.value = "";
    folderInput.click();
  });

  fileInput.addEventListener("change", () => {
    const arr = Array.from(fileInput.files || []);
    uploadState.files = arr;
    updateUploadSelectedInfo();
  });

  folderInput.addEventListener("change", () => {
    const arr = Array.from(folderInput.files || []);
    uploadState.files = arr;
    updateUploadSelectedInfo();
  });

  btnStartUpload.addEventListener("click", async () => {
    if (!uploadState.files.length) {
      alert("No files selected");
      return;
    }
    try {
      await doUpload();
      modal.classList.add("hidden");
      await loadTags();
      await loadFiles();
    } catch (err) {
      console.error("upload error", err);
      alert("Upload failed");
    }
  });
}

function updateUploadSelectedInfo() {
  const info = document.getElementById("uploadSelectedInfo");
  if (!uploadState.files.length) {
    info.textContent = "No files selected";
  } else if (uploadState.files.length === 1) {
    info.textContent = uploadState.files[0].name;
  } else {
    info.textContent = `${uploadState.files.length} files selected`;
  }
}

function renderUploadTagList() {
	const container = document.getElementById("uploadTagList");
	container.innerHTML = "";

	allTags.forEach((tag) => {
		const wrapper = document.createElement("label");
		wrapper.className = "tag-bubble upload-tag";

		const color = tag.ColorHex || "#888888";
		wrapper.style.backgroundColor = color + "22";
		wrapper.style.borderColor = color;

		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.className = "upload-tag-checkbox";
		cb.dataset.slug = tag.Slug;
		cb.dataset.id = tag.Id;

		// clicking checkbox toggles selection only
		cb.addEventListener("click", (e) => {
			e.stopPropagation();
			// let the checkbox update then nothing else here (upload reads checked state)
		});

		const dot = document.createElement("span");
		dot.className = "tag-dot";
		dot.style.backgroundColor = color;

		const span = document.createElement("span");
		span.textContent = tag.Name;

		wrapper.appendChild(cb);
		wrapper.appendChild(dot);
		wrapper.appendChild(span);

		// clicking wrapper (not the checkbox) opens the tag editor — prevent checkbox toggle
		wrapper.addEventListener("click", (e) => {
			if (e.target === cb) return;
			e.preventDefault();
			e.stopPropagation();
			openTagEditor(tag);
		});

		container.appendChild(wrapper);
	});

	// append small create button next to upload tag list
	const createBtn = document.createElement("button");
	createBtn.className = "tag-add-list";
	createBtn.title = "Create tag";
	createBtn.textContent = "+";
	createBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		openTagEditor(null); // create mode
	});
	container.appendChild(createBtn);
}

/* ============================================================
   TAG EDITOR / FILE SIDEBAR
============================================================ */

// Replace openTagEditor to also support "create" mode when tag is null
let currentEditingTag = null;
function openTagEditor(tag) {
	// tag == null => create mode
	currentEditingTag = tag || null;
	const modal = document.getElementById("tagEditorModal");
	document.getElementById("tagEditName").value = tag ? tag.Name || "" : "";
	document.getElementById("tagEditColor").value = tag ? tag.ColorHex || "#888888" : "#888888";
	document.getElementById("tagEditColorHex").value = tag ? tag.ColorHex || "#888888" : "#888888";
	// adjust modal title
	const titleEl = document.querySelector("#tagEditorModal .modal-header h2");
	if (titleEl) titleEl.textContent = tag ? "Edit Tag" : "Create Tag";
	modal.classList.remove("hidden");
}

document.getElementById("tagEditorClose").addEventListener("click", () => {
  document.getElementById("tagEditorModal").classList.add("hidden");
});

document.getElementById("btnSaveTag").addEventListener("click", async () => {
  if (!currentEditingTag) return;
  const name = document.getElementById("tagEditName").value.trim();
  const colorHex = document.getElementById("tagEditColorHex").value.trim();
  try {
    await apiPatch(`/api/tags/${currentEditingTag.Id}`, { name, colorHex });
    document.getElementById("tagEditorModal").classList.add("hidden");
    await loadTags();
    await loadFiles();
  } catch (err) {
    console.error("save tag", err);
    alert("Failed to save tag");
  }
});

document.getElementById("btnDeleteTag").addEventListener("click", async () => {
  if (!currentEditingTag) return;
  if (!confirm(`Delete tag "${currentEditingTag.Name}"?`)) return;
  try {
    await apiDelete(`/api/tags/${currentEditingTag.Id}`);
    document.getElementById("tagEditorModal").classList.add("hidden");
    currentEditingTag = null;
    await loadTags();
    await loadFiles();
  } catch (err) {
    console.error("delete tag", err);
    alert("Failed to delete tag");
  }
});

document.getElementById("tagEditColor").addEventListener("input", (e) => {
  document.getElementById("tagEditColorHex").value = e.target.value;
});
document.getElementById("tagEditColorHex").addEventListener("input", (e) => {
  const v = e.target.value;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    document.getElementById("tagEditColor").value = v;
  }
});

// File sidebar
let currentSidebarFile = null;
async function openFileSidebar(file) {
  currentSidebarFile = file;
  currentSidebarFolder = null; // <-- ensure folder state cleared
  const sidebar = document.getElementById("fileSidebar");
  document.getElementById("fileSidebarTitle").textContent = file.Name;
  const fileTagListEl = document.getElementById("fileTagList");
  fileTagListEl.innerHTML = "<div class='loading'>Loading tags...</div>";
  const saveBtn = document.getElementById("btnSaveFileTags");
  saveBtn.disabled = true;

  // fetch tags with selection for this file
  try {
    const data = await apiGet(`/api/file/${file.Id}/tags`);
    fileTagListEl.innerHTML = "";
    // data: [{Id,Name,Slug,ColorHex, Selected}]
    data.forEach((t) => {
      const wrapper = document.createElement("label");
      wrapper.className = "tag-bubble upload-tag";
      wrapper.style.backgroundColor = (t.ColorHex || "#888888") + "22";
      wrapper.style.borderColor = t.ColorHex || "#888888";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.Selected;
      cb.dataset.id = t.Id;

      // prevent checkbox click from bubbling (so it won't open editor)
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
      });

      const dot = document.createElement("span");
      dot.className = "tag-dot";
      dot.style.backgroundColor = t.ColorHex || "#888888";

      const span = document.createElement("span");
      span.textContent = t.Name;

      wrapper.appendChild(cb);
      wrapper.appendChild(dot);
      wrapper.appendChild(span);

      // clicking label (not checkbox) opens tag editor — prevent label default toggle
      wrapper.addEventListener("click", (e) => {
        if (e.target === cb) return;
        e.preventDefault();
        e.stopPropagation();
        openTagEditor(t);
      });

      fileTagListEl.appendChild(wrapper);
    });

    saveBtn.disabled = false;
    sidebar.classList.remove("hidden");
  } catch (err) {
    console.error("open sidebar", err);
    fileTagListEl.innerHTML = "";
    saveBtn.disabled = false;
    alert("Failed to load file tags: " + (err && err.message ? err.message : String(err)));
  }
}

document.getElementById("fileSidebarClose").addEventListener("click", () => {
  document.getElementById("fileSidebar").classList.add("hidden");
});

// Folder sidebar (similar to file sidebar but for folders)
let currentSidebarFolder = null;
async function openFolderSidebar(folder) {
  currentSidebarFolder = folder;
  currentSidebarFile = null; // <-- ensure file state cleared
  const sidebar = document.getElementById("fileSidebar");
  document.getElementById("fileSidebarTitle").textContent = folder.Name + " (Folder)";
  const fileTagListEl = document.getElementById("fileTagList");
  fileTagListEl.innerHTML = "<div class='loading'>Loading tags...</div>";
  const saveBtn = document.getElementById("btnSaveFileTags");
  saveBtn.disabled = true;

  try {
    const data = await apiGet(`/api/folder/${folder.Id}/tags`);
    fileTagListEl.innerHTML = "";
    data.forEach((t) => {
      const wrapper = document.createElement("label");
      wrapper.className = "tag-bubble upload-tag";
      wrapper.style.backgroundColor = (t.ColorHex || "#888888") + "22";
      wrapper.style.borderColor = t.ColorHex || "#888888";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.Selected;
      cb.dataset.id = t.Id;

      // prevent checkbox click from bubbling (so it won't open editor)
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
      });

      const dot = document.createElement("span");
      dot.className = "tag-dot";
      dot.style.backgroundColor = t.ColorHex || "#888888";

      const span = document.createElement("span");
      span.textContent = t.Name;

      wrapper.appendChild(cb);
      wrapper.appendChild(dot);
      wrapper.appendChild(span);

      // clicking label (not checkbox) opens tag editor — prevent label default toggle
      wrapper.addEventListener("click", (e) => {
        if (e.target === cb) return;
        e.preventDefault();
        e.stopPropagation();
        openTagEditor(t);
      });

      fileTagListEl.appendChild(wrapper);
    });

    saveBtn.disabled = false;
    sidebar.classList.remove("hidden");
  } catch (err) {
    console.error("open folder sidebar", err);
    fileTagListEl.innerHTML = "";
    saveBtn.disabled = false;
    alert("Failed to load folder tags: " + (err && err.message ? err.message : String(err)));
  }
}

// Update save button to handle both files and folders
document.getElementById("btnSaveFileTags").addEventListener("click", async () => {
  const checks = Array.from(document.querySelectorAll("#fileTagList input[type=checkbox]"));
  const tagIds = checks.filter(c => c.checked).map(c => parseInt(c.dataset.id, 10));

  if (currentSidebarFile) {
    try {
      await apiPost(`/api/file/${currentSidebarFile.Id}/tags`, { tagIds });
      document.getElementById("fileSidebar").classList.add("hidden");
      await loadFiles();
      await loadTags();
    } catch (err) {
      console.error("save file tags", err);
      alert("Failed to save file tags");
    }
  } else if (currentSidebarFolder) {
    try {
      await apiPost(`/api/folder/${currentSidebarFolder.Id}/tags`, { tagIds });
      document.getElementById("fileSidebar").classList.add("hidden");
      await loadFiles();
      await loadTags();
    } catch (err) {
      console.error("save folder tags", err);
      alert("Failed to save folder tags");
    }
  }
});

document.getElementById("btnCreateTag").addEventListener("click", async () => {
  const name = document.getElementById("tagEditName").value.trim();
  const colorHex = document.getElementById("tagEditColorHex").value.trim();
  if (!name) {
    alert("Tag name required");
    return;
  }
  try {
    // POST /api/tags will create or return existing by slug
    await apiPost("/api/tags", { name, colorHex });
    document.getElementById("tagEditorModal").classList.add("hidden");

    // reload global tag list and files
    await loadTags();
    await loadFiles();

    // If a file or folder sidebar is open, refresh it so the new tag appears immediately
    if (currentSidebarFile) {
      try { await openFileSidebar(currentSidebarFile); } catch (e) { /* ignore */ }
    } else if (currentSidebarFolder) {
      try { await openFolderSidebar(currentSidebarFolder); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error("create tag", err);
    alert("Failed to create tag");
  }
});

/* ============================================================
   UPLOAD with progress
============================================================ */

function formatBytesShort(bytes) {
  if (bytes == null) return "0 B";
  const sizes = ["B", "KB", "MB", "GB"];
  if (bytes === 0) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${sizes[i]}`;
}

function updateUploadProgressUI(percent, uploaded, total, speedBytesPerSec, etaText) {
  const row = document.getElementById("uploadProgressRow");
  row.classList.remove("hidden");
  document.getElementById("uploadProgressBar").style.width = percent + "%";
  document.getElementById("uploadPercent").textContent = `${percent.toFixed(1)}%`;
  document.getElementById("uploadSpeed").textContent = `${formatBytesShort(speedBytesPerSec)}/s`;
  document.getElementById("uploadETA").textContent = etaText == null ? "—" : etaText;
  document.getElementById("uploadSize").textContent = `${formatBytesShort(uploaded)} / ${formatBytesShort(total)}`;
}

function resetUploadProgressUI() {
  const row = document.getElementById("uploadProgressRow");
  row.classList.add("hidden");
  document.getElementById("uploadProgressBar").style.width = "0%";
  document.getElementById("uploadPercent").textContent = `0%`;
  document.getElementById("uploadSpeed").textContent = `0 KB/s`;
  document.getElementById("uploadETA").textContent = `—`;
  document.getElementById("uploadSize").textContent = `0 / 0`;
}

async function doUpload() {
  const fd = new FormData();
  if (currentFolder && currentFolder.Id) {
    fd.append("folderId", String(currentFolder.Id));
  }

  const newTagsValue = document.getElementById("uploadNewTags").value || "";
  fd.append("newTags", newTagsValue);

  const checked = Array.from(
    document.querySelectorAll(".upload-tag-checkbox:checked")
  );
  const slugs = checked.map((cb) => cb.dataset.slug);
  fd.append("tagSlugs", slugs.join(","));

  let totalSize = 0;
  for (const file of uploadState.files) {
    const rel =
      file.webkitRelativePath && file.webkitRelativePath.length > 0
        ? file.webkitRelativePath
        : file.name;
    fd.append("files", file, rel);
    totalSize += file.size || 0;
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const startTime = Date.now();
    let lastLoaded = 0;
    let lastTime = startTime;

    // samples for averaging over last 5 seconds
    const progressSamples = [];

    xhr.upload.addEventListener("progress", (e) => {
      const now = Date.now();
      const loaded = e.loaded;
      const percent = totalSize ? (loaded / totalSize) * 100 : 0;

      // push sample and prune older than 5s
      progressSamples.push({ time: now, loaded });
      const cutoff = now - 5000;
      while (progressSamples.length > 1 && progressSamples[0].time < cutoff) {
        progressSamples.shift();
      }

      // compute average speed over available samples (<=5s)
      let avgSpeed = 0;
      if (progressSamples.length >= 2) {
        const oldest = progressSamples[0];
        const newest = progressSamples[progressSamples.length - 1];
        const deltaBytes = newest.loaded - oldest.loaded;
        const deltaSec = Math.max(0.001, (newest.time - oldest.time) / 1000);
        avgSpeed = deltaBytes / deltaSec;
      } else {
        // fallback to instantaneous over last tick
        const dt = Math.max(0.001, (now - lastTime) / 1000);
        avgSpeed = (loaded - lastLoaded) / dt;
      }

      // estimate remaining time in minutes using avgSpeed and remaining bytes
      let etaText = "—";
      const remaining = Math.max(0, totalSize - loaded);
      if (avgSpeed > 0 && remaining > 0) {
        const etaSeconds = remaining / avgSpeed;
        const etaMinutes = etaSeconds / 60;
        etaText = `${etaMinutes.toFixed(1)} min`;
      } else if (remaining === 0) {
        etaText = "0.0 min";
      }

      lastLoaded = loaded;
      lastTime = now;

      updateUploadProgressUI(percent, loaded, totalSize, avgSpeed, etaText);
    });

    xhr.onreadystatechange = async () => {
      if (xhr.readyState === 4) {
        resetUploadProgressUI();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (!data.ok) return reject(new Error(data.error || "Upload failed"));
            resolve(data);
          } catch (err) {
            reject(new Error("Upload failed: invalid response"));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        }
      }
    };

    xhr.open("POST", "/api/upload", true);
    xhr.send(fd);
    // show progress UI (initial)
    updateUploadProgressUI(0, 0, totalSize, 0, "—");
  });
}

// Helper: darken a hex color by a percentage (e.g., 20 for 20% darker)
function darkenHex(hex, percent) {
  // Remove '#' if present
  hex = hex.replace('#', '');
  
  // Parse RGB
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  // Darken by reducing brightness
  const factor = 1 - (percent / 100);
  const newR = Math.round(r * factor);
  const newG = Math.round(g * factor);
  const newB = Math.round(b * factor);
  
  // Convert back to hex
  return '#' + [newR, newG, newB].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Helper: lighten a hex color by a percentage (e.g., 40 for 40% lighter)
function lightenHex(hex, percent) {
  hex = hex.replace('#', '');
  
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  // Lighten by moving towards white (255)
  const factor = percent / 100;
  const newR = Math.round(r + (255 - r) * factor);
  const newG = Math.round(g + (255 - g) * factor);
  const newB = Math.round(b + (255 - b) * factor);
  
  return '#' + [newR, newG, newB].map(x => x.toString(16).padStart(2, '0')).join('');
}

// default theme values used by reset buttons
const DEFAULT_BG_PANEL = "#020617";
const DEFAULT_BG_FILES = "#111827";
const DEFAULT_BG_FILES_DARK = "#1a2332";
const DEFAULT_BTN_BG = lightenHex(DEFAULT_BG_FILES, 40);

// THEME / SETTINGS (updated to handle bg-panel, bg-files, bg-files-alt, bg-files-dark & btn-bg)
function applyTheme(bgPanel, bgFiles, bgFilesDark) {
  if (bgPanel) document.documentElement.style.setProperty('--bg-panel', bgPanel);
  if (bgFiles) {
    document.documentElement.style.setProperty('--bg-files', bgFiles);
    // automatically compute 20% darker variant for alternating rows
    const darkAlt = darkenHex(bgFiles, 20);
    document.documentElement.style.setProperty('--bg-files-alt', darkAlt);
    // automatically compute 40% lighter variant for buttons
    const btnBg = lightenHex(bgFiles, 40);
    document.documentElement.style.setProperty('--btn-bg', btnBg);
  }
  if (bgFilesDark) document.documentElement.style.setProperty('--bg-files-dark', bgFilesDark);
}

function loadThemeFromStorage() {
  const bgPanel = localStorage.getItem('themeBgPanel') || null;
  const bgFiles = localStorage.getItem('themeBgFiles') || null;
  const bgFilesDark = localStorage.getItem('themeBgFilesDark') || null;
  if (bgPanel || bgFiles || bgFilesDark) applyTheme(bgPanel, bgFiles, bgFilesDark);
}

// call early so UI picks up stored theme
loadThemeFromStorage();

function setupSettings() {
  const toggle = document.getElementById('settingsToggle');
  const modal = document.getElementById('settingsModal');
  const close = document.getElementById('settingsClose');
  const save = document.getElementById('btnSaveSettings');

  const inPanel = document.getElementById('settingsBgPanel');
  const inPanelHex = document.getElementById('settingsBgPanelHex');
  const btnResetPanel = document.getElementById('btnResetPanel');

  const inFiles = document.getElementById('settingsBgFiles');
  const inFilesHex = document.getElementById('settingsBgFilesHex');
  const btnResetFiles = document.getElementById('btnResetFiles');

  const inFilesDark = document.getElementById('settingsBgFilesDark');
  const inFilesDarkHex = document.getElementById('settingsBgFilesDarkHex');
  const btnResetFilesDark = document.getElementById('btnResetFilesDark');

  function initInputs() {
    const style = getComputedStyle(document.documentElement);
    const curPanel = style.getPropertyValue('--bg-panel').trim() || DEFAULT_BG_PANEL;
    const curFiles = style.getPropertyValue('--bg-files').trim() || DEFAULT_BG_FILES;
    const curFilesDark = style.getPropertyValue('--bg-files-dark').trim() || DEFAULT_BG_FILES_DARK;

    inPanel.value = curPanel; inPanelHex.value = curPanel;
    inFiles.value = curFiles; inFilesHex.value = curFiles;
    inFilesDark.value = curFilesDark; inFilesDarkHex.value = curFilesDark;
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    initInputs();
    modal.classList.remove('hidden');
  });

  close.addEventListener('click', () => modal.classList.add('hidden'));

  // live-preview on color change (applyTheme immediately)
  inPanel.addEventListener('input', (e) => {
    const v = e.target.value;
    inPanelHex.value = v;
    applyTheme(v, null, null);
  });
  inPanelHex.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      inPanel.value = v;
      applyTheme(v, null, null);
    }
  });

  inFiles.addEventListener('input', (e) => {
    const v = e.target.value;
    inFilesHex.value = v;
    applyTheme(null, v, null);
  });
  inFilesHex.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      inFiles.value = v;
      applyTheme(null, v, null);
    }
  });

  inFilesDark.addEventListener('input', (e) => {
    const v = e.target.value;
    inFilesDarkHex.value = v;
    applyTheme(null, null, v);
  });
  inFilesDarkHex.addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      inFilesDark.value = v;
      applyTheme(null, null, v);
    }
  });

  // reset buttons set inputs back to defaults and preview
  btnResetPanel.addEventListener('click', () => {
    inPanel.value = DEFAULT_BG_PANEL;
    inPanelHex.value = DEFAULT_BG_PANEL;
    applyTheme(DEFAULT_BG_PANEL, null, null);
  });
  btnResetFiles.addEventListener('click', () => {
    inFiles.value = DEFAULT_BG_FILES;
    inFilesHex.value = DEFAULT_BG_FILES;
    applyTheme(null, DEFAULT_BG_FILES, null);
  });
  btnResetFilesDark.addEventListener('click', () => {
    inFilesDark.value = DEFAULT_BG_FILES_DARK;
    inFilesDarkHex.value = DEFAULT_BG_FILES_DARK;
    applyTheme(null, null, DEFAULT_BG_FILES_DARK);
  });

  save.addEventListener('click', () => {
    const p = inPanelHex.value.trim() || inPanel.value;
    const f = inFilesHex.value.trim() || inFiles.value;
    const fd = inFilesDarkHex.value.trim() || inFilesDark.value;

    if (!/^#[0-9a-fA-F]{6}$/.test(p) || !/^#[0-9a-fA-F]{6}$/.test(f) || !/^#[0-9a-fA-F]{6}$/.test(fd)) {
      alert('Please provide valid hex colors like #rrggbb');
      return;
    }

    localStorage.setItem('themeBgPanel', p);
    localStorage.setItem('themeBgFiles', f);
    localStorage.setItem('themeBgFilesDark', fd);

    applyTheme(p, f, fd);
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

/* ============================================================
   AUTO-REFRESH POLLING
============================================================ */
let autoRefreshInterval = null;
const REFRESH_INTERVAL = 2000; // 2 seconds

function startAutoRefresh() {
  if (autoRefreshInterval) return; // already running
  autoRefreshInterval = setInterval(() => {
    loadFiles().catch((err) => {
      console.error("Auto-refresh error:", err);
    });
  }, REFRESH_INTERVAL);
  console.log("Auto-refresh started");
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    console.log("Auto-refresh stopped");
  }
}

// Stop auto-refresh when page unloads (cleanup)
window.addEventListener("beforeunload", () => {
  stopAutoRefresh();
});

// New helper: download folder zip via fetch so we can show server error messages (e.g. missing archiver)
function downloadFolderZip(folder) {
  const id = folder.Id;
  fetch(`/download-folder/${id}`).then(async (res) => {
    if (!res.ok) {
      const txt = await res.text().catch(() => `HTTP ${res.status}`);
      alert("Folder download failed: " + txt);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const name = (folder.Name || "folder") + ".zip";
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }).catch((err) => {
    console.error("downloadFolderZip error", err);
    alert("Folder download failed: " + (err && err.message ? err.message : String(err)));
  });
}

//# sourceMappingURL=app.js.map
