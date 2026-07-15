/**
 * `dosu ask` — ask a question and get an AI-generated answer.
 *
 * Calls the Python backend's /ask endpoint which runs the research workflow
 * synchronously and returns the answer.
 */

import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { printResult } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.active_account?.target?.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.active_account?.target?.deployment_id || !cfg.active_account?.target?.space_id) {
    console.error(pc.red("Missing deployment config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function askCommand(): Command {
  const cmd = new Command("ask")
    .description("Ask a question and get an AI-generated answer")
    .argument("<question>", "The question to ask")
    .option("--session <id>", "Continue a previous ask session")
    .option("--json", "Output as JSON")
    .action(async (question: string, opts: { session?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const backendURL = getBackendURL();

      if (!backendURL) {
        console.error(pc.red("Backend URL not configured."));
        process.exit(1);
      }

      logger.debug("ask", `Asking: ${question}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      try {
        const resp = await fetch(`${backendURL}/ask`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            "X-Dosu-API-Key": cfg.active_account!.target!.api_key!,
          },
          body: JSON.stringify({
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            deployment_id: cfg.active_account!.target!.deployment_id!,
            question,
            session_id: opts.session ?? undefined,
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          let detail = `Request failed with status ${resp.status}`;
          try {
            const errBody = await resp.json();
            const raw = errBody.detail ?? detail;
            detail = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
          } catch {}
          console.error(pc.red(`Error: ${detail}`));
          process.exit(1);
        }

        const body = await resp.json();

        if (opts.json) {
          printResult(body, opts);
          return;
        }

        // Display the answer
        if (body.answer) {
          console.log(body.answer);
        } else {
          console.log(JSON.stringify(body, null, 2));
        }

        // Show session ID for follow-up
        if (body.session_id) {
          console.log(`\n${pc.dim(`Session: ${body.session_id}`)}`);
        }

        // Show observations if available
        if (body.observations && body.observations.length > 0) {
          console.log(`\n${pc.bold("Key observations:")}`);
          for (const obs of body.observations) {
            console.log(`  ${pc.dim("•")} ${obs}`);
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
