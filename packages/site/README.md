# @dh/site - damicohealth.com

Static site for DH EMR. Plain HTML plus one stylesheet, no build step:
`public/` is the deployable root and is served exactly as-is.

Two products, one site. The landing page presents DH EMR Clinic and DH EMR
Field side by side with equal weight; each has its own app address, its own
demo and its own guide set.

## Layout

```
public/
  index.html            landing page: both products, which-one-is-for-us,
                        customization, ownership
  site.css              the one stylesheet (tokens match the apps)
  clinic/index.html     URL holder for DH EMR Clinic; build:clinic replaces it
  field/index.html      URL holder for DH EMR Field; build:field replaces it
  demo/clinic/          Clinic demo (build output, gitignored)
  demo/field/           Field demo (build output, gitignored)
  guides/index.html     guides hub
  guides/clinic/        Clinic guide set
  guides/field/         Field guide set
  404.html              self-contained (inline styles, root-absolute links)
  robots.txt
```

Favicons are inline SVG data URIs in each page head; there is no favicon
file.

## Preview locally

From the repo root, with no downloads at all:

```
node packages/site/serve.mjs 4180
```

then open http://localhost:4180. `serve.mjs` resolves directory `index.html`
files and serves `404.html` for anything missing, mirroring GitHub Pages.
The `site-preview` entry in `.claude/launch.json` runs the same thing.
(`npm run preview` in this package still calls `python3 -m http.server`,
which is not installed on every machine; prefer `serve.mjs`.)

## How the apps and demos land here

The site never builds an app. Each product package owns its build and emits
into `public/`:

- `packages/field` builds DH EMR Field for `/field/` and its DH_DEMO variant
  (seeded fictional clinic, all demo safety laws) for `/demo/field/`.
- `packages/clinic` builds DH EMR Clinic for `/clinic/` and its demo for
  `/demo/clinic/`.

`npm run build:demos` at the repo root regenerates both demos. The
production apps are built with their base path and output directory set
(DEPLOY.md has the exact commands). All four directories are regenerated at
deploy; `public/clinic/index.html` and `public/field/index.html` are the
only files in those directories that live in git, and the build overwrites
them.

## Editing rules

- No em dashes anywhere. Regular hyphens only.
- The UI terms are "visit" and "patient number", one term everywhere. Never
  "encounter", never "MRN" as a visible word.
- Every public-facing page carries, visibly: "DH EMR is not a certified
  EHR and is not HIPAA-compliant. It is intended for global-health use
  outside the US."
- Product copy is written against the rendering code, not from memory.
  Field claims on the landing page and in `field/index.html` were checked
  against `packages/field/src/App.tsx` (the four tabs) and the UI kit in
  `packages/core/src/ui` (setup wizard choices, Settings cards, the visit
  form, analytics panels). A page naming a control that does not exist is
  worse than no page.
- Plain, short sentences. ESL-friendly. No marketing voice.
- Color discipline is the apps': `#f68630` is decorative fill only, never
  text and never under text; all text is 4.5:1+ on its surface. Tokens live
  at the top of `site.css`; add tokens, do not hard-code colors (404.html is
  the one exception, because it must be self-contained).
- Responsive from 320px with no horizontal scroll. Check every change at a
  narrow width.
- Internal links are relative (except in 404.html, which is served at
  arbitrary depths and must stay root-absolute). The landing page's
  product sections are `#clinic` and `#field`; other pages link to them as
  `../#clinic` and `../#field`.
- No screenshots, testimonials, user counts or download links. Where a
  thing is coming, the page says it is coming.
- The two products never switch into each other and never merge records.
  Do not write copy that implies otherwise.

## Deploying

See DEPLOY.md: the four build directories, the GitHub Pages workflow, the
custom domain, and the post-deploy checklist.
