/* Generador de códigos QR, modo byte, corrección de errores nivel M, versiones 1 a 10.

   ¿Por qué uno propio y no una librería? Porque el único QR que este juego necesita es el link
   para que un celular entre como control (ver pad.html), y ese link mide ~40 caracteres: entra
   holgado en una versión 3. Traer una dependencia npm para eso significaría que el deploy
   dependa de que un `npm install` ande ese día, o peor, un <script> a un CDN — y la página se
   sirve entera desde la misma VM justamente para que ande aunque afuera no haya nada.

   Nivel M (recupera ~15%) y no L: el QR se lee de la pantalla de una tele o un monitor, muchas
   veces de costado y con reflejos, así que el margen extra de corrección se paga solo.

   Uso:  QR.matrix("https://…")  ->  [[0|1, …], …]   (1 = módulo oscuro)
         QR.draw(canvas, texto)  ->  lo dibuja centrado y escalado al canvas. */

var QR = (function () {
  "use strict";

  /* Por versión: [codewords de datos, codewords de corrección por bloque, bloques del grupo 1,
     datos por bloque del grupo 1, bloques del grupo 2, datos por bloque del grupo 2].
     Son los valores de la tabla del estándar para nivel M, nada más que las 10 primeras
     versiones — con 213 bytes de tope, de sobra para una URL. */
  var VERSIONS = [
    null,
    [16, 10, 1, 16, 0, 0],    // 1
    [28, 16, 1, 28, 0, 0],    // 2
    [44, 26, 1, 44, 0, 0],    // 3
    [64, 18, 2, 32, 0, 0],    // 4
    [86, 24, 2, 43, 0, 0],    // 5
    [108, 16, 4, 27, 0, 0],   // 6
    [124, 18, 4, 31, 0, 0],   // 7
    [154, 22, 2, 38, 2, 39],  // 8
    [182, 22, 3, 36, 2, 37],  // 9
    [216, 26, 4, 43, 1, 44],  // 10
  ];

  /* Centros de los patrones de alineación por versión (el estándar los deriva de una fórmula,
     pero para 10 versiones la tabla es más corta y no se puede equivocar). */
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  /* ---------------------------------------------------------------- GF(256) */
  /* Aritmética del campo de Galois que usa Reed-Solomon, con el polinomio primitivo 0x11d que
     fija el estándar. Las tablas de log/antilog convierten multiplicar en sumar índices. */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    var i;
    for (i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* Polinomio generador de grado `degree`: (x - a^0)(x - a^1)…(x - a^(degree-1)). */
  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = [];
      for (var n = 0; n <= poly.length; n++) next.push(0);
      /* poly[0] es el coeficiente de mayor grado, así que multiplicar por x deja cada
         coeficiente en su misma posición del array (que ahora es un grado más largo) y
         multiplicar por a^d lo corre uno a la derecha. */
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /* División polinómica: el resto son los codewords de corrección del bloque. */
  function rsRemainder(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var rem = [];
    for (var n = 0; n < ecLen; n++) rem.push(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ---------------------------------------------------------------- codificación */
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        // par sustituto: se codifica el punto de código completo, no las dos mitades
        var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var header = 4 + (v < 10 ? 8 : 16); // indicador de modo + contador de caracteres
      if (VERSIONS[v][0] * 8 - header >= byteLen * 8) return v;
    }
    return -1; // más de 213 bytes: no es un caso que este juego produzca
  }

  function buildCodewords(bytes, version) {
    var spec = VERSIONS[version];
    var dataCw = spec[0];
    var bits = [];
    var i, j, g;
    function push(value, len) {
      for (var k = len - 1; k >= 0; k--) bits.push((value >> k) & 1);
    }
    push(0x4, 4); // modo byte (0100)
    push(bytes.length, version < 10 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);

    // Terminador (hasta 4 ceros) y relleno hasta cerrar el último byte.
    var cap = dataCw * 8;
    for (i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    // Bytes de relleno alternados que manda el estándar, hasta llenar la capacidad.
    var padBytes = [0xec, 0x11];
    for (i = 0; data.length < dataCw; i++) data.push(padBytes[i % 2]);

    /* Los datos se parten en bloques (cada uno con su propia corrección) y después se
       entrelazan: primero el byte 0 de cada bloque, después el byte 1 de cada uno, etc. Así una
       mancha o un reflejo se reparte entre bloques en vez de destruir uno entero. */
    var blocks = [];
    var ecLen = spec[1];
    var pos = 0;
    for (g = 0; g < spec[2]; g++) { blocks.push(data.slice(pos, pos + spec[3])); pos += spec[3]; }
    for (g = 0; g < spec[4]; g++) { blocks.push(data.slice(pos, pos + spec[5])); pos += spec[5]; }
    var ecBlocks = blocks.map(function (blk) { return rsRemainder(blk, ecLen); });

    var out = [];
    var maxData = Math.max(spec[3], spec[5]);
    for (i = 0; i < maxData; i++) {
      for (g = 0; g < blocks.length; g++) if (i < blocks[g].length) out.push(blocks[g][i]);
    }
    for (i = 0; i < ecLen; i++) {
      for (g = 0; g < ecBlocks.length; g++) out.push(ecBlocks[g][i]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- matriz */
  function fill2d(size, value) {
    var m = [];
    for (var i = 0; i < size; i++) {
      var row = [];
      for (var j = 0; j < size; j++) row.push(value);
      m.push(row);
    }
    return m;
  }

  function placeFinder(m, reserved, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var inner = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m[rr][cc] = inner ? 1 : 0;
        reserved[rr][cc] = true;
      }
    }
  }

  function placePatterns(m, reserved, version) {
    var size = m.length;
    var i, r, c;
    placeFinder(m, reserved, 0, 0);
    placeFinder(m, reserved, 0, size - 7);
    placeFinder(m, reserved, size - 7, 0);

    // Patrones de tiempo: la fila y la columna 6, alternando oscuro/claro.
    for (i = 8; i < size - 8; i++) {
      var v = i % 2 === 0 ? 1 : 0;
      m[6][i] = v; reserved[6][i] = true;
      m[i][6] = v; reserved[i][6] = true;
    }

    // Alineación: en todos los cruces de la tabla salvo los tres que pisarían un finder.
    var centers = ALIGN[version];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var cr = centers[a], cc2 = centers[b];
        if ((cr <= 8 && cc2 <= 8) || (cr <= 8 && cc2 >= size - 9) || (cr >= size - 9 && cc2 <= 8)) continue;
        for (r = -2; r <= 2; r++) {
          for (c = -2; c <= 2; c++) {
            m[cr + r][cc2 + c] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
            reserved[cr + r][cc2 + c] = true;
          }
        }
      }
    }

    /* Área de la información de formato: se reserva ahora (con ceros) y se escribe al final,
       cuando ya se sabe qué máscara ganó. El módulo oscuro fijo va acá mismo. */
    m[size - 8][8] = 1; reserved[size - 8][8] = true;
    for (i = 0; i <= 8; i++) {
      if (!reserved[8][i]) { reserved[8][i] = true; m[8][i] = 0; }
      if (!reserved[i][8]) { reserved[i][8] = true; m[i][8] = 0; }
    }
    for (i = 0; i < 8; i++) {
      if (!reserved[8][size - 1 - i]) { reserved[8][size - 1 - i] = true; m[8][size - 1 - i] = 0; }
      if (!reserved[size - 1 - i][8]) { reserved[size - 1 - i][8] = true; m[size - 1 - i][8] = 0; }
    }

    // Bloque de versión (solo de la 7 en adelante): 18 bits con su BCH, duplicado en dos esquinas.
    if (version >= 7) {
      var rem = version;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
      var bits = (version << 12) | (rem & 0xfff);
      for (i = 0; i < 18; i++) {
        var bit = (bits >> i) & 1;
        var rr = Math.floor(i / 3), cc3 = i % 3;
        m[rr][size - 11 + cc3] = bit; reserved[rr][size - 11 + cc3] = true;
        m[size - 11 + cc3][rr] = bit; reserved[size - 11 + cc3][rr] = true;
      }
    }
  }

  /* Recorrido en zigzag de a dos columnas, de abajo hacia arriba y alternando, salteando la
     columna 6 (el patrón de tiempo vertical) y todo lo reservado. */
  function placeData(m, reserved, codewords) {
    var size = m.length;
    var bitIdx = 0;
    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var i = 0; i < size; i++) {
        var row = upward ? size - 1 - i : i;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (reserved[row][c]) continue;
          var bit = 0;
          if (bitIdx < codewords.length * 8) bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          m[row][c] = bit;
          bitIdx++;
        }
      }
      upward = !upward;
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  /* Los 15 bits de formato (nivel de corrección + máscara) con su BCH y el XOR fijo del
     estándar, escritos por duplicado alrededor de los finders. */
  function placeFormat(m, maskId) {
    var size = m.length;
    var data = (0x0 << 3) | maskId; // 00 = nivel M
    var rem = data;
    for (var n = 0; n < 10; n++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    /* Los 15 módulos se recorren del bit más significativo al menos: la copia 1 arranca en
       (8,0) yendo a la derecha y sigue subiendo por la columna 8, y la copia 2 arranca abajo
       de todo en la columna 8 y termina en el borde derecho de la fila 8. */
    for (var i = 0; i < 15; i++) {
      var bit = (bits >> (14 - i)) & 1;
      // copia 1: fila 8 (izquierda, salteando el patrón de tiempo en la columna 6) y columna 8
      if (i < 6) m[8][i] = bit;
      else if (i === 6) m[8][7] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;
      // copia 2: columna 8 (de abajo hacia arriba) y después fila 8 (hacia la derecha)
      if (i < 7) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }
    m[size - 8][8] = 1; // módulo oscuro, siempre
  }

  /* Penalización del estándar (las cuatro reglas). Se prueban las 8 máscaras y gana la de menor
     puntaje: es lo que evita rachas largas del mismo color o bloques que confundan al lector. */
  function penalty(m) {
    var size = m.length, score = 0, r, c, i;

    for (r = 0; r < size; r++) {
      for (var dir = 0; dir < 2; dir++) {
        var run = 1;
        for (c = 1; c < size; c++) {
          var cur = dir === 0 ? m[r][c] : m[c][r];
          var prev = dir === 0 ? m[r][c - 1] : m[c - 1][r];
          if (cur === prev) run++;
          else { if (run >= 5) score += run - 2; run = 1; }
        }
        if (run >= 5) score += run - 2;
      }
    }

    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) {
        var okH1 = true, okH2 = true, okV1 = true, okV2 = true;
        for (i = 0; i < 11; i++) {
          if (m[r][c + i] !== pat1[i]) okH1 = false;
          if (m[r][c + i] !== pat2[i]) okH2 = false;
          if (m[c + i][r] !== pat1[i]) okV1 = false;
          if (m[c + i][r] !== pat2[i]) okV2 = false;
        }
        if (okH1) score += 40;
        if (okH2) score += 40;
        if (okV1) score += 40;
        if (okV2) score += 40;
      }
    }

    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function matrix(text) {
    var bytes = utf8Bytes(String(text));
    var version = pickVersion(bytes.length);
    if (version === -1) return null;
    var size = version * 4 + 17;
    var codewords = buildCodewords(bytes, version);

    var reserved = fill2d(size, false);
    var base = fill2d(size, 0);
    placePatterns(base, reserved, version);
    placeData(base, reserved, codewords);

    var best = null, bestScore = Infinity;
    for (var maskId = 0; maskId < 8; maskId++) {
      var m = base.map(function (row) { return row.slice(); });
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (!reserved[r][c] && maskFn(maskId, r, c)) m[r][c] ^= 1;
        }
      }
      placeFormat(m, maskId);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /* Dibuja el QR ocupando el canvas, con el margen ("quiet zone") de 4 módulos que pide el
     estándar: sin ese borde claro alrededor, muchos lectores directamente no lo encuentran. */
  function draw(canvas, text, opts) {
    opts = opts || {};
    var m = matrix(text);
    if (!m) return false;
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var modules = m.length + quiet * 2;
    var px = Math.max(1, Math.floor(canvas.width / modules));
    var side = px * modules;
    var ctx = canvas.getContext("2d");
    var off = Math.floor((canvas.width - side) / 2);

    ctx.fillStyle = opts.light || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.dark || "#05060d";
    for (var r = 0; r < m.length; r++) {
      for (var c = 0; c < m.length; c++) {
        if (m[r][c]) ctx.fillRect(off + (c + quiet) * px, off + (r + quiet) * px, px, px);
      }
    }
    return true;
  }

  return { matrix: matrix, draw: draw };
})();

// Solo para poder probarlo desde Node (ver el test de qr en scratchpad); en el browser no existe.
if (typeof module !== "undefined" && module.exports) module.exports = QR;
