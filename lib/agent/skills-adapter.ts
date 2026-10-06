import { SKILL_INDEX, readDesignSystemTemplate } from '@/lib/agent/skills';

export const DESIGN_SYSTEM_CSS = 'design-system.css';
export const SITE_CSS_FILE = 'site.css';
export const DESIGN_SYSTEM_FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">',
].join('\n');

/**
 * Upstream light-mode accent pairs fail WCAG AA (measured with relative luminance:
 * btn-primary 2.36:1, text-accent 2.36:1, accent-display text 3.36:1, btn-danger 3.74:1).
 * This overlay is appended to the seeded copy only; the vendored file stays untouched.
 * Strong tokens reach >= 4.5:1 in light mode and map to the bright dark-mode accents.
 */
export const ACCESSIBILITY_OVERLAY = `
/* --- Accessibility overlay (Replit-Clone, not part of upstream bm-design-system) ---
   Upstream light-mode accent pairs fail WCAG AA. Use accent-strong / danger-strong for
   any small accent text, links and filled buttons. Values measured: 5.49:1 on white. */
@theme {
  --color-accent-strong: oklch(50% 0.12 215.221);
  --color-danger-strong: oklch(55% 0.2 25);
}
.dark {
  --color-accent-strong: oklch(78.9% 0.154 211.53);
  --color-danger-strong: oklch(72% 0.2 22);
}
@layer base {
  a { color: var(--color-accent-strong); }
  a:hover { color: color-mix(in oklab, var(--color-accent-strong), black 15%); }
  /* Links inside running text must not rely on colour alone (WCAG 1.4.1). */
  p a, li a, dd a, td a, label a { text-decoration: underline; text-underline-offset: 2px; }
}
@layer components {
  .btn-primary { @apply bg-accent-strong text-page hover:bg-accent-strong/90; }
  .btn-soft { @apply text-accent-strong; }
  .btn-link { @apply text-accent-strong; }
  .btn-danger { @apply bg-danger-strong text-page hover:bg-danger-strong/90; }
  .badge-accent { @apply text-accent-strong; }
  .badge-signal { @apply text-ink-display; }
  /* Invented/sample content (data-sample): highlighted so the owner replaces it before launch. */
  [data-sample] {
    background: color-mix(in oklab, var(--color-signal) 14%, transparent);
    outline: 1.5px dashed color-mix(in oklab, var(--color-signal-display) 70%, transparent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .toggle-button-on,
  .toggle-button[aria-pressed="true"] { @apply text-accent-strong; }
}
`;

/**
 * Upstream is inconsistent about fonts (SKILL.md: Inter + DM Sans, the CSS names a font
 * we cannot load). We follow SKILL.md's locked defaults and pin them in the seeded CSS.
 */
export async function renderDesignSystemCss() {
  const template = await readDesignSystemTemplate();
  const base = template
    .replace(/--font-display:[^;]+;/, "--font-display: 'Inter', ui-sans-serif, system-ui, sans-serif;")
    .replace(/--font-sans:[^;]+;/, "--font-sans: 'DM Sans', ui-sans-serif, system-ui, sans-serif;");
  return base + ACCESSIBILITY_OVERLAY;
}

export const SITE_CSS_STUB = `/* site.css: this site's own CSS.
   The design system (tokens, component classes, accessibility overlay) is provided by the platform
   through <link rel="stylesheet" href="design-system.css"> and cannot be edited. This file is
   compiled on its own: if it has an error the page falls back to the plain design system.

   Brand colour: override the accent tokens in BOTH themes (see read_skill bm-design-system
   references/derive-palette.md):
     @theme { --color-accent: oklch(...); --color-accent-faded: oklch(...); --color-accent-display: oklch(...); --color-accent-strong: oklch(...); }
     .dark  { --color-accent: oklch(...); --color-accent-faded: oklch(...); --color-accent-display: oklch(...); --color-accent-strong: oklch(...); }
   Custom classes: write plain CSS declarations. @apply works only with real Tailwind utilities
   (never with another custom class). */
`;

/** Adapter text injected into the system prompt for WEB_APP artifacts. */
export const DESIGN_SYSTEM_BLOCK = [
  'DESIGN ENGINE (bm-skills, Builder Methods). Skills are instructions only; you cannot run commands or npm here. Read them with read_skill:',
  SKILL_INDEX,
  '',
  'How to apply bm-design-system in this sandbox (overrides the skill where it assumes a shell, npm, routes or AGENTS.md edits):',
  `1. The design-system stylesheet is provided and maintained by the platform; you cannot create or edit ${DESIGN_SYSTEM_CSS}. Learn the token and class names with read_skill bm-design-system SKILL.md, references/agent-instructions.md and references/styles/design-system.css. New sites get an empty ${SITE_CSS_FILE} for your own CSS (read it first).`,
  `2. index.html MUST include exactly one <link rel="stylesheet" href="${DESIGN_SYSTEM_CSS}"> in <head>. The server swaps it for the Tailwind v4 runtime plus the design system plus ${SITE_CSS_FILE}, so Tailwind utilities (bg-page, bg-surface, text-ink-body, text-ink-display, border-hairline, bg-accent, ...) and component classes (btn btn-primary, badge, callout, form-control, toggle-button, modal) work. Do not add other Tailwind or CSS-framework links.`,
  `3. Add these font tags in <head> (design-system defaults Inter + DM Sans):\n${DESIGN_SYSTEM_FONT_LINKS}`,
  `4. Use tokens and component classes, not raw hex, inline style attributes or one-off values. Bare semantic HTML (h1-h6, p, a, ul, label) is already styled. If a primitive is missing, add a small class to ${SITE_CSS_FILE} using plain CSS declarations (never @apply another custom class: one such error is what unstyled a whole page before).`,
  `5. Brand colour: if the user gave a brand colour or a reference palette, override only the accent triplet plus accent-strong in ${SITE_CSS_FILE}, inside @theme { } and .dark { }, following references/derive-palette.md. Otherwise keep the defaults.`,
  '6. Skip the skill steps that need a shell or a React project (route page, component copy, npm installs, AGENTS.md edits, favicon image generation). For a favicon, write a simple icon.svg and link it.',
  '7. The design system works with the static stack (index.html + site.css + script.js). It is not wired into React (esbuild) artifacts yet, so build marketing sites and content pages as static unless real app state needs React.',
  '8. Contrast: upstream accent pairs fail WCAG AA in light mode, so the platform adds an overlay. For small accent text, eyebrows and links use text-accent-strong (never text-accent or text-accent-display); filled buttons are btn-primary; on signal backgrounds use text-ink-display.',
  '9. Start every new website or app screen from a template: call use_template with no arguments to list them, pick the closest (landing, app-dashboard, auth, settings, admin-table), call use_template with its id, then customise ALL of it. Templates only seed an empty artifact. Replace every {{placeholder}}; complete_build is blocked while any remain. Add pages by writing new .html files that link design-system.css and reuse the template markup.',
  '10. Keep semantics when editing templates: a <dl> group holds only <dt>/<dd>; wide tables go inside <div class="overflow-x-auto">; every control needs a visible label. Keep the light/dark theme toggle (data-theme-toggle) unless the user says otherwise.',
  '11. Never invent facts. Any invented number, rating, count, percentage, phone number or quote MUST sit inside an element with the data-sample attribute (it is highlighted so the owner replaces it); complete_build is blocked otherwise. Prefer leaving such content out.',
  '12. Images: use only files that exist (images/<name>.jpg) or inline SVG; never hotlink remote images and never reference files you have not created (complete_build is blocked on missing files and remote images). Photography makes a site feel real: call generate_image(slot, description) for the few images that matter (hero and key sections, at most 6, about a minute each). Describe subject, setting, light and mood; no text, logos or real named people. Reference the file with width and height, loading=lazy (hero: fetchpriority=high) and a plain descriptive alt. Never overwrite an image that already exists (the owner may have uploaded it). Generated people are illustrative: never present them as real clients or staff. For businesses where authenticity matters (care, medical, legal), tell the owner they can replace any image with a real photo in the Images panel.',
  '13. You CAN see the rendered page: call check_preview after your edits. It returns screenshots (desktop, phone, dark mode) and measured findings (invisible text, sideways scrolling, broken or blocked images, console errors, accessibility). Pass look_at (the text or selector you just changed) to get crops of exactly that area in every view. LOOK at every screenshot, judge layout, colour, spacing and legibility like a designer, fix what is wrong, and check again. complete_build is blocked until the latest version has been checked and has no errors, and it also runs an automated audit (CSS compile, assets, classes, sample content).',
  '13b. Your final summary must state what you actually saw in the screenshots and what you changed because of it. If check_preview was unavailable, say plainly that the page was not visually checked. Never describe a page you did not see.',
  '14. In planning, read_skill bm-prd-creator (SKILL.md and steps/core-purpose.md, top-level-features.md, out-of-scope.md) to shape your single question per turn and the final plan (purpose, features, out of scope, stack, and any reference sites or images the owner supplied).',
].join('\n');
