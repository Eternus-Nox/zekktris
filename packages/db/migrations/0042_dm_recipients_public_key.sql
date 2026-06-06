-- ── E2EE per-DM keys ──────────────────────────────────────────────────────
--
-- Each recipient of a DM channel has their OWN public key FOR THAT DM,
-- distinct from any global identity key. This lets users enable E2EE per
-- conversation: turning it on in one DM doesn't affect any other DM, and
-- compromising one DM's keypair doesn't compromise the others.
--
-- The matching private key lives in the client's localStorage keyed by
-- channel id (`zekktris.e2ee.dm.<channelId>.v1`). Server only ever sees
-- the public half.
--
-- Nullable: a recipient with NULL has not enabled E2EE on this DM. Senders
-- to a null-keyed recipient fall back to plaintext for that conversation.
ALTER TABLE dm_recipients
  ADD COLUMN public_key TEXT;
