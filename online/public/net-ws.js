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
  var roomMode = null; // "rounds" | "infinite", conocido recién tras "joined"/"lobby"
  var roomRounds = null;
  var queued = null; // acción pedida antes de que abriera el socket

  /* --- reconexión ---
     El servidor entrega un token al entrar; guardándolo podemos volver al MISMO slot, con el
     puntaje y el lugar en el roster intactos, en vez de que un parpadeo de wifi te deje afuera
     de la partida para siempre. Va en sessionStorage y no en localStorage a propósito: es por
     pestaña, así que dos pestañas en la misma PC (que es como se prueba esto) no se pisan el
     token entre ellas. */
  var SESSION_KEY = "lss-session";
  var token = null;
  var reconnectTimer = null;
  var reconnectTries = 0;
  var MAX_RECONNECT_TRIES = 12;
  var wantConnection = false; // false = cierre deliberado, no reintentar

  function saveSession() {
    try {
      if (token && roomCode) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: roomCode, token: token }));
    } catch (e) { /* modo incógnito o storage bloqueado: seguimos sin reconexión */ }
  }
  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (e) { return null; }
  }
  function clearSession() {
    token = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

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
    wantConnection = true;
    ws = new WebSocket(url());

    ws.onopen = function () {
      reconnectTries = 0;
      /* Si veníamos de una caída y tenemos token, lo primero es pedir volver a nuestro lugar.
         Recién si el servidor lo rechaza caemos al flujo normal de lobby. */
      var sess = loadSession();
      if (sess && sess.token) {
        ws.send(JSON.stringify({ t: "rejoin", code: sess.code, token: sess.token }));
      } else if (queued) {
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
        if (msg.token) { token = msg.token; saveSession(); }
      } else if (msg.t === "lobby") {
        ownerId = msg.owner;
        roomCode = msg.code;
        roomMode = msg.mode;
        roomRounds = msg.rounds;
      } else if (msg.t === "rejoinFailed") {
        /* La sala se cerró o ya nos soltó: limpiamos y arrancamos de cero. */
        clearSession();
        myId = null;
        roomCode = null;
        roomMode = null;
        roomRounds = null;
      }
      emit(msg.t, msg);
    };

    ws.onclose = function () {
      emit("close");
      /* Solo insistimos si estábamos en una sala: si nunca entramos a ninguna, no hay nada que
         recuperar y reintentar en loop sería ruido. */
      if (wantConnection && token) scheduleReconnect();
    };
    ws.onerror = function () {
      /* onclose siempre viene después; alcanza con manejar ahí para no mostrar dos errores. */
    };
  }

  /* Backoff creciente con techo: reintenta rápido al principio (la mayoría de los cortes duran
     un par de segundos) y después se espacia para no martillar un servidor que está caído. */
  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectTries >= MAX_RECONNECT_TRIES) {
      emit("reconnectGaveUp");
      return;
    }
    var delay = Math.min(4000, 300 * Math.pow(1.6, reconnectTries));
    reconnectTries++;
    emit("reconnecting", { intento: reconnectTries, de: MAX_RECONNECT_TRIES });
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else queued = obj; // se manda apenas abra
  }

  return {
    connect: open,

    /* mode y rounds quedan fijos para toda la vida de la sala — se deciden acá, antes de que
       exista, no dentro del lobby. Ver el comentario en server.js sobre por qué. */
    create: function (nick, mode, rounds) {
      open();
      send({ t: "create", nick: nick, mode: mode, rounds: rounds });
    },
    join: function (code, nick) {
      open();
      send({ t: "join", code: code, nick: nick });
    },

    sendInput: function (action, down) {
      send({ t: "input", k: action, d: down });
    },
    /* Solo tiene efecto en modo "rounds" y solo en el lobby (el servidor lo valida igual, esto
       es solo para no gastar un mensaje si obviamente no aplica). */
    setRounds: function (rounds) {
      send({ t: "setRounds", rounds: rounds });
    },
    start: function (snail) {
      send({ t: "start", snail: snail });
    },
    again: function () {
      send({ t: "again" });
    },
    /* Corte manual de una partida en modo infinito. El servidor la rechaza si no sos el
       anfitrión o si la sala no está en modo infinito. */
    endMatch: function () {
      send({ t: "endMatch" });
    },

    /* Sesión previa en esta pestaña, si la hay. El index la consulta al cargar para saber si
       tiene que mostrar "reconectando" en vez del lobby. */
    getSavedSession: loadSession,
    forget: clearSession,

    getMyId: function () {
      return myId;
    },
    getCode: function () {
      return roomCode;
    },
    getMode: function () {
      return roomMode;
    },
    getRounds: function () {
      return roomRounds;
    },
    isOwner: function () {
      return myId !== null && myId === ownerId;
    },

    on: function (name, fn) {
      handlers[name] = fn;
    },
  };
})();
