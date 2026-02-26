import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { GROQ_API_KEY } from "./config.js";
import { logger } from "./logger.js";

const WHISPER_MODEL =
  process.env.WHISPER_MODEL_PATH ||
  path.join(os.homedir(), ".local/share/whisper-models/ggml-small.bin");

const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "it";
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Transcribe audio buffer using local whisper-cli (preferred) or Groq API (fallback).
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = "voice.ogg",
): Promise<string | null> {
  // Try local whisper-cli first
  if (fs.existsSync(WHISPER_MODEL)) {
    try {
      return transcribeLocal(audioBuffer);
    } catch (err) {
      logger.warn({ err }, "Local whisper failed, trying Groq fallback");
    }
  }

  // Fallback to Groq API
  if (GROQ_API_KEY) {
    return transcribeGroq(audioBuffer, filename);
  }

  logger.warn("No transcription backend available (no whisper model, no GROQ_API_KEY)");
  return null;
}

function transcribeLocal(audioBuffer: Buffer): string | null {
  const tmpDir = os.tmpdir();
  const oggPath = path.join(tmpDir, `nanoclaw-voice-${Date.now()}.ogg`);
  const wavPath = oggPath.replace(".ogg", ".wav");

  try {
    fs.writeFileSync(oggPath, audioBuffer);

    // Convert ogg to wav (whisper-cli needs wav format)
    execSync(`ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`, {
      timeout: 30000,
    });

    const output = execSync(
      `whisper-cli -m "${WHISPER_MODEL}" --no-prints --no-timestamps -l ${WHISPER_LANGUAGE} -f "${wavPath}"`,
      { timeout: 60000, encoding: "utf-8" },
    );

    const text = output.trim();
    logger.info({ chars: text.length }, "Voice transcribed (local)");
    return text || null;
  } finally {
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

async function transcribeGroq(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: "audio/ogg" }),
      filename,
    );
    formData.append("model", "whisper-large-v3");
    formData.append("response_format", "text");

    const response = await fetch(GROQ_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ status: response.status, err }, "Groq transcription failed");
      return null;
    }

    const text = (await response.text()).trim();
    logger.info({ chars: text.length }, "Voice transcribed (Groq)");
    return text || null;
  } catch (err) {
    logger.error({ err }, "Groq transcription error");
    return null;
  }
}
