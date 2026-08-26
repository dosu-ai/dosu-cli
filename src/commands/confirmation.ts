import * as p from "@clack/prompts";
import pc from "picocolors";
import { printResult } from "./output";

export async function confirmAction({
  confirmed,
  json,
  message,
  preview,
}: {
  confirmed?: boolean;
  json?: boolean;
  message: string;
  preview: Record<string, unknown>;
}): Promise<boolean> {
  if (confirmed) return true;

  if (!json && process.stdin?.isTTY) {
    const answer = await p.confirm({ message, initialValue: false });
    if (p.isCancel(answer)) {
      console.log(pc.dim("Cancelled."));
      return false;
    }
    if (answer === true) return true;
  }

  if (json) {
    printResult({ ...preview, applied: false, confirmRequired: true }, { json: true });
  } else {
    console.log(pc.dim("Aborted. Re-run with --confirm to apply."));
  }
  return false;
}
