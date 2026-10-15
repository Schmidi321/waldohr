#!/usr/bin/env bash
# Ersatzquelle für das Offline-Modell auf den Hetzner-Server bringen (waldohr.fotoreich.eu).
# Aufruf in Git Bash, aus diesem Ordner:   bash deploy-modell-spiegel.sh
#
# Der Server lädt das BirdNET-ZIP SELBST von Zenodo (75 MB müssen nicht durch die heimische
# Leitung), prüft die SHA-256 und legt es unter /srv/fotoreich/waldohr/modell/ ab. Danach hängt
# das Skript EINMALIG einen Caddy-Block an (mit CORS, sonst darf die App von github.io bzw. aus der
# Capacitor-Hülle nicht laden) und lädt Caddy neu. Mehrfach ausführen ist harmlos.
#
# DNS: *.fotoreich.eu zeigt per Wildcard schon auf den Server — kein neuer A-Record nötig.
# Lizenz: Das Modell bleibt CC BY-NC-SA 4.0; der Spiegel verteilt es unverändert und kostenlos.
set -euo pipefail

SERVER="root@167.233.155.192"
DOMAIN="waldohr.fotoreich.eu"
URL_PFAD="modell/BirdNET_v2.4_tfjs.zip"

ssh "$SERVER" bash -s <<'REMOTE'
set -e
WEBDIR="/opt/relief/deploy/fotoreich/waldohr"   # -> /srv/fotoreich/waldohr im Container
CADDY="/opt/relief/deploy/Caddyfile"
ZIP="$WEBDIR/modell/BirdNET_v2.4_tfjs.zip"
SHA="f81af091fe334b15ad3f82766b3340ed768b0a6acd274ab10e8fc32d19410655"

mkdir -p "$WEBDIR/modell"
if [ -f "$ZIP" ] && echo "$SHA  $ZIP" | sha256sum -c --quiet - 2>/dev/null; then
  echo "  Modell liegt schon (Prüfsumme ok)."
else
  echo "  Lade Modell von Zenodo …"
  curl -fL --retry 3 -o "$ZIP.tmp" "https://zenodo.org/api/records/15050749/files/BirdNET_v2.4_tfjs.zip/content"
  echo "$SHA  $ZIP.tmp" | sha256sum -c --quiet - || { rm -f "$ZIP.tmp"; echo "  Prüfsumme falsch — abgebrochen."; exit 1; }
  mv "$ZIP.tmp" "$ZIP"   # Webdatei, nicht das Caddyfile — mv ist hier unkritisch
  echo "  Modell abgelegt, Prüfsumme ok."
fi

if grep -q "^waldohr.fotoreich.eu" "$CADDY"; then
  echo "  Caddy-Block existiert schon – nicht erneut angehängt."
else
  cp "$CADDY" "$CADDY.bak-$(date +%Y%m%d-%H%M%S)"
  # Mit >> anhängen, NIE mv/sed -i: Docker bindet das Caddyfile über den Inode.
  cat >> "$CADDY" <<'BLOCK'

waldohr.fotoreich.eu {
        root * /srv/fotoreich/waldohr
        header {
                Access-Control-Allow-Origin "*"
                X-Content-Type-Options nosniff
                Strict-Transport-Security "max-age=31536000"
                -Server
        }
        header /modell/* Cache-Control "public, max-age=604800"
        file_server
        log {
                output file /data/waldohr-access.log {
                        roll_size 50MiB
                        roll_keep 5
                }
        }
}
BLOCK
  echo "  Caddy-Block angehängt (Backup der alten Konfig angelegt)."
fi

cd /opt/relief/deploy
# </dev/null: sonst schluckt "exec -T" den Rest dieses Heredocs (bekannter Fallstrick).
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null
echo "  Caddy neu geladen."
REMOTE

echo "→ Test (beim ersten Mal wird das Zertifikat geholt) …"
CODE=000
for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -I "https://$DOMAIN/$URL_PFAD" || true)
  [ "$CODE" = "200" ] && break
  sleep 3
done
echo "https://$DOMAIN/$URL_PFAD : $CODE"
[ "$CODE" = "200" ] || echo "Kein 200? Erst 'caddy reload' einmal einzeln per ssh wiederholen (Zertifikat-Fallstrick)."
