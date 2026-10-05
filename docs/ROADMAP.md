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

## Done after session 1
- Production export, launch gate, EstherCare polish pass (see docs/launch/esthercare.md).
- Lesson: automated scores (Lighthouse 100) missed two invisible-text bugs. A screenshot-based visual check belongs in the agent loop (session 2).

## Session 2 (done on branch feat/session2-render-check)
- `check_preview`: headless Chrome renders desktop, phone and dark mode; measured findings (invisible text via a pixel-vs-computed-colour detector, sideways scroll, broken/blocked images, console errors, tap targets, axe-core) and screenshots go back to the agent. First check walks the whole page (7 views), re-checks send 3; `look_at` crops around the thing just edited. `complete_build` is blocked until the latest version was checked and has no errors; if Chrome is unavailable the agent must say the page was not visually checked.
- Snapshots before every agent run on an existing site; `bun run scripts/snapshots.ts list|create|restore`.
- Tests: tests/render-check.test.ts (7), tests/snapshots.test.ts (5), tests/site-audit.test.ts (13).
- Proven end to end: the agent found and fixed a real historical invisible-button bug on its own, and reported honestly what it did and did not see.

## Next
- Session 3a: image slots (named, with an upload panel and optional Codex image generation) so generated sites are not text-only; `apply_template` (restyle/replace with snapshot, restore button in the editor).
- Session 3b: `capture_reference(url)` with SSRF defences (https/443 only, resolve and refuse private ranges, pin IP, re-check redirects and subresources, size/time caps, untrusted-content wrapping).
