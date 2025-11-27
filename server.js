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
   LIST FILES (with auto cleanup if missing on disk)
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

    // Get folder path for discovery scan
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

    // Run file discovery in background (async, don't wait)
    jobQueue.enqueue(async () => {
      await discoverAndAddNewFiles(folderId, folderPath);
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
   UPLOAD FILES / FOLDERS (Busboy, streaming, temp files)
============================================================ */
app.post("/api/upload", (req, res) => {
  console.log("UPLOAD START");
  const busboy = createBusboy(req);

  const fields = {
    folderId: null,
    tagSlugs: [],
    newTags: [],
  };

  const uploaded = [];

  busboy.on("field", (name, value) => {
    if (name === "folderId") {
      const v = (value || "").trim();
      fields.folderId = v ? parseInt(v, 10) : null;
    } else if (name === "tagSlugs") {
      fields.tagSlugs = (value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (name === "newTags") {
      fields.newTags = (value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  });

  busboy.on("file", (fieldname, file, info, encoding, mimeType) => {
    let filename;
    let mime;

    if (typeof info === "string") {
      // old Busboy: (field, file, filename, encoding, mimetype)
      filename = info;
      mime = mimeType || "application/octet-stream";
    } else if (info && typeof info === "object") {
      // new Busboy: (field, file, info)
      filename = info.filename;
      mime = info.mimeType || info.mimetype || "application/octet-stream";
    } else {
      filename = "unnamed";
      mime = "application/octet-stream";
    }

    if (!filename) {
      file.resume();
      return;
    }

    const parts = String(filename).split(/[\\/]/);
    const baseName = parts.pop();
    const subDirs = parts.filter(Boolean);
    const safeName = baseName.replace(/[^\w.\-]+/g, "_");

    const idPart = Date.now() + "-" + Math.random().toString(36).slice(2);
    const diskPath = path.join(UPLOAD_ROOT, `${idPart}_${safeName}`);

    const writeStream = fs.createWriteStream(diskPath);
    let size = 0;

    file.on("data", (chunk) => {
      size += chunk.length;
    });

    file.pipe(writeStream);

    const donePromise = new Promise((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", (err) => reject(err));
    });

    uploaded.push({
      diskPath,
      safeName,
      mime,
      subDirs,
      sizeRef: () => size,
      donePromise,
    });
  });

  let finishedCalled = false;

  async function handleFinished() {
    if (finishedCalled) return;
    finishedCalled = true;

    try {
      // Wait until all temp files are fully written
      await Promise.all(uploaded.map((u) => u.donePromise));

      if (!uploaded.length) {
        console.log("UPLOAD FINISH, no files");
        return res.status(400).json({ ok: false, error: "No files uploaded" });
      }

      console.log("UPLOAD FINISH, files seen:", uploaded.length);

      const pool = await getPool();

      // locate base folder
      let baseFolderId;
      let baseFullPath;

      if (fields.folderId) {
        const r = await pool
          .request()
          .input("Id", sql.Int, fields.folderId)
          .query("SELECT * FROM Folders WHERE Id=@Id");

        if (!r.recordset.length) {
          return res
            .status(400)
            .json({ ok: false, error: "Target folder not found" });
        }

        baseFolderId = r.recordset[0].Id;
        baseFullPath = r.recordset[0].FullPath;
      } else {
        const root = await ensureRootFolder();
        baseFolderId = root.Id;
        baseFullPath = root.FullPath;
      }

      // tags
      const tagsFinal = [];

      // new tags
      for (const name of fields.newTags) {
        const slug = name.toLowerCase().replace(/\s+/g, "-");

        const exists = await pool
          .request()
          .input("Slug", sql.NVarChar(100), slug)
          .query("SELECT Id FROM Tags WHERE Slug=@Slug");

        if (exists.recordset.length) {
          tagsFinal.push(exists.recordset[0].Id);
        } else {
          const color =
            "#" +
            Math.floor(Math.random() * 16777215)
              .toString(16)
              .padStart(6, "0");
          const ins = await pool
            .request()
            .input("Name", sql.NVarChar(100), name)
            .input("Slug", sql.NVarChar(100), slug)
            .input("ColorHex", sql.NVarChar(7), color)
            .query(`
              INSERT INTO Tags (Name, Slug, ColorHex)
              OUTPUT INSERTED.Id
              VALUES (@Name, @Slug, @ColorHex);
            `);
          tagsFinal.push(ins.recordset[0].Id);
        }
      }

      // existing tags by slug
      for (const slug of fields.tagSlugs) {
        const r = await pool
          .request()
          .input("Slug", sql.NVarChar(100), slug)
          .query("SELECT Id FROM Tags WHERE Slug=@Slug");
        if (r.recordset.length) tagsFinal.push(r.recordset[0].Id);
      }

      // helper to ensure folder chain under base folder
      async function ensureFolderChain(baseId, basePath, subDirs) {
        let currentId = baseId;
        let currentPath = basePath;

        for (const segment of subDirs) {
          if (!segment) continue;
          const name = segment.replace(/[\/\\]/g, "");

          const exist = await pool
            .request()
            .input("ParentId", sql.Int, currentId)
            .input("Name", sql.NVarChar(255), name)
            .query(
              "SELECT * FROM Folders WHERE ParentId=@ParentId AND Name=@Name"
            );

          if (exist.recordset.length) {
            currentId = exist.recordset[0].Id;
            currentPath = exist.recordset[0].FullPath;
          } else {
            const newPath = `${currentPath}/${name}`;
            await ensureDiskFolder(newPath);

            const ins = await pool
              .request()
              .input("Name", sql.NVarChar(255), name)
              .input("ParentId", sql.Int, currentId)
              .input("FullPath", sql.NVarChar(1000), newPath)
              .query(`
                INSERT INTO Folders (Name, ParentId, FullPath)
                OUTPUT INSERTED.*
                VALUES (@Name, @ParentId, @FullPath);
              `);

            currentId = ins.recordset[0].Id;
            currentPath = ins.recordset[0].FullPath;
          }
        }

        return { folderId: currentId, fullPath: currentPath };
      }

      const inserted = [];

      for (const up of uploaded) {
        const chain = await ensureFolderChain(
          baseFolderId,
          baseFullPath,
          up.subDirs
        );

        const targetDir = await ensureDiskFolder(chain.fullPath);
        const idPart = Date.now() + "-" + Math.random().toString(36).slice(2);
        const finalName = `${idPart}_${up.safeName}`;
        const diskPath = path.join(targetDir, finalName);

        // async rename instead of renameSync
        await fsPromises.rename(up.diskPath, diskPath);

        const size = up.sizeRef();

        const insF = await pool
          .request()
          .input("FolderId", sql.Int, chain.folderId)
          .input("Name", sql.NVarChar(255), up.safeName)
          .input(
            "StoragePath",
            sql.NVarChar(1000),
            diskPath.replace(/\\/g, "/")
          )
          .input("SizeBytes", sql.BigInt, size)
          .input("MimeType", sql.NVarChar(255), up.mime || null)
          .query(`
            INSERT INTO Files (FolderId, Name, StoragePath, SizeBytes, MimeType)
            OUTPUT INSERTED.*
            VALUES (@FolderId, @Name, @StoragePath, @SizeBytes, @MimeType);
          `);

        const row = insF.recordset[0];
        inserted.push(row);

        // Replace TVP batch insert with parameterized inserts (avoid DB user-defined type)
        if (tagsFinal.length > 0) {
          for (const tid of tagsFinal) {
            await pool
              .request()
              .input("FileId", sql.Int, row.Id)
              .input("TagId", sql.Int, tid)
              .query("INSERT INTO FileTags (FileId, TagId) VALUES (@FileId, @TagId);");
          }
        }
      }

      res.json({ ok: true, files: inserted });
    } catch (err) {
      console.error("UPLOAD ERROR", err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Upload failed" });
      }
    } finally {
      // cleanup temp files asynchronously in background
      jobQueue.enqueue(async () => {
        for (const up of uploaded) {
          try {
            await fsPromises.unlink(up.diskPath);
          } catch (e) {
            // ignore if already deleted
          }
        }
      });
    }
  }

  busboy.on("error", (err) => {
    console.error("BUSBOY ERROR", err);
    if (!finishedCalled && !res.headersSent) {
      finishedCalled = true;
      res.status(500).json({ ok: false, error: "Upload failed (stream error)" });
    }
  });

  busboy.on("finish", handleFinished);
  busboy.on("close", handleFinished);

  req.pipe(busboy);
});

/* ============================================================
   DOWNLOAD / DELETE FILE
============================================================ */
app.get("/download/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Files WHERE Id=@Id");

    if (!r.recordset.length) return res.sendStatus(404);

    const file = r.recordset[0];
    if (!fs.existsSync(file.StoragePath)) return res.sendStatus(404);

    const mime = file.MimeType || "application/octet-stream";
    const safeName = String(file.Name || "download")
      .replace(/[\r\n"]/g, "_")
      .trim();
    const headerName = encodeURIComponent(safeName);

    res.setHeader("Content-Type", mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${headerName}"`
    );

    fs.createReadStream(file.StoragePath).pipe(res);
  } catch (e) {
    console.error("GET /download/:id error", e);
    res.status(500).end();
  }
});

app.delete("/api/file/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .query("SELECT * FROM Files WHERE Id=@Id");

    if (!r.recordset.length) {
      return res.status(404).json({ error: "File not found" });
    }

    const file = r.recordset[0];

    await pool
      .request()
      .input("FileId", sql.Int, id)
      .query(`
        DELETE FROM FileTags WHERE FileId=@FileId;
        DELETE FROM Files WHERE Id=@FileId;
      `);

    // async delete file in background
    jobQueue.enqueue(async () => {
      try {
        if (fs.existsSync(file.StoragePath)) {
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

// PATCH to rename file
app.patch("/api/file/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body || {};
  if (!id) return res.status(400).json({ error: "Invalid id" });
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });

  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("Id", sql.Int, id)
      .input("Name", sql.NVarChar(255), name.trim())
      .query(`
        UPDATE Files SET Name=@Name WHERE Id=@Id;
        SELECT * FROM Files WHERE Id=@Id;
      `);

    if (!r.recordset.length) return res.status(404).json({ error: "File not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    console.error("PATCH /api/file/:id error", err);
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
  const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds.map(x => parseInt(x,10)).filter(Boolean) : [];
  if (!id) return res.status(400).json({ error: "Invalid id" });
  try {
    const pool = await getPool();
    // remove existing, then batch insert provided
    await pool
      .request()
      .input("FileId", sql.Int, id)
      .query(`DELETE FROM FileTags WHERE FileId=@FileId;`);

    // Avoid using TVP (FileTagList); insert parameterized rows instead
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
   ROOT
============================================================ */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
