import { getDb } from "../db.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";
import { logger } from "../lib/logger.js";

export interface ResumeResult {
  ok: boolean;
  detail: string;
}

/**
 * Resume a failed run. Resets the failed step (and related stories/verify steps)
 * to pending, sets the run back to running, increments resume_count, and restarts crons.
 *
 * This is the shared logic used by both the CLI `workflow resume` command and the
 * medic auto-recovery system.
 */
export async function resumeRun(runId: string): Promise<ResumeResult> {
  const db = getDb();

  const run = db.prepare(
    "SELECT id, workflow_id, status FROM runs WHERE id = ?"
  ).get(runId) as { id: string; workflow_id: string; status: string } | undefined;

  if (!run) {
    return { ok: false, detail: `Run not found: ${runId}` };
  }
  if (run.status !== "failed") {
    return { ok: false, detail: `Run ${run.id.slice(0, 8)} is "${run.status}", not "failed"` };
  }

  // Find the failed step (first by step_index)
  const failedStep = db.prepare(
    "SELECT id, step_id, type, current_story_id FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1"
  ).get(run.id) as { id: string; step_id: string; type: string; current_story_id: string | null } | undefined;

  if (!failedStep) {
    return { ok: false, detail: `No failed step found in run ${run.id.slice(0, 8)}` };
  }

  // If it's a loop step with a failed story, reset that story to pending
  if (failedStep.type === "loop") {
    const failedStory = db.prepare(
      "SELECT id FROM stories WHERE run_id = ? AND status = 'failed' ORDER BY story_index ASC LIMIT 1"
    ).get(run.id) as { id: string } | undefined;
    if (failedStory) {
      db.prepare(
        "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      ).run(failedStory.id);
    }
    db.prepare(
      "UPDATE steps SET retry_count = 0 WHERE run_id = ? AND type = 'loop'"
    ).run(run.id);
  }

  // Check if the failed step is a verify step linked to a loop step's verify_each
  const loopStep = db.prepare(
    "SELECT id, loop_config FROM steps WHERE run_id = ? AND type = 'loop' AND status IN ('running', 'waiting', 'failed') LIMIT 1"
  ).get(run.id) as { id: string; loop_config: string | null } | undefined;

  if (loopStep?.loop_config) {
    const lc = JSON.parse(loopStep.loop_config);
    if (lc.verifyEach && lc.verifyStep === failedStep.step_id) {
      // Reset the loop step (developer) to pending so it re-claims the story
      db.prepare(
        "UPDATE steps SET status = 'pending', current_story_id = NULL, retry_count = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(loopStep.id);
      // Reset verify step to waiting (fires after developer completes)
      db.prepare(
        "UPDATE steps SET status = 'waiting', current_story_id = NULL, retry_count = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(failedStep.id);
      // Reset any failed stories to pending
      db.prepare(
        "UPDATE stories SET status = 'pending', updated_at = datetime('now') WHERE run_id = ? AND status = 'failed'"
      ).run(run.id);

      // Set run to running and increment resume_count
      db.prepare(
        "UPDATE runs SET status = 'running', resume_count = COALESCE(resume_count, 0) + 1, updated_at = datetime('now') WHERE id = ?"
      ).run(run.id);

      await restartCrons(run.workflow_id);

      const detail = `Reset loop step "${loopStep.id.slice(0, 8)}" to pending, verify step "${failedStep.step_id}" to waiting`;
      emitEvent({
        ts: new Date().toISOString(),
        event: "run.resumed",
        runId: run.id,
        workflowId: run.workflow_id,
        detail,
      });
      logger.info(`Resumed run ${run.id.slice(0, 8)}`, { runId: run.id });
      return { ok: true, detail };
    }
  }

  // Regular step: reset to pending
  db.prepare(
    "UPDATE steps SET status = 'pending', current_story_id = NULL, retry_count = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(failedStep.id);

  // Set run to running and increment resume_count
  db.prepare(
    "UPDATE runs SET status = 'running', resume_count = COALESCE(resume_count, 0) + 1, updated_at = datetime('now') WHERE id = ?"
  ).run(run.id);

  await restartCrons(run.workflow_id);

  const detail = `Reset step "${failedStep.step_id}" to pending`;
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.resumed",
    runId: run.id,
    workflowId: run.workflow_id,
    detail,
  });
  logger.info(`Resumed run ${run.id.slice(0, 8)}`, { runId: run.id });
  return { ok: true, detail };
}

async function restartCrons(workflowId: string): Promise<void> {
  try {
    const workflowDir = resolveWorkflowDir(workflowId);
    const workflow = await loadWorkflowSpec(workflowDir);
    await ensureWorkflowCrons(workflow);
  } catch (err) {
    logger.warn(`Could not restart crons for workflow ${workflowId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
