import { describe, it, expect } from 'vitest';
import { PET_STAGES } from '@zekktris/shared/pets';
import { PET_KEEPER_TIERS } from '../src/services/achievements';

// Zekk Keeper's rungs are ledger keys (`pet_keeper_<level>`, floored by
// counting recorded ids), so achievements.ts freezes them instead of reading
// them off the pet rules. They must still be the stages' first levels after
// the egg: pets.recordActivity announces a rung only on a stage change, and the
// descriptions name the stage a rung's level starts. If this fails, a stage's
// minLevel moved — a ledger change, not a rebalance: shipped rungs stay, and a
// new one is appended (with the hook and this pin updated to match).
describe('Zekk Keeper ladder', () => {
  it("is frozen at the pet stages' first levels after the egg", () => {
    expect(PET_KEEPER_TIERS).toEqual([1, 5, 10, 15, 25]);
    expect(PET_STAGES.filter((s) => s.minLevel > 0).map((s) => s.minLevel)).toEqual([...PET_KEEPER_TIERS]);
  });
});
