-- Native iOS push tokens (APNs). Separate from push_subscriptions because
-- APNs uses an opaque device-token string and a different transport (HTTP/2
-- to Apple) than browser Web Push, and Web Push doesn't work inside the iOS
-- WKWebView. Unique on token so a device re-registering upserts cleanly.

CREATE TABLE IF NOT EXISTS "apns_device_tokens" (
  "id" bigint PRIMARY KEY NOT NULL,
  "user_id" bigint NOT NULL,
  "token" text NOT NULL,
  "platform" text DEFAULT 'ios' NOT NULL,
  "label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "apns_device_tokens"
    ADD CONSTRAINT "apns_device_tokens_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apns_device_tokens_user_idx"
  ON "apns_device_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apns_device_tokens_token_idx"
  ON "apns_device_tokens" USING btree ("token");
