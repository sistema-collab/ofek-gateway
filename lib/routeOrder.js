// Misma semántica de "prefijo de ruta" que usa server.js para decidir qué
// proxy le toca a cada request. Vive acá (y no duplicada) para que el
// chequeo de orden de abajo valide exactamente lo mismo que se usa en el
// dispatch real.
function matchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// server.js despacha con `.find()`: la primera ruta cuyo prefijo matchea
// gana. Si una ruta definida antes es prefijo de otra definida después
// (ej. "/modulos" antes que "/modulos/cobranza"), la de después queda
// inalcanzable -- el "shadowing" nunca se dispara y esa ruta específica no
// se usa nunca. Esta función detecta ese caso recorriendo las rutas en el
// orden real en que fueron definidas.
function checkRouteOrder(prefixesInOrder) {
  for (let i = 0; i < prefixesInOrder.length; i++) {
    for (let j = i + 1; j < prefixesInOrder.length; j++) {
      if (matchesPrefix(prefixesInOrder[j], prefixesInOrder[i])) {
        throw new Error(
          `orden de rutas invalido: "${prefixesInOrder[i]}" (definida antes) tapa a "${prefixesInOrder[j]}" (definida despues). Movela despues en la lista de rutas.`
        );
      }
    }
  }
}

module.exports = { matchesPrefix, checkRouteOrder };
