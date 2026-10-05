import { prismaAdapter } from '@better-auth/prisma-adapter';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { prisma } from './prisma';
import { provisionNewUser } from './auth/provision-user';

const useDatabase = Boolean(process.env.DATABASE_URL);

// Local development only: lets you sign in without Google/GitHub OAuth apps.
// Hard-disabled in production builds regardless of the env flag.
// Comma-separated list of emails allowed to create an account when dev email
// auth is on. Empty list = nobody can sign up (fail closed).
const allowedEmails = (process.env.ALLOWED_EMAILS ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const devEmailAuth =
  process.env.NODE_ENV !== 'production' &&
  process.env.ENABLE_DEV_EMAIL_AUTH === '1';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  ...(useDatabase
    ? {
        database: prismaAdapter(prisma, {
          provider: 'postgresql',
        }),
      }
    : {}),
  ...(devEmailAuth
    ? { emailAndPassword: { enabled: true, minPasswordLength: 12 } }
    : {}),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    },
  },

  user: {
    additionalFields: {
      username: {
        type: 'string',
        required: false,
      },
    },
  },

  ...(useDatabase
    ? {
        databaseHooks: {
          user: {
            create: {
              before: async (user) => {
                if (
                  devEmailAuth &&
                  !allowedEmails.includes(String(user.email).toLowerCase())
                ) {
                  throw new APIError('FORBIDDEN', {
                    message: 'Sign-up is restricted on this instance.',
                  });
                }
                return { data: user };
              },
              after: async (user) => {
                await provisionNewUser({
                  id: user.id,
                  name: user.name,
                  email: user.email,
                  username:
                    typeof user.username === 'string' ? user.username : null,
                });
              },
            },
          },
        },
      }
    : {}),
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
