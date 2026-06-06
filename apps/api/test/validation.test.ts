import { describe, it, expect } from 'vitest';
import {
  emailSchema,
  usernameSchema,
  passwordSchema,
  displayNameSchema,
  messagePageLimitSchema,
} from '../src/lib/validation';
import {
  USERNAME_MIN_LENGTH,
  PASSWORD_MIN_LENGTH,
  MESSAGES_PAGE_DEFAULT,
  MESSAGES_PAGE_MAX,
} from '@zekktris/shared/constants';

describe('validation schemas', () => {
  describe('emailSchema', () => {
    it('accepts and normalizes a valid email (trim + lowercase)', () => {
      expect(emailSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
    });
    it('rejects a non-email', () => {
      expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    });
  });

  describe('usernameSchema', () => {
    it('lowercases a valid username', () => {
      expect(usernameSchema.parse('Valid_User.99')).toBe('valid_user.99');
    });
    it('rejects illegal characters and too-short input', () => {
      expect(usernameSchema.safeParse('has space').success).toBe(false);
      expect(usernameSchema.safeParse('bang!').success).toBe(false);
      expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH - 1)).success).toBe(false);
    });
    it('rejects consecutive dots (homograph guard)', () => {
      expect(usernameSchema.safeParse('a..b').success).toBe(false);
    });
    it('accepts the minimum length', () => {
      expect(usernameSchema.safeParse('a'.repeat(USERNAME_MIN_LENGTH)).success).toBe(true);
    });
  });

  describe('passwordSchema', () => {
    it('accepts a password at the minimum length', () => {
      expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    });
    it('rejects a password below the minimum length', () => {
      expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    });
  });

  describe('displayNameSchema', () => {
    it('strips zero-width and bidi-override characters', () => {
      expect(displayNameSchema.parse('al\u200Bice')).toBe('alice'); // zero-width space
      expect(displayNameSchema.parse('evil\u202Egnp.exe')).toBe('evilgnp.exe'); // RTL override
    });
    it('rejects a value that is empty after stripping/trimming', () => {
      expect(displayNameSchema.safeParse('   ').success).toBe(false);
      expect(displayNameSchema.safeParse('\u200B').success).toBe(false);
    });
    it('preserves case in a normal display name', () => {
      expect(displayNameSchema.parse('Alice Liddell')).toBe('Alice Liddell');
    });
  });
});

describe('messagePageLimitSchema', () => {
  it('applies the default when the limit is omitted', () => {
    expect(messagePageLimitSchema.parse(undefined)).toBe(MESSAGES_PAGE_DEFAULT);
  });
  it('coerces a numeric string', () => {
    expect(messagePageLimitSchema.parse('20')).toBe(20);
  });
  it('rejects below the minimum (0) and above the maximum', () => {
    expect(messagePageLimitSchema.safeParse(0).success).toBe(false);
    expect(messagePageLimitSchema.safeParse(MESSAGES_PAGE_MAX + 1).success).toBe(false);
  });
  it('accepts the maximum', () => {
    expect(messagePageLimitSchema.safeParse(MESSAGES_PAGE_MAX).success).toBe(true);
  });
});
