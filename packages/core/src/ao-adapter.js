export function buildAoSpawnCommand(session) {
  const issueFlag = session.issueId ? ` --issue ${session.issueId}` : "";
  return `ao spawn --repo ${session.repo}${issueFlag} --title "${session.title}"`;
}

export function buildAoReplyCommand(request, replyText) {
  return `ao send ${request.sessionId} "${replyText.replaceAll('"', '\\"')}"`;
}

export function buildAoRestoreCommand(sessionId) {
  return `ao session restore ${sessionId}`;
}
