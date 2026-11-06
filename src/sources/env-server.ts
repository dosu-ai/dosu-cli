/** The sessiondb server a machine nobody signs in on names through its environment:
 * DOSU_SESSIONDB_URL with DOSU_SESSIONDB_TOKEN. `sessions push` ships to it and `redact` removes
 * from it, so what one of them can reach, the other can too. */

import { CliUsageError } from "../cli/errors";
import { normalizeServerUrl } from "./server-wizard";

export interface EnvServer {
  url: string;
  token: string;
}

/** The server the environment names, undefined when it names none. Throws when only one of the
 * two is set, or the URL is not `https://` (or `http://` to this machine). */
export function envServer(env: NodeJS.ProcessEnv): EnvServer | undefined {
  const url = env.DOSU_SESSIONDB_URL?.trim();
  const token = env.DOSU_SESSIONDB_TOKEN?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) {
    throw new CliUsageError(
      "DOSU_SESSIONDB_URL and DOSU_SESSIONDB_TOKEN go together; set both, or neither to use a configured server",
    );
  }
  const server = normalizeServerUrl(url);
  if (!server) {
    throw new CliUsageError(
      `DOSU_SESSIONDB_URL must be an https:// URL (http:// only to localhost), got '${url}'`,
    );
  }
  return { url: server, token };
}
