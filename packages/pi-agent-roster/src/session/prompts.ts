/**
 * System prompt construction for isolated child agents.
 */

import type { AgentPromptConfig } from "../types.ts";
import type { EnvInfo } from "./env.ts";

const runtimeBaseline = `# Role
You are a coding agent working in an isolated child session.
Use only the task and resources available in this session. Do not assume access to another conversation.`;

export function buildAgentPrompt(config: AgentPromptConfig, cwd: string, env: EnvInfo): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;
  const instructions = config.systemPrompt.trim();

  if (config.promptMode === "replace") {
    return [runtimeBaseline, activeAgentTag, envBlock, instructions].filter(Boolean).join("\n\n");
  }

  const childGuidance = `<sub_agent_context>
You are handling one explicit, self-contained task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of shell file search
- Use the grep tool instead of shell content search
- Make independent tool calls in parallel
- Be concise but complete
</sub_agent_context>`;
  const staticInstructions = instructions
    ? `<agent_instructions>\n${instructions}\n</agent_instructions>`
    : "";
  return [runtimeBaseline, childGuidance, activeAgentTag, envBlock, staticInstructions]
    .filter(Boolean)
    .join("\n\n");
}
