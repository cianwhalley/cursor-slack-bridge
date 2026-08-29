import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "ogg",
  "oga",
  "wav",
  "webm",
  "aac",
]);

export type SlackFileLike = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  subtype?: string;
  mode?: string;
  url_private?: string;
  url_private_download?: string;
};

interface TranscriptionKeys {
  openRouterApiKey?: string;
  openAiApiKey?: string;
}

export interface TranscribeAudioOptions extends TranscriptionKeys {
  filename?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
}

function extensionFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1]?.toLowerCase();
}

function formatFromAttachment(filename: string | undefined, mimeType: string | undefined): string {
  const ext = extensionFromName(filename);
  if (ext) return ext;
  const subtype = mimeType?.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  return subtype || "m4a";
}

function readKeyFile(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  try {
    const value = readFileSync(path, "utf8").replace(/[\r\n]+/g, "").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function hasVaultToken(): boolean {
  return Boolean(process.env.AGENT_VAULT_TOKEN?.trim());
}

function behindMitmProxy(): boolean {
  return Boolean(process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim());
}

export function isTranscribableAudio(file: SlackFileLike): boolean {
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  const name = file.name || file.title;
  const ext = extensionFromName(name) ?? (file.filetype ? file.filetype.toLowerCase() : undefined);
  const subtype = typeof file.subtype === "string" ? file.subtype.toLowerCase() : "";
  const mode = typeof file.mode === "string" ? file.mode.toLowerCase() : "";

  return (
    subtype.includes("audio") ||
    subtype.includes("voice") ||
    mode === "audio" ||
    mime.startsWith("audio/") ||
    (mime === "video/mp4" && (ext === "m4a" || subtype.includes("voice") || subtype.includes("audio"))) ||
    (ext !== undefined && AUDIO_EXTENSIONS.has(ext))
  );
}

export function readTranscriptionKeys(): TranscriptionKeys {
  return {
    openRouterApiKey:
      process.env.OPENROUTER_API_KEY?.trim() || readKeyFile(process.env.OPENROUTER_API_KEY_FILE),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || readKeyFile(process.env.OPENAI_API_KEY_FILE),
  };
}

export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  options: TranscribeAudioOptions = {},
): Promise<string> {
  const keys: TranscriptionKeys = {
    openRouterApiKey: options.openRouterApiKey,
    openAiApiKey: options.openAiApiKey,
  };
  if (options.openRouterApiKey === undefined && options.openAiApiKey === undefined) {
    Object.assign(keys, readTranscriptionKeys());
  }

  const useOpenRouter =
    Boolean(keys.openRouterApiKey) || (!keys.openAiApiKey && (behindMitmProxy() || hasVaultToken()));
  const apiKey = keys.openRouterApiKey || keys.openAiApiKey;
  if (!apiKey && !useOpenRouter) {
    return "[Voice message - transcription unavailable: missing OPENROUTER_API_KEY or OPENAI_API_KEY]";
  }

  const fetcher = options.fetchImpl || fetch;
  const format = formatFromAttachment(options.filename, options.mimeType);
  const payload = {
    model: "openai/gpt-4o-mini-transcribe",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format,
    },
  };

  try {
    const response = useOpenRouter
      ? await postOpenRouterTranscription(payload, {
          apiKey: keys.openRouterApiKey,
          fetchImpl: options.fetchImpl,
          fetcher,
        })
      : await transcribeWithOpenAi(fetcher, apiKey as string, audioBuffer, format, options.mimeType);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`STT API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const result = (await response.json()) as { text?: unknown };
    const transcript = typeof result.text === "string" ? result.text.trim() : "";
    if (!transcript) throw new Error("STT API returned an empty transcript");

    return `[Voice message]: ${transcript}`;
  } catch (err) {
    console.error(
      "[stt] transcription failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "[Voice message - transcription failed]";
  }
}

async function postOpenRouterTranscription(
  payload: unknown,
  opts: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    fetcher: typeof fetch;
  },
): Promise<Response> {
  const url = "https://openrouter.ai/api/v1/audio/transcriptions";
  const useDirectFetch = Boolean(opts.apiKey || opts.fetchImpl || behindMitmProxy());
  if (useDirectFetch) {
    return opts.fetcher(url, {
      method: "POST",
      headers: {
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
  return vaultCurlJson(url, payload);
}

/** One-shot MITM for STT. Do not set HTTPS_PROXY on the long-lived bridge process. */
async function vaultCurlJson(url: string, payload: unknown): Promise<Response> {
  const dir = await mkdtemp(join(tmpdir(), "stt-"));
  const bodyPath = join(dir, "body.json");
  const outPath = join(dir, "out");
  await writeFile(bodyPath, JSON.stringify(payload));
  try {
    const { stdout } = await execFileAsync(
      "agent-vault",
      [
        "run",
        "--",
        "curl",
        "-sS",
        "-o",
        outPath,
        "-w",
        "%{http_code}",
        "-X",
        "POST",
        url,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        `@${bodyPath}`,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const status = Number.parseInt(String(stdout).trim(), 10) || 0;
    const text = await readFile(outPath, "utf8");
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeWithOpenAi(
  fetcher: typeof fetch,
  apiKey: string,
  audioBuffer: Buffer,
  format: string,
  mimeType: string | undefined,
): Promise<Response> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType || "audio/mpeg" });
  formData.append("file", blob, `voice.${format}`);
  formData.append("model", "whisper-1");

  return fetcher("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
}
