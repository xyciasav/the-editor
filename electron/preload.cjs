const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("editor", {
  darktableStatus: () => ipcRenderer.invoke("darktable:status"),
  chooseShoot: () => ipcRenderer.invoke("shoot:choose"),
  getThumbnail: (filePath) => ipcRenderer.invoke("thumbnail:get", filePath),
  createShoot: (shoot) => ipcRenderer.invoke("shoot:create", shoot),
  saveRetouchPlan: (plan) => ipcRenderer.invoke("retouch:save", plan),
  healPreview: (payload) => ipcRenderer.invoke("retouch:heal-preview", payload),
  chooseWatermark: () => ipcRenderer.invoke("watermark:choose"),
  chooseExportFolder: () => ipcRenderer.invoke("export:choose-folder"),
  startExport: (payload) => ipcRenderer.invoke("export:start", payload),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("job:progress", listener);
    return () => ipcRenderer.removeListener("job:progress", listener);
  },
});
