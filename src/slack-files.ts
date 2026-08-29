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

async function downloadFile(
  file: SlackFile,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error("no private download URL");
  }
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`file too large (${buf.length} bytes)`);
  }
  return buf;
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
      const buf = await downloadFile(file, opts.botToken, fetchImpl);
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
