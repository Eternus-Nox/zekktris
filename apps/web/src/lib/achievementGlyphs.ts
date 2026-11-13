/**
 * Achievement badge glyphs — which icon each badge wears.
 *
 * Shared by the achievements shelf (app/AchievementsShelf, which re-exports
 * these) and the achievement-unlock toast (state/AppState), so an unlocked
 * badge pops up wearing exactly the glyph it then shows on the shelf. It lives
 * in lib/ so the always-loaded app state can use it without pulling the
 * lazily-loaded shelf component into the main bundle.
 */

import type { ComponentType } from 'react';
import {
  Activity,
  BarChart,
  Bookmark,
  Calendar,
  CalendarCheck,
  Camera,
  CircleInCircle,
  Compass,
  Flame,
  Hand,
  HandPointing,
  HandTap,
  Heart,
  Key,
  Landmark,
  Lock,
  MessageSquare,
  Mic,
  MoonStar,
  PawPrint,
  Phone,
  Radio,
  Shield,
  Smile,
  Sparkles,
  Sprout,
  Sun,
  Timer,
  Users,
  Zap,
} from './icons';

export type BadgeGlyph = ComponentType<{ size?: number; className?: string }>;

// Each glyph follows the iOS badge's SF Symbol (Achievement.sfSymbol in
// ios-native Models.swift), so a badge reads the same on both clients and
// two badges share a glyph only where iOS gives them one symbol (Marathon
// and Inseparable: a flame). The one gap left: Guardian Angel's adult and
// child has no glyph here yet, so it borrows Social Circle's Users.

/** Single badges, by their exact id (a Map: an id is server data, and must
    never find an Object.prototype member). */
export const BADGE_EXACT_ICONS: ReadonlyMap<string, BadgeGlyph> = new Map<string, BadgeGlyph>([
  ['locked_in', Key],
  ['double_locked', Shield],
  ['tagged', Bookmark],
  ['framed', Camera],
  ['signature_look', Sparkles],
  ['off_the_record', Lock],
  ['discovered', Compass],
  ['guardian_angel', Users],
  ['first_contact', Radio],
]);

/**
 * Badge families, by id PREFIX, so every rung shares its family's glyph:
 * `family_<goal>`, and the legacy bare first rungs too (`founder`,
 * `welcome_committee`, `event_horizon` — exact matches here once left their
 * higher rungs on the fallback). Tried in order, first match wins: a prefix
 * must never start with an earlier one, or that family silently wears the
 * earlier family's glyph — so put the more specific prefix first
 * (`founding_member` is not a `founder`, and doesn't start with it).
 */
export const BADGE_PREFIX_ICONS: ReadonlyArray<readonly [prefix: string, icon: BadgeGlyph]> = [
  ['pet_keeper', PawPrint],
  ['pet_perfect_day', Sun],
  ['kindred', Heart],
  ['inseparable', Flame],
  ['regular', Calendar],
  ['vanishing_act', Timer],
  ['crowd_pleaser', Smile],
  ['pollster', BarChart],
  ['ring_ring', Phone],
  ['poke_sent', HandPointing],
  ['poke_received', HandTap],
  ['founding_member', Sprout],
  ['veteran', CalendarCheck],
  ['chatterbox', MessageSquare],
  ['social', Users],
  ['night_owl', MoonStar],
  ['first_responder', Zap],
  ['marathon', Flame],
  ['founder', Landmark],
  ['voice_of_people', Mic],
  ['welcome_committee', Hand],
  ['event_horizon', CircleInCircle],
];

/** A badge's glyph. The server sends none (only its `marker`), so an id
    neither table knows gets Activity, the shelf's default glyph. */
export function badgeIcon(id: string): BadgeGlyph {
  const exact = BADGE_EXACT_ICONS.get(id);
  if (exact) return exact;
  for (const [prefix, icon] of BADGE_PREFIX_ICONS) if (id.startsWith(prefix)) return icon;
  return Activity;
}
