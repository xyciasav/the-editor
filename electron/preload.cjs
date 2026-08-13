const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("editor", {
  darktableStatus: () => ipcRenderer.invoke("darktable:status"),
  chooseShoot: () => ipcRenderer.invoke("shoot:choose")
});
