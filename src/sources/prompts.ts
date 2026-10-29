/** Prompt helpers the setup flows share: answers given up front (flags, environment) are taken
 * first, and under `--yes` a missing answer is an error rather than a question. */

import { CliUsageError } from "../cli/errors";
import * as p from "../tui/prompts";

/** A static key pair for a bucket. Never saved on this machine: the server holds the write
 * keys, Dosu the read keys. */
export interface KeyPair {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

export function required(label: string): (value: string) => string | undefined {
  return (value) => (value.trim() ? undefined : `${label} is required`);
}

/** Static keys from the ambient environment, when it has a full pair. */
export function envCredentials(prefix: "AWS" | "R2" | "DOSU_SOURCE"): KeyPair | undefined {
  const id = process.env[`${prefix}_ACCESS_KEY_ID`];
  const secret = process.env[`${prefix}_SECRET_ACCESS_KEY`];
  if (!id || !secret) return undefined;
  const token = process.env[`${prefix}_SESSION_TOKEN`];
  return {
    access_key_id: id,
    secret_access_key: secret,
    ...(token ? { session_token: token } : {}),
  };
}

export class WizardCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "WizardCancelled";
  }
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new WizardCancelled();
  return value as T;
}

export interface Asker {
  text(opts: Parameters<typeof p.text>[0], given: string | undefined): Promise<string>;
  select<T>(opts: Parameters<typeof p.select<T>>[0], given: T | undefined): Promise<T>;
  confirm(opts: Parameters<typeof p.confirm>[0], given: boolean | undefined): Promise<boolean>;
}

/** Prompts that take a given answer first, and under `--yes` refuse to ask at all. */
export function asker(yes: boolean, io: p.PromptIO): Asker {
  const missing = (what: string): never => {
    throw new CliUsageError(`--yes: ${what} was not given (pass it as a flag or environment)`);
  };
  return {
    async text(opts, given) {
      if (given !== undefined) return given;
      if (opts.initialValue !== undefined && yes) return opts.initialValue;
      if (yes) return missing(opts.message);
      return unwrap(await p.text(opts, io));
    },
    async select(opts, given) {
      if (given !== undefined) return given;
      if (yes) return missing(opts.message);
      return unwrap(await p.select(opts, io));
    },
    async confirm(opts, given) {
      if (given !== undefined) return given;
      if (yes) return opts.initialValue ?? true;
      return unwrap(await p.confirm(opts, io));
    },
  };
}

export async function askKeyPair(
  ask: Asker,
  what: string,
  given: KeyPair | undefined,
): Promise<KeyPair> {
  if (given) return given;
  const access_key_id = await ask.text(
    { message: `${what}: access key id`, validate: required("The access key id") },
    undefined,
  );
  const secret_access_key = await ask.text(
    { message: `${what}: secret access key`, mask: true, validate: required("The secret") },
    undefined,
  );
  return { access_key_id, secret_access_key };
}
