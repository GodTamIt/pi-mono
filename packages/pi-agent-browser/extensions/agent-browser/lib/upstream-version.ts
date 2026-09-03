import {
  MINIMUM_AGENT_BROWSER_VERSION,
  MINIMUM_AGENT_BROWSER_VERSION_LABEL,
  SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
  TARGET_AGENT_BROWSER_VERSION,
  TARGET_AGENT_BROWSER_VERSION_LABEL,
  isSupportedAgentBrowserVersion,
} from "../../../scripts/agent-browser-target.mjs";

export {
  MINIMUM_AGENT_BROWSER_VERSION,
  MINIMUM_AGENT_BROWSER_VERSION_LABEL,
  SUPPORTED_AGENT_BROWSER_VERSION_LABEL,
  TARGET_AGENT_BROWSER_VERSION,
  TARGET_AGENT_BROWSER_VERSION_LABEL,
  isSupportedAgentBrowserVersion,
};

export function parseAgentBrowserVersionOutput(stdout: string): string | undefined {
  const match = stdout.trim().match(/^agent-browser\s+(\d+\.\d+\.\d+(?:[-+]\S+)?)$/);
  return match?.[1];
}

export function getAgentBrowserVersionValidationError(stdout: string): string | undefined {
  return parseAgentBrowserVersionOutput(stdout)
    ? undefined
    : "agent-browser --version returned an unrecognized value. Run pi-agent-browser-doctor and verify the installed binary.";
}
