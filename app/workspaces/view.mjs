// @ts-check
import {automationReady} from '../sources/trial.mjs';
import {publicSession} from '../agents/sessions.mjs';
import {workerKey} from '../automation/worker-key.mjs';
import {automationProgress, runKindLabel, runOperationLabel} from '../automation/progress.mjs';
import {CONVERSATION_WORKER, isConversation, conversationWaiting} from './conversation.mjs';

// Web execution state uses the shared workspace and worker presentation contract.
export function webWorkspaceView(snapshot, agents) {
  const {automation: a, runs, activeRun: run} = snapshot;
  const progress = automationProgress(snapshot),
    title = progress.title;
  const execution = {
    status: run || a.status === 'enabled' ? 'running' : a.status,
    note: run ? a.goal : (runs[0]?.summary ?? 'Tell the agent what you want to do.'),
    intervalMinutes: a.intervalMinutes,
    task: run ? {id: run.id, kind: run.kind, createdAt: run.startedAt} : null,
  };
  const definitions = [...(snapshot.workers ?? [{id: 'main', name: 'Worker 1'}])];
  if (runs.some(isConversation) && !definitions.some((w) => w.id === CONVERSATION_WORKER))
    definitions.push({id: CONVERSATION_WORKER, name: 'Chat', conversation: true});
  const workers = definitions.map((worker) => {
    const slotRun = (snapshot.activeRuns ?? [run]).find(
        (r) => r && (r.workerId ?? 'main') === worker.id,
      ),
      ownRun = runs.find((r) => r.id === slotRun?.id) ?? slotRun,
      ownSession = agents.sessions.get(workerKey(a.id, worker.id));
    const ownActive = publicSession(ownSession);
    if (worker.conversation) {
      const waiting = conversationWaiting(ownRun);
      return {
        ...worker,
        active: ownActive,
        execution: {
          status: waiting ? 'waiting' : ownRun ? 'running' : 'paused',
          task: ownRun ? {id: ownRun.id, kind: ownRun.kind, createdAt: ownRun.startedAt} : null,
        },
        presentation: {
          title: waiting ? 'Chat open' : ownRun ? 'Preparing a reply' : 'Talk to the agent',
          status: waiting ? 'Waiting for a message' : ownRun ? 'Working' : 'Ready',
          detail: waiting
            ? 'You can write your next message. The same session stays open until you close the chat.'
            : 'The chat runs independently of source scans.',
        },
      };
    }
    const waiting = !ownRun && !ownActive && worker.enabled !== false && a.status === 'enabled';
    const startLabel =
      worker.id === 'main'
        ? progress.reviewed
          ? 'Start agent'
          : progress.primary?.label
        : 'Start worker';
    return {
      ...worker,
      active: ownActive,
      execution: {
        ...execution,
        ...(worker.enabled === false ? {status: 'paused'} : {}),
        task: ownRun
          ? {
              id: ownRun.id,
              kind: ownRun.kind,
              operation: ownRun.operation,
              createdAt: ownRun.startedAt,
            }
          : null,
      },
      presentation: {
        pageProgress: ownRun?.pageProgress ?? null,
        // The app prepares some tasks itself (reading pages and listings)
        // before the agent session starts.
        appWorking: Boolean(ownRun?.status === 'running' && !ownActive),
        title: waiting
          ? 'Waiting for the next task'
          : ownRun
            ? runOperationLabel(ownRun.operation, ownRun.kind)
            : isConversation(run)
              ? 'No task'
              : title,
        status: ownActive
          ? 'Working'
          : waiting
            ? 'Waiting for a task'
            : isConversation(run)
              ? 'Off'
              : progress.label,
        startLabel,
        detail: waiting
          ? 'Worker on; no agent session is running. It starts automatically when a suitable task arrives.'
          : ownRun
            ? (ownRun.sources ?? []).join(' · ')
            : progress.next,
        outcome:
          !waiting && !ownRun && progress.finishedRun
            ? {
                id: progress.finishedRun.id,
                title: progress.title,
                detail: progress.next,
                tone: progress.tone,
              }
            : null,
      },
    };
  });
  return {
    ...snapshot,
    progress,
    template: {id: a.templateId, kind: 'web'},
    capabilities: {
      concurrentConversation: true,
      maxWorkers: snapshot.definition?.execution.maxWorkers ?? 8,
      canStart: true,
      canRestart: automationReady(a),
      documents: true,
      terminalConversation: true,
      workerRestart: false,
      workerDescription: 'The agent follows the workspace’s sources and records.',
    },
    active:
      workers.find((w) => w.active?.sessionId === run?.id)?.active ??
      workers.find((w) => w.active)?.active ??
      null,
    execution,
    workers,
    activity: {
      title,
      detail: progress.detail,
      state: progress.label,
      tone: progress.tone,
      running: progress.running,
      at:
        (run?.startedAt ?? progress.finishedRun?.finishedAt)
          ? new Date(run?.startedAt ?? progress.finishedRun.finishedAt).toISOString()
          : null,
      url: null,
      history: runs.slice(0, 10).map((r) => ({
        at: r.startedAt,
        kind: 'agent_activity',
        data: {message: `${runKindLabel(r.kind)} · ${r.summary}`},
      })),
    },
  };
}
