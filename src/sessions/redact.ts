/**
 * Secret scrubbing for session transcripts — a TypeScript port of deja-vu's
 * redaction pass (github.com/vshulcz/deja-vu, `internal/redact/redact.go`,
 * MIT license). Ported instead of shipping the Go binary; the pattern set,
 * gates, and entropy heuristics are kept faithful so upstream fixes can be
 * re-ported by diffing that file.
 *
 * Everything the miner reads out of local session logs passes through here
 * before it can reach a model prompt or a knowledge write. The rules are
 * biased toward over-redaction: a false positive costs a little transcript
 * context, a false negative leaks a credential off the machine.
 *
 * Deliberate deviations from upstream:
 * - No `DEJA_NO_REDACT`-style disable switch — the miner's scrub pass must
 *   not be turnable-off.
 * - Dosu API keys (`sk_user_…`) are added to the provider pattern.
 */

/** Every replacement is `[redacted:<kind>]`; kinds mirror deja-vu's. */
export const REDACTION_MARKER = "[redacted:";

export type RedactionCounts = Record<string, number>;

export interface RedactionResult {
  text: string;
  /** Total replacements across all kinds. */
  count: number;
  /** Replacements per kind, e.g. `{ "github-token": 2, entropy: 1 }`. */
  counts: RedactionCounts;
}

const awsAccessKeyRE = /A(?:KIA|SIA)[0-9A-Z]{16}/g;
const awsSecretRE =
  /\b(aws[_-]?secret[_-]?access[_-]?key)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=_-]{32,})(\\*['"]?)/gi;
// The key may be embedded in a larger identifier (ANTHROPIC_API_KEY,
// x-api-key) and, in JSON, a closing quote can sit between the key and the
// delimiter ("api_key": "..."). The `\\*` runs tolerate escaped-JSON quotes
// (`api_key\":`) that agents paste constantly.
const genericKVRE =
  /\b([\w.-]{0,64}?(?:api[_-]?key|secret|token|passwd|password|authorization))(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})(\\*['"]?)/gi;
// An env var holding a credential does not have to say "api" or "token":
// DEJA_EMBED_KEY, GROQ_KEY all end in plain _KEY. Case-sensitive on purpose —
// this is the shell shape, and matching `cache_key:` too costs recall for no
// secret.
const envKeyRE =
  /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_KEY)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})(\\*['"]?)/g;
// The same shape in the languages people actually type in — an English-only
// list left "пароль: …" in the clear.
const genericKVIntlRE =
  /(парол[ьяею]|токен[ауы]?|секрет[ауы]?|ключ[аеиуом]?|contraseña|senha|passwort|密码|密碼|パスワード|비밀번호)(\\*['"]?\s*[:=]\s*)(\\*['"]?)([A-Za-z0-9/+=._-]{16,})(\\*['"]?)/gi;
const bearerRE = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi;
// A secret named in prose and quoted rather than assigned — tool output is
// full of `password authentication failed … with password "S3cr3tP@ssw0rd!"`.
// The quotes make it safe to be this loose: an unquoted mention matches
// nothing.
const quotedSecretRE =
  /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s+(?:is\s+|was\s+|for\s+)?)(\\*["'`])([^"'`\n]{6,80})(\\*["'`])/gi;
const pemPrivateRE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g;
// Provider prefixes. sk- allows internal hyphens/underscores so hyphenated
// formats (sk-ant-…, sk-proj-…) are covered. `sk_user_` is the Dosu addition.
const providerRE =
  /\b(gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk_user_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]*[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|xox[bpcs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g;
const jwtRE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
// Password is greedy so a password containing '@' (user:p@ss@host) splits on
// the last '@' and is redacted whole.
const connURLRE = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s]+)@([^\s]+)/g;

// kvHints are the substrings genericKVRE can anchor on; providerHints the
// literal prefixes of providerRE. Checking them first keeps the regexes off
// the vast majority of messages, which contain no credentials at all.
const kvHints = [
  "key",
  "secret",
  "token",
  "passw",
  "authorization",
  "пароль",
  "парол",
  "токен",
  "секрет",
  "ключ",
  "contraseña",
  "senha",
  "mot de passe",
  "passwort",
  "密码",
  "密碼",
  "パスワード",
  "비밀번호",
];

const providerHints = [
  "ghp_",
  "gho_",
  "ghs_",
  "ghu_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "sk_",
  "rk_",
  "sk-",
  "gsk_",
  "xai-",
  "hf_",
  "npm_",
  "xox",
  "AIza",
];

function isWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 45 || // -
    code === 46 // .
  );
}

function isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/**
 * Reports whether any key-ish word in the text is followed by an assignment.
 * genericKVRE cannot match unless one is, so skipping on a negative cannot
 * change what is redacted — it only keeps the regexes off ordinary chatter,
 * where "token", "secret" and "key" are everyday words.
 */
function kvAssignmentNearby(lower: string): boolean {
  for (const hint of kvHints) {
    let at = 0;
    for (;;) {
      const i = lower.indexOf(hint, at);
      if (i < 0) break;
      if (assignmentFollows(lower, i + hint.length)) return true;
      at = i + 1;
    }
  }
  return false;
}

/**
 * Skips what genericKVRE allows between the name and the value — the rest of
 * a longer name, spaces, and optional (possibly escaped) quotes — and looks
 * for the ':' or '=' the pattern requires. Chars >= 0x80 continue a
 * non-ASCII word so "парол" can reach the ':' behind "пароля".
 */
function assignmentFollows(s: string, start: number): boolean {
  let i = start;
  while (i < s.length && (isWordChar(s.charCodeAt(i)) || s.charCodeAt(i) >= 0x80)) i++;
  while (i < s.length && (isSpaceChar(s[i]) || s[i] === "'" || s[i] === '"' || s[i] === "\\")) i++;
  return i < s.length && (s[i] === ":" || s[i] === "=");
}

function containsAny(s: string, hints: readonly string[]): boolean {
  return hints.some((h) => s.includes(h));
}

function add(counts: RedactionCounts, kind: string, n: number): void {
  if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
}

function replaceWhole(s: string, re: RegExp, kind: string, counts: RedactionCounts): string {
  let n = 0;
  const out = s.replace(re, () => {
    n += 1;
    return `${REDACTION_MARKER}${kind}]`;
  });
  add(counts, kind, n);
  return out;
}

function replaceSubmatch(
  s: string,
  re: RegExp,
  kind: string,
  counts: RedactionCounts,
  repl: (groups: string[]) => string,
): string {
  let n = 0;
  const out = s.replace(re, (...args) => {
    n += 1;
    // args = [match, ...captures, offset, whole string]
    return repl(args.slice(0, -2) as string[]);
  });
  add(counts, kind, n);
  return out;
}

/** Emit the closing quote only when an opening quote was captured. */
function closingQuote(open: string, close: string): string {
  return open === "" ? "" : close;
}

function replaceProvider(s: string, counts: RedactionCounts): string {
  return s.replace(providerRE, (v) => {
    let kind = "provider-token";
    if (/^(gh[opsur]_|github_pat_)/.test(v)) kind = "github-token";
    else if (/^(?:sk|rk)_(?:live|test)_/.test(v)) kind = "stripe-key";
    else if (v.startsWith("sk_user_")) kind = "dosu-key";
    else if (v.startsWith("sk-ant-")) kind = "anthropic-key";
    else if (v.startsWith("sk-")) kind = "openai-key";
    else if (v.startsWith("gsk_")) kind = "groq-key";
    else if (v.startsWith("xai-")) kind = "xai-key";
    else if (v.startsWith("hf_")) kind = "huggingface-token";
    else if (v.startsWith("glpat-")) kind = "gitlab-token";
    else if (v.startsWith("npm_")) kind = "npm-token";
    else if (/^xox[bpcs]-/.test(v)) kind = "slack-token";
    else if (v.startsWith("AIza")) kind = "google-api-key";
    add(counts, kind, 1);
    return `${REDACTION_MARKER}${kind}]`;
  });
}

export function redactSecrets(text: string): RedactionResult {
  const counts: RedactionCounts = {};
  if (text === "") return { text, count: 0, counts };
  let s = text;
  const lower = s.toLowerCase();

  if (s.includes("-----BEGIN")) {
    s = replaceWhole(s, pemPrivateRE, "private-key", counts);
  }
  if (s.includes("://")) {
    s = replaceSubmatch(
      s,
      connURLRE,
      "url-credentials",
      counts,
      (m) => `${m[1]}${m[2]}:[redacted:url-credentials]@${m[4]}`,
    );
  }
  if (lower.includes("aws")) {
    s = replaceSubmatch(
      s,
      awsSecretRE,
      "aws-secret",
      counts,
      (m) => `${m[1]}${m[2]}${m[3]}[redacted:aws-secret]${closingQuote(m[3], m[5])}`,
    );
  }
  if (s.includes("AKIA") || s.includes("ASIA")) {
    s = replaceWhole(s, awsAccessKeyRE, "aws-access-key", counts);
  }
  if (
    lower.includes("password") ||
    lower.includes("passwd") ||
    lower.includes("pwd") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("apikey")
  ) {
    s = replaceSubmatch(
      s,
      quotedSecretRE,
      "quoted-secret",
      counts,
      (m) => `${m[1]}${m[2]}${m[3]}[redacted:quoted-secret]${m[5]}`,
    );
  }
  if (lower.includes("bearer") || lower.includes("basic ")) {
    s = replaceSubmatch(
      s,
      bearerRE,
      "bearer-token",
      counts,
      (m) => `${m[1]}${m[2]}[redacted:bearer-token]`,
    );
  }
  if (s.includes("eyJ")) {
    s = replaceWhole(s, jwtRE, "jwt", counts);
  }
  if (kvAssignmentNearby(lower)) {
    const kvRepl = (m: string[]) =>
      `${m[1]}${m[2]}${m[3]}[redacted:credential]${closingQuote(m[3], m[5])}`;
    s = replaceSubmatch(s, genericKVRE, "credential", counts, kvRepl);
    s = replaceSubmatch(s, envKeyRE, "credential", counts, kvRepl);
    s = replaceSubmatch(s, genericKVIntlRE, "credential", counts, kvRepl);
  }
  if (containsAny(s, providerHints)) {
    s = replaceProvider(s, counts);
  }
  s = redactEntropy(s, counts);

  let count = 0;
  for (const n of Object.values(counts)) count += n;
  return { text: s, count, counts };
}

// ── entropy pass ────────────────────────────────────────────────────────────
// Pattern matching only catches shapes we know. A bare high-entropy string is
// caught here instead — but entropy alone fires on identifiers, hashes and
// paths everywhere, so a token must also sit in a secret-shaped context: the
// value side of an assignment, or alone on its own line.

const entropyMinBits = 4.5;
const entropyMinAssign = 20;
const entropyMinStandalone = 28;

/**
 * Query-time stop words from deja-vu's `internal/query`, used to reject
 * assignment keys that are ordinary prose ("moved to: <blob>"). Only the
 * English list is ported: assignment keys are ASCII word chars by
 * construction, so the non-ASCII entries could never appear here.
 */
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "but",
  "by",
  "dealt",
  "did",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of freq.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(s: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let other = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) lower = true;
    else if (c >= 65 && c <= 90) upper = true;
    else if (c >= 48 && c <= 57) digit = true;
    else other = true;
  }
  return [lower, upper, digit, other].filter(Boolean).length;
}

function isHexish(s: string): boolean {
  return /^[0-9a-fA-F-]+$/.test(s);
}

/**
 * A filesystem path is not a blob whatever its case: rooted, more than one
 * separator, and none of the punctuation a credential or URL brings with it.
 */
function looksLikePath(tok: string): boolean {
  if (
    !tok.startsWith("/") &&
    !tok.startsWith("~/") &&
    !tok.startsWith("./") &&
    !tok.startsWith("../")
  ) {
    return false;
  }
  if ((tok.match(/\//g) ?? []).length < 2) return false;
  // '=' is base64 padding and the assignment a secret arrives in; ':' is a
  // scheme or a key. Either one means this is not a bare path.
  return !tok.includes("=") && !tok.includes(":");
}

function entropyCandidate(tok: string): boolean {
  if (tok.length > 256 || isHexish(tok) || charClasses(tok) < 3) return false;
  // Lowercase-only path segments sneak into the charset via '/' and '-';
  // real secrets with slashes (base64) mix cases.
  if (tok.includes("/") && tok.toLowerCase() === tok) return false;
  if (looksLikePath(tok)) return false;
  return shannonBits(tok) >= entropyMinBits;
}

/**
 * Reports whether s[start] begins the value side of an assignment: a word,
 * then = or :, optional quote/space, then the token. Prose assigns nothing —
 * a key that is an English stop word ("moved to: <blob>") does not count.
 */
function assignmentValue(s: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (s[i] === '"' || s[i] === "'" || s[i] === " " || s[i] === "\t")) i--;
  if (i < 0 || (s[i] !== "=" && s[i] !== ":")) return false;
  i--;
  while (i >= 0 && (s[i] === '"' || s[i] === "'" || s[i] === " " || s[i] === "\t")) i--;
  const end = i + 1;
  while (i >= 0 && isWordChar(s.charCodeAt(i))) i--;
  const key = s.slice(i + 1, end);
  // A pure-digit key is the Telegram bot-token shape (12345678:AA…) — keep
  // it. Otherwise require a real word: two-letter keys are log noise.
  if (/^[0-9]+$/.test(key)) return key.length >= 6;
  if (key.length < 3) return false;
  return !stopWords.has(key.toLowerCase());
}

/**
 * Reports whether the token is the only content on its line — the shape of a
 * pasted credential.
 */
function standaloneLine(s: string, start: number, end: number): boolean {
  for (let i = start - 1; i >= 0 && s[i] !== "\n"; i--) {
    if (s[i] !== " " && s[i] !== "\t" && s[i] !== "\r") return false;
  }
  for (let j = end; j < s.length && s[j] !== "\n"; j++) {
    if (s[j] !== " " && s[j] !== "\t" && s[j] !== "\r") return false;
  }
  return true;
}

function isEntropyChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 || // +
    code === 47 || // /
    code === 95 || // _
    code === 45 // -
  );
}

/**
 * Finds runs of twenty or more characters from [A-Za-z0-9+/_-], plus up to
 * two trailing '=' of base64 padding.
 */
function entropySpans(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < s.length; ) {
    if (!isEntropyChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const run = i;
    while (i < s.length && isEntropyChar(s.charCodeAt(i))) i++;
    if (i - run < entropyMinAssign) continue;
    let end = i;
    for (let pad = 0; pad < 2 && end < s.length && s[end] === "="; pad++) end++;
    out.push([run, end]);
    i = end;
  }
  return out;
}

function redactEntropy(s: string, counts: RedactionCounts): string {
  if (s.length < entropyMinAssign) return s;
  const spans = entropySpans(s);
  if (spans.length === 0) return s;
  let out = "";
  let last = 0;
  for (const [start, end] of spans) {
    const tok = s.slice(start, end);
    if (tok.includes(REDACTION_MARKER)) continue;
    const hit =
      (tok.length >= entropyMinAssign && assignmentValue(s, start) && entropyCandidate(tok)) ||
      (tok.length >= entropyMinStandalone &&
        standaloneLine(s, start, end) &&
        entropyCandidate(tok));
    if (!hit) continue;
    out += `${s.slice(last, start)}[redacted:entropy]`;
    last = end;
    add(counts, "entropy", 1);
  }
  if (last === 0) return s;
  return out + s.slice(last);
}
