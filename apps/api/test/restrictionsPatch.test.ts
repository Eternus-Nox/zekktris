import { describe, it, expect } from 'vitest';
import { restrictionsPatch } from '../src/routes/family';

// Regression for the "allowCreateGuild enforced but unsettable" bug: the
// PATCH /family/children/:id/restrictions validator stripped allowCreateGuild,
// so a parent could never toggle it even though the column was enforced on
// guild creation and both clients sent it.
describe('family restrictionsPatch validator', () => {
  it('accepts allowCreateGuild (the bug: it used to be stripped)', () => {
    const parsed = restrictionsPatch.parse({ allowCreateGuild: false });
    expect(parsed).toHaveProperty('allowCreateGuild', false);
  });

  it('accepts every child_restrictions column', () => {
    const all = {
      canAddFriends: false,
      canRemoveFriends: false,
      allowVoice: false,
      allowVideo: false,
      allowStream: false,
      allowCreateGuild: false,
      allowJoinGuilds: false,
      allowMessaging: false,
      dmPolicy: 'friends' as const,
    };
    expect(restrictionsPatch.parse(all)).toEqual(all);
  });

  it('accepts each dmPolicy value and rejects junk', () => {
    for (const p of ['none', 'friends', 'all'] as const) {
      expect(restrictionsPatch.parse({ dmPolicy: p })).toHaveProperty('dmPolicy', p);
    }
    expect(() => restrictionsPatch.parse({ dmPolicy: 'everyone' })).toThrow();
  });

  it('keeps fields optional (partial patch leaves others undefined)', () => {
    const parsed = restrictionsPatch.parse({ allowCreateGuild: true });
    expect(parsed.allowCreateGuild).toBe(true);
    expect(parsed.allowVoice).toBeUndefined();
  });

  it('rejects a non-boolean allowCreateGuild', () => {
    expect(() => restrictionsPatch.parse({ allowCreateGuild: 'yes' })).toThrow();
  });
});
