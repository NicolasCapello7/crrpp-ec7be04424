#!/usr/bin/env bash
# Publishes the app files and the server of THIS folder to https://staging.bpmtickets.com.ar (test data only).
set -e
cd "$(dirname "$0")"
rm -rf .staging-app && mkdir .staging-app
for f in index.html sw.js manifest.webmanifest icon-192.png icon-512.png apple-touch-icon.png og.png privacidad.html; do cp "../$f" .staging-app/; done
# a phone can install both: the test icon is named apart
sed -i 's/"name": "BPM Tickets"/"name": "BPM Tickets (Pruebas)"/; s/"short_name": "BPM Tickets"/"short_name": "BPM Pruebas"/' .staging-app/manifest.webmanifest
sed -i 's/name="apple-mobile-web-app-title" content="BPM Tickets"/name="apple-mobile-web-app-title" content="BPM Pruebas"/' .staging-app/index.html
# staging must never be indexed by search engines
printf 'User-agent: *\nDisallow: /\n' > .staging-app/robots.txt
WRANGLER_SEND_METRICS=false CI=true npx --yes wrangler@3.114.15 deploy --env staging
