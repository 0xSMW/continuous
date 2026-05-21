const sensitiveMessagePatterns = [
  /postgres(?:ql)?:\/\//i,
  /mysql:\/\//i,
  /redis:\/\//i,
  /mongodb(?:\+srv)?:\/\//i,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|private[_ -]?key|credential|connection[_ -]?string|dsn)\b/i,
];

const publicMessagePatterns = [
  /^Dynamic app-server (?:Core|worker|control) tool arguments must be an object\.$/,
  /^continuous\.(?:core|worker|workflow|approval)\.(?:schema|command|view) /,
  /^(?:Core|Worker|Control) command and view names must be /,
  /^(?:Core|Worker|Workflow|Approval|continuous\.[a-z.]+ payload) fields must be /,
  /^(?:core|worker|workflow|approval|config)(?:\.[A-Za-z0-9_]+)? (?:is|required|must|fields)/,
  /^idempotencyKey /,
  /^Unsupported app-server /,
  /^Unsupported Core ledger collection\./,
  /^Unknown app-server /,
  /^.+ transport context (?:is|requires) /,
  /^.+ requires .+\.$/,
  /^.+ must be .+\.$/,
];

export function appServerToolErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) {
    return fallback;
  }

  const message = error.message.trim();

  if (!message || message.length > 500) {
    return fallback;
  }

  if (sensitiveMessagePatterns.some((pattern) => pattern.test(message))) {
    return fallback;
  }

  if (publicMessagePatterns.some((pattern) => pattern.test(message))) {
    return message;
  }

  return fallback;
}
