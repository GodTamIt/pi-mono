export * from "./service/service.ts";
export { AgentStackOverrides } from "./stacks/stack-resolver.ts";
export {
  MANAGED_SUBAGENT_TOOLS,
  PRIMARY_AGENT_FLAG,
  PRIMARY_STACK_FLAG,
} from "./primary/controller.ts";

export const ROSTER_STATUS_COMMAND = "roster-status";
export const ROSTER_NAME_FLAG = "roster-name";
export const ROSTER_NOOP_TOOL = "roster_noop";

export interface RosterStatus {
  name: string;
  ready: boolean;
}
