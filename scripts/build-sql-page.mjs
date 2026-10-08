// Publishes the canonical Supabase scripts (supabase/*.sql) on the website:
// packages/site/public/supabase/index.html shows each script in full with a
// Copy button and a download link, and the raw .sql files sit beside it.
// Runs at deploy (npm run build:sql) and for the local preview; the output
// directory is gitignored so the repo keeps exactly one copy of each script.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'supabase')
const out = join(root, 'packages', 'site', 'public', 'supabase')
mkdirSync(out, { recursive: true })

const SCRIPTS = [
  {
    file: 'setup.sql',
    id: 'setup',
    title: 'setup.sql',
    what: 'Creates the tables, the access rules, the server-side checks behind the Staff screen and the live updates. Safe to run twice; re-running is the upgrade path.',
  },
  {
    file: 'verify.sql',
    id: 'verify',
    title: 'verify.sql',
    what: 'Checks the project after setup.sql. Every row of its output must say PASS. It changes nothing and ends by rolling itself back.',
  },
  {
    file: 'rollback-v4-to-v3.sql',
    id: 'rollback',
    title: 'rollback-v4-to-v3.sql',
    what: 'Only for an organization that upgraded from the pre-split v3 schema and needs to go back. Read its header before running it.',
  },
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const icon = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230e6e64'/%3E%3Cpath d='M32 17v30M17 32h30' stroke='%23ffffff' stroke-width='10' stroke-linecap='round'/%3E%3C/svg%3E`
const title = 'Database setup scripts - DH EMR'
const desc = 'The SQL that sets up and checks a DH EMR cloud project on Supabase: setup.sql, verify.sql and the rollback script, each with a Copy button.'

const sections = SCRIPTS.map((s) => {
  const sql = readFileSync(join(src, s.file), 'utf8')
  if (sql.includes('\u2014')) throw new Error(`${s.file} contains an em dash`)
  copyFileSync(join(src, s.file), join(out, s.file))
  const lines = sql.split('\n').length
  return `
      <section class="sql-script" id="${s.id}">
        <h2>${s.title}</h2>
        <p>${s.what}</p>
        <div class="cta-row sql-actions">
          <button type="button" class="btn btn-primary" data-copy="${s.id}-code">Copy ${s.title}</button>
          <a class="btn btn-secondary" href="${s.file}" download>Download</a>
          <span class="muted small">${lines} lines</span>
        </div>
        <pre class="sql-code" id="${s.id}-code" tabindex="0" aria-label="${s.title}">${esc(sql)}</pre>
      </section>`
}).join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${desc}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="DH EMR">
  <meta property="og:url" content="https://damicohealth.com/supabase/">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="https://damicohealth.com/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="https://damicohealth.com/og-image.png">
  <link rel="icon" href="${icon}">
  <link rel="stylesheet" href="../site.css">
  <style>
    .sql-script { margin-top: 2.2rem; }
    .sql-actions { align-items: center; gap: 0.75rem; margin: 0.5rem 0 0.75rem; }
    .sql-code {
      max-height: 26rem;
      overflow: auto;
      margin: 0;
      padding: 1rem 1.1rem;
      background: #1a2330;
      color: #e7ecf2;
      border-radius: var(--radius, 10px);
      font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
      tab-size: 2;
    }
    .sql-code:focus { outline: 3px solid var(--primary, #0e6e64); outline-offset: 2px; }
  </style>
</head>
<body>

<header class="site-header">
  <div class="wrap">
    <a class="wordmark" href="../">
      <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#0e6e64"/>
        <path d="M32 17v30M17 32h30" stroke="#ffffff" stroke-width="10" stroke-linecap="round"/>
      </svg>
      DH EMR
    </a>
    <nav class="site-nav" aria-label="Site">
      <a href="../#clinic">Clinic</a>
      <a href="../#field">Field</a>
      <a href="../guides/">Guides</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <div class="page">
      <p class="kicker">DH EMR cloud project</p>
      <h1>Database setup scripts</h1>
      <p>These set up and check the Supabase project your organization owns. The step-by-step is in the guides: <a href="../guides/clinic/setup.html#schema">Setting up DH EMR Clinic</a> and <a href="../guides/field/cloud-sync.html#schema">Cloud sync setup for DH EMR Field</a>. In short: open your project's SQL Editor, start a new query, press Copy under <code>setup.sql</code> below, paste, and click Run; then do the same with <code>verify.sql</code>.</p>
      <div class="callout warn">
        <p><strong>Upgrading a project already in use?</strong> Run <code>setup.sql</code> after clinic hours. The run briefly locks the records table, so a device syncing at that moment shows a sync error, retries, and succeeds. Nothing is lost, but it is alarming mid-clinic.</p>
      </div>
${sections}
      <p class="muted small sql-note">The scripts are published straight from the <code>supabase</code> folder of the <a href="https://github.com/DamicoHealth/dh-emr/tree/main/supabase" rel="noopener">DH EMR source</a>, which also holds the same instructions as SETUP.md.</p>
    </div>
  </div>
</main>

<div class="notice">
  <div class="wrap">
    <p>DH EMR is not a certified EHR and is not HIPAA-compliant. It is intended for global-health use outside the US.</p>
  </div>
</div>

<footer class="site-footer">
  <div class="wrap">
    <nav aria-label="Footer">
      <a href="../">Home</a>
      <a href="../clinic/">Clinic</a>
      <a href="../field/">Field</a>
      <a href="../guides/">Guides</a>
      <a href="../demo/clinic/">Clinic demo</a>
      <a href="../demo/field/">Field demo</a>
      <a href="../privacy/">Privacy</a>
      <a href="../terms/">Terms</a>
    </nav>
    <p>Damico Health - free, open tools for global-health clinics.</p>
  </div>
</footer>

<script>
  // Copy buttons: the whole script, exactly as published. Falls back to
  // selecting the text when the clipboard API is unavailable (http, old
  // browsers), so a manual Cmd+C / Ctrl+C still works.
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const pre = document.getElementById(btn.dataset.copy)
      const label = btn.textContent
      try {
        await navigator.clipboard.writeText(pre.textContent)
        btn.textContent = 'Copied'
      } catch {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        btn.textContent = 'Selected: press Ctrl+C or Cmd+C'
      }
      setTimeout(() => { btn.textContent = label }, 2500)
    })
  }
</script>

</body>
</html>
`
writeFileSync(join(out, 'index.html'), html)
console.log(`wrote ${join(out, 'index.html')} and ${SCRIPTS.length} scripts`)
