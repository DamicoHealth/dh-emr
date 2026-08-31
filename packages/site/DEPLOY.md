# Deploying damicohealth.com

STATUS: stub - deployment pending Alec's repo + DNS step. Nothing below is
live yet.

## Intended setup

- Host: GitHub Pages, deploying `packages/site/public/` as the site root
  (via a Pages workflow that uploads that directory as the artifact - no
  build step, the files are served as-is).
- Custom domain: damicohealth.com (apex), with www redirecting to apex.
- Canonical app URL: https://damicohealth.com/app/ - the placeholder page
  holds this URL now so links never change when the app ships.
- Demo URL: https://damicohealth.com/demo/ - populated by the app's
  `build:demo` output (see README.md).

## Steps when Alec is ready

1. Push this repo to GitHub and enable Pages (GitHub Actions source).
2. Add a workflow that publishes `packages/site/public/` on pushes that
   touch `packages/site/`.
3. Add a `CNAME` file containing `damicohealth.com` to `public/` (or set
   the custom domain in the Pages settings, which creates it).
4. DNS: apex A/AAAA records to GitHub Pages IPs (or ALIAS/ANAME), `www`
   CNAME to the Pages hostname. Enable "Enforce HTTPS" once the
   certificate issues.
5. Verify every page live, including /404 handling and robots.txt.

Notes:

- 404.html is self-contained (inline styles, absolute links) because GitHub
  Pages serves it at whatever path was requested.
- The old dh-field-emr hosting, if any remains, should redirect or be
  retired as part of the DNS step.
