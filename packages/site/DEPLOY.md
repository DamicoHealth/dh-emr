# Deploying damicohealth.com

STATUS: not live. The GitHub repo, Pages and DNS are Alec's step. Everything
below is the layout the site and both apps are already built for.

## What is deployed

GitHub Pages serves `packages/site/public/` as the site root, as-is. At
deploy time that directory holds:

```
public/
  index.html          landing page: both products side by side   (committed)
  site.css            the one stylesheet                          (committed)
  404.html            self-contained, root-absolute links          (committed)
  robots.txt                                                      (committed)
  CNAME               "damicohealth.com", added at the DNS step    (committed)
  guides/             hub, plus guides/field/ and guides/clinic/   (committed)
  clinic/             DH EMR Clinic app        <- build:clinic     (build output)
  field/              DH EMR Field app         <- build:field      (build output)
  demo/clinic/        Clinic demo              <- build:demos      (build output)
  demo/field/         Field demo               <- build:demos      (build output)
```

The four build directories are regenerated at every deploy and never
committed. In git, `public/clinic/` and `public/field/` each hold only a
placeholder `index.html` that says the app runs at that address and links
to its guide set. The build overwrites that placeholder with the app. Nothing
else on the site links inside those directories, so the swap changes no URL.

## Canonical URLs

| URL                              | What it is                          |
| -------------------------------- | ----------------------------------- |
| https://damicohealth.com/        | landing page                        |
| https://damicohealth.com/clinic/ | DH EMR Clinic (the app)             |
| https://damicohealth.com/field/  | DH EMR Field (the app)              |
| https://damicohealth.com/demo/clinic/ | Clinic demo                    |
| https://damicohealth.com/demo/field/  | Field demo                     |
| https://damicohealth.com/guides/clinic/ | Clinic guide set             |
| https://damicohealth.com/guides/field/  | Field guide set              |

Every link on the site, in the guides and in the apps' own About text must
use these and nothing else. There is no `/app/` and no root `/demo/` app.

## Build contract, one app at a time

| Product     | Root script    | Vite base      | Output directory          | Storage suffix  |
| ----------- | -------------- | -------------- | ------------------------- | --------------- |
| Field       | `build:field`  | `/field/`      | `public/field/`           | `` (bare)       |
| Clinic      | `build:clinic` | `/clinic/`     | `public/clinic/`          | `-clinic`       |
| Field demo  | `build:demos`  | `/demo/field/` | `public/demo/field/`      | `-demo`         |
| Clinic demo | `build:demos`  | `/demo/clinic/`| `public/demo/clinic/`     | `-clinic-demo`  |

Why the suffix column is load-bearing: all four builds run on ONE origin,
damicohealth.com. IndexedDB and localStorage are scoped to the origin, not
the path, so without the suffix the Field app and the Field demo would share
one patient database (this was a live incident in the old app; REBUILD-
HANDOFF section 4.1 invariant 5). Field production keeps the bare prefix for
continuity with every device already in service. Clinic production is
`-clinic` so a device with both products installed never shares records,
settings, device identity or auth session between them. Never build a
production app with a demo suffix or a demo with a production one.

The base path also places each app's service worker under its own scope
(`/field/sw.js` controls `/field/` only, and so on), so four workers coexist
on one origin without claiming each other's pages. Clinical builds register
with `prompt` (the user clicks "Update now"; nothing reloads mid-visit).
Demo builds register with `autoUpdate`.

State of the scripts on 2026-10-06:

- `build:demos` already does the right thing: each package's `build:demo`
  sets DH_DEMO, its suffix, its base and its output directory.
- `build:field` and `build:clinic` (root) run each package's `build`, which
  now typechecks and emits straight into `packages/site/public/field` and
  `packages/site/public/clinic` with the right `--base`. Each package also
  has `build:local` (plain `vite build` into its own `dist/`), which is
  what the `.claude/launch.json` previews serve.
- The root `.gitignore` ignores `public/field/*` and `public/clinic/*`
  except their placeholder `index.html` pages. A LOCAL deploy build
  overwrites those placeholders (expected); do not commit the overwritten
  copies - the real deploy builds in CI.

Full build from the repo root, exactly what the workflow runs:

```
npm ci
npm test
npm --workspace @dh/field run typecheck
npm --workspace @dh/field exec vite build -- --base=/field/ --outDir=../site/public/field --emptyOutDir
npm --workspace @dh/clinic run typecheck
npm --workspace @dh/clinic exec vite build -- --base=/clinic/ --outDir=../site/public/clinic --emptyOutDir
npm run build:demos
```

## Git hygiene for the build directories

The root `.gitignore` must ignore all four build directories while keeping
the two placeholders. Today it lists only `packages/site/public/demo/`; add
the app lines:

```
packages/site/public/demo/
packages/site/public/field/*
!packages/site/public/field/index.html
packages/site/public/clinic/*
!packages/site/public/clinic/index.html
```

After a local production build, git shows `public/field/index.html` (or
`public/clinic/index.html`) as modified because the app's shell replaced the
placeholder. Restore it before committing:

```
git checkout -- packages/site/public/field/index.html packages/site/public/clinic/index.html
```

Never commit build output. The PHI tripwire from CLAUDE.md runs before every
commit regardless.

## GitHub Pages workflow

Pages source: GitHub Actions (not a branch). The workflow builds the four
apps into `public/`, adds `CNAME`, and uploads `packages/site/public/` as the
Pages artifact. Deploying from a branch would mean committing build output,
which the section above forbids.

```yaml
name: Deploy damicohealth.com
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm --workspace @dh/field run typecheck
      - run: npm --workspace @dh/field exec vite build -- --base=/field/ --outDir=../site/public/field --emptyOutDir
      - run: npm --workspace @dh/clinic run typecheck
      - run: npm --workspace @dh/clinic exec vite build -- --base=/clinic/ --outDir=../site/public/clinic --emptyOutDir
      - run: npm run build:demos
      - run: echo damicohealth.com > packages/site/public/CNAME
      - uses: actions/upload-pages-artifact@v3
        with:
          path: packages/site/public
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Pushes that touch only `packages/core` still redeploy, on purpose: core is
inside both apps.

## Custom domain and DNS

1. Push the repo to GitHub. Settings, Pages, Source: GitHub Actions.
2. Run the workflow once and confirm the `*.github.io` address serves the
   site before touching DNS.
3. DNS at the registrar: apex `A` records to the four GitHub Pages IPs
   (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153) and
   the matching `AAAA` records; `www` as a `CNAME` to `<owner>.github.io`.
4. Settings, Pages, Custom domain: `damicohealth.com`. GitHub verifies DNS,
   then issues the certificate. Turn on "Enforce HTTPS" once it has.
5. Commit `packages/site/public/CNAME` containing `damicohealth.com` (the
   workflow writes it too; committing it keeps the Pages setting from being
   lost on the next deploy). The `www` host redirects to the apex.

## Verify after every deploy

- `/` loads. The Clinic and Field panels each have Try the demo, Launch and
  Guides, and all six links resolve.
- `/clinic/` opens DH EMR Clinic (page title "DH EMR Clinic"; the setup
  wizard opens on the cloud step). `/field/` opens DH EMR Field (page title
  "DH EMR Field"; the wizard offers "Connect to our clinic cloud" and "Use
  this device on its own").
- `/demo/field/` and `/demo/clinic/` show the DEMO bar at the top.
- Browser DevTools, Application, IndexedDB on the origin: four distinct
  database names, `dh-emr-db` (Field), `dh-emr-db-clinic`, `dh-emr-db-demo`,
  `dh-emr-db-clinic-demo`. If two builds share a name, stop and fix the
  suffix before anyone enters a record.
- Application, Service Workers: four registrations, scopes `/field/`,
  `/clinic/`, `/demo/field/`, `/demo/clinic/`.
- `/guides/field/` and `/guides/clinic/` load and link back to `/`.
- A made-up address (for example `/nothing-here/`) shows the 404 page with
  working links to `/`, `/clinic/`, `/field/` and `/guides/`.
- `/robots.txt` is served as text.

## Retiring what came before

- If any old dh-field-emr hosting still answers, redirect it to
  https://damicohealth.com/field/ or take it down as part of the DNS step.
- The earlier site plan used `/app/` and a root `/demo/`. Neither was ever
  public. `public/app/index.html` is a leftover from that plan and should be
  deleted (or made a plain link to `/`) so nothing on the site claims there
  is one app.
