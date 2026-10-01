const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("easyreadDesktop", {
  isElectron: true,
  platform: process.platform,
});
