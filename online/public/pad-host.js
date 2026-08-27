/* Lado "pantalla" de los celulares-control del modo Local.

   El modo Local no usa la red para nada: el Sim corre en esta misma máquina y los jugadores
   entran por teclado o por mando. Esto agrega una tercera fuente de input — el celular de cada
   uno — sin cambiar nada de eso: se abre una sala de mandos en el servidor (ver "salas de
   mandos" en online/server.js), los teléfonos entran con un código, y sus botones llegan acá
   como eventos "input" que se enchufan derecho a Sim.handleInput. El servidor no simula ni
   valida nada de la partida; es un cable entre la pantalla y los teléfonos.

   Por qué un socket propio y no el de Net (net-ws.js): son dos conversaciones distintas y sin
   nada en común — Net tiene su sala, su token de reconexión y su lógica de "volver a mi slot"
   pensada para una partida online; meterle esto adentro obligaría a distinguir en cada mensaje
   de qué mundo viene. Y en modo Local Net ni siquiera está conectado. */

var PadHost = (function () {
  "use strict";

  var ws = null;
  var code = null;
  var token = null;
  var handlers = {};
  var wantOpen = false;   // false = lo cerramos a propósito, no reintentar
  var retryTimer = null;
  var tries = 0;
  var MAX_TRIES = 20;

  /* sessionStorage y no localStorage, igual que el token de sala en net-ws.js: es de ESTA
     pestaña. Dos pestañas del juego en la misma PC (que es como se prueba esto) tienen que
     poder tener cada una su propia sala de mandos, no pelearse la misma. */
  var TOKEN_KEY = "lss-pad-host";

  function loadToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function saveToken(v) {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* incógnito o storage bloqueado: seguimos sin poder recuperar la sala */ }
  }

  function emit(name, payload) {
    var fn = handlers[name];
    if (fn) fn(payload);
  }

  function url() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function open() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    wantOpen = true;
    emit("status", code ? "reconnecting" : "connecting");
    try {
      ws = new WebSocket(url());
    } catch (e) {
      emit("status", "error");
      return;
    }

    ws.onopen = function () {
      tries = 0;
      /* Con token pedimos LA MISMA sala: un F5 en la pantalla no tiene por qué obligar a ocho
         personas a volver a escanear el QR. Si el servidor ya la soltó, nos devuelve una nueva
         con otro código y el cartel de la pantalla se actualiza solo. */
      send({ t: "padCreate", token: token || loadToken() || undefined });
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.t) return;

      if (msg.t === "padCreated") {
        code = msg.code;
        token = msg.token;
        saveToken(token);
        emit("status", "ready");
        emit("created", { code: code, pads: msg.pads || [], resumed: !!msg.resumed });
        return;
      }
      if (msg.t === "padJoin") { emit("join", msg); return; }
      if (msg.t === "padLeave") { emit("leave", msg); return; }
      if (msg.t === "padGone") { emit("gone", msg); return; }
      if (msg.t === "padInput") { emit("input", msg); return; }
      if (msg.t === "padMsg") { emit("msg", msg); return; }
      if (msg.t === "err") { emit("error", msg); return; }
    };

    ws.onclose = function () {
      ws = null;
      if (!wantOpen) return;
      emit("status", "reconnecting");
      scheduleRetry();
    };
    ws.onerror = function () { /* onclose viene siempre después; se maneja allá */ };
  }

  /* Mismo backoff que net-ws.js: rápido al principio (la mayoría de los cortes duran un par de
     segundos) y después más espaciado, para no martillar un servidor caído. */
  function scheduleRetry() {
    if (retryTimer) return;
    if (tries >= MAX_TRIES) {
      emit("status", "error");
      return;
    }
    var delay = Math.min(4000, 300 * Math.pow(1.6, tries));
    tries++;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      open();
    }, delay);
  }

  return {
    open: open,

    /* Cierra la sala de mandos de verdad: los teléfonos reciben el aviso y vuelven a la pantalla
       de "entrar con código". Se llama al salir del modo Local — dejarla abierta significaría
       tener a ocho personas con un control que ya no mueve nada. */
    close: function () {
      wantOpen = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      send({ t: "padClose" });
      saveToken(null);
      token = null;
      code = null;
      if (ws) {
        try { ws.close(); } catch (e) { /* ya estaba cerrado */ }
        ws = null;
      }
      emit("status", "closed");
    },

    isOpen: function () { return !!code && !!ws && ws.readyState === 1; },
    getCode: function () { return code; },

    /* El link que va en el QR y en el cartel. Lleva el código adentro para que escanear alcance:
       el que escanea ya entra a su sala, sin tipear nada. */
    joinUrl: function () {
      return location.origin + "/pad" + (code ? "?c=" + code : "");
    },

    sendTo: function (pad, data) { send({ t: "padTo", pad: pad, data: data }); },
    broadcast: function (data) { send({ t: "padAll", data: data }); },
    kick: function (pad, reason) { send({ t: "padKick", pad: pad, reason: reason || null }); },

    on: function (name, fn) { handlers[name] = fn; },
  };
})();
