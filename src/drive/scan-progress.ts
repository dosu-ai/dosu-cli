interface ScanProgressOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export function createScanProgress(output: ScanProgressOutput = process.stdout) {
  const isTTY = output.isTTY === true;

  return {
    start(message: string): void {
      output.write(isTTY ? `◒  ${message}` : `${message}\n`);
    },
    update(message: string): void {
      if (isTTY) output.write(`\r\x1b[2K◒  ${message}`);
    },
    stop(message: string): void {
      output.write(isTTY ? `\r\x1b[2K◇  ${message}\n` : `◇  ${message}\n`);
    },
  };
}
