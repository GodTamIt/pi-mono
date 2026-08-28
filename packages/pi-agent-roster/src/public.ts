export const ROSTER_STATUS_COMMAND = "roster-status";
export const ROSTER_NAME_FLAG = "roster-name";
export const ROSTER_NOOP_TOOL = "roster_noop";

export interface RosterStatus {
  name: string;
  ready: boolean;
}
