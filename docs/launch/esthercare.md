# EstherCare: launch checklist

State on 2026-10-05: design, copy, mobile and security pass done; production export verified (Lighthouse 100/100/100 on desktop, mobile and the privacy page; strict CSP with zero violations; layout shift 0). `data-sample` highlights mark everything that still needs a real decision. The exporter refuses to build until they are gone.

## Export
```
bun run scripts/export-static.ts <project>/main dist --origin https://YOUR-DOMAIN --security-contact mailto:you@YOUR-DOMAIN
node scripts/serve-dist.mjs dist 4500     # local check with the real headers
```
Serve `dist/` over HTTPS with the headers in `dist/_headers` (Netlify / Cloudflare Pages) or `dist/nginx-security.conf`. Run the CSP as `Content-Security-Policy-Report-Only` for a week first.

## Only the owner can confirm (claims a care business must be able to prove)
1. Insurance and bonding (the word "insured" was removed from the page until proven).
2. Background checks: police information check with vulnerable sector check, references, training. The FAQ and the "Every companion" figure are marked as sample.
3. Services: overnight, live-in and 24/7 visits, the 2-hour minimum, 24-hour notice, "no long-term contracts".
4. Transportation: companions driving clients, and the vehicle insurance behind it.
5. Medication reminders and wheelchair help: check they stay inside the non-medical scope.
6. Sources for "1 in 5 Canadian seniors" and "20+ languages", or remove them.
7. Testimonials and stories must be real and consented. Replace the invented ones; do not pair an invented story with a real person's likeness.
8. Land acknowledgement wording: confirm with local Indigenous guidance (Treaty 6, Métis homeland, which Nations to name).
9. Real phone, email and hours everywhere (utility bar, contact section, footer, privacy notice, both forms' fallback address).

## Must be built before launch
1. **Forms send nothing yet.** Set `data-endpoint` on both forms to a real HTTPS endpoint (see design below). Until then they open an email draft as a fallback.
2. **Privacy notice** (privacy.html) is a draft: legal review against Alberta PIPA and PIPEDA, then fill the highlighted details.
3. **Photos are AI-generated.** Replace with real, consented photography when available; the slots are `images/<name>.jpg` (hero, team, companionship, meals, outings, story1 to story3).

## Form endpoint design (from the security review)
POST JSON over HTTPS to your own endpoint in Canada; no cookies, no GET, no PII in URLs or logs; validate on the server (lengths, phone and email format, `need` as an enum, strip control characters); send notifications as plain text, never HTML; honeypot and minimum fill time are already in the page, add a per-IP rate limit (about 5 per 10 minutes); store the consent version and time that the page already sends; set a retention period; restrict CORS to your origin.

## Known and accepted
- Dev preview loads Google Fonts; the export self-hosts Inter and DM Sans.
- Platform: previews run on the app origin (see SECURITY_AUDIT.md R1). Do not host the editor publicly before moving previews to a separate cookieless origin.
- Taste calls left to the owner: blue headings versus ink headings, the amount of full-width blue bands, and the three Lighthouse-clean but subjective layout suggestions in the design review.
