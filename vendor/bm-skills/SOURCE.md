# bm-skills (vendored, read-only)

- Upstream: https://github.com/buildermethods/bm-skills by Brian Casel (Builder Methods)
- Pinned commit: d42872fdf28b7b48df45a321b1890254ffcb77a8 (2026-10-04)
- Included: bm-design-system, bm-prd-creator, bm-favicon-creator. Not included: bm-skill-builder, .agents/ (cloud setup scripts that use sudo and curl|sh), .claude-plugin/.
- Licence: upstream has no LICENSE file; its README says "Open source. Free to use, fork, and adapt." Treat as permissive by stated intent, confirm with the author before redistributing this repo publicly.
- Files are NOT modified. Our adaptation lives in lib/agent/skills-adapter.ts and lib/agent/skills.ts.
- Integrity: MANIFEST.json holds sha256 per file; run `node scripts/verify-bm-skills.mjs`.
- Updating: re-clone, review the diff as untrusted text (it becomes agent instructions), re-pin the SHA, regenerate the manifest.
