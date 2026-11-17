// A2A Task lifecycle store. States follow the A2A TaskState enum;
// business progress ("stage") is tracked in task.metadata.stage / stageHistory.
import { EventEmitter } from 'node:events';
import { newId, nowIso, clone } from '../utils/ids.js';

export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected'];
export const TERMINAL_STATES = new Set(['completed', 'canceled', 'failed', 'rejected']);

export class TaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class TaskStore extends EventEmitter {
  constructor({ max = 200 } = {}) {
    super();
    this.max = max;
    this.tasks = new Map();
  }

  create({ id, contextId, stage = 'received', envelope = null, extra = {} } = {}) {
    const taskId = id && !this.tasks.has(id) ? id : newId('task');
    const at = nowIso();
    const task = {
      kind: 'task',
      id: taskId,
      contextId: contextId || newId('ctx'),
      status: { state: 'submitted', timestamp: at },
      artifacts: [],
      history: [],
      metadata: { stage, stageHistory: [{ stage, state: 'submitted', at }], envelope, ...extra },
    };
    this.tasks.set(taskId, task);
    if (this.tasks.size > this.max) this.tasks.delete(this.tasks.keys().next().value);
    this.emit('change', clone(task));
    return clone(task);
  }

  get(id) { return clone(this.tasks.get(id)) ?? null; }
  has(id) { return this.tasks.has(id); }
  isTerminal(id) { const t = this.tasks.get(id); return !!t && TERMINAL_STATES.has(t.status.state); }

  /** Move a task forward. message = A2A Message (agent role) describing the transition. */
  update(id, { state, stage, message, artifact, metadata } = {}) {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError('TASK_NOT_FOUND', `Task ${id} not found`);
    if (TERMINAL_STATES.has(task.status.state)) throw new TaskError('TASK_TERMINAL', `Task ${id} is already ${task.status.state}`);
    if (state && !TASK_STATES.includes(state)) throw new TaskError('INVALID_STATE', `Unknown state ${state}`);
    const at = nowIso();
    task.status = { state: state ?? task.status.state, timestamp: at, ...(message ? { message } : {}) };
    if (stage) {
      task.metadata.stage = stage;
      task.metadata.stageHistory.push({ stage, state: task.status.state, at });
    }
    if (artifact) task.artifacts.push(artifact);
    if (metadata) Object.assign(task.metadata, metadata);
    this.emit('change', clone(task));
    return clone(task);
  }

  cancel(id, reason = 'Canceled by requester') {
    const task = this.tasks.get(id);
    if (!task) throw new TaskError('TASK_NOT_FOUND', `Task ${id} not found`);
    if (TERMINAL_STATES.has(task.status.state)) throw new TaskError('TASK_NOT_CANCELABLE', `Task ${id} is ${task.status.state} and cannot be canceled`);
    return this.update(id, { state: 'canceled', stage: 'canceled', message: { kind: 'message', role: 'agent', messageId: newId('msg'), parts: [{ kind: 'text', text: reason }] } });
  }

  list(limit = 50) { return [...this.tasks.values()].reverse().slice(0, limit).map(clone); }
  clear() { this.tasks.clear(); }
}
