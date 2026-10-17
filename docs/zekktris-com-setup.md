# Setting up Zekktris on zekktris.com

End-to-end deployment guide for hosting Zekktris at `https://www.zekktris.com`
with Cloudflare in front, including outbound email for password resets.

## What you'll set up

1. DNS pointing `zekktris.com` and `www.zekktris.com` at your server
2. TLS — Caddy (bundled) handles cert provisioning automatically
3. **Receiving** email at `you@zekktris.com` via Cloudflare Email Routing
4. **Sending** email from `noreply@zekktris.com` via a separate SMTP relay
5. Zekktris `.env` wired to use all of the above

> **The Cloudflare gotcha you need to know up front.** Cloudflare Email
> Routing is a *receive-only* forwarder — it can route mail addressed
> to `you@zekktris.com` into your real inbox, but it cannot *send*
> outbound mail. Zekktris needs an outbound SMTP relay (Resend, Brevo,
> SendGrid, etc.) for password resets. The two systems coexist: CF
> Email Routing handles incoming, the SMTP relay handles outgoing.
> Both can live on the same domain.

---

## 1. Point the domain at your server

In Cloudflare DNS for `zekktris.com`:

| Type | Name | Content              | Proxy            |
|------|------|----------------------|------------------|
| A    | @    | `<your-server-IPv4>` | Proxied (orange) |
| A    | www  | `<your-server-IPv4>` | Proxied (orange) |

If your server has IPv6, add AAAA records too.

### Cloudflare SSL/TLS mode

In **Cloudflare → SSL/TLS → Overview**, pick one of:

- **Full (strict)** — recommended. Cloudflare requires your origin
  (Caddy) to present a valid public cert. Caddy auto-provisions one
  via Let's Encrypt as long as ports 80 and 443 are reachable on
  your server (Cloudflare proxies through to them).
- **Full** — accepts self-signed certs. Works but slightly less secure
  (a man-in-the-middle between CF and your server could swap the
  cert).
- **Flexible** — **don't use**. This is HTTP between CF and your
  origin, and breaks the secure-cookie auth flow.

For Full (strict), port 80 must be reachable so Caddy can complete
the ACME HTTP-01 challenge. After the first issue Caddy uses TLS-ALPN
challenges over 443, but the initial cert wants 80.

---

## 2. Bring up Zekktris

```bash
./install.sh --domain zekktris.com
```

The installer writes `.env` with fresh secrets (database password, JWT and
field-encryption keys, LiveKit and Web-Push keys), sets `SITE_ADDRESS`,
`PUBLIC_URL` and `COOKIE_SECURE=true` for the domain, and starts the stack.
While it runs, keep the Cloudflare records on **DNS only** (grey cloud) so the
first Let's Encrypt certificate can be issued; switch the proxy back on
afterwards.

Then tell Caddy that Cloudflare is in front — it decides whose word Caddy takes
for the visitor's IP address:

```bash
echo 'EDGE_PROXY=cloudflare' >> .env
docker compose up -d proxy
```

Without it every visitor appears to come from a Cloudflare edge (or, through a
Cloudflare Tunnel, from the Docker bridge gateway), so per-IP rate limits and
IP bans hit everyone at once. Only set it while **all** outside traffic comes
through Cloudflare (proxied DNS or a Tunnel): it trusts Cloudflare's ranges and
the Docker bridge range, and a visitor reaching Caddy directly from one of those
could otherwise pick their own address. See `ops/caddy-modes/README`.
`./scripts/doctor.sh` checks that the addresses come out right.

> Cloudflare talks to your origin on whatever port the DNS record points at —
> 443 for a proxied A record. `--domain` mode serves HTTP on 80 and HTTPS on
> 443 directly.

At this point `https://www.zekktris.com` should serve the app. If it
doesn't, check `docker compose logs proxy` (Caddy) — the most common issues
are:
- Port 80 blocked → ACME can't complete
- Cloudflare proxy still on Flexible → cert mismatch
- DNS not propagated → wait a few minutes

---

## 3. Set up receiving email (Cloudflare Email Routing)

In **Cloudflare → Email → Email Routing → Get started**:

1. Enable Email Routing. Cloudflare adds 3 MX records + a TXT (SPF
   include for cf) to your DNS automatically.
2. Add a destination — your real inbox (e.g. `you@gmail.com`).
   Confirm it via the verification email Cloudflare sends.
3. Add a route — for now, the simplest is a catch-all:
   - **Catch-all address** → forward to `you@gmail.com`

   This means anything sent to `*@zekktris.com` lands in your real
   inbox. You can later add specific routes (e.g.
   `support@zekktris.com` → ticket system) and disable the catch-all.

For password reset, set up at minimum:
- `noreply@zekktris.com` → forward to your inbox (so bounces and
  out-of-office replies don't vanish)
- `postmaster@zekktris.com` → forward to your inbox (RFC requires
  this address to be reachable; some receivers check)

---

## 4. Set up outbound email (Resend, recommended)

This is the piece Zekktris actually needs for password resets. Pick a
provider — **Resend** is the easiest modern choice for personal /
small-instance use:

### 4a. Create the Resend account

1. Sign up at [resend.com](https://resend.com) (3,000/month free, no
   credit card)
2. **Domains → Add Domain** → enter `zekktris.com`
3. Resend shows you 3 DNS records to add — typically:
   - **MX record** for `send.zekktris.com` (Resend's bounce return-path)
   - **TXT record** for SPF: `v=spf1 include:amazonses.com ~all` on
     `send.zekktris.com`
   - **TXT record** for DKIM: long base64 string on a `resend._domainkey`
     name

   Copy the exact values Resend gives you — they're account-specific.

4. Add all three to Cloudflare DNS (orange-cloud OFF for these — DNS
   records for mail should not be proxied). After ~5 min, click
   **Verify** in Resend. Status flips to "Verified".

5. **API Keys → Create API Key**. Copy the `re_...` key — you'll
   paste it into Zekktris's `.env` next.

### 4b. Wire it into Zekktris

In `.env`:

```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SMTP_FROM=noreply@zekktris.com
SMTP_SECURE=false
```

Note `SMTP_USER` is literally the string `resend` for every Resend
account — that's how their SMTP gateway is set up. The unique
credential is in `SMTP_PASS`.

`SMTP_FROM` must be an address on your verified sending domain. You
don't need to set up Cloudflare Email Routing for `noreply@` — Resend
handles the sending side. The Cloudflare Email Routing side is just
so replies and bounces have somewhere to land.

### 4c. Bounce back to Zekktris

```bash
docker compose up -d api   # picks up the new .env values
docker compose logs api | grep -i smtp   # should show transport ready
```

---

## 5. (Optional) Set up DMARC

This isn't strictly required for password reset to work — Resend's
DKIM + SPF give you sender authentication on their own — but DMARC
tells receiving servers what to do with mail that *fails* auth, which
both improves your deliverability reputation and protects against
spoofing of your domain.

Add to Cloudflare DNS, name `_dmarc.zekktris.com`, type TXT:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@zekktris.com; pct=100
```

`dmarc-reports@zekktris.com` should be set up in Cloudflare Email
Routing to forward to your inbox if you actually want to see the
weekly reports. Start with `p=quarantine` for a few weeks to make
sure nothing's wrong, then move to `p=reject` once you're confident.

---

## 6. Test password reset

1. Open https://www.zekktris.com/forgot-password
2. Enter the email of any account you've registered
3. Within ~30s, the reset email should land in that inbox
4. Click the link, which takes you to
   https://www.zekktris.com/reset-password?token=...
5. Set a new password (8–200 chars per the form hints)
6. Sign in with the new password

If the email doesn't arrive:

- **Resend dashboard → Logs** shows every send attempt with the SMTP
  response. Usually tells you exactly why (domain not verified,
  bounce, suppression list, etc).
- **`docker compose logs api | grep -i mail`** shows the api's side
  of the SMTP conversation.
- Check spam — first sends from a new domain often land in spam
  until reputation builds. After DMARC + a few legitimate sends,
  this clears up.

---

## What about other SMTP providers?

The setup is structurally identical for any provider — sign up, verify
your domain via DKIM/SPF DNS records, get SMTP credentials, fill in
`.env`. Cheat sheet for the most common alternatives:

| Provider | SMTP_HOST                | SMTP_USER     | SMTP_PASS             | Free tier |
|----------|--------------------------|---------------|-----------------------|-----------|
| Resend   | `smtp.resend.com`        | `resend`      | API key               | 3000/mo   |
| Brevo    | `smtp-relay.brevo.com`   | login email   | SMTP key (not pwd)    | 300/day   |
| SendGrid | `smtp.sendgrid.net`      | `apikey`      | API key               | 100/day   |
| Mailgun  | `smtp.mailgun.org`       | mailgun login | Mailgun SMTP pwd      | trial     |
| AWS SES  | `email-smtp.<region>...` | IAM SMTP user | IAM SMTP password     | cheap-est at scale |

All of them use `SMTP_PORT=587` with `SMTP_SECURE=false` (STARTTLS).
A few support `SMTP_PORT=465` with `SMTP_SECURE=true` (implicit TLS)
if your network blocks 587 — both work.

---

## Common pitfalls

- **Cookies don't stick after sign-in** → `COOKIE_SECURE` doesn't
  match `PUBLIC_URL`. HTTPS public URL needs `COOKIE_SECURE=true`.
- **Cloudflare shows 521/522** → origin isn't reachable. Check that
  ports 80/443 (or whatever HTTP_PORT/HTTPS_PORT you set) are
  reachable from the public internet. Cloudflare's "DNS only" mode
  (grey cloud) is useful to test the origin directly without CF
  in the middle.
- **Emails go to spam** → no DKIM/SPF/DMARC, or your sending IP is
  cold. Resend bypasses both — they handle reputation pooling. If
  you're rolling your own SMTP, expect a few weeks of low
  deliverability while reputation builds.
- **"This server hasn't enabled email" on /forgot-password** →
  `SMTP_HOST` or `SMTP_FROM` empty in the api container's env. Check
  `docker compose config | grep SMTP` to confirm the values made it
  through, and `docker compose logs api` for startup-time email
  config logs.
