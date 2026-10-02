/**
 * Legal pages — Terms of Service + Privacy Policy.
 *
 * Public routes (/terms, /privacy) so they're reachable during signup (the
 * "I agree" checkbox links here) and from anywhere in the app. Rendered as
 * their own scroll container because the document (html/body) is locked to the
 * viewport in this SPA.
 *
 * ⚠️ These are a good-faith starting point tailored to Zekktris's actual
 * features — NOT legal advice. Have a lawyer review, and fill the
 * [bracketed] placeholders (contact address, legal entity, jurisdiction,
 * voice/video provider), before relying on them for a public launch.
 */
import { Link } from 'react-router-dom';
import { ZekktrisMark } from '../lib/ZekktrisMark';
import { useSourceCodeUrl } from '../lib/sourceCode';

const LAST_UPDATED = 'October 2, 2026';
const CONTACT_EMAIL = 'support@zekktris.com';
const PRIVACY_EMAIL = 'privacy@zekktris.com';

/** The hosted service vs. a server someone runs themselves. The same web
 *  bundle ships with every install, so the page says which one it is. */
function isSelfHosted(): boolean {
  const host = window.location.hostname;
  return host !== 'zekktris.com' && host !== 'www.zekktris.com';
}

function LegalLayout({
  title,
  otherLabel,
  otherTo,
  children,
}: {
  title: string;
  otherLabel: string;
  otherTo: string;
  children: React.ReactNode;
}) {
  const sourceUrl = useSourceCodeUrl();
  return (
    <div className="zk-screen overflow-y-auto bg-bg-1 text-ink-1 relative">
      <div className="abyss" aria-hidden />
      <div className="relative z-10 mx-auto w-full max-w-2xl px-5 py-10 safe-area-padded">
        <div className="flex items-center gap-2 mb-8">
          <ZekktrisMark size={28} className="w-7 h-7 shrink-0" />
          <span className="text-lg font-bold tracking-tight">Zekktris</span>
          <span className="flex-1" />
          <Link to="/" className="text-sm text-ink-3 hover:text-accent hover:underline">
            Home
          </Link>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-ink-3 mt-1 mb-8">Last updated: {LAST_UPDATED}</p>
        {isSelfHosted() && (
          <p className="mb-8 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-ink-2">
            This Zekktris server ({window.location.host}) is run independently by its own
            administrators, not by the Zekktris team. These are the default Zekktris terms; the
            people running this server are responsible for it and for your data on it. Contact
            them with questions.
          </p>
        )}
        <div className="legal-prose space-y-5 text-[0.95rem] leading-relaxed text-ink-2">
          {children}
        </div>
        <div className="mt-12 pt-6 border-t text-sm flex flex-wrap items-center gap-x-4 gap-y-2" style={{ borderColor: 'var(--zk-line-soft)' }}>
          <Link to={otherTo} className="text-accent hover:underline">
            {otherLabel}
          </Link>
          <span className="flex-1" />
          <span className="text-ink-3">
            Zekktris is free software (AGPL-3.0) ·{' '}
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Source code
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Section heading — consistent spacing/weight across both documents. */
function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-ink-1 pt-3">{children}</h2>;
}

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" otherLabel="Read the Privacy Policy →" otherTo="/privacy">
      <p>
        These Terms of Service (the &ldquo;Terms&rdquo;) govern your access to and use of Zekktris
        (the &ldquo;Service&rdquo;). By creating an account or using the Service you agree to these
        Terms. If you do not agree, do not use the Service.
      </p>

      <H>1. Who may use Zekktris</H>
      <p>
        You must be at least 13 years old to create an account. If you are between 13 and 17, you
        may use Zekktris only under the supervision of a parent or guardian: you are asked to
        connect a guardian account, and if you do not do so within 30 days your account is
        restricted until a guardian is linked. Supervised accounts are always shown that they are
        supervised. When a supervised user turns 18, supervision ends automatically. By signing up
        you confirm that the date of birth you provide is accurate and that you meet these
        requirements. You may not use the Service if you are barred from doing so under applicable
        law.
      </p>

      <H>2. Your account</H>
      <p>
        You are responsible for your account and for keeping your credentials secure — including
        your password, any passkeys, and two-factor authentication. Notify us promptly of any
        unauthorized use. You are responsible for all activity under your account. Accounts are for
        individuals; do not share your account or impersonate others. If you create bot or automated
        accounts, you remain responsible for everything they do, they must follow these Terms and
        our rate limits, and they cannot hold a perk tier.
      </p>

      <H>3. Free service and perk tiers</H>
      <p>
        Zekktris is free. Every feature — including cosmetic personalization such as themes, avatar
        frames, and a name tag (also called a clan tag) — is available to every account, and
        nothing is sold. We do not charge for the Service or take payment details.
      </p>
      <p>
        The administrators of a Zekktris server may give accounts a <strong>perk tier</strong> —
        currently Scout, Guardian, or Legend. A tier raises limits such as the maximum screen-share
        and camera quality (by default: everyone can share at 720p and 30fps; Scout adds 1080p and
        60fps, Guardian adds 2K, and Legend adds 4K) and may raise upload limits, and it can show a
        title on your profile. A tier never changes what you can say, who you can talk to, or which
        communities you can join, and gives no moderation or social advantage. Tiers are granted at
        the administrators&rsquo; discretion, are non-transferable, may be time-limited, and may be
        changed or removed at any time.
      </p>
      <p>
        A supervising parent&rsquo;s or guardian&rsquo;s tier also extends to the accounts of the
        minors they supervise; that shared benefit ends automatically when the supervision link
        ends (including when the minor turns 18).
      </p>
      <p>
        If you bought a membership before Zekktris became free, you keep your tier. You can stop
        any remaining billing from Settings, and no further charges are taken once it is stopped.
        Payments already made were processed by{' '}
        <a href="https://stripe.com/privacy" className="text-accent hover:underline">
          Stripe
        </a>{' '}
        and are not refundable except where a refund is required by law.
      </p>

      <H>4. Acceptable use</H>
      <p>You agree not to use Zekktris to:</p>
      <ul className="list-disc pl-6 space-y-1">
        <li>break the law or facilitate illegal activity;</li>
        <li>
          upload, share, or solicit content that sexualizes minors — we have zero tolerance for
          child sexual abuse material and will report it to the authorities;
        </li>
        <li>harass, threaten, defame, or incite violence against others;</li>
        <li>distribute malware, spam, or engage in phishing or fraud;</li>
        <li>infringe others&rsquo; intellectual property or privacy;</li>
        <li>
          scrape, overload, disrupt, reverse-engineer, or attempt to bypass the security,
          rate limits, or parental-supervision features of the Service;
        </li>
        <li>evade a ban, or help a supervised minor circumvent guardian controls.</li>
      </ul>
      <p>
        We may remove content and suspend or terminate accounts that violate these Terms. Community
        (server) owners set additional rules for their spaces; we may still act on Service-wide
        violations regardless of a server&rsquo;s own rules.
      </p>

      <H>5. Your content</H>
      <p>
        You retain ownership of the content you create — messages, media, and profile information
        (&ldquo;Your Content&rdquo;). You grant us a worldwide, non-exclusive, royalty-free license
        to host, store, reproduce, and transmit Your Content solely to operate, secure, and provide
        the Service (for example, delivering your messages to their recipients). You are responsible
        for Your Content and represent that you have the rights to share it.
      </p>

      <H>6. Messages, encryption, and voice</H>
      <p>
        Direct messages may be end-to-end encrypted, in which case we cannot read their contents.
        End-to-end encryption is not available for a supervised minor&rsquo;s direct messages so
        that a linked guardian can review them — except messages between the minor and their own
        guardian, which remain private. Encryption is a feature, not a guarantee of secure
        communications, and does not protect against a compromised device. Voice and video are
        provided in real time through third-party infrastructure. Do not rely on the Service for
        communications where failure or interception could cause harm.
      </p>

      <H>7. Service changes and availability</H>
      <p>
        We may change, suspend, or discontinue features at any time. The Service is provided without
        any uptime guarantee, and features may vary between the web, desktop, and mobile apps.
      </p>

      <H>8. Termination</H>
      <p>
        You may stop using the Service and delete your account at any time. We may suspend or
        terminate your access — including issuing temporary or permanent instance-wide bans, at our
        discretion and enforced by our staff and moderators — if you violate these Terms or to
        protect the Service or its users. Attempting to evade a ban is itself a violation. Some
        provisions survive termination (including ownership, disclaimers, and limitations of
        liability).
      </p>

      <H>9. Disclaimers</H>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without
        warranties of any kind, whether express or implied, to the maximum extent permitted by law.
        We do not warrant that the Service will be uninterrupted, secure, or error-free.
      </p>

      <H>10. Limitation of liability</H>
      <p>
        To the maximum extent permitted by law, Zekktris and its operators will not be liable for
        any indirect, incidental, special, consequential, or punitive damages, or any loss of data,
        use, or goodwill, arising from your use of the Service.
      </p>

      <H>11. Changes to these Terms</H>
      <p>
        We may update these Terms from time to time. If we make material changes we will take
        reasonable steps to notify you (for example, in-app). Your continued use after the changes
        take effect constitutes acceptance.
      </p>

      <H>12. Governing law &amp; contact</H>
      <p>
        These Terms are governed by the laws of [your jurisdiction], without regard to conflict-of-
        law rules. Questions about these Terms can be sent to{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent hover:underline">
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" otherLabel="Read the Terms of Service →" otherTo="/terms">
      <p>
        This Privacy Policy explains what information Zekktris (the &ldquo;Service&rdquo;) collects,
        how we use it, and the choices you have. By using the Service you agree to this policy.
      </p>

      <H>1. Information we collect</H>
      <ul className="list-disc pl-6 space-y-1">
        <li>
          <strong>Account information</strong> you provide: email address, username, display name,
          and date of birth. Passwords are never stored in plain text — only a salted hash.
        </li>
        <li>
          <strong>Content</strong> you create: messages, attachments and media, reactions, server
          and channel data, and (while active) voice/video streams.
        </li>
        <li>
          <strong>Security &amp; authentication</strong> data: session records, and — if you enable
          them — two-factor authentication settings and passkey public keys (we never receive your
          biometrics or private keys).
        </li>
        <li>
          <strong>Perk tier</strong> data, if you have one: your tier, who granted it, and when it
          expires. If you bought a membership before Zekktris became free, we also keep the customer
          and subscription identifiers our former payment processor assigned you. We have never
          collected or stored your card number — that went directly to the processor.
        </li>
        <li>
          <strong>Notification tokens</strong>, if you turn on push notifications: the device or
          browser push token or subscription (for example, an Apple, Google, or browser push
          endpoint and its keys) needed to deliver notifications to your device.
        </li>
        <li>
          <strong>Technical data</strong> needed to run and secure the Service: IP address, device
          and browser information, and timestamps, used for delivery, abuse prevention, and
          rate limiting.
        </li>
      </ul>
      <p>
        We do not use any third-party advertising, analytics, telemetry, or cross-site tracking
        services, and we do not sell your personal information. Our display fonts are served from our
        own servers, not a third-party font CDN.
      </p>

      <H>2. How we use information</H>
      <p>
        We use your information to provide and maintain the Service (delivering messages, running
        voice, syncing your account across devices, and sending push notifications you have opted
        into); to manage perk tiers; to secure it and prevent
        abuse; to enforce our Terms; to operate age-gating and parental supervision; and to
        communicate with you about your account (for example, verification and password-reset
        emails).
      </p>

      <H>3. Children and minors</H>
      <p>
        Zekktris is not for children under 13, and we reject signups that report an age under 13. We
        collect date of birth to enforce this and to identify accounts aged 13–17, which are
        supervised: a linked parent or guardian can review the minor&rsquo;s messages and contacts
        and set restrictions, and the minor is always shown that their account is supervised. To
        support this review, we store the supervision link, the guardian&rsquo;s restriction
        settings, any watch words the guardian configures, and excerpts of messages those watch
        words flag. A minor&rsquo;s direct messages are not end-to-end encrypted while supervised so
        the guardian can review them — except messages between the minor and their own guardian,
        which stay private. Supervision, and the associated guardian access, ends automatically when
        the user turns 18. If you believe a child under 13 has created an account, contact us and we
        will remove it.
      </p>

      <H>4. End-to-end encryption</H>
      <p>
        When end-to-end encryption is enabled for a direct message, its contents are encrypted on
        your device and we cannot read them. Encryption does not apply to the exceptions described
        above (a supervised minor&rsquo;s non-guardian DMs), and message metadata (such as who is
        messaging whom and when) is still processed to deliver messages. For notification previews of
        encrypted messages, the encrypted content is passed through the push services below and
        decrypted on your device — it is never readable by us or by those services.
      </p>

      <H>5. How we share information</H>
      <p>We do not sell your personal information. We share it only:</p>
      <ul className="list-disc pl-6 space-y-1">
        <li>
          with other users as you direct — people in a server you join can see the messages and
          profile you share there, and a linked guardian can see a supervised minor&rsquo;s activity
          as described above;
        </li>
        <li>
          with service providers that help us run the Service, which may process your data only on
          our behalf, including:{' '}
          <a href="https://stripe.com/privacy" className="text-accent hover:underline">
            Stripe
          </a>{' '}
          only for memberships bought before Zekktris became free; an email provider for
          verification, reset, and guardian-invitation messages (a guardian invitation sends the
          address you supply, along with the minor&rsquo;s display name, to the email provider);
          real-time voice/video infrastructure ([LiveKit]) that carries your audio/video streams and
          a participant identifier when you are in a call; and push-notification gateways — Apple Push
          Notification service, Google Firebase Cloud Messaging, and your browser&rsquo;s push
          service — to deliver notifications you have enabled;
        </li>
        <li>when required by law, or to protect the rights, safety, and security of users and the Service.</li>
      </ul>

      <H>6. Cookies and local storage</H>
      <p>
        We use cookies and browser local storage for essential purposes only — keeping you signed
        in (session/refresh tokens) and remembering your preferences. We do not use them for
        third-party advertising or cross-site tracking.
      </p>

      <H>7. Data retention</H>
      <p>
        We keep your account and content until you delete them. Messages remain until you or a
        space&rsquo;s moderators remove them; some direct messages may be set to auto-delete after a
        period. Media is stored on our own servers (not a third-party media host) and may be
        retained for a limited time for operational and safety reasons and then removed. For safety
        and abuse enforcement, we may retain snapshots of flagged non-encrypted content and records
        of moderation actions, which can outlast the account for audit purposes. Accounts that stay
        inactive for a long period (by default about a year) may be deleted automatically. Billing
        and transaction records may be kept longer than other data to meet tax, accounting, and
        legal obligations. When you delete your account, we delete or de-identify your personal
        information, except where we must retain it to comply with law or resolve disputes.
      </p>

      <H>8. Your rights and choices</H>
      <p>
        You can view and update your profile, change or delete your content, add security like
        passkeys and two-factor authentication, stop billing for an old membership, and delete your
        account at any time from Settings. Depending on where you live, you may have additional
        rights to access, correct, or delete your personal information; contact us to exercise them.
      </p>

      <H>9. Security</H>
      <p>
        We protect your data with measures including encrypted transport (HTTPS), salted password
        hashing, optional passkeys and two-factor authentication, and session controls. Sensitive
        credentials such as passwords, tokens, and recovery codes are stored only as hashes. No
        system is perfectly secure, but we work to safeguard your information.
      </p>

      <H>10. Changes to this policy</H>
      <p>
        We may update this policy from time to time and will take reasonable steps to notify you of
        material changes. Your continued use after the changes take effect constitutes acceptance.
      </p>

      <H>11. Contact</H>
      <p>
        Questions about privacy can be sent to{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`} className="text-accent hover:underline">
          {PRIVACY_EMAIL}
        </a>
        .
      </p>
    </LegalLayout>
  );
}
