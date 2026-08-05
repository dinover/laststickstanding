/* Minimal PeerJS wrapper for the standalone online mode (index.html). Handles only the
   WebRTC room plumbing — room codes, connecting, sending/receiving — never touches game
   state. Loaded after the PeerJS CDN script. Fully independent from sdk.js/FreeConsole;
   nothing here is shared with screen.html or controller.html. */

var ROOM_PREFIX = "lss-";

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

  function create(onReady, onError) {
    attempt(0, onReady, onError);
  }

  function attempt(tries, onReady, onError) {
    if (tries > 6) { onError && onError("no-code"); return; }
    var c = randomRoomCode(4);
    var p = new Peer(ROOM_PREFIX + c);
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
      conns[id].send(state);
    }
  }

  return {
    create: create,
    broadcast: broadcast,
    getCode: function () { return code; },
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

  function join(code, nickname) {
    var p = new Peer();
    p.on("open", function () {
      peer = p;
      var c = p.connect(ROOM_PREFIX + code.toUpperCase().trim());
      conn = c;
      c.on("open", function () {
        c.send({ t: "hello", nickname: nickname });
        handlers.open && handlers.open();
      });
      c.on("data", function (data) { handlers.state && handlers.state(data); });
      c.on("close", function () { handlers.close && handlers.close(); });
      c.on("error", function (err) { handlers.error && handlers.error((err && err.type) || String(err)); });
    });
    p.on("error", function (err) { handlers.error && handlers.error((err && err.type) || String(err)); });
  }

  function sendInput(data) {
    if (conn && conn.open) conn.send(data);
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
