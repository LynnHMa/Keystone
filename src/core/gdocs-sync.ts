import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildMemoryBundle } from "./bundle.js";
import type { KeystoneEngine } from "./engine.js";

export const INBOX_PLACEHOLDER =
  "[Keystone Inbox] 在下方粘贴网页/手机 Gemini 聊出的重要记忆（多条用 --- 分隔）。同步后会自动归档进 Keystone 并清空此文档。";

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GDocsSyncOptions {
  serviceAccountJson: string;
  docIds: {
    identity?: string;
    knowledge?: string;
    timeline?: string;
    inbox?: string;
  };
  bankId?: string;
  maxEpisodes?: number;
}

export interface GDocsSyncReport {
  harvestedCount: number;
  inboxCleared: boolean;
  updatedDocs: Array<{ role: string; docId: string; status: "updated" | "unchanged" | "skipped"; chars: number }>;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Exchanges a Google Cloud Service Account JSON key for an OAuth2 access token
 * using Node.js built-in `node:crypto` RS256 signing (zero external SDK dependencies).
 */
export async function getServiceAccountAccessToken(
  creds: ServiceAccountCredentials,
  scopes = ["https://www.googleapis.com/auth/documents"]
): Promise<string> {
  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = base64Url(
    JSON.stringify({
      iss: creds.client_email,
      scope: scopes.join(" "),
      aud: tokenUri,
      iat: now,
      exp: now + 3600
    })
  );

  const signingInput = `${header}.${claimSet}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(creds.private_key));
  const assertion = `${signingInput}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Google OAuth response missing access_token");
  }
  return data.access_token;
}

interface GoogleDocResponse {
  body?: {
    content?: Array<{
      endIndex?: number;
      paragraph?: {
        elements?: Array<{ textRun?: { content?: string } }>;
      };
    }>;
  };
}

export function extractGoogleDocBody(doc: GoogleDocResponse): { text: string; endIndex: number } {
  const elements = doc.body?.content ?? [];
  let text = "";
  let endIndex = 1;
  for (const el of elements) {
    if (typeof el.endIndex === "number" && el.endIndex > endIndex) {
      endIndex = el.endIndex;
    }
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) {
          text += pe.textRun.content;
        }
      }
    }
  }
  return { text, endIndex };
}

export async function readGoogleDoc(
  accessToken: string,
  docId: string
): Promise<{ text: string; endIndex: number }> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Docs GET (${docId}) failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const doc = (await res.json()) as GoogleDocResponse;
  return extractGoogleDocBody(doc);
}

export function buildReplaceDocRequests(currentEndIndex: number, newText: string): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  // Google Docs body always ends with a final newline that cannot be deleted (endIndex - 1)
  if (currentEndIndex > 2) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: 1,
          endIndex: currentEndIndex - 1
        }
      }
    });
  }
  if (newText.length > 0) {
    requests.push({
      insertText: {
        location: { index: 1 },
        text: newText
      }
    });
  }
  return requests;
}

export async function replaceGoogleDocText(
  accessToken: string,
  docId: string,
  newText: string
): Promise<"updated" | "unchanged"> {
  const current = await readGoogleDoc(accessToken, docId);
  const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();
  if (normalize(current.text) === normalize(newText)) {
    return "unchanged";
  }

  const requests = buildReplaceDocRequests(current.endIndex, newText.replace(/\r\n/g, "\n"));
  if (requests.length === 0) return "unchanged";

  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requests })
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Docs batchUpdate (${docId}) failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return "updated";
}

/**
 * Parses notes dropped into 04_Gemini_Inbox, ignoring the placeholder banner and splitting on `---`.
 */
export function parseInboxEntries(rawText: string): Array<{ title: string; content: string }> {
  const cleaned = rawText
    .replace(/\r\n/g, "\n")
    .replace(INBOX_PLACEHOLDER, "")
    .replace(/\[Keystone Inbox\][^\n]*\n?/g, "")
    .trim();

  if (cleaned.length < 12) return [];

  const blocks = cleaned
    .split(/\n\s*---+\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 12);

  return blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const first = lines[0]?.replace(/^#+\s*/, "").replace(/^\*\*|\*\*$/g, "").trim() || "Gemini Web Note";
    const title = first.slice(0, 72);
    return { title, content: block };
  });
}

/**
 * End-to-end bidirectional sync:
 * 1) Harvests any new notes from `04_Gemini_Inbox` into Keystone and resets inbox to placeholder.
 * 2) Rebuilds the 3 Markdown bundles so harvested notes flow immediately into `03_Recent_Timeline`.
 * 3) Updates the 3 Google Docs in-place (keeping their Doc IDs so Gemini Gems auto-update live).
 */
export async function syncGoogleDocs(
  engine: KeystoneEngine,
  opts: GDocsSyncOptions
): Promise<GDocsSyncReport> {
  const creds = JSON.parse(opts.serviceAccountJson) as ServiceAccountCredentials;
  if (!creds.client_email || !creds.private_key) {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON: missing client_email or private_key");
  }

  const accessToken = await getServiceAccountAccessToken(creds);
  const bankId = opts.bankId || engine.config.globalBankId;

  let harvestedCount = 0;
  let inboxCleared = false;

  // 1. Harvest 04_Gemini_Inbox if configured
  if (opts.docIds.inbox && opts.docIds.inbox.trim()) {
    const inboxId = opts.docIds.inbox.trim();
    const inboxDoc = await readGoogleDoc(accessToken, inboxId);
    const entries = parseInboxEntries(inboxDoc.text);

    for (const entry of entries) {
      await engine.retain({
        bankId,
        kind: "observation",
        title: `[gemini-web] ${entry.title}`,
        content: entry.content,
        harness: "gemini-web",
        tags: ["gemini-web", "inbox-harvest"],
        syncMode: "none"
      });
      harvestedCount++;
    }

    if (harvestedCount > 0 || inboxDoc.text.trim() === "") {
      await replaceGoogleDocText(accessToken, inboxId, `${INBOX_PLACEHOLDER}\n\n`);
      inboxCleared = true;
    }
  }

  // 2. Rebuild fresh Markdown bundles (including anything just harvested)
  const bundle = buildMemoryBundle(engine, {
    bankId,
    maxEpisodes: opts.maxEpisodes ?? 30
  });

  const fileMap = new Map(bundle.files.map((f) => [f.name, f.path]));
  const targets: Array<{ role: string; docId?: string; fileName: string }> = [
    { role: "identity", docId: opts.docIds.identity, fileName: "01_Identity_And_Corrections.md" },
    { role: "knowledge", docId: opts.docIds.knowledge, fileName: "02_Knowledge_Pages.md" },
    { role: "timeline", docId: opts.docIds.timeline, fileName: "03_Recent_Timeline.md" }
  ];

  const updatedDocs: GDocsSyncReport["updatedDocs"] = [];
  for (const t of targets) {
    if (!t.docId || !t.docId.trim()) {
      updatedDocs.push({ role: t.role, docId: "", status: "skipped", chars: 0 });
      continue;
    }
    const localPath = fileMap.get(t.fileName);
    if (!localPath) {
      updatedDocs.push({ role: t.role, docId: t.docId, status: "skipped", chars: 0 });
      continue;
    }
    const content = readFileSync(localPath, "utf8");
    const status = await replaceGoogleDocText(accessToken, t.docId.trim(), content);
    updatedDocs.push({ role: t.role, docId: t.docId.trim(), status, chars: content.length });
  }

  return {
    harvestedCount,
    inboxCleared,
    updatedDocs
  };
}
