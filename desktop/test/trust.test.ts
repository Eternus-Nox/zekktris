// Run with `npm test` (Node 22.18+ runs TypeScript directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalUrl, isSameOrigin, permissionAllowed } from '../src/trust.ts';

const SERVER = 'https://chat.example.com';

test('externalUrl lets web and mail links through', () => {
  assert.equal(externalUrl('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(externalUrl('http://example.org'), 'http://example.org/');
  assert.equal(externalUrl('mailto:someone@example.org'), 'mailto:someone@example.org');
  assert.equal(externalUrl('HTTPS://Example.org/'), 'https://example.org/');
});

test('externalUrl drops every other scheme and garbage', () => {
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'file://attacker.example/share/payload.exe',
    'smb://attacker.example/share',
    'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
    'ms-msdt:/id PCWDiagnostic',
    'ms-settings:',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'zekktris://channel/1',
    'steam://run/1',
    'vbscript:msgbox',
    '  ',
    'not a url',
    '',
  ]) {
    assert.equal(externalUrl(url), null, url);
  }
});

test('isSameOrigin compares origins, not prefixes', () => {
  assert.equal(isSameOrigin('https://chat.example.com/channels/1', SERVER), true);
  assert.equal(isSameOrigin('https://chat.example.com/', SERVER), true);
  assert.equal(isSameOrigin('https://chat.example.com:443', SERVER), true);
  assert.equal(isSameOrigin('https://chat.example.com.evil.test/', SERVER), false);
  assert.equal(isSameOrigin('https://evil.test/?https://chat.example.com', SERVER), false);
  assert.equal(isSameOrigin('http://chat.example.com/', SERVER), false);
  assert.equal(isSameOrigin('https://chat.example.com:8443/', SERVER), false);
  assert.equal(isSameOrigin('file:///app/static/picker.html', SERVER), false);
  assert.equal(isSameOrigin('', SERVER), false);
  assert.equal(isSameOrigin(undefined, SERVER), false);
  assert.equal(isSameOrigin(null, SERVER), false);
  assert.equal(
    isSameOrigin('http://192.168.1.20:5550/app', 'http://192.168.1.20:5550'),
    true,
  );
});

test('permissionAllowed grants what the web app uses, on the server origin only', () => {
  for (const p of [
    'notifications',
    'media',
    'display-capture',
    'fullscreen',
    'screen-wake-lock',
    'clipboard-sanitized-write',
  ]) {
    assert.equal(permissionAllowed(p, `${SERVER}/channels/1`, SERVER), true, p);
    assert.equal(permissionAllowed(p, 'https://evil.test/', SERVER), false, p);
    assert.equal(permissionAllowed(p, 'file:///app/static/picker.html', SERVER), false, p);
    assert.equal(permissionAllowed(p, undefined, SERVER), false, p);
  }
});

test('permissionAllowed never grants clipboard-read or anything unlisted', () => {
  for (const p of [
    'clipboard-read',
    'deprecated-sync-clipboard-read',
    'mediaKeySystem',
    'geolocation',
    'openExternal',
    'hid',
    'usb',
    'serial',
    'fileSystem',
    'unknown',
  ]) {
    assert.equal(permissionAllowed(p, `${SERVER}/`, SERVER), false, p);
  }
});
