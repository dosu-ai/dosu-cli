import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("returns clean text unchanged with a zero count", () => {
    const input = "The watermark gate advanced to 2026-08-27; nothing secret here.";
    expect(redactSecrets(input)).toEqual({ text: input, count: 0, counts: {} });
  });

  it("returns empty text unchanged", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0, counts: {} });
  });

  it("redacts PEM private key blocks including the delimiters", () => {
    const input = [
      "here is the key:",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Zx0FAKE",
      "-----END RSA PRIVATE KEY-----",
      "done",
    ].join("\n");

    const { text, counts } = redactSecrets(input);

    expect(counts).toEqual({ "private-key": 1 });
    expect(text).toBe("here is the key:\n[redacted:private-key]\ndone");
  });

  it("redacts only the password of a connection URL, keeping user and host", () => {
    const { text, counts } = redactSecrets(
      "DATABASE_URL is postgres://admin:s3cr3t@db.internal:5432/app",
    );

    expect(counts).toEqual({ "url-credentials": 1 });
    expect(text).toBe(
      "DATABASE_URL is postgres://admin:[redacted:url-credentials]@db.internal:5432/app",
    );
  });

  it("splits a password containing '@' on the last '@'", () => {
    const { text } = redactSecrets("mysql://root:p@ss@db.host/x");

    expect(text).toBe("mysql://root:[redacted:url-credentials]@db.host/x");
  });

  it("redacts AWS secret access key assignments", () => {
    const { text, counts } = redactSecrets(
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY00",
    );

    expect(counts["aws-secret"]).toBe(1);
    expect(text).toContain("AWS_SECRET_ACCESS_KEY=[redacted:aws-secret]");
  });

  it("redacts AWS access key IDs anywhere in text", () => {
    const { text, counts } = redactSecrets("creds AKIAIOSFODNN7EXAMPLE end");

    expect(counts).toEqual({ "aws-access-key": 1 });
    expect(text).toBe("creds [redacted:aws-access-key] end");
  });

  it("redacts quoted secrets named in prose", () => {
    const { text, counts } = redactSecrets(
      'FATAL: password authentication failed with password "S3cr3tP@ssw0rd!"',
    );

    expect(counts).toEqual({ "quoted-secret": 1 });
    expect(text).toBe(
      'FATAL: password authentication failed with password "[redacted:quoted-secret]"',
    );
  });

  it("keeps the Bearer/Basic prefix and redacts only the token", () => {
    const bearer = redactSecrets("Authorization: Bearer abc.def-ghi_jkl~mno123456");
    expect(bearer.text).toBe("Authorization: Bearer [redacted:bearer-token]");

    const basic = redactSecrets("curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA=='");
    expect(basic.text).toContain("Basic [redacted:bearer-token]");
  });

  it("redacts JWTs, including Supabase-style keys", () => {
    const { text, counts } = redactSecrets(
      "anon key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi",
    );

    expect(counts).toEqual({ jwt: 1 });
    expect(text).toBe("anon key [redacted:jwt]");
  });

  it("redacts a JWT glued to a preceding word character", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake-signature";
    const forms = [
      // A JWT on its own line inside JSON-in-a-string: the escaped newline's `n` touches it.
      [`{"stdout": "output:\\n${jwt}\\n"}`, `{"stdout": "output:\\n[redacted:jwt]\\n"}`],
      [`"\\t${jwt}"`, `"\\t[redacted:jwt]"`],
      // URL-encoded `=` and space.
      [`?q=access_token%3D${jwt}`, `?q=access_token%3D[redacted:jwt]`],
      [`Authorization:%20${jwt}`, `Authorization:%20[redacted:jwt]`],
    ];

    for (const [input, expected] of forms) {
      expect(redactSecrets(input)).toEqual({ text: expected, count: 1, counts: { jwt: 1 } });
    }
  });

  it("leaves dotted identifiers that merely contain eyJ alone", () => {
    for (const input of ["keyJsonSchema.properties.name", "surveyJson.data.items.length"]) {
      expect(redactSecrets(input).text).toBe(input);
    }
  });

  describe("generic credential assignments", () => {
    it("keeps the key name and redacts the value", () => {
      const { text, counts } = redactSecrets("export DATABASE_PASSWORD=hunter2hunter2hunter2");

      expect(counts).toEqual({ credential: 1 });
      expect(text).toBe("export DATABASE_PASSWORD=[redacted:credential]");
    });

    it("handles quoted JSON-style assignments", () => {
      const { text } = redactSecrets('{"api_key": "abcd1234efgh5678ijkl"}');

      expect(text).toBe('{"api_key": "[redacted:credential]"}');
    });

    it("handles escaped-JSON quotes between key and value", () => {
      const { text } = redactSecrets('paste: {\\"token\\": \\"abcd1234efgh5678ijkl\\"}');

      expect(text).toContain("[redacted:credential]");
      expect(text).not.toContain("abcd1234efgh5678ijkl");
    });

    it("catches bare *_KEY env vars whose name says neither api nor token", () => {
      const { text, counts } = redactSecrets("export GROQ_KEY=9f2b8c1d4e5a6f7b8c9d");

      expect(counts).toEqual({ credential: 1 });
      expect(text).toBe("export GROQ_KEY=[redacted:credential]");
    });

    it("leaves lowercase cache_key-style yaml alone", () => {
      const input = "cache_key: build-artifacts-v2";

      expect(redactSecrets(input).text).toBe(input);
    });

    it("redacts a refresh token shorter than the generic 16-character floor", () => {
      const forms = [
        [
          '{\n  "refresh_token": "abc123def456"\n}',
          '{\n  "refresh_token": "[redacted:credential]"\n}',
        ],
        ['{"refresh_token":"abc123def456"}', '{"refresh_token":"[redacted:credential]"}'],
        [
          '{\\"refresh_token\\": \\"abc123def456\\"}',
          '{\\"refresh_token\\": \\"[redacted:credential]\\"}',
        ],
        ["refresh_token=abc123def456", "refresh_token=[redacted:credential]"],
        ["refreshToken: abc123def456", "refreshToken: [redacted:credential]"],
        ["REFRESH-TOKEN=abc123def456", "REFRESH-TOKEN=[redacted:credential]"],
      ];

      for (const [input, expected] of forms) {
        expect(redactSecrets(input)).toEqual({
          text: expected,
          count: 1,
          counts: { credential: 1 },
        });
      }
    });

    it("gives access and id tokens the same 8-character floor as refresh tokens", () => {
      const forms = [
        ['{"access_token":"opaque12345"}', '{"access_token":"[redacted:credential]"}'],
        ["id_token=abc123def456", "id_token=[redacted:credential]"],
        [
          '\\n  \\"accessToken\\": \\"opaque12345\\"',
          '\\n  \\"accessToken\\": \\"[redacted:credential]\\"',
        ],
      ];

      for (const [input, expected] of forms) {
        expect(redactSecrets(input)).toEqual({
          text: expected,
          count: 1,
          counts: { credential: 1 },
        });
      }
    });

    it("leaves empty and null refresh tokens alone", () => {
      for (const input of ['{"refresh_token": null}', '{"refresh_token": ""}']) {
        expect(redactSecrets(input).text).toBe(input);
      }
    });

    it("catches non-English credential words", () => {
      const { text, counts } = redactSecrets("пароль: abcd1234efgh5678ijkl");

      expect(counts).toEqual({ credential: 1 });
      expect(text).toBe("пароль: [redacted:credential]");
    });
  });

  describe("provider tokens", () => {
    it.each([
      ["github-token", "push with ghp_abcdefghijklmnopqrstuvwx0123456789"],
      ["github-token", "pat github_pat_11ABCDEFG0_abcdefghijklmnopqrstuv"],
      ["gitlab-token", "ci glpat-abcdefghij0123456789"],
      ["stripe-key", "stripe sk_live_abcdefghijklmnop"],
      ["dosu-key", "dosu sk_user_abcdef1234567890"],
      ["anthropic-key", "llm sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
      ["openai-key", "openai sk-proj-abcdefghijklmnopqrstuvwxyz"],
      ["groq-key", "groq gsk_abcdefghijklmnopqrstuvwxyz"],
      ["xai-key", "xai xai-abcdefghijklmnopqrstuvwxyz"],
      ["huggingface-token", "hf hf_abcdefghijklmnopqrstuvwxyz"],
      ["npm-token", "publish npm_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["slack-token", "hook xoxb-1234567890-abcdefghij"],
      ["google-api-key", "maps AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ])("labels %s", (kind, input) => {
      const { text, counts } = redactSecrets(input);

      expect(counts[kind]).toBe(1);
      expect(text).toContain(`[redacted:${kind}]`);
    });

    // Dosu keys are `sk_user_` + token_urlsafe, so '-' and '_' appear mid-key.
    it.each([
      ["hyphen", "sk_user_aB3xY7pQ9zK2-mN8vR4tWcD5fGh6JkL1mN0pQ2rS4tU6"],
      ["underscore", "sk_user_aB3xY7pQ9zK2_mN8vR4tWcD5fGh6JkL1mN0pQ2rS4tU6"],
    ])("redacts a whole sk_user_ key containing a %s", (_name, key) => {
      const prose = redactSecrets(`use ${key} for auth`);
      expect(prose.text).toBe("use [redacted:dosu-key] for auth");
      expect(prose.counts).toEqual({ "dosu-key": 1 });

      const json = redactSecrets(`{"header": "${key}"}`);
      expect(json.text).toBe('{"header": "[redacted:dosu-key]"}');
    });
  });

  describe("entropy pass", () => {
    it("redacts a high-entropy assignment value no pattern knows", () => {
      const { text, counts } = redactSecrets("DEPLOY_CRED=aB3xY7pQ9zK2mN8vR4tWcD5f");

      expect(counts).toEqual({ entropy: 1 });
      expect(text).toBe("DEPLOY_CRED=[redacted:entropy]");
    });

    it("redacts a high-entropy token standing alone on its line", () => {
      const { text, counts } = redactSecrets("paste:\n  aB3xY7pQ9zK2mN8vR4tWcD5fGh6J\ndone");

      expect(counts).toEqual({ entropy: 1 });
      expect(text).toBe("paste:\n  [redacted:entropy]\ndone");
    });

    it("leaves hex digests alone", () => {
      const input = "commit d3b07384d113edec49eaa6238ad5ff00d3b07384";

      expect(redactSecrets(input).counts.entropy).toBeUndefined();
    });

    it("leaves filesystem paths alone even when they carry entropy", () => {
      const input = "/private/tmp/aB3xY7pQ9zK2mN8vR4tW-Users-james/scratch";

      expect(redactSecrets(input).text).toBe(input);
    });

    it("does not fire on prose after a stop-word key", () => {
      const input = "moved to: aB3xY7pQ9zK2mN8vR4tWcD5f";

      expect(redactSecrets(input).counts.entropy).toBeUndefined();
    });

    it("skips markers left by earlier rules", () => {
      const { text, counts } = redactSecrets(
        "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456ghi",
      );

      expect(counts).toEqual({ jwt: 1 });
      expect(text).toBe("token: [redacted:jwt]");
    });

    it("skips the pass entirely for text shorter than any candidate token", () => {
      const input = "ok, thanks!";

      expect(redactSecrets(input)).toEqual({ text: input, count: 0, counts: {} });
    });

    it("leaves hex digests and single-class values alone even as assignment values", () => {
      const hex = "SHA=d3b07384d113edec49eaa6238ad5ff00d3b07384";
      const lowerOnly = "CRED=abcdefghijklmnopqrstuvwxyz";

      expect(redactSecrets(hex).text).toBe(hex);
      expect(redactSecrets(lowerOnly).text).toBe(lowerOnly);
    });

    it("leaves a lowercase slash-separated value alone (a path segment, not base64)", () => {
      const input = "dir=/usr/local/lib/python3-site-packages9";

      expect(redactSecrets(input).text).toBe(input);
    });

    it("treats a rooted value with a single separator as a blob rather than a path", () => {
      const { text, counts } = redactSecrets("CRED=/aB3xY7pQ9zK2mN8vR4tWcD5f");

      expect(counts).toEqual({ entropy: 1 });
      expect(text).toBe("CRED=[redacted:entropy]");
    });

    it("treats a slash-laden token carrying base64 padding as a blob, not a path", () => {
      const { text, counts } = redactSecrets("/tmp/aB3xY7pQ9zK2mN8vR4tWcD5f/blob==");

      expect(counts).toEqual({ entropy: 1 });
      expect(text).toBe("[redacted:entropy]");
    });

    it("tolerates whitespace and quotes between the key and the assignment", () => {
      const { text, counts } = redactSecrets('"DEPLOY_CRED" = aB3xY7pQ9zK2mN8vR4tWcD5f');

      expect(counts).toEqual({ entropy: 1 });
      expect(text).toBe('"DEPLOY_CRED" = [redacted:entropy]');
    });

    it("accepts a long pure-digit key (Telegram bot-token shape) but not a short one", () => {
      const bot = redactSecrets("123456789:AAH4Qk7pZxTyW3mN9vRbC2dLg8sJ1e");
      expect(bot.counts).toEqual({ entropy: 1 });
      expect(bot.text).toBe("123456789:[redacted:entropy]");

      const noise = "42:AAH4Qk7pZxTyW3mN9vRbC2dLg8sJ1e";
      expect(redactSecrets(noise).text).toBe(noise);
    });

    it("rejects two-letter keys as log noise", () => {
      const input = "ab=aB3xY7pQ9zK2mN8vR4tWcD5f";

      expect(redactSecrets(input).text).toBe(input);
    });

    it("requires a standalone token to be alone on its line, ignoring trailing whitespace", () => {
      const trailingText = "paste:\n  aB3xY7pQ9zK2mN8vR4tWcD5fGh6J done";
      expect(redactSecrets(trailingText).text).toBe(trailingText);

      const trailingSpace = redactSecrets("paste:\n  aB3xY7pQ9zK2mN8vR4tWcD5fGh6J  \t\r\ndone");
      expect(trailingSpace.counts).toEqual({ entropy: 1 });
      expect(trailingSpace.text).toBe("paste:\n  [redacted:entropy]  \t\r\ndone");
    });
  });

  it("counts every match across kinds and reports a total", () => {
    const input =
      "first AKIAIOSFODNN7EXAMPLE then AKIA0123456789ABCDEF and xoxb-1234567890-abcdefghij";

    const { count, counts } = redactSecrets(input);

    expect(counts).toEqual({ "aws-access-key": 2, "slack-token": 1 });
    expect(count).toBe(3);
  });

  it("leaves short or non-secret-looking values alone", () => {
    const input = "the token count was 42 and password rules require 8 chars";

    expect(redactSecrets(input).count).toBe(0);
  });
});
