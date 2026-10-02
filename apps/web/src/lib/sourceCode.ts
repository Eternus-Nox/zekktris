import { useEffect, useState } from 'react';

/** Upstream repository — used until the server says otherwise. */
const UPSTREAM_SOURCE_URL = 'https://github.com/Eternus-Nox/zekktris';

/**
 * Where this server's source code lives (AGPL-3.0 §13: people using a server
 * over the network must be offered its source). The server reports it in the
 * public GET /api/v1/instance/info — a self-hoster running a modified version
 * points SOURCE_CODE_URL at their own fork.
 */
export function useSourceCodeUrl(): string {
  const [url, setUrl] = useState(UPSTREAM_SOURCE_URL);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/instance/info', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { sourceCode?: unknown } | null) => {
        if (!cancelled && typeof info?.sourceCode === 'string' && /^https?:\/\//.test(info.sourceCode)) {
          setUrl(info.sourceCode);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return url;
}
