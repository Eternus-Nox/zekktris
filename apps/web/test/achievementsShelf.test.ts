import { describe, expect, it } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BADGE_EXACT_ICONS, BADGE_PREFIX_ICONS, badgeIcon } from '../src/app/AchievementsShelf';
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
} from '../src/lib/icons';

// The achievements shelf's badge glyphs. The server sends no icon (only a
// `marker`), so the web maps ids to glyphs itself — by family prefix, so that
// every rung (`family_<goal>`) shares one, with Activity for anything unknown.
// Nothing fails when an id falls through, which is how a dozen badges went
// on showing the fallback: these pin the map.

describe('achievement badge glyphs', () => {
  it('gives every rung of a family its family glyph', () => {
    const cases: Array<[string, ComponentType]> = [
      // The newer families (the server's ids: achievements.ts).
      ['pet_keeper_1', PawPrint],
      ['pet_keeper_25', PawPrint],
      ['pet_perfect_day', Sun],
      ['kindred_2', Heart],
      ['kindred_5', Heart],
      ['regular_30', Calendar],
      ['regular_365', Calendar],
      ['vanishing_act', Timer],
      ['crowd_pleaser_3', Smile],
      ['crowd_pleaser_5', Smile],
      ['pollster_3', BarChart],
      ['pollster_5', BarChart],
      // Badges that used to fall through to the fallback.
      ['inseparable_7', Flame],
      ['inseparable_30', Flame],
      ['inseparable_100', Flame],
      ['ring_ring', Phone],
      ['poke_sent_1', HandPointing],
      ['poke_sent_3', HandPointing],
      ['poke_sent_5', HandPointing],
      ['poke_received_5', HandTap],
      ['founding_member', Sprout],
      // …including the higher rungs of families whose bare first rung was
      // matched exactly.
      ['welcome_committee', Hand],
      ['welcome_committee_10', Hand],
      ['welcome_committee_50', Hand],
      ['event_horizon', CircleInCircle],
      ['event_horizon_600', CircleInCircle],
      // The rest, each on iOS's symbol (Achievement.sfSymbol).
      ['veteran_1', CalendarCheck],
      ['veteran_3', CalendarCheck],
      ['chatterbox_100', MessageSquare],
      ['chatterbox_100000', MessageSquare],
      ['social_5', Users],
      ['social_50', Users],
      ['night_owl', MoonStar],
      ['first_responder', Zap],
      ['marathon', Flame],
      ['founder', Landmark],
      ['founder_100', Landmark],
      ['founder_500', Landmark],
      ['voice_of_people', Mic],
      ['locked_in', Key],
      ['double_locked', Shield],
      ['tagged', Bookmark],
      ['framed', Camera],
      ['signature_look', Sparkles],
      ['off_the_record', Lock],
      ['discovered', Compass],
      ['guardian_angel', Users],
      ['first_contact', Radio],
    ];
    for (const [id, icon] of cases) expect(badgeIcon(id), id).toBe(icon);
  });

  it('tells badges apart where iOS does', () => {
    // iOS's Achievement.sfSymbol (ios-native Models.swift), one id per
    // badge: two badges share a web glyph exactly when they share a symbol
    // there (Marathon and Inseparable are both flames).
    const IOS: Record<string, string> = {
      veteran_1: 'calendar.badge.checkmark',
      chatterbox_100: 'bubble.left.and.bubble.right.fill',
      social_5: 'person.2.fill',
      night_owl: 'moon.stars.fill',
      first_responder: 'bolt.fill',
      marathon: 'flame.fill',
      founding_member: 'leaf.fill',
      founder: 'building.columns.fill',
      voice_of_people: 'mic.fill',
      locked_in: 'key.fill',
      double_locked: 'lock.shield.fill',
      tagged: 'tag.fill',
      framed: 'photo.circle.fill',
      signature_look: 'sparkles',
      welcome_committee: 'hand.wave.fill',
      off_the_record: 'lock.fill',
      discovered: 'safari.fill',
      guardian_angel: 'figure.and.child.holdinghands',
      first_contact: 'antenna.radiowaves.left.and.right',
      event_horizon: 'circle.circle.fill',
      pet_keeper_1: 'pawprint.fill',
      pet_perfect_day: 'sun.max.fill',
      kindred_2: 'heart.fill',
      inseparable_7: 'flame.fill',
      regular_30: 'calendar',
      vanishing_act: 'timer',
      crowd_pleaser_3: 'face.smiling.fill',
      pollster_3: 'chart.bar.fill',
      ring_ring: 'phone.fill',
      poke_sent_1: 'hand.point.right.fill',
      poke_received_5: 'hand.tap.fill',
    };
    // Not yet: Guardian Angel's adult-and-child has no web glyph of its own
    // and still wears Social Circle's Users.
    const known = new Set(['guardian_angel/social_5', 'social_5/guardian_angel']);
    const ids = Object.keys(IOS);
    for (const a of ids) {
      for (const b of ids) {
        if (known.has(`${a}/${b}`)) continue;
        expect(badgeIcon(a) === badgeIcon(b), `${a} / ${b}`).toBe(IOS[a] === IOS[b]);
      }
    }
  });

  it('shows the default glyph for an id it does not know', () => {
    for (const id of ['', 'mystery_badge', 'pet', 'poke', 'constructor', 'toString', '__proto__']) {
      expect(badgeIcon(id), id).toBe(Activity);
    }
  });

  it("never lets a family wear an earlier family's glyph", () => {
    // First match wins, so a prefix starting with an earlier one could never
    // match: the more specific prefix has to come first.
    BADGE_PREFIX_ICONS.forEach(([later], j) => {
      for (const [earlier] of BADGE_PREFIX_ICONS.slice(0, j)) {
        expect(later.startsWith(earlier), `${later} is caught by ${earlier}`).toBe(false);
      }
    });
    // A single badge isn't swallowed by a family either.
    for (const id of BADGE_EXACT_ICONS.keys()) {
      for (const [prefix] of BADGE_PREFIX_ICONS) expect(id.startsWith(prefix), `${id} / ${prefix}`).toBe(false);
    }
    // Founding Member is not a Founder.
    expect(badgeIcon('founding_member')).not.toBe(badgeIcon('founder'));
  });

  it('draws the new glyphs like the rest of the set', () => {
    for (const icon of [
      PawPrint,
      Sparkles,
      Heart,
      Flame,
      Sprout,
      CalendarCheck,
      HandTap,
      MoonStar,
      Zap,
      Landmark,
      CircleInCircle,
      Sun,
    ]) {
      const html = renderToStaticMarkup(createElement(icon, { size: 16 }));
      expect(html).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
      expect(html).toContain('fill="none" stroke="currentColor" stroke-width="1.6"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toMatch(/NaN|undefined/);
    }
  });
});
