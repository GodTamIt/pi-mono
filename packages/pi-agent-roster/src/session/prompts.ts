/**
 * System prompt construction for isolated child agents.
 */

import type { AgentPromptConfig } from "../types.ts";
import type { EnvInfo } from "./env.ts";

const runtimeBaseline = `# Role
You are a coding agent working in an isolated child session.
Use only the task and resources available in this session. Do not assume access to another conversation.`;

const TOOL_GUIDANCE: Readonly<Record<string, string>> = {
  read: "Use the read tool instead of cat/head/tail",
  edit: "Use the edit tool instead of sed/awk",
  write: "Use the write tool instead of echo/heredoc",
  find: "Use the find tool instead of shell file search",
  grep: "Use the grep tool instead of shell content search",
};

export function buildAgentPrompt(
  config: AgentPromptConfig,
  cwd: string,
  env: EnvInfo,
  enabledToolNames: readonly string[] = [],
): string {
  const instructions = config.systemPrompt.trim();

  // promptMode controls how a profile relates to Pi's primary-agent prompt, but
  // every child still needs the roster's isolation and runtime baseline.
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;
  const enabled = new Set(enabledToolNames);
  const toolGuidance = Object.entries(TOOL_GUIDANCE)
    .filter(([name]) => enabled.has(name))
    .map(([_, guidance]) => `- ${guidance}`);
  const childGuidance = `<sub_agent_context>
You are handling one explicit, self-contained task.
${[...toolGuidance, "- Make independent tool calls in parallel", "- Be concise but complete"].join(
  "\n",
)}
</sub_agent_context>`;
  const staticInstructions = instructions
    ? `<agent_instructions>\n${instructions}\n</agent_instructions>`
    : "";
  return [runtimeBaseline, childGuidance, activeAgentTag, envBlock, staticInstructions]
    .filter(Boolean)
    .join("\n\n");
}
