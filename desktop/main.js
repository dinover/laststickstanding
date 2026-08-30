/* Electron main process for the desktop build of Last Stick Standing. No local sim, no P2P,
   no Steamworks — just a window pointed at the same authoritative WebSocket server the browser
   build uses (games/laststickstanding/online). net-ws.js builds its WS url from location.host,
   so loading the server's own page here gets a fully working game for free. */
const { app, BrowserWindow } = require("electron");
const path = require("path");

const SERVER_URL = process.env.LSS_SERVER_URL || "https://147-15-101-103.nip.io";

function createWindow() {
  var win = new BrowserWindow({
    width: 1024, height: 640,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "LSS icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(SERVER_URL);
  win.webContents.on("did-fail-load", function () {
    win.loadFile(path.join(__dirname, "offline.html"));
  });
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
