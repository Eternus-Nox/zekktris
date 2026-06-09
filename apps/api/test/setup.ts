/**
 * Test environment bootstrap.
 * ---------------------------
 * The API's env module (src/env.ts) validates process.env at import time, and
 * many modules read derived values (signing secrets, LiveKit creds) at import.
 * Vitest runs this file before any test module is imported, so we seed the
 * required vars here. `||=` means a real shell/CI value always wins — this only
 * fills gaps, never clobbers a configured environment.
 *
 * None of these point at live infrastructure: DATABASE_URL is only validated as
 * a URL (postgres-js connects lazily, and the units under test issue no query),
 * and the LiveKit creds are used purely to sign tokens locally.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV ||= 'test';
// Uploads default to /data/uploads (not writable in a test run); point them
// at a throwaway temp dir so upload-path tests can write without root.
process.env.UPLOAD_DIR ||= join(tmpdir(), 'zekktris-test-uploads');
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/zekktris_test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret-minimum-32-characters-long';
process.env.JWT_REFRESH_SECRET ||= 'test-only-refresh-secret-distinct-32-characters';
process.env.LIVEKIT_API_KEY ||= 'test-livekit-key';
process.env.LIVEKIT_API_SECRET ||= 'test-livekit-secret-minimum-32-characters-long';
process.env.LIVEKIT_WS_URL ||= 'wss://livekit.test';
