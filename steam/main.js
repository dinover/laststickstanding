/* Electron main process for the Steam build of Last Stick Standing.
   Owns the Steamworks session (steamworks.js) and exposes lobby/P2P networking to the
   renderer through preload.js's ipcRenderer bridge. The renderer (game.html + net-steam.js)
   never touches Steam APIs directly. */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

let steam = null;
let win = null;
const PACKET_CHANNEL = 0;

function initSteam() {
  try {
    // steamworks.js expects steam_appid.txt next to the executable (or cwd) in dev; in a
    // packaged build electron-builder ships it alongside the app.
    const steamworks = require("steamworks.js");
    steam = steamworks.init();
    console.log("Steamworks initialized:", steam.localplayer.getName());
  } catch (err) {
    console.error("Steamworks init failed — must be launched via/with Steam running.", err);
    steam = null;
  }
  return steam;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1024, height: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "game.html"));
}

app.whenReady().then(() => {
  initSteam();
  createWindow();

  if (steam) {
    // Someone accepted a Steam invite / clicked "join game" from a friend's profile while
    // this instance was already running — forward the lobby id so the renderer can auto-join.
    steam.callback.register(steam.callback.SteamCallback.GameLobbyJoinRequested, (result) => {
      if (win) win.webContents.send("steam:joinRequested", result.lobbySteamId.toString());
    });

    // Poll Steamworks callbacks — steamworks.js needs its native event loop pumped regularly.
    setInterval(() => { try { steam.runCallbacks(); } catch (e) {} }, 33);

    // Someone launched the game directly from a Steam invite link (game wasn't running yet).
    try {
      const cmdLine = process.argv.join(" ");
      const m = cmdLine.match(/\+connect_lobby\s+(\d+)/);
      if (m) win.webContents.once("did-finish-load", () => win.webContents.send("steam:joinRequested", m[1]));
    } catch (e) {}
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------------------------------------------------------------- lobby / P2P IPC */
function requireSteam() {
  if (!steam) throw new Error("Steam no está disponible (¿el cliente de Steam está abierto?)");
  return steam;
}

ipcMain.handle("steam:createLobby", async () => {
  const s = requireSteam();
  const lobbyId = await s.matchmaking.createLobby(s.matchmaking.LobbyType.FriendsOnly, 8);
  watchLobby(lobbyId);
  return lobbyId.toString();
});

ipcMain.handle("steam:joinLobby", async (_e, lobbyIdStr) => {
  const s = requireSteam();
  const lobbyId = BigInt(lobbyIdStr);
  await s.matchmaking.joinLobby(lobbyId);
  watchLobby(lobbyId);
  return lobbyId.toString();
});

ipcMain.handle("steam:leaveLobby", async (_e, lobbyIdStr) => {
  const s = requireSteam();
  s.matchmaking.leaveLobby(BigInt(lobbyIdStr));
  return true;
});

ipcMain.handle("steam:openInviteOverlay", async (_e, lobbyIdStr) => {
  const s = requireSteam();
  s.overlay.activateInviteDialog(BigInt(lobbyIdStr));
  return true;
});

ipcMain.handle("steam:getPersonaName", async () => {
  const s = requireSteam();
  return s.localplayer.getName();
});

ipcMain.handle("steam:getLobbyOwner", async (_e, lobbyIdStr) => {
  const s = requireSteam();
  return s.matchmaking.getLobbyOwner(BigInt(lobbyIdStr)).steamId64.toString();
});

ipcMain.handle("steam:getSteamId", async () => {
  const s = requireSteam();
  return s.localplayer.getSteamId().steamId64.toString();
});

ipcMain.handle("steam:sendToAll", async (_e, lobbyIdStr, packet) => {
  const s = requireSteam();
  const lobbyId = BigInt(lobbyIdStr);
  const buf = Buffer.from(JSON.stringify(packet), "utf8");
  const members = s.matchmaking.getLobbyMembers(lobbyId);
  const meId = s.localplayer.getSteamId().steamId64;
  members.forEach((m) => {
    if (m.steamId64 === meId) return;
    try { s.networking.sendP2PPacket(m.steamId64, buf, PACKET_CHANNEL); } catch (e) {}
  });
  return true;
});

ipcMain.handle("steam:sendTo", async (_e, steamIdStr, packet) => {
  const s = requireSteam();
  const buf = Buffer.from(JSON.stringify(packet), "utf8");
  try { s.networking.sendP2PPacket(BigInt(steamIdStr), buf, PACKET_CHANNEL); } catch (e) {}
  return true;
});

const watchedLobbies = new Set();
function watchLobby(lobbyId) {
  const key = lobbyId.toString();
  if (watchedLobbies.has(key)) return;
  watchedLobbies.add(key);

  // Poll membership + incoming P2P packets. steamworks.js doesn't push a JS event for either,
  // so a short interval per lobby is the simplest reliable option at this scale (a handful of
  // players, one lobby per host process).
  let lastMembers = [];
  const iv = setInterval(() => {
    if (!steam) return;
    try {
      const members = steam.matchmaking.getLobbyMembers(lobbyId).map((m) => m.steamId64.toString());
      if (members.length !== lastMembers.length || members.some((m, i) => m !== lastMembers[i])) {
        lastMembers = members;
        if (win) win.webContents.send("steam:lobbyMembersChanged", members);
      }

      let packet;
      while ((packet = steam.networking.isP2PPacketAvailable(PACKET_CHANNEL))) {
        const data = steam.networking.readP2PPacket(packet.size, PACKET_CHANNEL);
        if (!data) break;
        try {
          const parsed = JSON.parse(Buffer.from(data.data).toString("utf8"));
          if (win) win.webContents.send("steam:p2pData", data.steamId.steamId64.toString(), parsed);
        } catch (e) {}
      }
    } catch (e) {
      clearInterval(iv);
      watchedLobbies.delete(key);
    }
  }, 33);
}
