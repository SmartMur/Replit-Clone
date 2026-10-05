# Builder-experience roadmap

Evidence: 12 agent turns across three EstherCare builds (owner feedback verbatim in the planning notes) plus the engineering sessions that built this platform.

## Session 1 (done on branch feat/session1-and-images)
- Design-system CSS is platform-managed (virtual file, composed at serve time with the accessibility overlay). The agent writes `site.css` only; a broken `site.css` is dropped, not fatal.
- Compile check, asset check (missing files, remote images), unknown classes, sample-content marking (`data-sample`, highlighted in preview), inline-style and hex warnings, theme-toggle and `<dl>` checks at `complete_build`. Errors block; warnings block once.
- Approved plan is replayed on follow-up turns (it was silently dropped before).
- Landing template has a light/dark toggle.
- `scripts/generate-images.mjs`: generate site photography with Codex native image generation (owner's Codex login, no API key), one image at a time (parallel runs stalled).
- Tests: `bun test tests/site-audit.test.ts`.

## Decisions (owner, 2026-10-05)
1. Photos: AI-generated via Codex image generation into named image slots, owner can replace with real photos any time.
2. Reference capture (agent sees URLs the owner pastes): YES, limited to URLs in the owner's own messages. Not built yet.
3. Strictness: the assistant decides. Chosen: errors block (compile failure, missing/remote assets, unmarked invented content, more than 8 inline styles, more than 5 unknown classes); warnings block once so the agent must acknowledge them.

## Next
- Session 2: headless-Chrome render check with screenshots fed back to the agent; snapshots before template/design-system swaps and `apply_template`; image upload panel.
- Session 3: `capture_reference(url)` with SSRF defences (https/443 only, resolve and refuse private ranges, pin IP, re-check redirects and subresources, size/time caps, untrusted-content wrapping).
