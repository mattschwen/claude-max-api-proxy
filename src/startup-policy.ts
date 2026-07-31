export function shouldFailStartupForMissingClaudeModels(
  requireClaude: boolean,
  availableClaudeModelCount: number,
): boolean {
  return requireClaude && availableClaudeModelCount === 0;
}
