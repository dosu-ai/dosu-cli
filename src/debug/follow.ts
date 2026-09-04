/** Incremental file tail for `dosu logs --follow`: poll() emits what was appended since the
 * previous call, and restarts from the new end when the file shrinks. */

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface LogFollower {
  poll(): void;
}

export function createLogFollower(path: string, emit: (chunk: string) => void): LogFollower {
  const sizeOf = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };

  let offset = sizeOf();

  return {
    poll(): void {
      const size = sizeOf();
      if (size < offset) offset = 0;
      if (size === offset) return;
      try {
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          const read = readSync(fd, buf, 0, buf.length, offset);
          offset += read;
          if (read > 0) emit(buf.toString("utf-8", 0, read));
        } finally {
          closeSync(fd);
        }
      } catch {
        // File vanished between stat and open; the next poll re-syncs.
      }
    },
  };
}
