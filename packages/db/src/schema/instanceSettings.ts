import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Instance-wide key/value settings an admin can change at runtime (as opposed
 * to env, which requires a redeploy). Values are stored as text — booleans as
 * 'true'/'false', etc. Absence of a row means "fall back to the env default".
 */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
