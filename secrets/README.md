# Secrets drop-zone

## APNs (iOS push notifications)

Drag your Apple push key here — the file named like `AuthKey_AB12CD34EF.p8`
from developer.apple.com → Certificates, Identifiers & Profiles → Keys.

That's it for the key: the api scans this folder on startup, picks up the
first `.p8` it finds, and reads the Key ID from the filename (so don't
rename the file).

Then set in `.env` (next to docker-compose.yml):

```
APNS_TEAM_ID=YOUR10CHARTEAMID
APNS_BUNDLE_ID=com.your.bundleid
APNS_PRODUCTION=false   # false for Xcode-run builds, true for TestFlight
```

Apply with:

```
docker compose up -d --force-recreate api
```

Verify in `docker logs zekktris-api` — you should see a line like
`APNs: configured (key AB12CD34EF, topic com.your.bundleid, sandbox)`.

Files in this folder are git-ignored.
