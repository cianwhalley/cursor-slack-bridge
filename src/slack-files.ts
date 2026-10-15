import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isTranscribableAudio,
  transcribeAudioBuffer,
  type SlackFileLike,
} from "./transcription.js";

const MAX_BYTES = 25 * 1024 * 1024;

export type SlackFile = SlackFileLike;

export type IngestResult = {
  promptAddon: string;
  inboundVoice: boolean;
};

function safeName(name: string | undefined, fallback: string): string {
  const base = (name || fallback).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return base || fallback;
}

function tsSlug(messageTs: string): string {
  return messageTs.replace(/[^\d.]+/g, "") || String(Date.now());
}

async function filesInfo(
  file: SlackFile,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<SlackFile> {
  if ((file.url_private_download || file.url_private) && file.mimetype) {
    return file;
  }
  if (!file.id) return file;
  const res = await fetchImpl(
    `https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  if (!res.ok) return file;
  const json = (await res.json()) as { ok?: boolean; file?: SlackFile };
  if (!json.ok || !json.file) return file;
  return { ...file, ...json.file };
}

function responseStatus(res: Response): number {
  if (typeof res.status === "number" && res.status > 0) return res.status;
  return res.ok ? 200 : 0;
}

function locationOf(res: Response): string | undefined {
  const headers = res.headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  return headers.get("location") || undefined;
}

/** Slack file URLs 302 onto another Slack host. Fetch drops Authorization on that hop, which Slack answers with 403. */
function slackOwned(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "slack.com" ||
    host.endsWith(".slack.com") ||
    host === "slack-files.com" ||
    host.endsWith(".slack-files.com") ||
    host === "slack-edge.com" ||
    host.endsWith(".slack-edge.com")
  );
}

async function refreshFile(
  file: SlackFile,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<SlackFile> {
  if (!file.id) return file;
  const res = await fetchImpl(
    `https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  if (!res.ok) return file;
  const json = (await res.json()) as { ok?: boolean; file?: SlackFile };
  if (!json.ok || !json.file) return file;
  return { ...file, ...json.file };
}

async function downloadFile(
  file: SlackFile,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  let url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error("no private download URL");
  }
  for (let hop = 0; hop < 5; hop++) {
    const headers: Record<string, string> = {};
    if (slackOwned(url)) headers.Authorization = `Bearer ${botToken}`;
    const res = await fetchImpl(url, { headers, redirect: "manual" });
    const status = responseStatus(res);
    if (status >= 300 && status < 400) {
      const loc = locationOf(res);
      if (!loc) throw new Error(`download HTTP ${status}`);
      url = new URL(loc, url).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`download HTTP ${status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      throw new Error(`file too large (${buf.length} bytes)`);
    }
    return buf;
  }
  throw new Error("download redirected too many times");
}

export async function ingestSlackFiles(opts: {
  files: SlackFile[];
  botToken: string;
  workspace: string;
  messageTs: string;
  fetchImpl?: typeof fetch;
  transcribe?: typeof transcribeAudioBuffer;
}): Promise<IngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const transcribe = opts.transcribe ?? transcribeAudioBuffer;
  const lines: string[] = [];
  let inboundVoice = false;

  for (const raw of opts.files) {
    let file: SlackFile;
    try {
      file = await filesInfo(raw, opts.botToken, fetchImpl);
    } catch (err) {
      const name = raw.name || raw.id || "file";
      lines.push(
        `[Slack file] name=${name} download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const name = file.name || file.title || file.id || "file";
    try {
      let buf: Buffer;
      try {
        buf = await downloadFile(file, opts.botToken, fetchImpl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("download HTTP 403") || !file.id) throw err;
        file = await refreshFile(file, opts.botToken, fetchImpl);
        buf = await downloadFile(file, opts.botToken, fetchImpl);
      }
      if (isTranscribableAudio(file)) {
        inboundVoice = true;
        const transcript = await transcribe(buf, {
          filename: name,
          mimeType: file.mimetype,
        });
        lines.push(transcript);
      } else {
        const dir = join(opts.workspace, ".slack-inbox");
        await mkdir(dir, { recursive: true });
        const dest = join(dir, `${tsSlug(opts.messageTs)}-${safeName(name, "file")}`);
        await writeFile(dest, buf);
        lines.push(
          `[Slack file] name=${name} path=${dest} mime=${file.mimetype || "application/octet-stream"}`,
        );
      }
    } catch (err) {
      lines.push(
        `[Slack file] name=${name} download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    promptAddon: lines.join("\n"),
    inboundVoice,
  };
}

export const VOICE_REPLY_INSTRUCTION = [
  "The user sent a Slack voice note. Reply with a voice note for this turn unless they asked for text-only.",
  "Do not transcribe audio yourself — the transcript is already in this prompt.",
  "Write the spoken reply, synthesize it with the hub voice-note skill (persona voice ID in SOUL.md), then end your Slack reply with a final line exactly:",
  "VOICE_REPLY: /absolute/path.mp3",
].join("\n");
