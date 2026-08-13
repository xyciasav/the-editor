const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DARKTABLE = "C:\\Program Files\\darktable\\bin\\darktable-cli.exe";
const PHOTO_EXTENSIONS = new Set([".arw", ".cr2", ".cr3", ".dng", ".nef", ".orf", ".raf", ".rw2", ".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
