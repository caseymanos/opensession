import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import {
  taskReminderMaximumWakeCycles,
  TaskReminderExecutionService,
  type TaskReminderWorkflowInput,
} from "./task-reminders.js";

export class TaskReminderWorkflow extends WorkflowEntrypoint<
  Env,
  TaskReminderWorkflowInput
> {
  override async run(
    event: Readonly<WorkflowEvent<TaskReminderWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<{ processed: true }> {
    const workflowId = event.payload.workflow_id;
    try {
      for (let cycle = 0; cycle < taskReminderMaximumWakeCycles; cycle += 1) {
        const outcome = await step.do(
          `evaluate-current-assignments-${cycle}`,
          {
            retries: { backoff: "exponential", delay: "10 seconds", limit: 5 },
          },
          async () =>
            new TaskReminderExecutionService(this.env).execute(workflowId),
        );
        if (!outcome.nextWakeAt) return { processed: true };
        await step.sleepUntil(
          `wait-for-current-due-${cycle}`,
          new Date(outcome.nextWakeAt),
        );
      }
      throw new Error("Task reminder workflow exceeded 100 due-date changes.");
    } catch (error) {
      const now = new Date().toISOString();
      await this.env.DB.prepare(
        `UPDATE workflow_runs
         SET status = 'failed', error_code = ?2, updated_at = ?3
         WHERE id = ?1 AND status <> 'canceled'`,
      )
        .bind(
          workflowId,
          error instanceof Error ? error.name.slice(0, 80) : "WorkflowError",
          now,
        )
        .run();
      throw error;
    }
  }
}
