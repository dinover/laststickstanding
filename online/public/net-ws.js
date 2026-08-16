/* Transporte WebSocket para el build online (servidor autoritativo).

   Mismo espíritu que net-steam.js: un módulo que solo habla de plumbing de red y nunca toca
   estado de juego. Pero acá NO hay NetHost/NetGuest — con el servidor simulando, todos los
   clientes son iguales: mandan input y renderizan snapshots. Lo único que distingue a uno es
   ser "owner" de la sala (puede empezar la partida), y eso lo decide el servidor, no el cliente.

   No hay PeerJS, ni broker público, ni STUN/TURN: una sola conexión saliente al mismo origen
   desde el que se sirvió la página. */

var Net = (function () {
  "use strict";

  var ws = null;
  var handlers = {};
  var myId = null;
  var roomCode = null;
  var ownerId = null;
  var queued = null; // acción pedida antes de que abriera el socket

  function emit(name, payload) {
    var fn = handlers[name];
    if (fn) fn(payload);
  }

  function url() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host;
  }

  function open() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket(url());

    ws.onopen = function () {
      if (queued) {
        ws.send(JSON.stringify(queued));
        queued = null;
      }
      emit("open");
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!msg || !msg.t) return;

      if (msg.t === "joined") {
        myId = msg.id;
        roomCode = msg.code;
        ownerId = msg.owner;
      } else if (msg.t === "lobby") {
        ownerId = msg.owner;
        roomCode = msg.code;
      }
      emit(msg.t, msg);
    };

    ws.onclose = function () {
      emit("close");
    };
    ws.onerror = function () {
      /* onclose siempre viene después; alcanza con manejar ahí para no mostrar dos errores. */
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else queued = obj; // se manda apenas abra
  }

  return {
    connect: open,

    create: function (nick) {
      open();
      send({ t: "create", nick: nick });
    },
    join: function (code, nick) {
      open();
      send({ t: "join", code: code, nick: nick });
    },

    sendInput: function (action, down) {
      send({ t: "input", k: action, d: down });
    },
    start: function (rounds, snail) {
      send({ t: "start", rounds: rounds, snail: snail });
    },
    again: function () {
      send({ t: "again" });
    },

    getMyId: function () {
      return myId;
    },
    getCode: function () {
      return roomCode;
    },
    isOwner: function () {
      return myId !== null && myId === ownerId;
    },

    on: function (name, fn) {
      handlers[name] = fn;
    },
  };
})();
