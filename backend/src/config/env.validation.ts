/**
 * Boot-time environment checks.
 *
 * Deliberately fatal rather than warning: a service that starts with a default
 * signing key is worse than one that refuses to start, because nobody notices
 * the former until tokens are being forged.
 */

const EXAMPLE_SECRET = 'change-me-in-production';
const MIN_SECRET_LENGTH = 32;

export interface Env extends Record<string, unknown> {
  NODE_ENV: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  PORT: number;
}

export function validateEnv(config: Record<string, unknown>): Env {
  const problems: string[] = [];
  const nodeEnv = String(config.NODE_ENV ?? 'development');
  const isProduction = nodeEnv === 'production';

  const databaseUrl = String(config.DATABASE_URL ?? '');
  if (!databaseUrl) {
    problems.push('DATABASE_URL is required.');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// connection string.');
  }

  const jwtSecret = String(config.JWT_SECRET ?? '');
  if (!jwtSecret) {
    problems.push('JWT_SECRET is required. Generate one with: openssl rand -hex 32');
  } else if (isProduction) {
    if (jwtSecret === EXAMPLE_SECRET) {
      problems.push('JWT_SECRET is still the example value. Generate one with: openssl rand -hex 32');
    }
    if (jwtSecret.length < MIN_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`);
    }
  }

  const port = Number(config.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('PORT must be a valid port number.');
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nSee backend/.env.example.`,
    );
  }

  return { ...config, NODE_ENV: nodeEnv, DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret, PORT: port };
}

export const isTrue = (value: unknown): boolean => String(value ?? '').toLowerCase() === 'true';
