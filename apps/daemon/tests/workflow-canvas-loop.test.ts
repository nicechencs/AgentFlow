import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createComposedAppServices } from "../src/composition/index.js";
import { startDaemon, type StartedDaemon } from "../src/bootstrap/index.js";
import { commandHeaders, json, uniqueLockPath } from "./helpers.js";

/**
 * Canvas closed loop (D15 / T18): save draft → reload still present → publish
 * immutable → unpublished cannot bind/execute → bind published → confirm/start
 * uses that graph. Headed Electron is still out of scope; see
 * /workspace/agentflow-canvas-tw-checklist.md.
 */
interface ComposedHarness {
  daemon: StartedDaemon;
  stateDir: string;
  auth: Record<string, string>;
}

async function startComposedDaemon(): Promise<ComposedHarness> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-canvas-loop-"));
  const services = await createComposedAppServices({ stateDir, completeAfterMs: 5 });
  const daemon = await startDaemon({
    stateDir,
    services,
    lockPath: uniqueLockPath(),
    heartbeatMs: 30,
    pollMs: 20,
  });
  return { daemon, stateDir, auth: { authorization: `Bearer ${daemon.sessionToken}` } };
}

const canvasGraph = {
  entry: "design",
  nodes: [
    { id: "design", kind: "task", role: "planner", title: "Design" },
    { id: "ship", kind: "task", role: "developer", title: "Ship" },
  ],
  edges: [{ id: "e_design_ship", from: "design", to: "ship", waitFor: "outputs_ready" }],
};

describe("canvas draft save / reload / publish / unpublished not executable", () => {
  const harnesses: ComposedHarness[] = [];

  afterEach(async () => {
    for (const item of harnesses.splice(0)) {
      await item.daemon.close();
      fs.rmSync(item.stateDir, { recursive: true, force: true });
    }
  });

  it("keeps the draft after save+reload, publishes immutably, and refuses unpublished bind", async () => {
    const harness = await startComposedDaemon();
    harnesses.push(harness);
    const { daemon, auth } = harness;

    const created = await json(daemon.port, "/api/v1/workflows", {
      method: "POST",
      headers: commandHeaders(auth, "canvas-wf"),
      body: JSON.stringify({ name: "Canvas loop", description: "save then reload" }),
    });
    expect(created.status).toBe(201);
    const workflow = created.body as { id: string; stateRevision: number; name: string };

    const versionRes = await json(daemon.port, `/api/v1/workflows/${workflow.id}/versions`, {
      method: "POST",
      headers: commandHeaders(auth, "canvas-ver", workflow.stateRevision),
      body: JSON.stringify(canvasGraph),
    });
    expect(versionRes.status).toBe(201);
    const draft = versionRes.body as {
      id: string;
      stateRevision: number;
      status: string;
      nodes: Array<{ id: string }>;
    };
    expect(draft.status).toBe("draft");
    expect(draft.nodes.map((node) => node.id)).toEqual(["design", "ship"]);

    // Reload path used by the canvas after refresh.
    const reloadedWf = await json(daemon.port, `/api/v1/workflows/${workflow.id}`, {
      headers: auth,
    });
    expect(reloadedWf.status).toBe(200);
    expect((reloadedWf.body as { name: string }).name).toBe("Canvas loop");

    const reloadedVer = await json(
      daemon.port,
      `/api/v1/workflows/${workflow.id}/versions/${draft.id}`,
      { headers: auth },
    );
    expect(reloadedVer.status).toBe(200);
    expect((reloadedVer.body as { status: string }).status).toBe("draft");
    expect(
      ((reloadedVer.body as { nodes: Array<{ id: string }> }).nodes ?? []).map((node) => node.id),
    ).toEqual(["design", "ship"]);

    const projectRes = await json(daemon.port, "/api/v1/projects", {
      method: "POST",
      headers: commandHeaders(auth, "canvas-prj"),
      body: JSON.stringify({ name: "Canvas project", objective: "bind only published" }),
    });
    expect(projectRes.status).toBe(201);
    const project = projectRes.body as { id: string; stateRevision: number };

    const bindDraft = await json(daemon.port, `/api/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: commandHeaders(auth, "canvas-bind-draft", project.stateRevision),
      body: JSON.stringify({ workflowVersionId: draft.id }),
    });
    expect(bindDraft.status).toBe(422);

    const publishedRes = await json(
      daemon.port,
      `/api/v1/workflows/${workflow.id}/versions/${draft.id}:publish`,
      {
        method: "POST",
        headers: commandHeaders(auth, "canvas-publish", draft.stateRevision),
        body: "{}",
      },
    );
    expect(publishedRes.status).toBe(200);
    const published = publishedRes.body as { id: string; status: string; stateRevision: number };
    expect(published.status).toBe("published");

    // Published graph must not accept an in-place draft PATCH (immutable).
    const patchPublished = await json(
      daemon.port,
      `/api/v1/workflows/${workflow.id}/versions/${published.id}`,
      {
        method: "PATCH",
        headers: commandHeaders(auth, "canvas-patch-pub", published.stateRevision),
        body: JSON.stringify({
          ...canvasGraph,
          nodes: [
            ...canvasGraph.nodes,
            { id: "extra", kind: "task", role: "developer", title: "Extra" },
          ],
        }),
      },
    );
    expect([400, 409, 422]).toContain(patchPublished.status);

    const bindPublished = await json(daemon.port, `/api/v1/projects/${project.id}`, {
      method: "PATCH",
      headers: commandHeaders(auth, "canvas-bind-pub", project.stateRevision),
      body: JSON.stringify({ workflowVersionId: published.id }),
    });
    expect(bindPublished.status).toBe(200);
    expect((bindPublished.body as { workflowVersionId?: string }).workflowVersionId).toBe(
      published.id,
    );

    const planned = await json(daemon.port, `/api/v1/projects/${project.id}:start-planning`, {
      method: "POST",
      headers: commandHeaders(
        auth,
        "canvas-plan",
        (bindPublished.body as { stateRevision: number }).stateRevision,
      ),
      body: "{}",
    });
    expect(planned.status).toBe(200);
    const planning = planned.body as { stateRevision: number; planArtifactVersionId: string };

    const confirmed = await json(daemon.port, `/api/v1/projects/${project.id}:confirm-plan`, {
      method: "POST",
      headers: commandHeaders(auth, "canvas-confirm", planning.stateRevision),
      body: JSON.stringify({ planArtifactVersionId: planning.planArtifactVersionId }),
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "ready" });
    const ready = confirmed.body as { stateRevision: number };

    const started = await json(daemon.port, `/api/v1/projects/${project.id}:start`, {
      method: "POST",
      headers: commandHeaders(auth, "canvas-start", ready.stateRevision),
      body: "{}",
    });
    expect(started.status).toBe(200);

    const tasks = await json(daemon.port, `/api/v1/tasks?projectId=${project.id}`, {
      headers: auth,
    });
    expect(tasks.status).toBe(200);
    const titles = ((tasks.body as { items: Array<{ title: string }> }).items ?? []).map(
      (item) => item.title,
    );
    expect(titles.map((title) => title.toLowerCase()).sort()).toEqual(["design", "ship"]);
    expect(titles.some((title) => /dev_alpha|整合|规划/.test(title))).toBe(false);
  });
});
