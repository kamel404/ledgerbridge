/**
 * Logs must not contain secrets, tokens or full customer emails (SPEC §10).
 * Every log message passes through redact() before it's written, as a safety
 * net: code should not log such values in the first place.
 */

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** An Authorization header value, whatever the scheme: "Authorization: ***". */
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^"'\s,}]+/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
/** key=value or "key": "value" pairs whose key looks secret. */
const SECRET_PAIR =
  /(["']?(?:client_?secret|clientSecret|password|secret|token|access_token|x-signature)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi;

/** ap@cedar.example -> a***@cedar.example */
export function maskEmail(email: string): string {
  return email.replace(EMAIL, '$1***@$2');
}

export function redact(text: string): string {
  return text
    .replace(EMAIL, '$1***@$2')
    .replace(AUTH_HEADER, '$1***')
    .replace(BEARER, '$1 ***')
    .replace(SECRET_PAIR, '$1***');
}
