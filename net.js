/* Minimal PeerJS wrapper for the standalone online mode (index.html). Handles only the
   WebRTC room plumbing — room codes, connecting, sending/receiving — never touches game
   state. Loaded after the PeerJS CDN script. Fully independent from sdk.js/FreeConsole;
   nothing here is shared with screen.html or controller.html. */

var ROOM_PREFIX = "lss-";

/* WebRTC needs to find a path between the two computers. Plain STUN (the PeerJS default)
   only works when at least one side has a NAT simple enough to be traversed directly — most
   home routers, but not symmetric NAT (common on 4G/CGNAT and some corporate/campus
   networks). Without a TURN relay as fallback, two players who both sit behind that kind of
   NAT can complete the PeerJS *signaling* handshake (so the room code "works" and the
   connection object even reports "open") while the actual media/data path never comes up —
   which reads as exactly "no one sees each other join, and starting the match leaves the
   guest stuck on the waiting screen forever". Adding a TURN relay (used only when a direct
   path fails, so this changes nothing for connections that already worked) fixes that class
   of failure. Credentials are the openrelay.metered.ca public test project — free, meant for
   exactly this kind of small non-commercial use. */
var ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

function randomRoomCode(len) {
  var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I, easy to read aloud
  var s = "";
  for (var i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* Room creator. Becomes the match's simulation authority (see index.html). */
var NetHost = (function () {
  var peer = null, conns = {}, nextGuestId = 1, code = null;
  var handlers = {};
  var stats = { sent: 0, failed: 0, lastError: "" }; // surfaced by getStats() — see game.html's debug line

  function create(onReady, onError) {
    attempt(0, onReady, onError);
  }

  function attempt(tries, onReady, onError) {
    if (tries > 6) { onError && onError("no-code"); return; }
    var c = randomRoomCode(4);
    var p = new Peer(ROOM_PREFIX + c, { config: ICE_CONFIG });
    p.on("open", function () {
      peer = p; code = c;
      peer.on("connection", onConnection);
      onReady(c);
    });
    p.on("error", function (err) {
      var type = (err && err.type) || String(err);
      if (type === "unavailable-id") { p.destroy(); attempt(tries + 1, onReady, onError); }
      else onError && onError(type);
    });
  }

  function onConnection(conn) {
    var guestId = nextGuestId++;
    conns[guestId] = conn;
    conn.on("data", function (data) {
      if (data && data.t === "hello") {
        handlers.join && handlers.join(guestId, data.nickname || ("Jugador " + guestId));
      } else {
        handlers.input && handlers.input(guestId, data);
      }
    });
    var drop = function () { delete conns[guestId]; handlers.leave && handlers.leave(guestId); };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  function broadcast(state) {
    for (var id in conns) {
      if (!conns[id].open) continue;
      state.yourId = Number(id); // stamped per-recipient so each guest knows which id is "them"
      // A single guest with a wedged/half-open channel throwing here (BinaryPack can throw
      // synchronously on a send it can't serialize/deliver) must not stop the broadcast loop
      // for everyone else — and critically, must not bubble up into the caller's rAF frame,
      // which would silently kill the whole host game loop (no more frames, no more
      // broadcasts, match frozen) since nothing after the throw ever runs.
      try { conns[id].send(state); stats.sent++; } catch (e) { stats.failed++; stats.lastError = (e && e.message) || String(e); }
    }
  }

  // Debug-only counters so the lobby UI can show "is this actually connected" instead of
  // everyone staring at a silent hang with no way to tell signaling-succeeded-but-no-data-flows
  // apart from a real crash. Never touches game state.
  function getStats() {
    var ids = Object.keys(conns);
    return {
      guestCount: ids.length,
      openCount: ids.filter(function (id) { return conns[id].open; }).length,
      sent: stats.sent,
      failed: stats.failed,
      lastError: stats.lastError,
    };
  }

  return {
    create: create,
    broadcast: broadcast,
    getCode: function () { return code; },
    getStats: getStats,
    onGuestJoin: function (fn) { handlers.join = fn; },
    onGuestInput: function (fn) { handlers.input = fn; },
    onGuestLeave: function (fn) { handlers.leave = fn; },
  };
})();

/* Room joiner. Sends input, renders whatever state the host broadcasts — no local
   simulation. */
var NetGuest = (function () {
  var peer = null, conn = null;
  var handlers = {};
  var stats = { received: 0 };

  function join(code, nickname) {
    var p = new Peer({ config: ICE_CONFIG });
    p.on("open", function () {
      peer = p;
      var c = p.connect(ROOM_PREFIX + code.toUpperCase().trim());
      conn = c;
      c.on("open", function () {
        // Sending the instant "open" fires is a known race across WebRTC stacks — the local
        // end can report the channel open a beat before it's actually ready to deliver, so
        // this first message is the one most likely to vanish silently. Re-announcing a
        // couple of times over the next few seconds costs nothing (the host handles a
        // repeated "hello" on the same connection as a harmless no-op re-add) and is what
        // saves a guest from being stuck on "esperando" forever when that race hits.
        var helloAttempts = 0;
        function sendHello() {
          if (!c.open || helloAttempts >= 4) return;
          helloAttempts++;
          c.send({ t: "hello", nickname: nickname });
        }
        sendHello();
        setTimeout(sendHello, 800);
        setTimeout(sendHello, 2000);
        setTimeout(sendHello, 4000);
        handlers.open && handlers.open();
      });
      c.on("data", function (data) { stats.received++; handlers.state && handlers.state(data); });
      c.on("close", function () { handlers.close && handlers.close(); });
      c.on("error", function (err) { handlers.error && handlers.error((err && err.type) || String(err)); });
    });
    p.on("error", function (err) { handlers.error && handlers.error((err && err.type) || String(err)); });
  }

  function sendInput(data) {
    if (conn && conn.open) conn.send(data);
  }

  function getStats() {
    return { open: !!(conn && conn.open), received: stats.received };
  }

  return {
    join: join,
    sendInput: sendInput,
    getStats: getStats,
    onOpen: function (fn) { handlers.open = fn; },
    onState: function (fn) { handlers.state = fn; },
    onClose: function (fn) { handlers.close = fn; },
    onError: function (fn) { handlers.error = fn; },
  };
})();
