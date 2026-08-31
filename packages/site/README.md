# @dh/site - damicohealth.com

Static site for DH EMR. Plain HTML plus one stylesheet, no build step:
`public/` is the deployable root and is served exactly as-is.

## Layout

```
public/
  index.html        landing page
  site.css          the one stylesheet (matches the app design tokens)
  app/index.html    placeholder holding the canonical /app/ URL
  demo/index.html   placeholder holding the canonical /demo/ URL
  guides/index.html guides hub (guides ship with the new app)
  404.html          self-contained (inline styles, absolute links)
  robots.txt
```

Favicons are inline SVG data URIs in each page head; there is no favicon
file.

## Preview locally

From `packages/site/`:

```
npx serve public
```

or, with no downloads at all:

```
python3 -m http.server 8080 --directory public
```

(also available as `npm run preview` in this package). Then open
http://localhost:8080 (serve prints its own port, usually 3000).

## How the demo lands here

The app package (`packages/app`) will grow a `build:demo` script during the
demo build phase. It builds the DH_DEMO variant of the app - seeded
fictional clinic, all demo safety laws - with its Vite base path set for
`/demo/`, and outputs into `packages/site/public/demo/`, replacing the
placeholder page there. The site never builds the demo itself; it only
hosts the output. Until that script exists, `/demo/` shows the placeholder.

The real app will occupy `/app/` the same way; that placeholder holds the
URL so links shared today never change.

## Editing rules

- No em dashes anywhere. Regular hyphens only.
- The UI terms are "visit" and "patient number", one term everywhere.
- Every public-facing page carries, visibly: "DH EMR is not a certified
  EHR and is not HIPAA-compliant. It is intended for global-health use
  outside the US."
- Color discipline is the app's: `#f68630` is decorative fill only, never
  text and never under text; all text is 4.5:1+ on its surface.
- Internal links are relative (except in 404.html, which is served at
  arbitrary depths and must stay root-absolute and self-contained).
- No fabricated screenshots, testimonials, user counts, or download links.
  Where a thing is coming, the page says it is coming.

## Deploying

See DEPLOY.md (stub - deployment is pending Alec's repo and DNS step).
