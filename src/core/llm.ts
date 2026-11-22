import type { LlmConfig, RecallResult } from "./types.js";

export interface ExtractedMemory {
  kind: "world" | "experience" | "observation";
  title: string;
  content: string;
  entities: string[];
  tags: string[];
}

export class OptionalLlmClient {
  constructor(private readonly cfg?: LlmConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg?.apiKey && this.cfg?.baseUrl);
  }

  hasEmbeddings(): boolean {
    return Boolean(this.cfg?.apiKey && this.cfg?.baseUrl && this.cfg?.embeddingModel);
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.hasEmbeddings() || !this.cfg) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 8000);
      const res = await fetch(`${this.cfg.baseUrl!.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify({
          model: this.cfg.embeddingModel,
          input: text.slice(0, 8000)
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      return data.data?.[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  async reflect(query: string, memories: RecallResult[]): Promise<string | null> {
    if (!this.isConfigured() || !this.cfg || memories.length === 0) return null;
    const context = memories
      .map(
        (m, i) =>
          `[${i + 1}] (${m.kind.toUpperCase()} | ${m.id} | ${m.updatedAt} | harness=${m.harness})\nTitle: ${m.title}\n${m.content.slice(0, 1400)}`
      )
      .join("\n\n---\n\n");

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 20000);
      const res = await fetch(`${this.cfg.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify({
          model: this.cfg.model || "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "You are the Reflect engine of Keystone (a Hindsight-inspired coding agent memory). Synthesize an accurate, evidence-backed answer from the provided memory records. Always prioritize CORRECTION over older observations/episodes. Cite memory IDs inline like [id]. Be concise and factual."
            },
            {
              role: "user",
              content: `Question: ${query}\n\nRetrieved Memory Records:\n${context}`
            }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch {
      return null;
    }
  }

  async distillSession(transcriptText: string): Promise<ExtractedMemory[] | null> {
    if (!this.isConfigured() || !this.cfg || !transcriptText.trim()) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 20000);
      const res = await fetch(`${this.cfg.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify({
          model: this.cfg.model || "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "Extract durable engineering memories from this coding-agent session transcript. Return ONLY a JSON array of objects with keys: kind ('world' | 'experience' | 'observation'), title, content, entities (string[]), tags (string[]). Focus on decisions, root causes, user preferences, architecture facts, and gotchas. Skip ephemeral chitchat."
            },
            {
              role: "user",
              content: transcriptText.slice(-16000)
            }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as ExtractedMemory[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
