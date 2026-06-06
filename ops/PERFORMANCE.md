# Performance & tuning

The application layer (virtualized message list, batched queries, lazy
images, code-split routes, immutable CDN caching) is already tuned. The
levers below are infrastructure-side and most benefit from being matched
to your actual hardware and traffic.

## 1. Prepared statements (free query speedup)

`DB_PREPARED` (api env, default `false`). Prepared statements cache query
plans on the Postgres connection. They're disabled by default because
pgBouncer in transaction-pooling mode doesn't support them.

**The default compose setup connects the api directly to Postgres (no
pgBouncer), so you can turn this on:**

```env
DB_PREPARED=true
```

Only keep it `false` if you put pgBouncer (transaction mode) between the
api and Postgres.

`DB_POOL_MAX` (default `10`) sizes the connection pool — raise it for a
busy instance with many concurrent requests.

## 2. Postgres memory tuning

The `db` service ships with slow-query logging on
(`log_min_duration_statement=300` → anything over 300ms shows in
`docker logs zekktris-db`). The memory settings are commented in
`docker-compose.yml`; uncomment and size them to the RAM you can give
Postgres. Rough rule of thumb for **N GB dedicated to Postgres**:

| setting                | value            |
| ---------------------- | ---------------- |
| `shared_buffers`       | ~25% of N        |
| `effective_cache_size` | ~50–75% of N     |
| `work_mem`             | 16–64MB (per sort) |
| `maintenance_work_mem` | 128–512MB        |

After large purges (channel purge, user sweeps), dead tuples accumulate.
Autovacuum handles this, but you can force a one-off reclaim:

```bash
docker exec zekktris-db psql -U commune -d commune -c "VACUUM ANALYZE;"
```

Watch dead tuples with:

```bash
docker exec zekktris-db psql -U commune -d commune -c \
  "SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;"
```

## 3. CDN media served by Caddy

Caddy now serves `/cdn/*` straight off the upload volume (mounted
read-only at `/srv/cdn`), taking media bandwidth off the Node API. It's
safe by construction:

- Non-inline-safe types (html/svg/xml/js/css) are forced to download as
  `application/octet-stream`, and `nosniff` is global — no stored-XSS
  vector.
- If a file isn't on disk (or the volume isn't mounted), the request
  falls back to the api exactly as before. **Shipping this without the
  volume mount changes nothing**, so it's safe to roll out incrementally.

Files are content-addressed and immutable, so they're served with a
1-year `immutable` cache header — repeat loads never hit the server.

## 4. HTTP/3

Enabled in Caddy global options (`protocols h1 h2 h3`) and the proxy now
maps the HTTPS port over UDP. **Only active on the `https://` deployment
path** — browsers won't negotiate h3 over plain `http://`. No effect on a
plain `:5550` LAN setup.

## 5. Bundle analysis

```bash
ANALYZE=1 pnpm --filter @zekktris/web build
```

writes `apps/web/dist/stats.html` — a gzip/brotli treemap of the bundle.
Use it to spot anything heavy before optimizing further.

## 6. Measure before more changes

The above are the last broadly-safe wins. Beyond them, drive changes from
data: the slow-query log (#2), the bundle treemap (#5), and a Lighthouse
run against the deployed app. Speculative micro-optimization past this
point tends to cost more than it returns.
