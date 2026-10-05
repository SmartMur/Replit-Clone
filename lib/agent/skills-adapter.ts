import { SKILL_INDEX, readDesignSystemTemplate } from '@/lib/agent/skills';

export const DESIGN_SYSTEM_CSS = 'design-system.css';
export const DESIGN_SYSTEM_FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">',
].join('\n');

/**
 * Upstream is inconsistent about fonts (SKILL.md: Inter + DM Sans, the CSS names a font
 * we cannot load). We follow SKILL.md's locked defaults and pin them in the seeded CSS.
 */
export async function renderDesignSystemCss() {
  const template = await readDesignSystemTemplate();
  return template
    .replace(/--font-display:[^;]+;/, "--font-display: 'Inter', ui-sans-serif, system-ui, sans-serif;")
    .replace(/--font-sans:[^;]+;/, "--font-sans: 'DM Sans', ui-sans-serif, system-ui, sans-serif;");
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
  '8. Contrast: the default accent on a white page fails WCAG AA for small text. For small accent-coloured text (eyebrows, labels, links) use the darker text-accent-display token; reserve text-accent for large text and icons.',
  '9. In planning, read_skill bm-prd-creator (SKILL.md and steps/core-purpose.md, top-level-features.md, out-of-scope.md) to shape your single question per turn and the final plan (purpose, features, out of scope, stack).',
].join('\n');
