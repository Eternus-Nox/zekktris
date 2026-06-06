import { describe, it, expect } from 'vitest';
import {
  countMentions,
  messageMatchesPatterns,
  messageMatchesRegexes,
  messageMatchesLinkFilter,
} from '../src/services/automod';

// These helpers are pure (no DB) so they always run, regardless of integration setup.
describe('automod pure helpers', () => {
  describe('countMentions', () => {
    it('counts user, role, and mass mentions together', () => {
      expect(countMentions('hi <@123> and <@&456> and @everyone')).toBe(3);
    });

    it('returns 0 when there are no mentions', () => {
      expect(countMentions('just a normal message')).toBe(0);
    });

    it('counts @here as a mass mention', () => {
      expect(countMentions('@here come look')).toBe(1);
    });
  });

  describe('messageMatchesPatterns (word-boundary, case-insensitive)', () => {
    it('matches a blocked word regardless of case', () => {
      expect(messageMatchesPatterns('You are a JERK', ['jerk'])).toBe(true);
    });

    it('respects word boundaries — no partial/substring match', () => {
      expect(messageMatchesPatterns('jerkstore opens today', ['jerk'])).toBe(false);
    });

    it('returns false for an empty pattern list', () => {
      expect(messageMatchesPatterns('anything goes', [])).toBe(false);
    });

    it('returns false when none of the patterns match', () => {
      expect(messageMatchesPatterns('a perfectly clean message', ['spam', 'scam'])).toBe(false);
    });
  });

  describe('messageMatchesRegexes', () => {
    it('matches a valid pattern case-insensitively', () => {
      expect(messageMatchesRegexes('Order #12345', ['#[0-9]+'])).toBe(true);
    });

    it('does not match when the pattern is absent', () => {
      expect(messageMatchesRegexes('no digits here', ['[0-9]+'])).toBe(false);
    });

    it('skips an invalid regex instead of throwing', () => {
      expect(messageMatchesRegexes('anything', ['(unclosed'])).toBe(false);
    });
  });

  describe('messageMatchesLinkFilter', () => {
    it('matches an exact blocked domain', () => {
      expect(messageMatchesLinkFilter('check evil.com out', ['evil.com'])).toBe(true);
    });

    it('matches a subdomain of a blocked domain', () => {
      expect(messageMatchesLinkFilter('go to login.evil.com now', ['evil.com'])).toBe(true);
    });

    it('does not match an unrelated domain', () => {
      expect(messageMatchesLinkFilter('visit good.com instead', ['evil.com'])).toBe(false);
    });

    it('matches invite links via the zk:invite token', () => {
      expect(
        messageMatchesLinkFilter('join https://zekktris.com/invite/abc123', ['zk:invite']),
      ).toBe(true);
    });

    it('returns false with no patterns', () => {
      expect(messageMatchesLinkFilter('https://evil.com', [])).toBe(false);
    });
  });
});
