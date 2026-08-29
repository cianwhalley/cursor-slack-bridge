import { readFileSync } from "node:fs";

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

function hasVaultProxy(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY?.trim() ||
      process.env.https_proxy?.trim() ||
      process.env.AGENT_VAULT_TOKEN?.trim(),
  );
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

  const useOpenRouter = Boolean(keys.openRouterApiKey) || (!keys.openAiApiKey && hasVaultProxy());
  const apiKey = keys.openRouterApiKey || keys.openAiApiKey;
  if (!apiKey && !useOpenRouter) {
    return "[Voice message - transcription unavailable: missing OPENROUTER_API_KEY or OPENAI_API_KEY]";
  }

  const fetcher = options.fetchImpl || fetch;
  const format = formatFromAttachment(options.filename, options.mimeType);

  try {
    const response = useOpenRouter
      ? await fetcher("https://openrouter.ai/api/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini-transcribe",
            input_audio: {
              data: audioBuffer.toString("base64"),
              format,
            },
          }),
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
