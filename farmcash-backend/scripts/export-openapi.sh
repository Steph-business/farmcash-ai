#!/usr/bin/env bash
# =====================================================================
# Re-génère docs/api/openapi.json + collection Postman
# depuis le serveur NestJS en cours d'exécution (Swagger /api/docs-json).
#
# Usage :
#   bash scripts/export-openapi.sh
#   BASE_URL=https://staging.farmcash.ai bash scripts/export-openapi.sh
#
# Pré-requis :
#   - Le backend doit tourner et exposer /api/docs-json
#     (vérifier avec : curl -s -o /dev/null -w "%{http_code}" \
#        $BASE_URL/api/docs-json     # attendu : 200)
#   - npx disponible (Node 18+).
# =====================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCS_DIR="$ROOT_DIR/docs/api"
OPENAPI_FILE="$DOCS_DIR/openapi.json"
POSTMAN_FILE="$DOCS_DIR/farmcash.postman_collection.json"

mkdir -p "$DOCS_DIR"

echo "==> Vérification du serveur sur $BASE_URL/api/docs-json"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/docs-json" || echo '000')"
if [ "$HTTP_CODE" != "200" ]; then
  echo "ERREUR : /api/docs-json a renvoyé HTTP $HTTP_CODE." >&2
  echo "Démarre le backend avec : cd $ROOT_DIR && npm run start:dev" >&2
  exit 1
fi
echo "    OK ($HTTP_CODE)"

echo "==> Téléchargement et formatage de openapi.json"
curl -sf "$BASE_URL/api/docs-json" | python3 -m json.tool > "$OPENAPI_FILE"

LINES="$(wc -l < "$OPENAPI_FILE" | tr -d ' ')"
BYTES="$(wc -c < "$OPENAPI_FILE" | tr -d ' ')"
echo "    Écrit : $OPENAPI_FILE ($LINES lignes, $BYTES octets)"

ENDPOINTS="$(python3 -c "import json; print(len(json.load(open('$OPENAPI_FILE')).get('paths', {})))")"
TAGS="$(python3 -c "import json; print(', '.join(sorted({t['name'] for t in json.load(open('$OPENAPI_FILE')).get('tags', [])})))")"
echo "    Endpoints : $ENDPOINTS"
echo "    Tags      : $TAGS"

echo "==> Génération de la collection Postman (openapi-to-postmanv2)"
npx -y openapi-to-postmanv2@latest \
  -s "$OPENAPI_FILE" \
  -o "$POSTMAN_FILE" \
  -p \
  -O folderStrategy=Tags,requestParametersResolution=Example,exampleParametersResolution=Example

POSTMAN_BYTES="$(wc -c < "$POSTMAN_FILE" | tr -d ' ')"
echo "    Écrit : $POSTMAN_FILE ($POSTMAN_BYTES octets)"

echo ""
echo "Done."
echo "Files :"
echo "  - $OPENAPI_FILE"
echo "  - $POSTMAN_FILE"
echo ""
echo "Importe la collection dans Postman : File -> Import -> $POSTMAN_FILE"
