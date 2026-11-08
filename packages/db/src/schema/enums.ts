import { pgEnum } from 'drizzle-orm/pg-core';

export const userStatusEnum = pgEnum('user_status', [
  'online',
  'idle',
  'dnd',
  'offline',
  'invisible',
]);

export const channelTypeEnum = pgEnum('channel_type', [
  'guild_text',
  'guild_category',
  'guild_voice', // reserved — accepted by schema, not exposed in v1 UI
  'guild_stage', // stage / town-hall — speaker / audience model
  'guild_forum', // post-list container; children are public_thread "posts"
  'guild_link', // external URL bookmark; clicking prompts before navigation
  'public_thread',
  'dm',
  'group_dm',
]);

export const relationshipTypeEnum = pgEnum('relationship_type', [
  'outgoing_request',
  'incoming_request',
  'friend',
  'blocked',
]);

export const overrideTargetEnum = pgEnum('override_target', ['role', 'member']);

// Parental controls. A supervision link moves pending → active (child
// accepted) and can later be revoked. Flags record whether the watched
// message was outbound or inbound from the child's perspective.
export const parentLinkStatusEnum = pgEnum('parent_link_status', [
  'pending',
  'active',
  'revoked',
]);

export const flagDirectionEnum = pgEnum('flag_direction', [
  'sent',
  'received',
]);

// A supervised child can ask their parent to approve an action they're
// restricted from doing themselves.
export const childRequestTypeEnum = pgEnum('child_request_type', [
  'friend',
  'guild',
]);

export const childRequestStatusEnum = pgEnum('child_request_status', [
  'pending',
  'approved',
  'denied',
]);

export const messageTypeEnum = pgEnum('message_type', [
  'default',
  'reply',
  'system_join',
  'system_leave',
  'system_pin',
  'system_channel_name_change',
  'system_recipient_add',
  'system_recipient_remove',
  'system_call',
  // Disappearing-messages timer changed (migration 0133). Its metadata is
  // { kind: 'disappearing_timer', timerSeconds, initiatorId }.
  'system_disappearing',
]);

export const auditTargetEnum = pgEnum('audit_target', [
  'guild',
  'channel',
  'role',
  'member',
  'message',
  'invite',
  'webhook',
  'emoji',
  'sticker',
  'automod_rule',
  'scheduled_event',
]);

/**
 * Per-user notification overrides target either a guild (mutes ALL its
 * channels unless a per-channel override re-enables) or a single
 * channel. Discord uses similar two-tier overrides; the per-channel
 * row wins when both exist.
 */
export const notificationTargetEnum = pgEnum('notification_target', [
  'guild',
  'channel',
]);

/**
 * Notification level controls how aggressive the push/badge surfacing
 * is for a given target. Mirrors Discord's options:
 *   - all      → push + badge for every message
 *   - mentions → push + badge only when mentioned (or DM)
 *   - nothing  → no push, no badge increment (mentions still INCREMENT
 *               the unread count; they just don't bubble to push or
 *               external surfaces). This is the "mute" UX.
 */
export const notificationLevelEnum = pgEnum('notification_level', [
  'all',
  'mentions',
  'nothing',
]);
