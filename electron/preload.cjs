const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("editor", {
  darktableStatus: () => ipcRenderer.invoke("darktable:status"),
  chooseShoot: () => ipcRenderer.invoke("shoot:choose"),
  createShoot: (shoot) => ipcRenderer.invoke("shoot:create", shoot),
  saveRetouchPlan: (plan) => ipcRenderer.invoke("retouch:save", plan)
});
