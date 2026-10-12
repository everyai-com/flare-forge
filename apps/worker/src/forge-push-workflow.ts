// ForgePushWorkflow: target of the namespace-wide Artifacts event
// triggers (wrangler.jsonc triggers.events: pushed, cloned, fetched,
// created, forked, imported, deleted). One instance per event
// (instance id = event id).
//
// Step 1 meters every event into the repo's ops ledger (forge-ops.ts;
// the event id dedupes retries in the Coordinator). Step 2, pushes
// only, reconciles the live footprint: duplicate deliveries and the
// agent's own report_push dedupe in the Coordinator on (intent, sha).
// Logic: forge-ops.ts + forge-push.ts (runtime-free, tested).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { WorkerEnv } from "./env";
import { coordinatorFor, meteredArtifacts } from "./coordinator";
import { forgeOpsLookups, handleArtifactsOpEvent, parseArtifactsOpEvent, type OpEventOutcome } from "./forge-ops";
import { handleForgePush, type ForgePushOutcome, type TreeReader } from "./forge-push";

export class ForgePushWorkflow extends WorkflowEntrypoint<WorkerEnv, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<{ ops: OpEventOutcome; push: ForgePushOutcome | null }> {
    const env = this.env;
    const ops = await step.do(
      "meter op",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async (): Promise<OpEventOutcome> => {
        const ns = env.COORDINATOR;
        if (!ns) return { status: "skipped", reason: "unattributed" };
        return handleArtifactsOpEvent(
          {
            namespace: env.ARTIFACTS_NAMESPACE ?? "",
            lookups: forgeOpsLookups(env.DB),
            record: (repo, entries, eventId) => coordinatorFor({ COORDINATOR: ns }, repo).recordOps(entries, eventId),
          },
          event.payload,
          event.instanceId,
          event.timestamp instanceof Date ? event.timestamp.getTime() : undefined,
        );
      },
    );
    console.log(JSON.stringify({ level: "info", msg: "forge op metered", instance: event.instanceId, ...ops }));
    if (parseArtifactsOpEvent(event.payload)?.kind !== "push") return { ops, push: null };
    const push = await step.do(
      "reconcile push",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async (): Promise<ForgePushOutcome> => {
        // The tree diff's reads count as binding calls (flushed below).
        const meter = meteredArtifacts(env, null);
        const artifacts = meter.artifacts;
        if (!artifacts) return { status: "skipped", reason: "unreadable" };
        const out = await handleForgePush(
          {
            db: env.DB,
            namespace: env.ARTIFACTS_NAMESPACE ?? "",
            openRepo: async (name: string): Promise<TreeReader & { [Symbol.dispose]?: () => void }> => artifacts.get(name),
            reportPush: (repo, intentId, input) => coordinatorFor(env, repo).reportPush(intentId, input),
          },
          event.payload,
        );
        await meter.flush();
        // A coordinator error other than an ownership/state race is
        // worth a retry; surface it so the step backs off.
        if (out.status === "failed" && out.error !== "not-owner" && out.error !== "not-pushable" && out.error !== "conflict") {
          throw new Error(`reportPush failed: ${out.error}`);
        }
        return out;
      },
    );
    console.log(JSON.stringify({ level: "info", msg: "forge push reconciled", instance: event.instanceId, ...push }));
    return { ops, push };
  }
}
