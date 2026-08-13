const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DARKTABLE = "C:\\Program Files\\darktable\\bin\\darktable-cli.exe";
const PHOTO_EXTENSIONS = new Set([".arw", ".cr2", ".cr3", ".dng", ".nef", ".orf", ".raf", ".rw2", ".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

function runDarktable(args) {
  return new Promise((resolve, reject) => {
    execFile(DARKTABLE, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve({ stdout, stderr });
    });
  });
}

function darktablePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 700,
    backgroundColor: "#11110f", titleBarStyle: "hiddenInset",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false }
  });
  if (!app.isPackaged) win.loadURL("http://localhost:5173");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

ipcMain.handle("darktable:status", () => new Promise((resolve) => {
  if (!fs.existsSync(DARKTABLE)) return resolve({ available: false, path: DARKTABLE });
  execFile(DARKTABLE, ["--version"], { windowsHide: true }, (error, stdout, stderr) => {
    const text = `${stdout || ""} ${stderr || ""}`;
    resolve({ available: !error, path: DARKTABLE, version: text.match(/darktable\s+([\d.]+)/i)?.[1] || "Installed" });
  });
}));

ipcMain.handle("shoot:choose", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose the folder containing this shoot" });
  if (result.canceled) return null;
  const folder = result.filePaths[0];
  const files = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PHOTO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name), type: path.extname(entry.name).slice(1).toUpperCase() }));
  return { folder, files };
});

ipcMain.handle("shoot:create", async (_event, shoot) => {
  if (!fs.existsSync(DARKTABLE)) throw new Error("Darktable CLI was not found.");
  if (!shoot?.folder || !Array.isArray(shoot.files)) throw new Error("The selected shoot is invalid.");
  const normalizedSource = path.resolve(shoot.folder).toLowerCase();
  const projectKey = crypto.createHash("sha256").update(normalizedSource).digest("hex").slice(0, 32);
  const projectDir = path.join(app.getPath("userData"), "shoots", projectKey);
  const previewDir = path.join(projectDir, "previews");
  const stagingDir = path.join(projectDir, "staging");
  const cacheDir = path.join(projectDir, "darktable-cache");
  const configDir = path.join(projectDir, "darktable-config");
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const previews = [];
  const failures = [];

  for (const [index, photo] of shoot.files.slice(0, 40).entries()) {
    const outputStem = path.join(previewDir, String(index + 1).padStart(4, "0"));
    const output = `${outputStem}.jpg`;
    const stagedInput = path.join(stagingDir, `${String(index + 1).padStart(4, "0")}${path.extname(photo.name).toLowerCase()}`);
    try {
      if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(photo.path).mtimeMs) {
        fs.copyFileSync(photo.path, stagedInput);
        const result = await runDarktable([darktablePath(stagedInput), darktablePath(outputStem), "--width", "1600", "--height", "1600", "--hq", "true", "--out-ext", "jpg", "--apply-custom-presets", "false", "--core", "--cachedir", darktablePath(cacheDir), "--configdir", darktablePath(configDir)]);
        if (!fs.existsSync(output)) {
          const diagnostic = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
          throw new Error(diagnostic || "Darktable finished without creating an output file.");
        }
      }
      const data = fs.readFileSync(output).toString("base64");
      previews.push({ ...photo, preview: `data:image/jpeg;base64,${data}` });
    } catch (error) {
      failures.push({ name: photo.name, message: error.message });
    } finally {
      try { if (fs.existsSync(stagedInput)) fs.unlinkSync(stagedInput); } catch {}
    }
  }
  const manifest = { sourceFolder: shoot.folder, createdAt: new Date().toISOString(), photoCount: shoot.files.length };
  fs.writeFileSync(path.join(projectDir, "shoot.json"), JSON.stringify(manifest, null, 2));
  return { projectDir, previews, failures, total: shoot.files.length };
});

ipcMain.handle("retouch:save", async (_event, payload) => {
  if (!payload?.projectDir || !payload.projectDir.startsWith(app.getPath("userData"))) throw new Error("Invalid project location.");
  const retouchFile = path.join(payload.projectDir, "retouch-plan.json");
  const plan = { version: 1, updatedAt: new Date().toISOString(), strength: payload.strength, operations: payload.operations };
  fs.writeFileSync(retouchFile, JSON.stringify(plan, null, 2));
  return { path: retouchFile, updatedAt: plan.updatedAt };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
