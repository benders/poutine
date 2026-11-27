/**
 * Credential redaction for anything that logs a URL (#317).
 *
 * Subsonic carries auth in the query string (`p`, `t`+`s`), and the hub adds
 * `castToken` (cast streams), `token` (JWT fallback) and `apiKey`
 * (OpenSubsonic). Fastify's default `req` serializer logs `req.url` verbatim,
 * so without this every request line — and every line forwarded by New
 * Relic logs-in-context — would carry them. Use `redactUrl()` for any
 * explicit `log.*({ url })` too.
 *
 * Fastify also interpolates the raw URL into a few message strings (the
 * default 404 handler's `Route GET:<url> not found`, "reply already sent"
 * warnings) and error messages. `redactingLoggerOptions` covers those with a
 * text-level pass over every string log argument and serialized error.
 */
import type { FastifyRequest } from "fastify";
import { stdSerializers } from "pino";
import type { LoggerOptions } from "pino";

/** Query parameters whose values never reach a log line (case-insensitive). */
export const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "p",
  "t",
  "s",
  "castToken",
  "token",
  "apiKey",
].map((k) => k.toLowerCase()));

export const REDACTED = "[REDACTED]";

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    // Malformed escape: match on the raw text rather than skip the check.
    return rawKey;
  }
}

/**
 * Replace the values of sensitive query parameters with `[REDACTED]`, and any
 * userinfo password in an absolute URL. Everything else — path, other params,
 * their original encoding and order, fragment — is left byte-for-byte intact.
 * Repeated keys are each redacted; keys are matched after percent-decoding.
 */
export function redactUrl(url: string): string {
  let out = url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*):[^/?#@]*@/i,
    `$1:${REDACTED}@`,
  );
  const q = out.indexOf("?");
  if (q === -1) return out;
  const hash = out.indexOf("#", q);
  const end = hash === -1 ? out.length : hash;
  const query = out.slice(q + 1, end);
  const redacted = query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      const rawKey = eq === -1 ? part : part.slice(0, eq);
      if (!SENSITIVE_QUERY_PARAMS.has(decodeKey(rawKey).trim().toLowerCase())) {
        return part;
      }
      return `${rawKey}=${REDACTED}`;
    })
    .join("&");
  out = out.slice(0, q + 1) + redacted + out.slice(end);
  return out;
}

/**
 * Drop-in replacement for Fastify's default `req` log serializer (same shape,
 * see `fastify/lib/logger-pino.js`) with the URL passed through `redactUrl`.
 */
export function redactingReqSerializer(req: FastifyRequest): {
  method: string;
  url: string;
  version: string | undefined;
  host: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
} {
  const version = req.headers?.["accept-version"];
  return {
    method: req.method,
    url: redactUrl(req.url ?? ""),
    version: Array.isArray(version) ? version.join(",") : version,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

const SENSITIVE_IN_TEXT = new RegExp(
  `([?&](?:${[...SENSITIVE_QUERY_PARAMS].join("|")})=)[^&\\s"'#]*`,
  "gi",
);

/**
 * Text-level fallback for free-form strings that may embed a URL (log
 * messages, error messages, stacks). Plain-key matches only — prefer
 * `redactUrl()` when the value is known to be a URL.
 */
export function redactText(text: string): string {
  return text.replace(SENSITIVE_IN_TEXT, `$1${REDACTED}`);
}

type SerializedError = ReturnType<typeof stdSerializers.err>;

function redactingErrSerializer(err: Error): SerializedError {
  const out = stdSerializers.err(err);
  if (typeof out.message === "string") out.message = redactText(out.message);
  if (typeof out.stack === "string") out.stack = redactText(out.stack);
  return out;
}

/**
 * Spread into the Fastify `logger` options: `req` / `err` serializers plus a
 * `logMethod` hook that redacts every string argument (the message and any
 * printf-style args).
 */
export const redactingLoggerOptions = {
  serializers: { req: redactingReqSerializer, err: redactingErrSerializer },
  hooks: {
    logMethod(args, method) {
      const redacted = args.map((a: unknown) =>
        typeof a === "string" ? redactText(a) : a,
      );
      return method.apply(this, redacted as Parameters<typeof method>);
    },
  },
} satisfies Pick<LoggerOptions, "serializers" | "hooks">;
