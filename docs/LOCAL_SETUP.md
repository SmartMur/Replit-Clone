# Local setup

Everything binds to `127.0.0.1`. Nothing is exposed to the network.

## One-time
1. Postgres (dedicated container, own volume, localhost only, port 5433):
   ```bash
   docker run -d --name replit-clone-pg --restart unless-stopped \
     -p 127.0.0.1:5433:5432 -e POSTGRES_USER=replit \
     -e POSTGRES_PASSWORD="$(openssl rand -hex 20)" -e POSTGRES_DB=replit_clone \
     -v replit-clone-pgdata:/var/lib/postgresql/data postgres:17-alpine
   ```
2. `npm ci --ignore-scripts` (the only dependencies with install scripts are
   `esbuild`, `sharp`, `prisma`, `@prisma/engines`, `unrs-resolver`; their
   binaries come from verified platform packages, so the scripts are not needed).
3. Create `.env.local` (gitignored):
   ```
   DATABASE_URL=postgresql://replit:<password>@127.0.0.1:5433/replit_clone
   BETTER_AUTH_URL=http://127.0.0.1:3000
   NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
   BETTER_AUTH_SECRET=<openssl rand -base64 32>
   ANTHROPIC_API_KEY=<needed for the AI agent>
   ENABLE_DEV_EMAIL_AUTH=1   # local only, see below
   ```
4. `npx prisma generate && npx prisma migrate deploy`

## Run
`scripts/dev.sh` then open http://127.0.0.1:3000

## Signing in locally
Upstream only supports Google/GitHub OAuth. With `ENABLE_DEV_EMAIL_AUTH=1`
(ignored when `NODE_ENV=production`) email/password sign-up is enabled in
better-auth. The UI has no form for it, so create the account with:
```bash
curl -c jar -X POST http://127.0.0.1:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3000' \
  -d '{"email":"you@local.test","password":"<12+ chars>","name":"You"}'
```
or configure GitHub/Google OAuth credentials in `.env.local`.

## Where data lives
- Project files: `.data/project-workspace/` (gitignored, outside `public/`)
- Avatars: `public/uploads/avatars/`
- Database: docker volume `replit-clone-pgdata`
