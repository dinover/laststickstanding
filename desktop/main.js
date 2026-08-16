/* Electron main process for the desktop/PeerJS build of Last Stick Standing. No Steamworks,
   no store account needed — just a plain window pointed at game.html, which does its own
   WebRTC room plumbing via net.js/PeerJS exactly like the browser index.html does. Requires
   an internet connection (PeerJS's public broker + WebRTC), but nothing else. */
const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  var win = new BrowserWindow({
    width: 1024, height: 640,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "game.html"));
}

app.whenReady().then(function () {
  createWindow();
  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});
