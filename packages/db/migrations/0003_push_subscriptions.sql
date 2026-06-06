-- Web Push subscriptions per user/device. Web Push requires a server-side
-- record of the browser-issued endpoint URL + key material in order to
-- send notifications; the web-push npm library reads these fields verbatim
-- when signing a payload.
--
-- We don't dedupe by user — a single user might have a desktop browser, a
-- phone PWA, and a tablet, each with its own subscription. The unique key
-- is `endpoint` so re-subscribing from the same browser upserts cleanly.

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" bigint PRIMARY KEY NOT NULL,
  "user_id" bigint NOT NULL,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx"
  ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_idx"
  ON "push_subscriptions" USING btree ("endpoint");
