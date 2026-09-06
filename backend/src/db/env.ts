import { config } from 'dotenv';
import { join } from 'node:path';

/**
 * Loads backend/.env for scripts run outside Nest (migrate, seed, tests).
 * Inside the app, ConfigModule already does this.
 */
export function loadEnv() {
  config({ path: join(__dirname, '..', '..', '.env') });
}
