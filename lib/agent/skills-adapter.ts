import { SKILL_INDEX, readDesignSystemTemplate } from '@/lib/agent/skills';

export const DESIGN_SYSTEM_CSS = 'design-system.css';
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
  p a, li a, dd a, td a { text-decoration: underline; text-underline-offset: 2px; }
}
@layer components {
  .btn-primary { @apply bg-accent-strong text-page hover:bg-accent-strong/90; }
  .btn-soft { @apply text-accent-strong; }
  .btn-link { @apply text-accent-strong; }
  .btn-danger { @apply bg-danger-strong text-page hover:bg-danger-strong/90; }
  .badge-accent { @apply text-accent-strong; }
  .badge-signal { @apply text-ink-display; }
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

/** Adapter text injected into the system prompt for WEB_APP artifacts. */
export const DESIGN_SYSTEM_BLOCK = [
  'DESIGN ENGINE (bm-skills, Builder Methods). Skills are instructions only; you cannot run commands or npm here. Read them with read_skill:',
  SKILL_INDEX,
  '',
  'How to apply bm-design-system in this sandbox (overrides the skill where it assumes a shell, npm, routes or AGENTS.md edits):',
  `1. New static sites start with a seeded ${DESIGN_SYSTEM_CSS} (tokens, Tailwind v4 @theme, component classes). Do not delete or rewrite it wholesale. Before styling, read_skill bm-design-system SKILL.md and references/agent-instructions.md, and skim ${DESIGN_SYSTEM_CSS} to learn the token and class names.`,
  `2. index.html MUST include exactly one <link rel="stylesheet" href="${DESIGN_SYSTEM_CSS}"> in <head>. The server swaps it for the Tailwind v4 runtime plus your CSS at preview time, so Tailwind utilities (bg-page, bg-surface, text-ink-body, text-ink-display, border-hairline, bg-accent, ...) and the component classes (btn btn-primary, etc.) work. Do not add other Tailwind or CSS-framework links.`,
  `3. Add these font tags in <head> (design-system defaults Inter + DM Sans):\n${DESIGN_SYSTEM_FONT_LINKS}`,
  '4. Use tokens and component classes, not raw hex or one-off values. Bare semantic HTML (h1-h6, p, a, ul, label) is already styled. If a primitive is missing, add a small class to the end of design-system.css instead of inline styles.',
  '5. Brand colour: if the user gave a brand colour, change only the accent triplet (--color-accent, -faded, -display) in BOTH :root @theme and .dark, following references/derive-palette.md. Otherwise keep the defaults.',
  '6. Skip the skill steps that need a shell or a React project (route page, component copy, npm installs, AGENTS.md edits, favicon image generation). For a favicon, write a simple icon.svg and link it.',
  '7. The design system works with the static stack (index.html + design-system.css + script.js). It is not wired into React (esbuild) artifacts yet, so build marketing sites and content pages as static unless real app state needs React.',
  '8. Contrast: the upstream accent pairs fail WCAG AA in light mode, so the seeded CSS ends with an accessibility overlay. For small accent text, eyebrows and links use text-accent-strong (never text-accent or text-accent-display); filled buttons are btn-primary (already fixed by the overlay); on signal backgrounds use text-ink-display.',
  '9. Start every new website or app screen from a template: call use_template with no arguments to list them, pick the closest (landing, app-dashboard, auth, settings, admin-table), call use_template with its id, then customise ALL of it. Templates only seed an empty artifact. Replace every {{placeholder}}; complete_build is blocked while any remain. Add pages by writing new .html files that link design-system.css and reuse the template markup.',
  '10. Keep semantics when editing templates: a <dl> group holds only <dt>/<dd>; wide tables go inside <div class="overflow-x-auto"> so phones never scroll the whole page sideways; every control needs a visible label.',
  '11. In planning, read_skill bm-prd-creator (SKILL.md and steps/core-purpose.md, top-level-features.md, out-of-scope.md) to shape your single question per turn and the final plan (purpose, features, out of scope, stack).',
].join('\n');
