const DEFAULT_TARGET_TTL_MS = 30 * 60 * 1000;
const TOKEN_COOKIE_NAME = 'oc_preview_token';
const PREVIEW_HOST_LABEL = 'preview';
const PREVIEW_LOCALHOST_SUFFIX = `.${PREVIEW_HOST_LABEL}.localhost`;
// Matches Host header values like:
//   <id>.preview.localhost
//   <id>.192-168-1-42.nip.io
//   <id>.10-0-0-5.sslip.io
const SUBDOMAIN_HOST_PATTERN = /^([a-f0-9]{16,64})\.([a-z0-9-]+\.)*?(?:preview\.localhost|nip\.io|sslip\.io)$/i;

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

// Detects RFC1918 / loopback / link-local / dotted-IPv4 hosts that we treat as
// "private" enough to use a subdomain proxy via nip.io.
const isPrivateIPv4 = (hostname) => {
  if (typeof hostname !== 'string') return false;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
};

const parseCookieHeader = (cookieHeader) => {
  const result = new Map();
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return result;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    result.set(key, value);
  }
  return result;
};

const buildCookie = ({
  name,
  value,
  path,
  maxAgeSeconds,
  secure,
}) => {
  const chunks = [`${name}=${value}`];
  if (path) chunks.push(`Path=${path}`);
  if (typeof maxAgeSeconds === 'number' && Number.isFinite(maxAgeSeconds)) {
    chunks.push(`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`);
  }
  chunks.push('HttpOnly');
  chunks.push('SameSite=Lax');
  if (secure) chunks.push('Secure');
  return chunks.join('; ');
};

const normalizeLoopbackUrl = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs are supported' };
  }

  const hostname = url.hostname;
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, error: 'Only loopback hosts are supported' };
  }

  const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'Invalid port' };
  }

  // Normalize common loopback hostnames to IPv4 to avoid environments where
  // `localhost` resolves to ::1 but the dev server only binds IPv4.
  if (hostname === '0.0.0.0' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    url.hostname = '127.0.0.1';
  }

  // Only keep origin here; the proxy path is preserved on the OpenChamber side.
  return { ok: true, origin: url.origin };
};

// Parse the request `Host` header and return { hostname, port, raw }.
const parseHostHeader = (req) => {
  const raw = typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
  if (!raw) return { hostname: '', port: '', raw: '' };
  // Handle bracketed IPv6 like [::1]:3001
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return { hostname: '', port: '', raw };
    const hostname = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : '';
    return { hostname, port, raw };
  }
  const idx = raw.indexOf(':');
  if (idx === -1) return { hostname: raw, port: '', raw };
  return { hostname: raw.slice(0, idx), port: raw.slice(idx + 1), raw };
};

// Decide which preview host strategy to use given the OpenChamber-facing Host
// header on the registration request.
//   - 'subdomain-localhost' → <id>.preview.localhost:<port>
//   - 'subdomain-nip'       → <id>.<dashed-ip>.nip.io:<port>
//   - 'path'                → /api/preview/proxy/<id>
const decidePreviewHostStrategy = (req) => {
  const { hostname, port } = parseHostHeader(req);
  if (!hostname) return { mode: 'path' };

  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower) || lower === 'localhost') {
    return { mode: 'subdomain-localhost', basePort: port };
  }

  if (isPrivateIPv4(lower)) {
    const dashed = lower.replace(/\./g, '-');
    return { mode: 'subdomain-nip', basePort: port, ipDashed: dashed };
  }

  return { mode: 'path' };
};

const buildPreviewOriginForId = ({ strategy, id, requestProtocol }) => {
  const protocol = requestProtocol === 'https' ? 'https' : 'http';
  const portSuffix = strategy.basePort ? `:${strategy.basePort}` : '';
  if (strategy.mode === 'subdomain-localhost') {
    return `${protocol}://${id}${PREVIEW_LOCALHOST_SUFFIX}${portSuffix}`;
  }
  if (strategy.mode === 'subdomain-nip') {
    return `${protocol}://${id}.${strategy.ipDashed}.nip.io${portSuffix}`;
  }
  return null;
};

// Pull the id out of the Host header if it matches our subdomain pattern.
const extractIdFromHost = (req) => {
  const { hostname } = parseHostHeader(req);
  if (!hostname) return '';
  const m = hostname.match(SUBDOMAIN_HOST_PATTERN);
  return m?.[1]?.toLowerCase() || '';
};

const requestProtocol = (req) => {
  const forwardedProto = typeof req?.headers?.['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  if (forwardedProto === 'https') return 'https';
  if (forwardedProto === 'http') return 'http';
  return req?.socket?.encrypted ? 'https' : 'http';
};

export const createPreviewProxyRuntime = ({
  crypto,
  URL,
  createProxyMiddleware,
}) => {
  const targets = new Map();
  let sweepTimer = null;

  const now = () => Date.now();

  const sweepExpired = () => {
    const t = now();
    for (const [id, entry] of targets.entries()) {
      if (entry.expiresAt <= t) {
        targets.delete(id);
      }
    }
  };

  const ensureSweeper = () => {
    if (sweepTimer) {
      return;
    }
    sweepTimer = setInterval(sweepExpired, 30_000);
    // Don't keep the process alive.
    sweepTimer.unref?.();
  };

  // `mode` records how the target is meant to be reached:
  //   'subdomain' → no token cookie required; subdomain id is the proof.
  //   'path'      → token cookie required, scoped to /api/preview/proxy/<id>.
  const createTarget = (origin, ttlMs, mode) => {
    const id = crypto.randomBytes(16).toString('hex');
    const token = mode === 'path' ? crypto.randomBytes(16).toString('hex') : '';
    const createdAt = now();
    const expiresAt = createdAt + (Number.isFinite(ttlMs) ? Math.max(15_000, Math.trunc(ttlMs)) : DEFAULT_TARGET_TTL_MS);
    targets.set(id, {
      id,
      origin,
      token,
      mode,
      createdAt,
      expiresAt,
    });
    return { id, token, expiresAt };
  };

  // Resolve a target from a request that arrived either:
  //   - on the subdomain host (extract id from Host), or
  //   - on the path-prefix route (extract id from URL path + verify cookie).
  const resolveTargetFromRequest = (req) => {
    // 1) Subdomain mode — id encoded in Host header.
    const subdomainId = extractIdFromHost(req);
    if (subdomainId) {
      const entry = targets.get(subdomainId);
      if (!entry || entry.expiresAt <= now()) {
        targets.delete(subdomainId);
        return { ok: false, status: 404, error: 'Preview target expired' };
      }
      if (entry.mode !== 'subdomain') {
        return { ok: false, status: 404, error: 'Preview target not found' };
      }
      const parsed = new URL(req?.originalUrl || req?.url || '/', 'http://localhost');
      return { ok: true, id: subdomainId, entry, parsed, viaSubdomain: true };
    }

    // 2) Path-prefix mode — id in URL, token in cookie.
    const rawUrl = req?.originalUrl || req?.url || '';
    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname || '';

    const match = pathname.match(/^\/api\/preview\/proxy\/([a-f0-9]{16,64})(?:\/|$)/i);
    const id = match?.[1] || '';
    if (!id) {
      return { ok: false, status: 404, error: 'Preview target not found' };
    }

    const entry = targets.get(id);
    if (!entry || entry.expiresAt <= now()) {
      targets.delete(id);
      return { ok: false, status: 404, error: 'Preview target expired' };
    }
    if (entry.mode !== 'path') {
      return { ok: false, status: 404, error: 'Preview target not found' };
    }

    const cookies = parseCookieHeader(req.headers?.cookie);
    const token = cookies.get(TOKEN_COOKIE_NAME) || '';
    if (!token || token !== entry.token) {
      return { ok: false, status: 403, error: 'Preview token missing' };
    }

    return { ok: true, id, entry, parsed, viaSubdomain: false };
  };

  const stripProxyPrefix = (pathname, id) => {
    const prefix = `/api/preview/proxy/${id}`;
    if (!pathname.startsWith(prefix)) {
      return pathname;
    }
    const rest = pathname.slice(prefix.length);
    return rest.length === 0 ? '/' : rest;
  };

  // Strip the `frame-ancestors` directive from a CSP header value while
  // preserving every other directive. Returns null if no directives remain.
  const removeFrameAncestorsDirective = (cspValue) => {
    if (typeof cspValue !== 'string' || cspValue.length === 0) {
      return cspValue;
    }
    const directives = cspValue
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const filtered = directives.filter((directive) => {
      const name = directive.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      return name !== 'frame-ancestors';
    });

    if (filtered.length === 0) {
      return null;
    }
    return filtered.join('; ');
  };

  // Drop response headers that prevent the dev server from being framed.
  // The proxy itself is same-origin, so embedding is otherwise safe.
  const stripFrameBustingHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') {
      return;
    }

    const headerKeys = Object.keys(headers);
    for (const key of headerKeys) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'x-frame-options') {
        delete headers[key];
        continue;
      }
      if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
        const original = headers[key];
        const values = Array.isArray(original) ? original : [original];
        const rewritten = values
          .map((value) => removeFrameAncestorsDirective(value))
          .filter((value) => typeof value === 'string' && value.length > 0);
        if (rewritten.length === 0) {
          delete headers[key];
        } else {
          headers[key] = Array.isArray(original) ? rewritten : rewritten[0];
        }
      }
    }
  };

  // The proxy middleware is created lazily so it can be shared between the
  // early host-gate (registered before the JSON body parser to avoid consuming
  // POST bodies destined for the dev server) and the late path-prefix mount.
  let cachedProxy = null;
  const getProxy = () => {
    if (cachedProxy) return cachedProxy;
    cachedProxy = createProxyMiddleware({
      target: 'http://127.0.0.1',
      changeOrigin: true,
      ws: true,
      // Restrict the proxy (especially its auto-attached `upgrade` listener,
      // which is registered globally on the underlying HTTP server when
      // `ws: true`) to preview paths/hosts. Without this, every WebSocket
      // upgrade on the server gets proxied and tears the socket down.
      pathFilter: (pathname, req) => {
        // Subdomain-host requests: proxy everything on that host.
        if (extractIdFromHost(req)) return true;
        // Path-prefix requests on the OpenChamber host.
        const target = req?.originalUrl || pathname || req?.url || '';
        return target.startsWith('/api/preview/proxy/');
      },
      router: (req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return 'http://127.0.0.1';
        }
        return resolved.entry.origin;
      },
      pathRewrite: (pathValue, req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return pathValue;
        }

        const parsed = new URL(req.originalUrl || req.url || '', 'http://localhost');
        // Never forward our auth cookie token to the dev server.
        parsed.searchParams.delete('ocPreview');

        let nextPath;
        if (resolved.viaSubdomain) {
          // Subdomain mode: the URL path is already the dev-server path.
          nextPath = parsed.pathname || '/';
        } else {
          nextPath = stripProxyPrefix(parsed.pathname, resolved.id);
        }
        const search = parsed.searchParams.toString();
        return `${nextPath}${search ? `?${search}` : ''}`;
      },
      on: {
        proxyReq: (proxyReq) => {
          // Keep local dev servers from receiving OpenChamber credentials.
          proxyReq.removeHeader('cookie');
          proxyReq.removeHeader('authorization');
          proxyReq.removeHeader('x-openchamber-ui-session');
          proxyReq.setHeader('accept-encoding', 'identity');
        },
        proxyRes: (proxyRes) => {
          // Allow the dev server response to be framed inside OpenChamber even
          // if it normally sets X-Frame-Options or a CSP frame-ancestors rule.
          // The proxy is same-origin so embedding is otherwise safe.
          stripFrameBustingHeaders(proxyRes.headers);
        },
        error: (err, _req, res) => {
          const isDev = typeof process !== 'undefined'
            && process
            && process.env
            && process.env.NODE_ENV !== 'production';

          const message = err && typeof err === 'object' && typeof err.message === 'string'
            ? err.message
            : 'Unknown proxy error';

          console.error('[preview-proxy] proxy error:', message);

          if (res && !res.headersSent && typeof res.status === 'function') {
            const payload = { error: 'Preview proxy error' };

            if (isDev) {
              try {
                const resolved = resolveTargetFromRequest(_req);
                payload.details = {
                  message,
                  code: err && typeof err === 'object' ? err.code : undefined,
                  targetOrigin: resolved?.ok ? resolved.entry.origin : undefined,
                };
              } catch {
                payload.details = { message };
              }
            }

            res.status(502).json(payload);
          }
        },
      },
    });
    return cachedProxy;
  };

  // Subdomain host gate. MUST be registered before the global JSON body
  // parser so that POSTs through the proxy aren't pre-consumed. Caller is
  // responsible for invoking this early in middleware setup.
  const attachHostGate = (app) => {
    ensureSweeper();
    const proxy = getProxy();
    app.use((req, res, next) => {
      const id = extractIdFromHost(req);
      if (!id) return next();
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      return proxy(req, res, next);
    });
  };

  const attach = (app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
  }) => {
    ensureSweeper();
    const proxy = getProxy();

    app.post('/api/preview/targets', express.json(), async (req, res) => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, res);
          if (!sessionToken) {
            return res.status(401).json({ error: 'UI authentication required' });
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            return res.status(403).json({ error: 'Invalid origin' });
          }
        }

        const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        if (!rawUrl) {
          return res.status(400).json({ error: 'url is required' });
        }

        const ttlMs = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : DEFAULT_TARGET_TTL_MS;
        const normalized = normalizeLoopbackUrl(rawUrl);
        if (!normalized.ok) {
          return res.status(400).json({ error: normalized.error });
        }

        const strategy = decidePreviewHostStrategy(req);
        const protocol = requestProtocol(req);

        if (strategy.mode === 'subdomain-localhost' || strategy.mode === 'subdomain-nip') {
          const target = createTarget(normalized.origin, ttlMs, 'subdomain');
          const previewOrigin = buildPreviewOriginForId({ strategy, id: target.id, requestProtocol: protocol });
          // No cookie under subdomain mode — the unguessable subdomain id is
          // the proof of authorization. (Same security model as the previous
          // path+cookie scheme: anyone who can read the registration response
          // body can reach the proxied content.)
          return res.json({
            id: target.id,
            mode: 'subdomain',
            previewOrigin,
            // Preserve the legacy field name; in subdomain mode it is `/`.
            proxyBasePath: '/',
            expiresAt: target.expiresAt,
          });
        }

        // Fallback: path-prefix mode (e.g. behind a tunnel where we can't get
        // a wildcard hostname). Vite-style root-absolute module URLs will not
        // work in this mode; the UI surfaces a hint when this happens.
        const target = createTarget(normalized.origin, ttlMs, 'path');
        const cookiePath = `/api/preview/proxy/${target.id}`;
        const secure = Boolean(req.secure);
        res.setHeader('Set-Cookie', buildCookie({
          name: TOKEN_COOKIE_NAME,
          value: target.token,
          path: cookiePath,
          maxAgeSeconds: Math.round((target.expiresAt - now()) / 1000),
          secure,
        }));

        return res.json({
          id: target.id,
          mode: 'path',
          previewOrigin: null,
          proxyBasePath: cookiePath,
          expiresAt: target.expiresAt,
        });
      } catch (error) {
        console.error('[preview-proxy] Failed to create target:', error);
        return res.status(500).json({ error: 'Failed to create preview target' });
      }
    });

    // Path-prefix route (legacy / tunnel fallback).
    app.use('/api/preview/proxy', (req, res, next) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({ error: resolved.error });
      }
      next();
    }, proxy);

    server.on('upgrade', (req, socket, head) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return;
      }

      const handleUpgrade = async () => {
        try {
          // Subdomain-mode upgrades are authorized by the unguessable
          // subdomain id alone, matching the HTTP path. Path-mode upgrades
          // still require an authenticated UI session.
          if (!resolved.viaSubdomain && uiAuthController?.enabled) {
            const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
            if (!sessionToken) {
              rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
              return;
            }

            const originAllowed = await isRequestOriginAllowed(req);
            if (!originAllowed) {
              rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
              return;
            }
          }

          // Rewrite req.url to what the dev server expects.
          const rawUrl = req.url || '';
          const parsed = new URL(rawUrl, 'http://localhost');
          const nextPath = resolved.viaSubdomain
            ? (parsed.pathname || '/')
            : stripProxyPrefix(parsed.pathname, resolved.id);
          const search = parsed.searchParams.toString();
          req.url = `${nextPath}${search ? `?${search}` : ''}`;

          proxy.upgrade(req, socket, head);
        } catch {
          rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
        }
      };

      void handleUpgrade();
    });
  };

  return {
    attachHostGate,
    attach,
  };
};
