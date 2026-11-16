import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import { globalTracker, type TeamMember } from "../state/tracker.js"
import { WorktreeManager, type WorktreeSandbox } from "../worktree/manager.js"
import crypto from "node:crypto"

export const DelegateInput = Schema.Struct({
  team_name: Schema.String.annotate({
    description: "Departmental team name (e.g. 'Backend', 'Frontend', 'Security', 'QA', 'DevOps')",
  }),
  agent_type: Schema.String.annotate({
    description: "Specialist agent name or role (e.g. 'backend-architect', 'frontend-developer', 'api-tester')",
  }),
  prompt: Schema.String.annotate({
    description: "Detailed instructions and requirements for the teammate",
  }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to run this task in an isolated git worktree to prevent concurrent write collisions (default: true)",
  }),
})

function normalizeAgentId(raw: string): string {
  if (!raw) return "build"
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

const WAIT_TIMEOUT_MS = 600_000

/** Text of the final assistant message, or undefined when it holds no text part. */
export function lastAssistantText(messages: ReadonlyArray<any> | undefined): string | undefined {
  const last = [...(messages ?? [])].reverse().find((m) => m?.type === "assistant")
  const text = (last?.content ?? [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
  return text || undefined
}

/** Model of the most recent assistant message, so a child can run on the caller's model. */
export function lastAssistantModel(messages: ReadonlyArray<any> | undefined): { id: string; providerID: string } | undefined {
  const last = [...(messages ?? [])].reverse().find((m) => m?.type === "assistant" && m?.model?.id && m?.model?.providerID)
  return last ? { id: last.model.id, providerID: last.model.providerID } : undefined
}

export function createDelegateTool(ctx: Plugin.Context) {
  return {
    id: "team_delegate",
    name: "team_delegate",
    description: "Delegate a task to a departmental teammate with optional git worktree sandboxing.",
    input: DelegateInput,
    execute: async (
      input: { team_name: string; agent_type: string; prompt: string; worktree?: boolean },
      toolCtx: { sessionID: string },
    ) => {
      const taskId = crypto.randomUUID().slice(0, 8)
      const baseDir = process.cwd()
      const useWorktree = input.worktree !== false
      const targetAgentId = normalizeAgentId(input.agent_type)

      let sandbox: WorktreeSandbox | undefined
      let workDir = baseDir

      if (useWorktree) {
        try {
          sandbox = await WorktreeManager.createSandbox(baseDir, input.team_name, taskId)
          workDir = sandbox.worktreePath
        } catch (err: any) {
          // If worktree creation fails (e.g. not a git repo), gracefully fallback to baseDir
          workDir = baseDir
        }
      }

      // Create child session via OpenCode v2 session API
      let childSession: any
      try {
        // A specialist has no model of its own and would fall back to the global default,
        // which can be a paid model. Run it on the model its caller already uses.
        let model: { id: string; providerID: string } | undefined
        try {
          model = lastAssistantModel(await (ctx.session as any).context({ sessionID: toolCtx.sessionID }))
        } catch {
          model = undefined
        }
        childSession = await ctx.session.create({
          agent: targetAgentId,
          parentID: toolCtx.sessionID,
          location: { directory: workDir },
          ...(model ? { model } : {}),
        } as any)
      } catch (err: any) {
        if (sandbox) {
          await WorktreeManager.discardSandbox(baseDir, sandbox)
        }
        return {
          content: `Failed to spawn teammate session for ${input.team_name} (${targetAgentId}): ${err.message || String(err)}`,
        }
      }

      const sessionId = childSession?.id || `sess_${taskId}`
      const memberRecord: TeamMember = {
        id: taskId,
        teamName: input.team_name,
        agentType: targetAgentId,
        sessionId,
        parentSessionId: toolCtx.sessionID,
        status: "running",
        prompt: input.prompt,
        worktreePath: sandbox?.worktreePath,
        worktreeBranch: sandbox?.branchName,
        createdAt: Date.now(),
      }
      globalTracker.register(memberRecord)

      try {
        // Dispatch task text to subagent (OpenCode v2 SessionPromptInput takes 'text')
        await ctx.session.prompt({
          sessionID: sessionId,
          text: input.prompt,
        } as any)

        // prompt only queues the message. wait blocks until the child goes idle,
        // and the reply is then read from the session context (verified on OpenCode 2.3.0).
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            (ctx.session as any).wait({ sessionID: sessionId }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`teammate did not finish within ${WAIT_TIMEOUT_MS / 1000}s`)),
                WAIT_TIMEOUT_MS,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }

        const messages = await (ctx.session as any).context({ sessionID: sessionId })
        const idle = [...(messages ?? [])].reverse().find((m: any) => m?.type === "idle")
        if (idle && idle.outcome !== "succeeded") {
          throw new Error(`teammate session ended with outcome "${idle.outcome}"`)
        }
        const deliverableText = lastAssistantText(messages)
        if (!deliverableText) {
          throw new Error("no reply captured from the teammate session")
        }

        // If a worktree was used, reconcile and merge changes back to base branch
        let reconcileNotice = ""
        if (sandbox) {
          const shortDesc = input.prompt.replace(/\s+/g, " ").slice(0, 60)
          const reconcile = await WorktreeManager.reconcileAndCleanup(
            baseDir,
            sandbox,
            `feat(${input.team_name.toLowerCase()}): ${shortDesc}`,
          )

          if (reconcile.merged) {
            reconcileNotice = `\n[Git]: Successfully merged changes from ${sandbox.branchName} into ${sandbox.baseBranch}. Worktree cleaned up.`
          } else if (reconcile.error) {
            reconcileNotice = `\n[Git Warning]: ${reconcile.error}`
          } else {
            reconcileNotice = `\n[Git]: No file modifications detected; worktree discarded.`
          }
        }

        globalTracker.update(sessionId, {
          status: "completed",
          finishedAt: Date.now(),
          deliverable: deliverableText,
        })

        return {
          content: `[Teammate Completed] ${input.team_name} (${targetAgentId}):\n${deliverableText}${reconcileNotice}`,
        }
      } catch (err: any) {
        if (sandbox) {
          await WorktreeManager.discardSandbox(baseDir, sandbox)
        }
        globalTracker.update(sessionId, {
          status: "error",
          finishedAt: Date.now(),
          error: err?.message || String(err),
        })
        return {
          content: `[Teammate Error] ${input.team_name} (${targetAgentId}) failed: ${err.message || String(err)}`,
        }
      }
    },
  }
}
