# Security audit (2026-10-05)

Scope: full read of auth, agent tools, preview/bundler, file storage, server
actions, Stripe webhook, dependencies. Upstream is a third-party tutorial
project (fork of `aalleejustadev/Replit-Clone`, 3 commits). Findings were
reproduced against a running instance before fixing.

## Fixed in `hardening/local-setup`

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Critical | **Path traversal via `artifactSlug`** in `/api/projects/:id/preview/:slug/...`. The slug was never validated, so `..%2f..%2f..` as the slug moved the served root up to the app directory. Reproduced: unauthenticated read of `package.json` and `.env.local` (DB URL, auth secret) whenever any project had a public deployment, and by any logged-in user for projects they could access. | `artifactWorkspaceDir()` now validates project id and slug against `^[A-Za-z0-9][A-Za-z0-9_-]*$` and throws otherwise; every caller goes through it. |
| 2 | High | **Prefix-only containment check** (`startsWith(dir)` with no separator) in 3 places, so `/ws/abc` also "contains" `/ws/abc-evil`. | New `isPathInside()` (separator-aware), used everywhere. |
| 3 | High | **Project files stored under `public/`**, so Next served them statically and skipped the preview authorization (images/SVG bypass the auth proxy entirely). | Workspace moved to `.data/project-workspace` (override `PROJECT_WORKSPACE_ROOT`), outside `public/`. Sample project committed by upstream removed from tracking. |
| 4 | High | **esbuild bundler could read any host file.** `import x from '../../../../some.json'` (or a bare package) was bundled into the served JS. Reachable by anything the agent writes, including prompt-injected content. | `confineToWorkspacePlugin`: every resolved import must be inside the artifact folder; only the CDN-mapped React packages stay external. Verified both the block and a normal local import. |
| 5 | Critical (dep) | Next.js 16.2.9: unauthenticated RCE advisories (image optimizer with AVIF, `next/og`), plus vulnerable postcss and sharp. | Upgraded to `next@16.3.8`, `eslint-config-next@16.3.8`; ran `npm audit fix`. |
| 6 | Low | `Content-Disposition` filename built from unsanitized path. | Sanitized. Also added `X-Content-Type-Options: nosniff` on preview responses. |
| 7 | Info | Local login impossible without OAuth apps. | `ENABLE_DEV_EMAIL_AUTH=1` enables email/password; hard-disabled when `NODE_ENV=production`. |

## Reviewed, no issue found
- Server actions and API routes check the session and project membership (`getAccessibleProject`) before acting.
- Stripe webhook verifies the signature and de-duplicates events.
- Agent tools are file-only (list/read/write/edit); there is no shell or network tool. File paths go through `normalizeRelativePath` and containment.
- Avatar upload allow-lists MIME type and derives the extension from it; served as an image type.
- Registry packages all have verified signatures; no git/URL dependencies.

## Residual risks (not fixed)
- **R1: previews run on the app origin.** Generated HTML/JS is served from `/api/projects/.../preview/...` with the user's session cookie. Script in a generated site can call the app's own endpoints as the logged-in user. Acceptable for single-user localhost where you wrote the prompts; **not acceptable for multi-user or public hosting.** Proper fix is a separate preview origin (for example `*.preview.example.com`) or sandboxed iframes plus signed URLs. Do not expose this instance publicly until that is done.
- **R1b: the editor preview iframe uses `sandbox="allow-scripts allow-same-origin"`** (`components/app/editor/artifact-preview.tsx:288`). With same-origin allowed, generated JS is not isolated from the app. Same fix as R1.
- **R2: 9 high `npm audit` findings remain**, all in Prisma's CLI toolchain (`prisma` → `@prisma/dev` → `mysql2`, `deepmerge-ts`, `@prisma/config`). They are not loaded by the running app (it uses the `pg` adapter). npm's suggested "fix" is a downgrade to Prisma 6 and was not applied.
- **R3: previews load React from esm.sh** (CDN import map) in the browser. Pin versions or self-host before relying on this.
- **R4: no rate limiting** on the agent endpoint beyond per-plan turn limits; the Anthropic key bills per call.
- **R5: avatar MIME check trusts the client-declared type** (content not sniffed). Low impact because the extension fixes the served type.

## Agent backend change (feat/subscription-agent)
The agent now uses the Claude Agent SDK on the owner's subscription login. Verified: the CLI exposes exactly one tool
family (`mcp__builder__*`), no slash commands, child env contains only PATH/HOME/LANG-type vars, a second concurrent run
on a project returns 409, and a full plan-then-build flow produces files, database rows and a working preview.
Residual: prompt injection in attachments can still make the agent write arbitrary files inside the artifact folder (see R1).

## bm-skills design engine (feat/bm-skills)
Third-party instruction content (vendor/bm-skills, pinned d42872f, 64 files, sha256 manifest, `node scripts/verify-bm-skills.mjs`).
- Exposure: the text becomes agent instructions. The agent has file tools only and the skill reader is read-only, restricted to .md/.css/.html/.txt inside three skill folders (traversal, absolute paths, .tsx and unvendored skills refused; unit-tested).
- Not vendored: `.agents/setup` and `.agents/resume` (sudo, curl|sh, Postgres config changes), the plugin manifests, bm-skill-builder.
- Tailwind v4 browser runtime is served from our own origin (`@tailwindcss/browser@4.3.3`, MIT), not a CDN.
- Generated sites load Inter and DM Sans from Google Fonts (the design system default). This is an external request from every generated site; switch to self-hosted fonts if that matters.
- Licence: upstream has no LICENSE file (README says free to use, fork, adapt). Confirm before publishing this repo publicly with the vendored copy.

## Templates and accessibility overlay (feat/templates)
- `use_template` only reads `templates/<id>/` where id matches `^[a-z0-9-]+$` and is listed by a valid template.json; file names must be plain names. Seven bad ids tested (traversal, absolute, case, empty).
- Measured finding: upstream bm-design-system light-mode accent pairs fail WCAG AA (btn-primary 2.36:1, text-accent 2.36:1, accent-display text 3.36:1, btn-danger 3.74:1, signal 2.09:1). An overlay appended to the seeded copy adds accent-strong/danger-strong tokens (5.49:1 on white), underlines in-text links and fixes the pressed toggle. The vendored file is unchanged.
- The Tailwind browser runtime makes a stray request for `tailwindcss` virtual paths; the preview server answers those with an empty stylesheet.
- Agent edits can still introduce defects (a malformed `<dl>` scored 96). A server-side accessibility check at complete_build would catch this class; not built.

## EstherCare production pass (2026-10-05)
Three independent reviews (copy, secure coding, visual and mobile) plus hands-on tests in a real browser.
- Site code: no exploitable XSS. Hostile input is shown as plain text (tested end to end against a stub endpoint); no `innerHTML`, `eval` or inline handlers remain after removing the SVG illustration generator; no third-party scripts; no `target=_blank`.
- Fixed: both forms silently discarded submissions (now: real endpoint support, honest error, email-draft fallback, consent checkbox, honeypot, minimum fill time); no privacy notice (draft added); focus return and Escape handling; slider pause control and reduced-motion support (WCAG 2.2.2); touch targets 44px; headings order; contrast on the blue bands; invisible button label and invisible consent link (both `.on-dark a` overriding white-on-white; automated accessibility tools did not catch them, screenshots did).
- Production export (`scripts/export-static.ts`): precompiled CSS (47KB) instead of a 282KB in-browser runtime, self-hosted fonts, no inline scripts or styles, strict CSP verified with zero violations, security headers, 404, robots, sitemap, security.txt, canonical and social tags; refuses to export while sample content remains.
- Platform change: the accessibility overlay now underlines links inside labels; sample markers are lighter.
- Open: previews on the app origin (R1), forms need a real endpoint, privacy notice needs legal review, owner-only claims in docs/launch/esthercare.md.
