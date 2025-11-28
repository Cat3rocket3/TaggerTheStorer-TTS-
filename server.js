// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const BusboyLib = require("busboy");
const { sql, getPool } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// physical uploads folder root
const UPLOAD_ROOT = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

/* ============================================================
   BACKGROUND JOB QUEUE (simple in-memory queue)
============================================================ */
class JobQueue {
  constructor() {
    this.jobs = [];
    this.processing = false;
  }

  enqueue(fn) {
    this.jobs.push(fn);
    this.process();
  }

  async process() {
    if (this.processing || this.jobs.length === 0) return;
    this.processing = true;

    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      try {
        await job();
      } catch (err) {
        console.error("Background job error:", err);
      }
    }

    this.processing = false;
  }
}

const jobQueue = new JobQueue();

// helpers
function fullPathToPhysical(fullPath) {
  const parts = (fullPath || "").split("/").filter(Boolean);
  return path.join(UPLOAD_ROOT, ...parts);
}

async function ensureDiskFolder(fullPath) {
  const physical = fullPathToPhysical(fullPath);
  await fsPromises.mkdir(physical, { recursive: true });
  return physical;
}

function createBusboy(req) {
  // Support both old (constructor) and new (function) busboy APIs
  try {
    return new BusboyLib({ headers: req.headers });
  } catch (e) {
    return BusboyLib({ headers: req.headers });
  }
}

// middleware
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_ROOT));
app.use(express.json());

/* ============================================================
   DB: ensure root folder exists on startup
============================================================ */
async function ensureRootFolder() {
  const pool = await getPool();
  const r = await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM Folders WHERE ParentId IS NULL)
    BEGIN
      INSERT INTO Folders (Name, ParentId, FullPath)
      VALUES ('root', NULL, '/root');
    END;
    SELECT TOP (1) * FROM Folders WHERE ParentId IS NULL ORDER BY Id;
  `);
  const root = r.recordset[0];
  await ensureDiskFolder(root.FullPath);
  return root;
}

/* ============================================================
   DB: ensure FolderTags table exists
============================================================ */
async function ensureFolderTagsTable() {
  const pool = await getPool();
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'FolderTags')
    BEGIN
      CREATE TABLE FolderTags (
        FolderId INT NOT NULL,
        TagId INT NOT NULL,
        PRIMARY KEY (FolderId, TagId),
        FOREIGN KEY (FolderId) REFERENCES Folders(Id) ON DELETE CASCADE,
        FOREIGN KEY (TagId) REFERENCES Tags(Id) ON DELETE CASCADE
      );
    END;
  `);
}

/* ============================================================
   TAGS
============================================================ */
app.get("/api/tags", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT Id, Name, Slug, ColorHex
      FROM Tags
      ORDER BY Name;
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error("GET /api/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/tags/:id/color", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { colorHex } = req.body || {};
  if (!colorHex || !/^#[0-9a-fA-F]{6}$/.test(colorHex)) {
    return res.status(400).json({ error: "Invalid color" });
  }
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("Id", sql.Int, id)
      .input("ColorHex", sql.NVarChar(7), colorHex)
      .query("UPDATE Tags SET ColorHex=@ColorHex WHERE Id=@Id;");
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/tags/:id/color error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// Add PATCH endpoint to update name and/or color
app.patch("/api/tags/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, colorHex } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  if (colorHex != null && colorHex !== "" && !/^#[0-9a-fA-F]{6}$/.test(colorHex)) {
    return res.status(400).json({ error: "Invalid color" });
  }
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("Id", sql.Int, id);

    const updates = [];
    if (name != null) {
      request.input("Name", sql.NVarChar(100), name);
      updates.push("Name=@Name");
    }
    if (colorHex != null) {
      request.input("ColorHex", sql.NVarChar(7), colorHex);
      updates.push("ColorHex=@ColorHex");
    }

    if (!updates.length) {
      const r = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Tags WHERE Id=@Id");
      if (!r.recordset.length) return res.status(404).json({ error: "Tag not found" });
      return res.json(r.recordset[0]);
    }

    const q = `UPDATE Tags SET ${updates.join(", ")} WHERE Id=@Id; SELECT * FROM Tags WHERE Id=@Id;`;
    const r = await request.query(q);
    if (!r.recordset.length) return res.status(404).json({ error: "Tag not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    console.error("PATCH /api/tags/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// Create a new tag
app.post("/api/tags", async (req, res) => {
  const { name, colorHex } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });
  if (colorHex != null && colorHex !== "" && !/^#[0-9a-fA-F]{6}$/.test(colorHex)) {
    return res.status(400).json({ error: "Invalid color" });
  }
  try {
    const pool = await getPool();
    const slug = String(name).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-]/g, "");
    // if exists return existing
    const exists = await pool.request().input("Slug", sql.NVarChar(100), slug).query("SELECT * FROM Tags WHERE Slug=@Slug");
    if (exists.recordset.length) {
      return res.json(exists.recordset[0]);
    }
    // generate color if not provided
    const color = colorHex && colorHex !== "" ? colorHex : ("#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"));
    const r = await pool
      .request()
      .input("Name", sql.NVarChar(100), name)
      .input("Slug", sql.NVarChar(100), slug)
      .input("ColorHex", sql.NVarChar(7), color)
      .query(`
        INSERT INTO Tags (Name, Slug, ColorHex)
        OUTPUT INSERTED.*
        VALUES (@Name, @Slug, @ColorHex);
      `);
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// Add DELETE endpoint to delete a tag
app.delete("/api/tags/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    
    // Delete all tag associations first (cascade)
    await pool
      .request()
      .input("TagId", sql.Int, id)
      .query(`
        DELETE FROM FileTags WHERE TagId=@TagId;
        DELETE FROM FolderTags WHERE TagId=@TagId;
        DELETE FROM Tags WHERE Id=@TagId;
      `);

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/tags/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   FOLDERS
============================================================ */
app.get("/api/root-folder", async (req, res) => {
  try {
    const root = await ensureRootFolder();
    res.json(root);
  } catch (err) {
    console.error("GET /api/root-folder error", err);
    res.status(500).json({ error: "Failed to get root folder" });
  }
});

app.get("/api/folders", async (req, res) => {
  const parentId = req.query.parentId ? parseInt(req.query.parentId, 10) : null;

  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("ParentId", sql.Int, parentId)
      .query(`
        SELECT 
          f.Id,
          f.Name,
          f.ParentId,
          f.FullPath,
          CASE WHEN EXISTS (SELECT 1 FROM Folders c WHERE c.ParentId = f.Id)
               THEN 1 ELSE 0 END AS HasChildren,
          -- include slug so the client can filter reliably: Name|ColorHex|Slug
          STRING_AGG(t.Name + '|' + t.ColorHex + '|' + t.Slug, ',') AS TagInfo
        FROM Folders f
        LEFT JOIN FolderTags ft ON ft.FolderId = f.Id
        LEFT JOIN Tags t ON t.Id = ft.TagId
        WHERE 
          (@ParentId IS NULL AND f.ParentId IS NULL)
          OR f.ParentId = @ParentId
        GROUP BY f.Id, f.Name, f.ParentId, f.FullPath
        ORDER BY f.Name;
      `);

    // remove folders that no longer exist on disk (async, in background)
    const existing = [];
    const cleanupJobs = [];

    for (const row of r.recordset) {
      const phys = fullPathToPhysical(row.FullPath);
      try {
        await fsPromises.access(phys);
        existing.push(row);
      } catch {
        // folder missing on disk, queue cleanup task
        cleanupJobs.push(async () => {
          const p = await getPool();
          await p
            .request()
            .input("FolderId", sql.Int, row.Id)
            .query(`
              DELETE FROM FileTags WHERE FileId IN (SELECT Id FROM Files WHERE FolderId=@FolderId);
              DELETE FROM Files WHERE FolderId=@FolderId;
              DELETE FROM Folders WHERE Id=@FolderId;
            `);
        });
      }
    }

    // queue cleanup tasks to background job queue
    cleanupJobs.forEach((job) => jobQueue.enqueue(job));

    res.json(existing);
  } catch (err) {
    console.error("GET /api/folders error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/folder/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Folders WHERE Id=@Id");

    if (!r.recordset.length) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(r.recordset[0]);
  } catch (err) {
    console.error("GET /api/folder/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/folders", async (req, res) => {
  const { name, parentId } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Folder name required" });
  }

  try {
    const pool = await getPool();

    let parentPath = "/root";
    let parentDbId = null;

    if (parentId) {
      const p = await pool
        .request()
        .input("Id", sql.Int, parentId)
        .query("SELECT * FROM Folders WHERE Id=@Id");

      if (!p.recordset.length) {
        return res.status(400).json({ error: "Parent not found" });
      }

      parentDbId = p.recordset[0].Id;
      parentPath = p.recordset[0].FullPath;
    }

    const fullPath = `${parentPath}/${name}`;

    await ensureDiskFolder(fullPath);

    const r = await pool
      .request()
      .input("Name", sql.NVarChar(255), name)
      .input("ParentId", sql.Int, parentDbId)
      .input("FullPath", sql.NVarChar(1000), fullPath)
      .query(`
        INSERT INTO Folders (Name, ParentId, FullPath)
        OUTPUT INSERTED.*
        VALUES (@Name, @ParentId, @FullPath);
      `);

    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/folders error", err);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

app.delete("/api/folder/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();

    const folderRes = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Folders WHERE Id=@Id");

    if (!folderRes.recordset.length) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const folder = folderRes.recordset[0];
    const phys = fullPathToPhysical(folder.FullPath);

    await pool
      .request()
      .input("FullPathPrefix", sql.NVarChar(1000), folder.FullPath + "%")
      .query(`
        DELETE FT
        FROM FileTags FT
        WHERE FT.FileId IN (
          SELECT Id FROM Files WHERE FolderId IN (
            SELECT Id FROM Folders WHERE FullPath LIKE @FullPathPrefix
          )
        );

        DELETE FROM Files WHERE FolderId IN (
          SELECT Id FROM Folders WHERE FullPath LIKE @FullPathPrefix
        );

        DELETE FROM Folders WHERE FullPath LIKE @FullPathPrefix;
      `);

    // delete folder asynchronously in background
    jobQueue.enqueue(async () => {
      try {
        await fsPromises.rm(phys, { recursive: true, force: true });
        console.log("Cleanup: removed folder", phys);
      } catch (err) {
        console.error("Cleanup error for folder", phys, err);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/folder/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   FILE DISCOVERY: scan disk folder, find new files, add to DB
============================================================ */
async function discoverAndAddNewFiles(folderId, folderPath) {
  try {
    const pool = await getPool();
    const phys = fullPathToPhysical(folderPath);

    // Check if folder exists on disk
    try {
      await fsPromises.access(phys);
    } catch {
      return; // folder doesn't exist on disk, skip
    }

    // List all files currently in DB for this folder
    const dbFiles = await pool
      .request()
      .input("FolderId", sql.Int, folderId)
      .query("SELECT StoragePath FROM Files WHERE FolderId=@FolderId;");

    const dbPaths = new Set(dbFiles.recordset.map(f => f.StoragePath));

    // Scan disk directory for files
    let entries = [];
    try {
      entries = await fsPromises.readdir(phys, { withFileTypes: true });
    } catch (err) {
      console.error("Error reading directory", phys, err);
      return;
    }

    // Filter to files only (not subdirectories)
    const diskFiles = entries
      .filter(entry => entry.isFile())
      .map(entry => ({
        name: entry.name,
        path: path.join(phys, entry.name).replace(/\\/g, "/"),
      }));

    // Find new files (on disk but not in DB)
    const newFiles = diskFiles.filter(df => !dbPaths.has(df.path));

    // Insert new files into DB
    for (const nf of newFiles) {
      try {
        const stat = await fsPromises.stat(nf.path);
        const size = stat.size || 0;
        const mime = "application/octet-stream"; // default mime type

        await pool
          .request()
          .input("FolderId", sql.Int, folderId)
          .input("Name", sql.NVarChar(255), nf.name)
          .input("StoragePath", sql.NVarChar(1000), nf.path)
          .input("SizeBytes", sql.BigInt, size)
          .input("MimeType", sql.NVarChar(255), mime)
          .query(`
            INSERT INTO Files (FolderId, Name, StoragePath, SizeBytes, MimeType)
            VALUES (@FolderId, @Name, @StoragePath, @SizeBytes, @MimeType);
          `);

        console.log("Discovered new file:", nf.path);
      } catch (err) {
        console.error("Error inserting discovered file", nf.path, err);
      }
    }
  } catch (err) {
    console.error("discoverAndAddNewFiles error", err);
  }
}

/* ============================================================
   RECURSIVE SYNC: discover folders/files on disk (recursive),
   add missing DB entries and remove DB rows for deleted items.
   Runs in background (queued).
============================================================ */
async function discoverAndSyncFolderRecursive(folderId, folderFullPath) {
  try {
    const pool = await getPool();
    const physBase = fullPathToPhysical(folderFullPath);

    // If folder doesn't exist on disk, nothing to do
    try {
      await fsPromises.access(physBase);
    } catch {
      return;
    }

    // Fetch existing folders under the prefix (FullPath LIKE prefix%)
    const folderPrefix = folderFullPath.endsWith("/") ? folderFullPath + "%" : folderFullPath + "%";
    const folderRows = await pool
      .request()
      .input("Prefix", sql.NVarChar(1000), folderPrefix)
      .query("SELECT Id, FullPath, ParentId FROM Folders WHERE FullPath LIKE @Prefix;");

    const existingFolderMap = new Map(); // fullPath -> { Id, ParentId }
    for (const r of folderRows.recordset) existingFolderMap.set(r.FullPath, { Id: r.Id, ParentId: r.ParentId });

    // Collect folder IDs under prefix to query files
    const folderIds = folderRows.recordset.map(r => r.Id);
    // Query existing files under those folders
    let existingFilesMap = new Map(); // storagePath -> { Id, FolderId }
    if (folderIds.length > 0) {
      const idsCsv = folderIds.join(",");
      const rFiles = await pool.request().query(`SELECT Id, StoragePath, FolderId FROM Files WHERE FolderId IN (${idsCsv});`);
      for (const rf of rFiles.recordset) existingFilesMap.set(String(rf.StoragePath), { Id: rf.Id, FolderId: rf.FolderId });
    }

    // Walk disk recursively to collect seen folders and files
    const seenFolders = new Set();
    const seenFiles = new Set();

    async function walkDir(dir) {
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const ent of entries) {
        const fullPath = path.join(dir, ent.name);
        const rel = path.relative(UPLOAD_ROOT, fullPath).replace(/\\/g, "/"); // e.g. "root/sub"
        const logicalFullPath = "/" + rel;
        if (ent.isDirectory()) {
          seenFolders.add(logicalFullPath);
          await walkDir(fullPath);
        } else if (ent.isFile()) {
          // normalize stored StoragePath to forward slashes (DB uses forward slashes)
          seenFiles.add(fullPath.replace(/\\/g, "/"));
        }
      }
    }

    await walkDir(physBase);

    // Ensure base folder is included (physBase corresponds to folderFullPath)
    seenFolders.add(folderFullPath);

    // INSERT missing folders (top-down)
    // We need to process seenFolders in order of path depth so parents exist first.
    const seenArr = Array.from(seenFolders);
    seenArr.sort((a, b) => a.split("/").length - b.split("/").length);

    for (const fFull of seenArr) {
      if (existingFolderMap.has(fFull)) continue;
      // compute parentFullPath
      const idx = fFull.lastIndexOf("/");
      const parentFull = idx > 0 ? fFull.slice(0, idx) : null;
      const name = fFull.split("/").pop() || fFull;
      const parentEntry = parentFull ? existingFolderMap.get(parentFull) : null;
      const parentIdForInsert = parentEntry ? parentEntry.Id : (folderId || null);

      try {
        const ins = await pool
          .request()
          .input("Name", sql.NVarChar(255), name)
          .input("ParentId", sql.Int, parentIdForInsert)
          .input("FullPath", sql.NVarChar(1000), fFull)
          .query(`
            INSERT INTO Folders (Name, ParentId, FullPath)
            OUTPUT INSERTED.*
            VALUES (@Name, @ParentId, @FullPath);
          `);
        const newRow = ins.recordset[0];
        existingFolderMap.set(fFull, { Id: newRow.Id, ParentId: newRow.ParentId });
        // add new folder id to list for file queries later
        folderIds.push(newRow.Id);
      } catch (err) {
        console.error("Error inserting discovered folder", fFull, err);
      }
    }

    // Re-query existing files map for up-to-date folderIds (in case we added folders)
    existingFilesMap = new Map();
    if (folderIds.length > 0) {
      const idsCsv2 = folderIds.join(",");
      const rFiles2 = await pool.request().query(`SELECT Id, StoragePath, FolderId FROM Files WHERE FolderId IN (${idsCsv2});`);
      for (const rf of rFiles2.recordset) existingFilesMap.set(String(rf.StoragePath), { Id: rf.Id, FolderId: rf.FolderId });
    }

    // INSERT missing files
    for (const filePath of seenFiles) {
      if (existingFilesMap.has(filePath)) continue;
      // determine folder fullPath for this file
      const dir = path.dirname(filePath);
      const rel = path.relative(UPLOAD_ROOT, dir).replace(/\\/g, "/"); // 'root/...'
      const folderFull = "/" + rel;
      const folderEntry = existingFolderMap.get(folderFull);
      if (!folderEntry) {
        // Shouldn't happen because we inserted folders above, but skip if missing
        console.warn("Missing folder for file, skipping:", filePath, "folderFull:", folderFull);
        continue;
      }
      try {
        const stat = await fsPromises.stat(filePath);
        const size = stat.size || 0;
        const name = path.basename(filePath);
        await pool
          .request()
          .input("FolderId", sql.Int, folderEntry.Id)
          .input("Name", sql.NVarChar(255), name)
          .input("StoragePath", sql.NVarChar(1000), filePath.replace(/\\/g, "/"))
          .input("SizeBytes", sql.BigInt, size)
          .input("MimeType", sql.NVarChar(255), "application/octet-stream")
          .query(`
            INSERT INTO Files (FolderId, Name, StoragePath, SizeBytes, MimeType)
            VALUES (@FolderId, @Name, @StoragePath, @SizeBytes, @MimeType);
          `);
        // optional: log
        console.log("Discovered and inserted file:", filePath);
      } catch (err) {
        console.error("Error inserting discovered file", filePath, err);
      }
    }

    // CLEANUP: delete DB files that no longer exist on disk
    // Get existing DB files under the prefix
    const rExistsFiles = await pool
      .request()
      .input("FolderPrefix", sql.NVarChar(1000), folderPrefix)
      .query(`
        SELECT f.Id, f.StoragePath
        FROM Files f
        INNER JOIN Folders fo ON fo.Id = f.FolderId
        WHERE fo.FullPath LIKE @FolderPrefix;
      `);
    for (const rf of rExistsFiles.recordset) {
      const sp = String(rf.StoragePath);
      if (!seenFiles.has(sp)) {
        // enqueue cleanup
        const fileId = rf.Id;
        jobQueue.enqueue(async () => {
          try {
            const p = await getPool();
            await p
              .request()
              .input("FileId", sql.Int, fileId)
              .query(`
                DELETE FROM FileTags WHERE FileId=@FileId;
                DELETE FROM Files WHERE Id=@FileId;
              `);
            console.log("Removed DB file for missing disk file:", fileId);
          } catch (err) {
            console.error("Error cleaning missing DB file", fileId, err);
          }
        });
      }
    }

    // CLEANUP: delete DB folders that no longer exist on disk
    const rExistsFolders = await pool
      .request()
      .input("Prefix", sql.NVarChar(1000), folderPrefix)
      .query(`SELECT Id, FullPath FROM Folders WHERE FullPath LIKE @Prefix;`);
    for (const rf of rExistsFolders.recordset) {
      if (!seenFolders.has(rf.FullPath)) {
        const folderIdToDel = rf.Id;
        jobQueue.enqueue(async () => {
          try {
            const p = await getPool();
            await p
              .request()
              .input("FolderId", sql.Int, folderIdToDel)
              .query(`
                DELETE FROM FileTags WHERE FileId IN (SELECT Id FROM Files WHERE FolderId=@FolderId);
                DELETE FROM Files WHERE FolderId=@FolderId;
                DELETE FROM Folders WHERE Id=@FolderId;
              `);
            console.log("Removed DB folder for missing disk folder:", rf.FullPath);
          } catch (err) {
            console.error("Error cleaning missing DB folder", rf.FullPath, err);
          }
        });
      }
    }
  } catch (err) {
    console.error("discoverAndSyncFolderRecursive error", err);
  }
}

/* ============================================================
   LIST FILES (with auto cleanup if missing on disk)
   (enqueue recursive sync instead of shallow discovery)
============================================================ */
app.get("/api/files", async (req, res) => {
  const folderId = req.query.folderId ? parseInt(req.query.folderId, 10) : null;
  const search = req.query.search || null;

  const tagSlugs = (req.query.tags || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  try {
    const pool = await getPool();

    // Get folder path for discovery/sync
    let folderPath = "/root";
    if (folderId) {
      const folderRes = await pool
        .request()
        .input("FolderId", sql.Int, folderId)
        .query("SELECT FullPath FROM Folders WHERE Id=@FolderId;");
      if (folderRes.recordset.length) {
        folderPath = folderRes.recordset[0].FullPath;
      }
    }

    // Run recursive sync in background (async, don't wait)
    jobQueue.enqueue(async () => {
      await discoverAndSyncFolderRecursive(folderId, folderPath);
    });

    // Query files as before
    const request = pool.request();

    request.input("FolderId", sql.Int, folderId);
    request.input("Search", sql.NVarChar(255), search);

    const tvp = new sql.Table("TagSlugList");
    tvp.columns.add("Slug", sql.NVarChar(100));
    tagSlugs.forEach((s) => tvp.rows.add(s));
    request.input("TagSlugs", tvp);

    const r = await request.execute("GetFiles");

    const keep = [];
    const cleanupJobs = [];

    for (const row of r.recordset) {
      const phys = row.StoragePath;
      try {
        await fsPromises.access(phys);
        keep.push(row);
      } catch {
        // file missing on disk, queue cleanup
        cleanupJobs.push(async () => {
          const p = await getPool();
          await p
            .request()
            .input("FileId", sql.Int, row.Id)
            .query(`
              DELETE FROM FileTags WHERE FileId=@FileId;
              DELETE FROM Files WHERE Id=@FileId;
            `);
          console.log("Cleaned up missing file from DB:", row.Id);
        });
      }
    }

    cleanupJobs.forEach((job) => jobQueue.enqueue(job));
    res.json(keep);
  } catch (err) {
    console.log("GET /api/files error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   LIST FOLDERS: enqueue recursive sync for this parent
============================================================ */
app.get("/api/folders", async (req, res) => {
  const parentId = req.query.parentId ? parseInt(req.query.parentId, 10) : null;

  try {
    const pool = await getPool();

    // determine parent full path
    let parentFullPath = "/root";
    if (parentId) {
      const pf = await pool.request().input("Id", sql.Int, parentId).query("SELECT FullPath FROM Folders WHERE Id=@Id");
      if (pf.recordset.length) parentFullPath = pf.recordset[0].FullPath;
    }

    // enqueue recursive sync for parent (background)
    jobQueue.enqueue(async () => {
      await discoverAndSyncFolderRecursive(parentId, parentFullPath);
    });

    const r = await pool
      .request()
      .input("ParentId", sql.Int, parentId)
      .query(`
        SELECT 
          f.Id,
          f.Name,
          f.ParentId,
          f.FullPath,
          CASE WHEN EXISTS (SELECT 1 FROM Folders c WHERE c.ParentId = f.Id)
               THEN 1 ELSE 0 END AS HasChildren,
          -- include slug so the client can filter reliably: Name|ColorHex|Slug
          STRING_AGG(t.Name + '|' + t.ColorHex + '|' + t.Slug, ',') AS TagInfo
        FROM Folders f
        LEFT JOIN FolderTags ft ON ft.FolderId = f.Id
        LEFT JOIN Tags t ON t.Id = ft.TagId
        WHERE 
          (@ParentId IS NULL AND f.ParentId IS NULL)
          OR f.ParentId = @ParentId
        GROUP BY f.Id, f.Name, f.ParentId, f.FullPath
        ORDER BY f.Name;
      `);

    // remove folders that no longer exist on disk (async, in background)
    const existing = [];
    const cleanupJobs = [];

    for (const row of r.recordset) {
      const phys = fullPathToPhysical(row.FullPath);
      try {
        await fsPromises.access(phys);
        existing.push(row);
      } catch {
        // folder missing on disk, queue cleanup task
        cleanupJobs.push(async () => {
          const p = await getPool();
          await p
            .request()
            .input("FolderId", sql.Int, row.Id)
            .query(`
              DELETE FROM FileTags WHERE FileId IN (SELECT Id FROM Files WHERE FolderId=@FolderId);
              DELETE FROM Files WHERE FolderId=@FolderId;
              DELETE FROM Folders WHERE Id=@FolderId;
            `);
        });
      }
    }

    // queue cleanup tasks to background job queue
    cleanupJobs.forEach((job) => jobQueue.enqueue(job));

    res.json(existing);
  } catch (err) {
    console.error("GET /api/folders error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/api/folder/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Folders WHERE Id=@Id");

    if (!r.recordset.length) {
      return res.status(404).json({ error: "Not found" });
    }

    res.json(r.recordset[0]);
  } catch (err) {
    console.error("GET /api/folder/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/folders", async (req, res) => {
  const { name, parentId } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Folder name required" });
  }

  try {
    const pool = await getPool();

    let parentPath = "/root";
    let parentDbId = null;

    if (parentId) {
      const p = await pool
        .request()
        .input("Id", sql.Int, parentId)
        .query("SELECT * FROM Folders WHERE Id=@Id");

      if (!p.recordset.length) {
        return res.status(400).json({ error: "Parent not found" });
      }

      parentDbId = p.recordset[0].Id;
      parentPath = p.recordset[0].FullPath;
    }

    const fullPath = `${parentPath}/${name}`;

    await ensureDiskFolder(fullPath);

    const r = await pool
      .request()
      .input("Name", sql.NVarChar(255), name)
      .input("ParentId", sql.Int, parentDbId)
      .input("FullPath", sql.NVarChar(1000), fullPath)
      .query(`
        INSERT INTO Folders (Name, ParentId, FullPath)
        OUTPUT INSERTED.*
        VALUES (@Name, @ParentId, @FullPath);
      `);

    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/folders error", err);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

app.delete("/api/folder/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();

    const folderRes = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Folders WHERE Id=@Id");

    if (!folderRes.recordset.length) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const folder = folderRes.recordset[0];
    const phys = fullPathToPhysical(folder.FullPath);

    await pool
      .request()
      .input("FullPathPrefix", sql.NVarChar(1000), folder.FullPath + "%")
      .query(`
        DELETE FT
        FROM FileTags FT
        WHERE FT.FileId IN (
          SELECT Id FROM Files WHERE FolderId IN (
            SELECT Id FROM Folders WHERE FullPath LIKE @FullPathPrefix
          )
        );

        DELETE FROM Files WHERE FolderId IN (
          SELECT Id FROM Folders WHERE FullPath LIKE @FullPathPrefix
        );

        DELETE FROM Folders WHERE FullPath LIKE @FullPathPrefix;
      `);

    // delete folder asynchronously in background
    jobQueue.enqueue(async () => {
      try {
        await fsPromises.rm(phys, { recursive: true, force: true });
        console.log("Cleanup: removed folder", phys);
      } catch (err) {
        console.error("Cleanup error for folder", phys, err);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/folder/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// PATCH to rename folder (updates FullPath for folder and descendants; attempts disk rename)
app.patch("/api/folder/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });

  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Folders WHERE Id=@Id");

    if (!r.recordset.length) return res.status(404).json({ error: "Folder not found" });

    const folder = r.recordset[0];
    const oldFull = folder.FullPath;
    // determine parent full path
    let parentFull = "/root";
    if (folder.ParentId != null) {
      const p = await pool.request().input("Id", sql.Int, folder.ParentId).query("SELECT FullPath FROM Folders WHERE Id=@Id");
      if (p.recordset.length) parentFull = p.recordset[0].FullPath;
    }

    const newFull = `${parentFull}/${name}`;

    // Update FullPath for this folder and all descendants by replacing prefix
    const oldPrefix = oldFull;
    const newPrefix = newFull;

    await pool
      .request()
      .input("OldPrefix", sql.NVarChar(1000), oldPrefix)
      .input("NewPrefix", sql.NVarChar(1000), newPrefix)
      .input("Name", sql.NVarChar(255), name)
      .input("Id", sql.Int, id)
      .query(`
        UPDATE Folders
        SET FullPath = @NewPrefix + SUBSTRING(FullPath, LEN(@OldPrefix) + 1, 2000)
        WHERE FullPath LIKE @OldPrefix + '%';

        UPDATE Folders SET Name=@Name WHERE Id=@Id;
      `);

    // Attempt to rename on disk
    const oldPhys = fullPathToPhysical(oldFull);
    const newPhys = fullPathToPhysical(newFull);
    try {
      // ensure destination parent exists
      await fsPromises.mkdir(path.dirname(newPhys), { recursive: true });
      await fsPromises.rename(oldPhys, newPhys);
    } catch (err) {
      // non-fatal: log and continue (DB already updated)
      console.error("Failed to rename folder on disk:", oldPhys, "->", newPhys, err);
    }

    const updated = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Folders WHERE Id=@Id");
    res.json(updated.recordset[0]);
  } catch (err) {
    console.error("PATCH /api/folder/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// GET download folder as zip (streams zip). Requires 'archiver' package.
app.get("/download-folder/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).send("Invalid id");

    const pool = await getPool();
    const r = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Folders WHERE Id=@Id");
    if (!r.recordset.length) return res.status(404).send("Not found");

    const folder = r.recordset[0];
    const phys = fullPathToPhysical(folder.FullPath);

    try {
      await fsPromises.access(phys);
    } catch {
      return res.status(404).send("Folder not found on disk");
    }

    let archiver;
    try {
      archiver = require("archiver");
    } catch (e) {
      console.error("archiver module not installed:", e);
      return res.status(500).send("Server missing 'archiver' module. Install with: npm install archiver");
    }

    const zipName = (folder.Name || "folder") + ".zip";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(zipName)}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("Archive error", err);
      try { res.status(500).end(); } catch (e) {}
    });

    archive.pipe(res);
    // append directory contents; second arg false to avoid nesting with full path
    archive.directory(phys, false);
    archive.finalize();
  } catch (err) {
    console.error("GET /download-folder/:id error", err);
    res.status(500).end();
  }
});

/* ============================================================
   FOLDER TAGS: get tags with selection and set tags for a folder
============================================================ */
app.get("/api/folder/:id/tags", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("FolderId", sql.Int, id)
      .query(`
        SELECT
          t.Id, t.Name, t.Slug, t.ColorHex,
          CASE WHEN ft.FolderId IS NULL THEN 0 ELSE 1 END AS Selected
        FROM Tags t
        LEFT JOIN FolderTags ft ON ft.TagId = t.Id AND ft.FolderId = @FolderId
        ORDER BY t.Name;
      `);
    const rows = r.recordset.map(rw => ({ ...rw, Selected: !!rw.Selected }));
    res.json(rows);
  } catch (err) {
    console.error("GET /api/folder/:id/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/folder/:id/tags", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    // remove existing, then insert provided
    await pool
      .request()
      .input("FolderId", sql.Int, id)
      .query(`DELETE FROM FolderTags WHERE FolderId=@FolderId;`);

    if (tagIds.length > 0) {
      for (const tid of tagIds) {
        await pool
          .request()
          .input("FolderId", sql.Int, id)
          .input("TagId", sql.Int, tid)
          .query("INSERT INTO FolderTags (FolderId, TagId) VALUES (@FolderId, @TagId);");
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/folder/:id/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   FILE TAGS: get tags with selection and set tags for a file
============================================================ */
app.get("/api/file/:id/tags", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("FileId", sql.Int, id)
      .query(`
        SELECT
          t.Id, t.Name, t.Slug, t.ColorHex,
          CASE WHEN ft.FileId IS NULL THEN 0 ELSE 1 END AS Selected
        FROM Tags t
        LEFT JOIN FileTags ft ON ft.TagId = t.Id AND ft.FileId = @FileId
        ORDER BY t.Name;
      `);
    const rows = r.recordset.map(rw => ({ ...rw, Selected: !!rw.Selected }));
    res.json(rows);
  } catch (err) {
    console.error("GET /api/file/:id/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/file/:id/tags", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds.map(x => parseInt(x, 10)).filter(Boolean) : [];
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    // remove existing, then insert provided
    await pool
      .request()
      .input("FileId", sql.Int, id)
      .query(`DELETE FROM FileTags WHERE FileId=@FileId;`);

    if (tagIds.length > 0) {
      for (const tid of tagIds) {
        await pool
          .request()
          .input("FileId", sql.Int, id)
          .input("TagId", sql.Int, tid)
          .query("INSERT INTO FileTags (FileId, TagId) VALUES (@FileId, @TagId);");
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/file/:id/tags error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   DOWNLOAD / DELETE / RENAME FILE
============================================================ */

// Download a file by id (streams from disk)
app.get("/download/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.sendStatus(400);

    const pool = await getPool();
    const r = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Files WHERE Id=@Id");
    if (!r.recordset.length) return res.sendStatus(404);

    const file = r.recordset[0];
    if (!file.StoragePath || !fs.existsSync(file.StoragePath)) return res.sendStatus(404);

    const mime = file.MimeType || "application/octet-stream";
    const safeName = String(file.Name || "download").replace(/[\r\n"]/g, "_").trim();
    const headerName = encodeURIComponent(safeName);

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${headerName}"`);

    const stream = fs.createReadStream(file.StoragePath);
    stream.on("error", (err) => {
      console.error("stream error", err);
      try { res.status(500).end(); } catch (e) {}
    });
    stream.pipe(res);
  } catch (err) {
    console.error("GET /download/:id error", err);
    res.status(500).end();
  }
});

// Delete file (DB + schedule disk deletion)
app.delete("/api/file/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();
    const r = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Files WHERE Id=@Id");
    if (!r.recordset.length) return res.status(404).json({ error: "File not found" });

    const file = r.recordset[0];

    // remove DB entries
    await pool.request().input("FileId", sql.Int, id).query(`
      DELETE FROM FileTags WHERE FileId=@FileId;
      DELETE FROM Files WHERE Id=@FileId;
    `);

    // schedule disk delete
    jobQueue.enqueue(async () => {
      try {
        if (file.StoragePath && fs.existsSync(file.StoragePath)) {
          await fsPromises.unlink(file.StoragePath);
        }
      } catch (err) {
        console.error("Cleanup error deleting file", file.StoragePath, err);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/file/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

// PATCH to rename file (updates DB Name; tries to rename file on disk)
app.patch("/api/file/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });

  try {
    const pool = await getPool();
    const r = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Files WHERE Id=@Id");
    if (!r.recordset.length) return res.status(404).json({ error: "File not found" });

    const file = r.recordset[0];
    const oldName = file.Name || "";
    const oldPath = file.StoragePath || "";

    // Update DB name
    await pool.request().input("Id", sql.Int, id).input("Name", sql.NVarChar(255), name.trim()).query(`
      UPDATE Files SET Name=@Name WHERE Id=@Id;
    `);

    // Attempt disk rename if storage path exists and extension preserved
    try {
      if (oldPath && fs.existsSync(oldPath)) {
        const dir = path.dirname(oldPath);
        // preserve extension if any
        const ext = path.extname(oldName) || "";
        const newFileName = name.trim() + ext;
        const newPath = path.join(dir, newFileName);
        // avoid overwriting existing file silently
        if (!fs.existsSync(newPath)) {
          await fsPromises.rename(oldPath, newPath);
          // update StoragePath in DB to new path
          await pool.request().input("Id", sql.Int, id).input("StoragePath", sql.NVarChar(1000), newPath.replace(/\\/g, "/")).query(`
            UPDATE Files SET StoragePath=@StoragePath WHERE Id=@Id;
          `);
        } else {
          console.warn("Target file exists, skipped disk rename:", newPath);
        }
      }
    } catch (err) {
      console.error("Failed to rename file on disk:", oldPath, err);
    }

    const updated = await pool.request().input("Id", sql.Int, id).query("SELECT * FROM Files WHERE Id=@Id");
    res.json(updated.recordset[0]);
  } catch (err) {
    console.error("PATCH /api/file/:id error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* ============================================================
   START SERVER
============================================================ */
app.listen(PORT, async () => {
  await ensureRootFolder();
  await ensureFolderTagsTable();
  console.log("===========================================");
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("===========================================");
});
