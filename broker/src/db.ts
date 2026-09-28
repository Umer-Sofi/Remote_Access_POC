import pg from 'pg';
import { config } from './config.js';

// One shared connection pool for the process.
export const db = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function waitForDb(attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
