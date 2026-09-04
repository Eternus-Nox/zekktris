#!/usr/bin/env node
/**
 * FCM diagnostic — answers "why is Android push not arriving?" one layer at a
 * time, instead of leaving you guessing between three of them.
 *
 * Layer 1 (always): can we mint a Google access token from FCM_CLIENT_EMAIL +
 * FCM_PRIVATE_KEY? This is the whole credential path — key format, PEM
 * recovery, service-account validity — and it needs no phone, no app and no
 * registered device. Run it before you deploy to know whether .env is right.
 *
 * Layer 2 (with a device token): actually deliver a notification, using the
 * SAME data-only shape services/fcm.ts sends, so it exercises the real client
 * code path (onMessageReceived → NotificationHelper) rather than a shape the
 * app never sees in production.
 *
 * Usage, from the repo root:
 *   node scripts/fcm-test.mjs                 # credentials only
 *   node scripts/fcm-test.mjs <device-token>  # credentials + real send
 *
 * Get a device token once the app has registered one:
 *   docker exec zekktris-db psql -U commune -d commune -t -c \
 *     "select token from apns_device_tokens where platform='android' limit 1;"
 *
 * Reads .env from the current directory. Prints no secret values.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const ENV_PATH = process.env.ZK_ENV_PATH ?? '.env';

function readEnv(key) {
    let raw;
    try {
        raw = readFileSync(ENV_PATH, 'utf8');
    } catch {
        die(`cannot read ${ENV_PATH} — run this from the directory holding .env`);
    }
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
    if (!m) return null;
    let v = m[1].trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
        v = v.slice(1, -1);
    }
    return v || null;
}

function die(msg) {
    console.error(`\n  FAIL  ${msg}\n`);
    process.exit(1);
}
const ok = (msg) => console.log(`  ok    ${msg}`);

/** Same normalisation as services/fcm.ts: raw PEM (with literal \n escapes) or
 *  base64 of the PEM. Mirrored rather than imported so this runs with no build
 *  step and no node_modules. */
function normalizeKey(raw) {
    if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
    try {
        return Buffer.from(raw, 'base64').toString('utf8');
    } catch {
        return raw;
    }
}

const projectId = readEnv('FCM_PROJECT_ID');
const clientEmail = readEnv('FCM_CLIENT_EMAIL');
const privateKeyRaw = readEnv('FCM_PRIVATE_KEY');

console.log(`\nFCM diagnostic  (${ENV_PATH})\n`);
if (!projectId) die('FCM_PROJECT_ID is not set');
if (!clientEmail) die('FCM_CLIENT_EMAIL is not set');
if (!privateKeyRaw) die('FCM_PRIVATE_KEY is not set');
ok(`project ${projectId}`);
ok(`service account ${clientEmail.replace(/^[^@]+/, '…')}`);

const pem = normalizeKey(privateKeyRaw);
if (!pem.includes('BEGIN') || !pem.includes('END')) {
    die(
        'FCM_PRIVATE_KEY is neither a PEM nor base64 of one.\n' +
        '        Rebuild it from the service-account JSON:\n' +
        "          node -e \"const j=require('./sa.json');console.log(Buffer.from(j.private_key).toString('base64'))\"",
    );
}
ok(`private key recovers a PEM (${pem.length} chars)`);

// ── Layer 1: mint an access token ──────────────────────────────────────────
const now = Math.floor(Date.now() / 1000);
const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signingInput = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;

let jwt;
try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    jwt = `${signingInput}.${signer.sign(pem, 'base64url')}`;
} catch (err) {
    die(`the PEM did not load as a signing key: ${err.message}`);
}
ok('JWT signed with the service-account key');

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
    }),
});
const tokenBody = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok) {
    die(
        `Google rejected the credentials (${tokenRes.status} ${tokenBody.error ?? ''}).\n` +
        `        ${tokenBody.error_description ?? JSON.stringify(tokenBody)}\n` +
        '        Usually: the key was revoked, or it belongs to a different project.',
    );
}
ok('Google issued an access token — CREDENTIALS ARE GOOD');

// ── Layer 2: deliver, if given a device token ──────────────────────────────
const deviceToken = process.argv[2];
if (!deviceToken) {
    console.log(
        '\nCredentials verified. Pass a device token as an argument to send a real\n' +
        'notification. If the token table has no android row yet, the app has not\n' +
        'registered — that is a client/registration problem, not a credential one.\n',
    );
    process.exit(0);
}

// The same data-only shape services/fcm.ts builds: no `notification` block, so
// onMessageReceived runs in every app state and the client draws the banner.
const message = {
    token: deviceToken,
    android: { priority: 'high' },
    data: {
        title: 'Zekktris',
        body: 'Test notification — push is working.',
        kind: 'message',
        tag: 'fcm-test',
    },
};

const sendRes = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
        method: 'POST',
        headers: {
            authorization: `Bearer ${tokenBody.access_token}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ message }),
    },
);
const sendBody = await sendRes.json().catch(() => ({}));
if (!sendRes.ok) {
    const status = sendBody?.error?.status ?? sendRes.status;
    let hint = '';
    if (status === 'NOT_FOUND' || status === 'UNREGISTERED') {
        hint = '\n        The token is dead — app uninstalled, or FCM rotated it. Relaunch and re-register.';
    } else if (status === 'INVALID_ARGUMENT') {
        hint = '\n        Malformed token, or it belongs to a different Firebase project than ' + projectId + '.';
    } else if (status === 'PERMISSION_DENIED') {
        hint = '\n        The service account lacks the Firebase Messaging role on this project.';
    }
    die(`FCM refused the send (${status}).${hint}\n        ${JSON.stringify(sendBody?.error ?? sendBody)}`);
}
ok(`FCM accepted the message (${sendBody.name})`);
console.log(
    '\nDelivered to FCM. If nothing appears on the phone, the remaining\n' +
    'suspects are on-device: POST_NOTIFICATIONS denied, or battery\n' +
    'optimisation holding a data-only push. Check Logcat for ZekMessagingService.\n',
);
