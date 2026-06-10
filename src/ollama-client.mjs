export const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Ollama returned non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
}

export async function getOllamaVersion() {
  const res = await fetch(`${DEFAULT_OLLAMA_URL}/api/version`);
  if (!res.ok) {
    throw new Error(`Ollama version check failed ${res.status}: ${await res.text()}`);
  }
  return readJsonResponse(res);
}

export async function listOllamaModels() {
  const res = await fetch(`${DEFAULT_OLLAMA_URL}/api/tags`);
  if (!res.ok) {
    throw new Error(`Ollama model list failed ${res.status}: ${await res.text()}`);
  }
  const body = await readJsonResponse(res);
  return body.models || [];
}

export async function assertOllamaModelAvailable(model) {
  const models = await listOllamaModels();
  const names = models.map((entry) => entry.name);
  if (!names.includes(model)) {
    throw new Error(`Ollama model '${model}' is not installed. Available models: ${names.join(", ") || "none"}`);
  }
  return models.find((entry) => entry.name === model);
}

export async function generateWithOllama({
  model = process.env.GEMMA_MODEL || "gemma4:12b",
  system,
  prompt,
  format = "json",
  options = {},
  keepAlive = process.env.OLLAMA_KEEP_ALIVE || "10m",
  timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 0),
}) {
  const requestBody = {
    model,
    system,
    prompt,
    stream: false,
    options,
    keep_alive: keepAlive,
  };
  if (format) requestBody.format = format;

  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`${DEFAULT_OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }

  const body = await readJsonResponse(res);
  return {
    raw: body,
    text: body.response || "",
    model: body.model || model,
    doneReason: body.done_reason || null,
    usage: {
      promptTokens: body.prompt_eval_count || 0,
      outputTokens: body.eval_count || 0,
      totalTokens: (body.prompt_eval_count || 0) + (body.eval_count || 0),
      promptEvalDurationNs: body.prompt_eval_duration || 0,
      evalDurationNs: body.eval_duration || 0,
      totalDurationNs: body.total_duration || 0,
    },
  };
}

export function parseJsonResponse(text) {
  if (!text || !text.trim()) {
    throw new Error("Model returned an empty response.");
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`Model did not return JSON: ${text.slice(0, 500)}`);
  }
}
