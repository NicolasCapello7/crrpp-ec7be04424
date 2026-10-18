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

## Branches waiting on staging (only go to production when the owner says so, naming the branch)
| Branch | Name for the owner | Content | Notes for the release |
|---|---|---|---|
| `plan-premium` | Plan Premium | Instagram story (1080×1920) from each event + "Tu página" stats (visits, taps on Comprar) | Create tables `visitas` and `clics` in rrpp-db before deploying the Worker (schema.sql v5) |
| `dashboard-jefes` | Dashboard Jefes de Equipo | Jefe invites RRPPs by mail, they accept; Estadísticas "Equipo / Mía" with time filters | Create table `equipo` + indexes in rrpp-db before deploying (schema.sql v6). Conflicts with plan-premium in Estadísticas |
| (in `staging` base) | Copia de seguridad | Load/save backup card in Ajustes, visible only on staging; `COPIA_EN_SITIO` (false) turns it on in production | Already in main, hidden |
| (in `staging` base) | Nuevo estilo | Fonts Bricolage Grotesque + Manrope, deeper colors, shadows, focus ring, active-tab pill; also the public page in worker.js | Not in main yet. Release = merge staging into main + deploy the production Worker (no DB changes). `plan-premium` and `dashboard-jefes` branched before it: merge `staging` into them before publishing them |

staging.bpmtickets.com.ar shows one branch at a time (last published: `staging`, with Nuevo estilo).

## Design
The UI UX Pro Max skill is installed in ~/.claude/skills/ui-ux-pro-max.
- Fonts: `--display` Bricolage Grotesque, always with `font-stretch: var(--display-w)` (82%, the narrow cut); `--body` Manrope.
- Colors live as tokens in `:root` (dark) with a light-mode override. Use `--accent-text` (not `--accent`) when green is used as text color, so it stays readable in light mode.
- Card depth comes from `--shadow`; the main green buttons use `--glow`.
