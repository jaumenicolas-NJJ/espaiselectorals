#!/usr/bin/env bash
# Batería de pruebas de Espais electorals.
#   bash pruebas/ejecutar.sh           reglas del servidor + interfaz completa en el navegador
#   bash pruebas/ejecutar.sh --carga   además, prueba de carga con 20 usuarios a la vez (unos 2 minutos)
# Cada batería arranca un servidor de pruebas con el almacén vacío: nunca se tocan los datos reales.
set -u
cd "$(dirname "$0")/.."
export PORT=${PORT:-8899}
LOG=$(mktemp); SP=""; fallos=0
parar() { [ -n "$SP" ] && kill "$SP" 2>/dev/null; wait "$SP" 2>/dev/null; SP=""; }
trap parar EXIT
arrancar() {
  parar; LAT="${1:-0}" node pruebas/servidor.mjs >"$LOG" 2>&1 & SP=$!
  for _ in $(seq 1 60); do node -e "fetch('http://localhost:$PORT/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && return 0; sleep 0.25; done
  echo "No arranca el servidor de pruebas:"; cat "$LOG"; exit 1
}
bateria() { echo; echo "=== $1 ==="; shift; "$@" || fallos=$((fallos + 1)); }
arrancar 0;  bateria "REGLAS DEL SERVIDOR" node pruebas/reglas.cjs
arrancar 0;  bateria "INTERFAZ (administración, 3 candidaturas y consulta a la vez)" node pruebas/interfaz.cjs
if [ "${1:-}" = "--carga" ]; then arrancar 60; bateria "CARGA (20 usuarios a la vez, latencia simulada)" node pruebas/carga.cjs; fi
parar
echo; if [ "$fallos" -eq 0 ]; then echo "TODAS LAS PRUEBAS CORRECTAS"; else echo "HAY $fallos BATERÍAS CON FALLOS"; exit 1; fi
