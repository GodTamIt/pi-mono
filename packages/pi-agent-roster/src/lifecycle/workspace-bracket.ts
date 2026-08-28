import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "./workspace.ts";

/** Owns a provider resolved at admission and its prepared child workspace. */
export class WorkspaceBracket {
  private prepared?: Workspace | undefined;
  private disposed = false;
  private resultAddendum = "";

  constructor(private readonly provider: WorkspaceProvider | undefined) {}

  hasProvider(): boolean {
    return this.provider !== undefined;
  }

  async prepare(ctx: WorkspacePrepareContext): Promise<string | undefined> {
    if (!this.provider) return undefined;
    this.prepared = await this.provider.prepare(ctx);
    return this.prepared?.cwd;
  }

  dispose(outcome: WorkspaceDisposeOutcome): string {
    if (!this.prepared || this.disposed) return this.resultAddendum;
    this.disposed = true;
    this.resultAddendum = this.prepared.dispose(outcome)?.resultAddendum ?? "";
    return this.resultAddendum;
  }
}
