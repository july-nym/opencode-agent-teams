import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { globalTracker } from "../src/state/tracker.js"
import { WorktreeManager } from "../src/worktree/manager.js"
import { createDelegateTool } from "../src/tools/delegate.js"
import { createStatusTool } from "../src/tools/status.js"
import { createBroadcastTool } from "../src/tools/broadcast.js"
import { createTerminateTool } from "../src/tools/terminate.js"

const exec = promisify(execFile)

async function runTests() {
  console.log("==================================================")
  console.log(" Running Agent-Teams v2 Test Suite")
  console.log("==================================================")

  const parentSession = "sess_parent_test_" + Date.now()

  // Test 1: Tracker Registration & Formatting
  console.log("\n[Test 1] Testing Global Swarm Tracker...")
  globalTracker.register({
    id: "task_backend_001",
    teamName: "Backend",
    agentType: "backend-architect",
    sessionId: "sess_backend_001",
    parentSessionId: parentSession,
    status: "running",
    prompt: "Design user database schema and migrations",
    createdAt: Date.now(),
  })

  globalTracker.register({
    id: "task_frontend_001",
    teamName: "Frontend",
    agentType: "frontend-developer",
    sessionId: "sess_frontend_001",
    parentSessionId: parentSession,
    status: "running",
    prompt: "Implement dashboard responsive UI components",
    createdAt: Date.now(),
  })

  const tree = globalTracker.formatTree(parentSession)
  console.log("Generated Swarm Tree:\n" + tree)
  assert.ok(tree.includes("backend-architect"), "Tree should contain backend member")
  assert.ok(tree.includes("frontend-developer"), "Tree should contain frontend member")
  console.log("✓ Tracker hierarchical tree generation passed")

  // Test 2: Tools Execution (Status, Broadcast, Terminate)
  console.log("\n[Test 2] Testing Status & Broadcast Tools...")
  const mockCtx = {
    session: {
      prompt: async () => {},
      interrupt: async () => {},
    },
  } as any

  const statusTool = createStatusTool(mockCtx)
  const statusRes = await statusTool.execute({}, { sessionID: parentSession })
  assert.ok(statusRes.content.includes("backend-architect"), "Status output should reflect active members")
  console.log("✓ team_status execution verified")

  const broadcastTool = createBroadcastTool(mockCtx)
  const broadcastRes = await broadcastTool.execute(
    { message: "Steering: ensure all endpoints use JWT auth" },
    { sessionID: parentSession }
  )
  assert.ok(broadcastRes.content.includes("Broadcast delivered to 2 teammate(s)"), "Broadcast should confirm delivery")
  console.log("✓ team_broadcast execution verified")

  const terminateTool = createTerminateTool(mockCtx)
  const termRes = await terminateTool.execute(
    { target: "all" },
    { sessionID: parentSession }
  )
  assert.ok(termRes.content.includes("Terminated and cleaned up 2"), "Should terminate all 2 running workers")
  console.log("✓ team_terminate execution verified")

  // Test 3: team_delegate returns the child's reply and never fakes success
  console.log("\n[Test 3] Testing team_delegate reply capture...")
  const fakeCtx = (messages: any[], wait: () => Promise<void> = async () => {}) =>
    ({
      session: {
        create: async () => ({ id: "sess_child_" + Math.random().toString(36).slice(2) }),
        prompt: async () => ({ type: "user" }),
        wait,
        context: async () => messages,
      },
    }) as any
  const delegateArgs = { team_name: "Backend", agent_type: "Backend Architect", prompt: "list files", worktree: false }
  const asst = (...parts: any[]) => ({ type: "assistant", content: parts })
  const idle = (outcome: string) => ({ type: "idle", outcome })

  const okRes = await createDelegateTool(
    fakeCtx([
      { type: "user", text: "list files" },
      asst({ type: "reasoning", text: "thinking" }, { type: "text", text: "authorize.ts\nroles.ts" }),
      idle("succeeded"),
    ]),
  ).execute(delegateArgs, { sessionID: parentSession })
  assert.ok(okRes.content.startsWith("[Teammate Completed] Backend (backend-architect)"), "Success keeps the prefix")
  assert.ok(okRes.content.includes("authorize.ts\nroles.ts"), "Reply text must be returned")
  assert.ok(!okRes.content.includes("Task execution dispatched"), "No dispatch stub")

  const emptyRes = await createDelegateTool(
    fakeCtx([asst({ type: "tool", name: "shell" }), idle("succeeded")]),
  ).execute(delegateArgs, { sessionID: parentSession })
  assert.ok(emptyRes.content.startsWith("[Teammate Error]"), "A reply with no text must be an error")
  assert.ok(emptyRes.content.includes("no reply captured"), "Error names the cause")

  const failedRes = await createDelegateTool(
    fakeCtx([asst({ type: "text", text: "partial" }), idle("failed")]),
  ).execute(delegateArgs, { sessionID: parentSession })
  assert.ok(failedRes.content.startsWith("[Teammate Error]"), "A failed child is an error even with partial text")

  const waitRes = await createDelegateTool(
    fakeCtx([asst({ type: "text", text: "late" }), idle("succeeded")], async () => {
      throw new Error("wait unsupported")
    }),
  ).execute(delegateArgs, { sessionID: parentSession })
  assert.ok(waitRes.content.startsWith("[Teammate Error]"), "A throwing wait must not become a fake success")
  // The child must run on the caller's model, never on the global default.
  let createArgs: any
  const modelCtx = fakeCtx([
    { type: "assistant", model: { id: "nvidia/free-model", providerID: "nvidia" }, content: [{ type: "text", text: "ok" }] },
    idle("succeeded"),
  ])
  const baseCreate = modelCtx.session.create
  modelCtx.session.create = async (a: any) => ((createArgs = a), baseCreate())
  await createDelegateTool(modelCtx).execute(delegateArgs, { sessionID: parentSession })
  assert.deepEqual(createArgs.model, { id: "nvidia/free-model", providerID: "nvidia" }, "Child inherits caller model")
  console.log("✓ team_delegate reply capture verified")

  console.log("\n==================================================")
  console.log(" ✓ All Agent-Teams v2 tests passed successfully!")
  console.log("==================================================")
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err)
  process.exit(1)
})
