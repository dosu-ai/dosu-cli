/**
 * `dosu ask` — ask a question and get an AI-generated answer.
 *
 * This command calls the Python backend directly (not tRPC) because the
 * tRPC answers.generateAnswer procedure uses callBackend() which requires
 * browser cookies. The Python backend natively supports X-Dosu-API-Key auth.
 */

import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { printResult } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.deployment_id || !cfg.space_id) {
    console.error(pc.red("Missing deployment config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function askCommand(): Command {
  const cmd = new Command("ask")
    .description("Ask a question and get an AI-generated answer")
    .argument("<question>", "The question to ask")
    .option("--json", "Output as JSON")
    .action(async (question: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const backendURL = getBackendURL();

      if (!backendURL) {
        console.error(pc.red("Backend URL not configured."));
        process.exit(1);
      }

      logger.debug("ask", `Asking: ${question}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);

      try {
        const resp = await fetch(`${backendURL}/doc/generate-answer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            "X-Dosu-API-Key": cfg.api_key!,
          },
          body: JSON.stringify({
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            space_id: cfg.space_id!,
            question,
          }),
          signal: controller.signal,
        });

        const body = await resp.json();

        if (!resp.ok) {
          const detail = body.detail ?? `Request failed with status ${resp.status}`;
          console.error(pc.red(`Error: ${detail}`));
          process.exit(1);
        }

        if (opts.json) {
          printResult(body, opts);
          return;
        }

        // Display the answer
        if (body.answer) {
          console.log(body.answer);
        } else if (body.body) {
          console.log(body.body);
        } else {
          console.log(JSON.stringify(body, null, 2));
        }

        // Show sources if available
        if (body.sources && body.sources.length > 0) {
          console.log(`\n${pc.bold("Sources:")}`);
          for (const source of body.sources) {
            console.log(`  ${pc.dim("•")} ${source.title ?? source.url ?? source.id}`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          console.error(pc.red("Request timed out."));
          process.exit(1);
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    });

  return cmd;
}
