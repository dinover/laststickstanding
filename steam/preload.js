/* Electron preload — the only bridge between the sandboxed renderer (game.html) and the
   Steamworks calls that live in main.js. Mirrors exactly what net-steam.js needs, nothing more:
   no direct Node/Steam API surface ever reaches game code. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("steamBridge", {
  createLobby: () => ipcRenderer.invoke("steam:createLobby"),
  joinLobby: (lobbyId) => ipcRenderer.invoke("steam:joinLobby", lobbyId),
  leaveLobby: (lobbyId) => ipcRenderer.invoke("steam:leaveLobby", lobbyId),
  sendToAll: (lobbyId, packet) => ipcRenderer.invoke("steam:sendToAll", lobbyId, packet),
  sendTo: (steamId, packet) => ipcRenderer.invoke("steam:sendTo", steamId, packet),
  openInviteOverlay: (lobbyId) => ipcRenderer.invoke("steam:openInviteOverlay", lobbyId),
  getLobbyOwner: (lobbyId) => ipcRenderer.invoke("steam:getLobbyOwner", lobbyId),
  getPersonaName: () => ipcRenderer.invoke("steam:getPersonaName"),
  getSteamId: () => ipcRenderer.invoke("steam:getSteamId"),

  onP2PData: (fn) => ipcRenderer.on("steam:p2pData", (_e, senderId, packet) => fn(senderId, packet)),
  onLobbyMembersChanged: (fn) => ipcRenderer.on("steam:lobbyMembersChanged", (_e, members) => fn(members)),
  onJoinRequested: (fn) => ipcRenderer.on("steam:joinRequested", (_e, lobbyId) => fn(lobbyId)),
  onLobbyClosed: (fn) => ipcRenderer.on("steam:lobbyClosed", () => fn()),
});
