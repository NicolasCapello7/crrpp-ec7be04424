# BPM Tickets

App for RRPPs (event promoters): `index.html` (PWA, vanilla JS) + `servidor/worker.js` (Cloudflare Worker + D1).

## Environments
- **Production**: https://bpmtickets.com.ar — Worker `eventos`, D1 `rrpp-db`. The app files are served from GitHub Pages (branch `main`).
- **Staging**: https://staging.bpmtickets.com.ar — Worker `eventos-staging`, D1 `rrpp-db-staging` (test data only). It carries its own copy of the app files, shows a "PRUEBAS" label and installs as "BPM Pruebas".

## Workflow: every change goes through staging first
1. Work on branch `staging`.
2. Publish it to staging: `bash servidor/deploy-staging.sh` (copies the app files and deploys the Worker with `--env staging`).
3. The owner tests on staging.bpmtickets.com.ar.
4. Only after their OK, release to production:
   - `git checkout main && git merge staging && git push` (the app on GitHub Pages)
   - from `servidor/`: `npx --yes wrangler@3.114.15 deploy` (the production Worker)
   - Database changes: run them on `rrpp-db-staging` first, then on `rrpp-db`, and add them to `servidor/schema.sql`.
5. Bump `VERSION` in index.html and `CACHE` in sw.js on every app change so phones pick it up.
