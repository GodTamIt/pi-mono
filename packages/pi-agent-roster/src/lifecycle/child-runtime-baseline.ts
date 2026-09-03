import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionContext } from "../types.ts";

/** Immutable model identity safe to retain before a child is admitted. */
export interface ChildModelIdentity {
  readonly provider: string;
  readonly id: string;
}

/** Child-only values safe to retain while work is queued. */
export interface ChildRuntimeBaseline {
  readonly cwd: string;
  readonly model?: ChildModelIdentity | undefined;
}

export function modelIdentity(model: Model<Api> | undefined): ChildModelIdentity | undefined {
  return model ? { provider: model.provider, id: model.id } : undefined;
}

/** Capture only immutable runtime configuration that is safe to use for a new child. */
export function buildChildRuntimeBaseline(ctx: SessionContext): ChildRuntimeBaseline {
  return {
    cwd: ctx.cwd,
    model: modelIdentity(ctx.model),
  };
}
