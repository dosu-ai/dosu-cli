/** Real-shaped OpenCode sessions for tests: the document `opencode export` prints, and the sqlite
 * DB opencode 1.18 keeps them in. */

import { createRequire } from "node:module";

export interface OpencodeFixture {
  id?: string;
  /** Set for a subagent's child session. */
  parentID?: string;
  directory?: string;
  /** What the user typed. */
  user?: string;
  /** The assistant's closing answer. */
  answer?: string;
  /** A memory digest Dosu's plugin pushed into the user message, flagged as such. */
  memory?: string;
}

/** One session as `opencode export` prints it, `{ info, messages: [{ info, parts }] }`: a user
 * prompt, a step that reads a file with a tool, and an answer. */
export function opencodeDocument(fixture: OpencodeFixture = {}) {
  const id = fixture.id ?? "ses_0ff3fixture00001";
  const ids = { sessionID: id };
  // Ids ascend in creation order, as opencode mints them.
  const user = { id: `msg_${id}_1`, ...ids };
  const step = { id: `msg_${id}_2`, ...ids };
  const answer = { id: `msg_${id}_3`, ...ids };
  const userParts: Record<string, unknown>[] = [
    {
      type: "text",
      text: fixture.user ?? "How does auth work in this app?",
      id: `prt_${id}_1`,
      messageID: user.id,
      ...ids,
    },
  ];
  if (fixture.memory) {
    userParts.push({
      type: "text",
      text: fixture.memory,
      synthetic: true,
      metadata: { dosu_memory: true },
      id: `prt_${id}_2`,
      messageID: user.id,
      ...ids,
    });
  }
  return {
    info: {
      id,
      slug: "calm-eagle",
      projectID: "15d496110225279d",
      directory: fixture.directory ?? "/repo/app",
      path: "",
      title: "Auth walkthrough",
      version: "1.18.34",
      ...(fixture.parentID ? { parentID: fixture.parentID } : {}),
      time: { created: 1790963932400, updated: 1790963941200 },
    },
    messages: [
      {
        info: { role: "user", time: { created: 1790963932445 }, agent: "build", ...user },
        parts: userParts,
      },
      {
        info: {
          role: "assistant",
          parentID: user.id,
          modelID: "claude-haiku-4-5",
          time: { created: 1790963934500, completed: 1790963936000 },
          ...step,
        },
        parts: [
          { type: "step-start", id: `prt_${id}_3`, messageID: step.id, ...ids },
          {
            type: "text",
            text: "Reading the auth module first.",
            time: { start: 1790963934596, end: 1790963934981 },
            id: `prt_${id}_4`,
            messageID: step.id,
            ...ids,
          },
          {
            type: "tool",
            tool: "read",
            callID: "toolu_0156L5aHDegRahdNMdG7zTv9",
            state: {
              status: "completed",
              input: { filePath: "/repo/app/auth.ts" },
              output: "export const KEY = 1;",
              time: { start: 1790963935000, end: 1790963935100 },
            },
            id: `prt_${id}_5`,
            messageID: step.id,
            ...ids,
          },
          {
            type: "step-finish",
            reason: "tool-calls",
            id: `prt_${id}_6`,
            messageID: step.id,
            ...ids,
          },
        ],
      },
      {
        info: {
          role: "assistant",
          parentID: user.id,
          modelID: "claude-haiku-4-5",
          time: { created: 1790963937000, completed: 1790963941100 },
          ...answer,
        },
        parts: [
          {
            type: "text",
            text: fixture.answer ?? "Auth reads KEY from auth.ts.",
            id: `prt_${id}_7`,
            messageID: answer.id,
            ...ids,
          },
        ],
      },
    ],
  };
}

export type OpencodeDocumentFixture = ReturnType<typeof opencodeDocument>;

/** The sessions as opencode stores them: one row per session, message, and part, ids and links in
 * columns and the rest as JSON. Rows go in out of order, as nothing promises otherwise. False when
 * the runtime has no sqlite builtin, so DB-backed tests can skip. */
export function makeOpencodeDb(
  path: string,
  docs: OpencodeDocumentFixture | OpencodeDocumentFixture[],
  extraSql: string[] = [],
): boolean {
  const requireRuntime = createRequire(import.meta.url);
  let db: { exec(sql: string): void; close(): void };
  try {
    /* v8 ignore next 3 -- exercised only when the test runner is Bun */
    if (process.versions.bun) {
      db = new (requireRuntime("bun:sqlite").Database)(path, { create: true });
    } else db = new (requireRuntime("node:sqlite").DatabaseSync)(path);
  } catch {
    return false;
  }
  const q = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
  db.exec(
    "CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  for (const doc of Array.isArray(docs) ? docs : [docs]) {
    const { info } = doc;
    const parent = "parentID" in info ? q(info.parentID) : "NULL";
    db.exec(
      `INSERT INTO session VALUES (${q(info.id)}, ${q(info.projectID)}, ${parent}, ${q(info.slug)}, ${q(info.directory)}, ${q(info.title)}, ${q(info.version)}, ${info.time.created}, ${info.time.updated})`,
    );
    for (const message of [...doc.messages].reverse()) {
      const { id, sessionID, ...data } = message.info;
      const t = message.info.time.created;
      db.exec(
        `INSERT INTO message VALUES (${q(id)}, ${q(sessionID)}, ${t}, ${t}, ${q(JSON.stringify(data))})`,
      );
      for (const part of [...message.parts].reverse()) {
        const { id: partId, messageID, sessionID: partSession, ...partData } = part;
        db.exec(
          `INSERT INTO part VALUES (${q(partId)}, ${q(messageID)}, ${q(partSession)}, ${t}, ${t}, ${q(JSON.stringify(partData))})`,
        );
      }
    }
  }
  for (const sql of extraSql) db.exec(sql);
  db.close();
  return true;
}
