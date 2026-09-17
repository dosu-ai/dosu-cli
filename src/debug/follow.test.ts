import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogFollower } from "./follow";

let dir: string;
let file: string;
let chunks: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-follow-"));
  file = join(dir, "debug.log");
  chunks = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createLogFollower", () => {
  it("emits only content appended after it was created", () => {
    writeFileSync(file, "old line\n");
    const follower = createLogFollower(file, (c) => chunks.push(c));

    follower.poll();
    expect(chunks).toEqual([]);

    appendFileSync(file, "new line\n");
    follower.poll();
    expect(chunks).toEqual(["new line\n"]);
  });

  it("emits successive appends across polls", () => {
    writeFileSync(file, "");
    const follower = createLogFollower(file, (c) => chunks.push(c));

    appendFileSync(file, "a\n");
    follower.poll();
    appendFileSync(file, "b\n");
    appendFileSync(file, "c\n");
    follower.poll();

    expect(chunks).toEqual(["a\n", "b\nc\n"]);
  });

  it("starts from the beginning when the file does not exist yet", () => {
    const follower = createLogFollower(file, (c) => chunks.push(c));
    follower.poll();
    expect(chunks).toEqual([]);

    writeFileSync(file, "first\n");
    follower.poll();
    expect(chunks).toEqual(["first\n"]);
  });

  it("restarts from the new end after the file is truncated", () => {
    writeFileSync(file, "a long existing line\n");
    const follower = createLogFollower(file, (c) => chunks.push(c));

    writeFileSync(file, "reset\n"); // shorter than before: truncation
    follower.poll();
    expect(chunks).toEqual(["reset\n"]);
  });

  it("survives the file being deleted while following", () => {
    writeFileSync(file, "line\n");
    const follower = createLogFollower(file, (c) => chunks.push(c));

    unlinkSync(file);
    follower.poll();
    expect(chunks).toEqual([]);

    writeFileSync(file, "reborn\n");
    follower.poll();
    expect(chunks).toEqual(["reborn\n"]);
  });
});
