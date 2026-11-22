export interface RedactionReport {
  text: string;
  redactedCount: number;
  kinds: string[];
}

const SECRET_RULES: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: "PRIVATE_KEY_BLOCK",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
  },
  {
    kind: "HINDSIGHT_TOKEN",
    pattern: /\bhsk_[A-Za-z0-9_-]{16,}\b/g
  },
  {
    kind: "OPENAI_OR_ANTHROPIC_KEY",
    pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g
  },
  {
    kind: "GITHUB_TOKEN",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g
  },
  {
    kind: "AWS_ACCESS_KEY",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
  },
  {
    kind: "GOOGLE_API_KEY",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g
  },
  {
    kind: "SLACK_TOKEN",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g
  },
  {
    kind: "JWT_TOKEN",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    kind: "BEARER_TOKEN",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{24,}={0,2}\b/gi
  },
  {
    kind: "ENV_SECRET_ASSIGNMENT",
    pattern: /^(\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*["']?)([^\s"'#]{12,})(["']?)/gim
  }
];

/**
 * Strips common secrets/tokens before any memory is persisted to the Git repository.
 */
export function redactSecrets(input: string, enabled = true): RedactionReport {
  if (!enabled || !input) {
    return { text: input, redactedCount: 0, kinds: [] };
  }

  let text = input;
  let redactedCount = 0;
  const kinds = new Set<string>();

  for (const rule of SECRET_RULES) {
    if (rule.kind === "BEARER_TOKEN") {
      text = text.replace(rule.pattern, (_match, prefix: string) => {
        redactedCount++;
        kinds.add(rule.kind);
        return `${prefix}[REDACTED:BEARER_TOKEN]`;
      });
    } else if (rule.kind === "ENV_SECRET_ASSIGNMENT") {
      text = text.replace(
        rule.pattern,
        (_match, prefix: string, value: string, suffix: string) => {
          if (value.startsWith("[REDACTED:")) return `${prefix}${value}${suffix}`;
          redactedCount++;
          kinds.add(rule.kind);
          return `${prefix}[REDACTED:ENV_SECRET]${suffix}`;
        }
      );
    } else {
      text = text.replace(rule.pattern, () => {
        redactedCount++;
        kinds.add(rule.kind);
        return `[REDACTED:${rule.kind}]`;
      });
    }
  }

  return {
    text,
    redactedCount,
    kinds: [...kinds]
  };
}
