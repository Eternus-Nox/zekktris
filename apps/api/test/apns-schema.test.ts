import { describe, it, expect } from 'vitest';
import { schema } from '../src/db';

// Regression guard for the VoIP-push crash: apns.ts's hasVoipTokens /
// sendVoipToUser referenced `schema.deviceTokens` (an undefined export — the
// real table is `apnsDeviceTokens`), which threw at runtime on the PushKit
// path. The primary guard is `tsc` (an undefined schema export is a type
// error), but this cheap no-DB check documents the contract the APNs service
// depends on and fails loudly if the table is renamed out from under it.
describe('apns schema contract', () => {
  it('exposes apnsDeviceTokens (the table the APNs/VoIP path uses)', () => {
    expect(schema.apnsDeviceTokens).toBeDefined();
  });

  it('has the columns the VoIP token queries rely on', () => {
    expect(schema.apnsDeviceTokens.token).toBeDefined();
    expect(schema.apnsDeviceTokens.userId).toBeDefined();
    expect(schema.apnsDeviceTokens.platform).toBeDefined();
  });

  it('does NOT expose a bare `deviceTokens` export (the old undefined ref)', () => {
    expect((schema as Record<string, unknown>).deviceTokens).toBeUndefined();
  });
});
