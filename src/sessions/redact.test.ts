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
