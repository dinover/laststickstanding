/* Steamworks-backed replacement for net.js's PeerJS transport. Deliberately mirrors net.js's
   public shape (NetHost/NetGuest, same method names) so game.html can wire NetHost/NetGuest
   exactly like index.html already does — only the transport underneath changes, from WebRTC
   room codes to a Steam lobby + P2P packets via window.steamBridge (see preload.js/main.js). */

var NetHost = (function () {
  var lobbyId = null;
  var guestBySteamId = {}, steamIdByGuest = {}, nextGuestId = 1;
  var handlers = {};

  function create(onReady, onError) {
    if (!window.steamBridge) { onError && onError("no-steam-bridge"); return; }
    window.steamBridge.createLobby().then(function (id) {
      lobbyId = id;
      wireIncoming();
      onReady(id);
    }).catch(function (err) {
      onError && onError((err && err.message) || String(err));
    });
  }

  function wireIncoming() {
    window.steamBridge.onP2PData(function (senderSteamId, data) {
      if (!data) return;
      var guestId = guestBySteamId[senderSteamId];
      if (data.t === "hello") {
        if (!guestId) {
          guestId = nextGuestId++;
          guestBySteamId[senderSteamId] = guestId;
          steamIdByGuest[guestId] = senderSteamId;
        }
        handlers.join && handlers.join(guestId, data.nickname || ("Jugador " + guestId));
        return;
      }
      if (!guestId) return; // packet from someone who never said hello — ignore
      handlers.input && handlers.input(guestId, data);
    });
    window.steamBridge.onLobbyMembersChanged(function (members) {
      var stillHere = {};
      members.forEach(function (m) { stillHere[m] = true; });
      Object.keys(guestBySteamId).forEach(function (steamId) {
        if (!stillHere[steamId]) {
          var guestId = guestBySteamId[steamId];
          delete guestBySteamId[steamId];
          delete steamIdByGuest[guestId];
          handlers.leave && handlers.leave(guestId);
        }
      });
    });
  }

  function broadcast(state) {
    if (!lobbyId) return;
    Object.keys(steamIdByGuest).forEach(function (guestId) {
      var steamId = steamIdByGuest[guestId];
      var payload = Object.assign({}, state, { yourId: Number(guestId) });
      window.steamBridge.sendTo(steamId, payload);
    });
  }

  return {
    create: create,
    broadcast: broadcast,
    getCode: function () { return lobbyId; },
    onGuestJoin: function (fn) { handlers.join = fn; },
    onGuestInput: function (fn) { handlers.input = fn; },
    onGuestLeave: function (fn) { handlers.leave = fn; },
  };
})();

var NetGuest = (function () {
  var lobbyId = null, ownerSteamId = null;
  var handlers = {};
  var joined = false;

  function join(code, nickname) {
    if (!window.steamBridge) { handlers.error && handlers.error("no-steam-bridge"); return; }
    window.steamBridge.joinLobby(code).then(function (id) {
      lobbyId = id;
      return window.steamBridge.getLobbyOwner(id);
    }).then(function (owner) {
      ownerSteamId = owner;
      window.steamBridge.onP2PData(function (senderSteamId, data) {
        if (senderSteamId !== ownerSteamId || !data) return;
        if (!joined) { joined = true; handlers.open && handlers.open(); }
        handlers.state && handlers.state(data);
      });
      window.steamBridge.onLobbyClosed(function () { handlers.close && handlers.close(); });
      window.steamBridge.sendTo(ownerSteamId, { t: "hello", nickname: nickname });
    }).catch(function (err) {
      handlers.error && handlers.error((err && err.message) || String(err));
    });
  }

  function sendInput(data) {
    if (ownerSteamId) window.steamBridge.sendTo(ownerSteamId, data);
  }

  return {
    join: join,
    sendInput: sendInput,
    onOpen: function (fn) { handlers.open = fn; },
    onState: function (fn) { handlers.state = fn; },
    onClose: function (fn) { handlers.close = fn; },
    onError: function (fn) { handlers.error = fn; },
  };
})();
