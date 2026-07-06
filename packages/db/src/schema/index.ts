/**
 * Schema barrel
 * -------------
 * Re-exports every table, relation, and inferred type. The Drizzle client is
 * constructed against this aggregate so `db.query.users.findFirst(...)` etc.
 * work for any defined entity.
 *
 * Tables are split across files by domain (users, guilds, channels,
 * messages) for editing sanity, but at the SQL level there's a single
 * relational graph and this barrel reconstructs that view.
 */

export * from './enums';
export * from './users';
export * from './guilds';
export * from './channels';
export * from './messages';
export * from './webhooks';
export * from './polls';
export * from './reactionRoles';
export * from './automod';
export * from './events';
export * from './savedMessages';
export * from './scheduledMessages';
export * from './botCommands';
export * from './family';
export * from './instanceSettings';
export * from './reports';
export * from './security';
export * from './subscriptions';
export * from './pokes';
