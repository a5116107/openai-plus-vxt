import {
  appendRunLogEvent,
  clearRunLogEvents,
  exportRunLogCsv,
  exportRunLogJsonl,
  listRunLogEvents,
  loadRunLogState,
} from './state';
import type {
  RunLogEvent,
  RunLogLevel,
  RunLogResponse,
  RunLogStage,
} from './types';

export async function handleRunLogList(input?: {
  limit?: number;
  accountId?: string;
  level?: RunLogLevel | 'all';
}): Promise<RunLogResponse> {
  const state = await loadRunLogState();
  const events = listRunLogEvents(state, input);
  return {
    ok: true,
    message: `日志 ${events.length}/${state.events.length}`,
    state,
    events,
  };
}

export async function handleRunLogAppend(
  partial: Partial<RunLogEvent> & { message: string; level?: RunLogLevel },
): Promise<RunLogResponse> {
  const state = await appendRunLogEvent(partial);
  return {
    ok: true,
    message: '已写入日志',
    state,
    events: state.events.slice(-1),
  };
}

export async function handleRunLogClear(): Promise<RunLogResponse> {
  const state = await clearRunLogEvents();
  return { ok: true, message: '日志已清空', state, events: [] };
}

export async function handleRunLogExport(format: 'csv' | 'jsonl' = 'csv'): Promise<RunLogResponse> {
  const state = await loadRunLogState();
  const exportText = format === 'jsonl' ? exportRunLogJsonl(state.events) : exportRunLogCsv(state.events);
  return {
    ok: true,
    message: `已导出 ${state.events.length} 条`,
    state,
    events: state.events,
    exportText,
  };
}

/** Convenience logger used by probe/automation. */
export async function logRun(
  level: RunLogLevel,
  message: string,
  extra?: Partial<RunLogEvent> & { stage?: RunLogStage | string },
): Promise<void> {
  await appendRunLogEvent({
    level,
    message,
    stage: extra?.stage || 'system',
    accountLabel: extra?.accountLabel || extra?.email || extra?.accountId || '系统',
    accountId: extra?.accountId || '',
    email: extra?.email || '',
    code: extra?.code || '',
    progress: extra?.progress || '',
    taskId: extra?.taskId || '',
    country: extra?.country || '',
    meta: extra?.meta,
    action: extra?.action,
  }).catch(() => undefined);
}

export function classifyFailureLevel(message: string): { level: RunLogLevel; action?: string } {
  const text = String(message || '').toLowerCase();
  if (!text) return { level: 'error', action: '检查输入后重试' };
  if (text.includes('requirezero') || text.includes('非 0') || text.includes('amount=')) {
    return { level: 'warn', action: '可换出口/国家继续撞资格' };
  }
  if (text.includes('timeout') || text.includes('超时') || text.includes('network') || text.includes('fetch')) {
    return { level: 'warn', action: '可重试；检查代理连通' };
  }
  if (text.includes('冷却') || text.includes('cooldown')) {
    return { level: 'warn', action: '等待冷却或换 seed' };
  }
  if (text.includes('409') || text.includes('session') || text.includes('sign-in session')) {
    return { level: 'error', action: '会话失效，需重新登录/换账号' };
  }
  if (text.includes('token') && text.includes('无效')) {
    return { level: 'error', action: '更新 accessToken 后重试' };
  }
  if (text.includes('已停止') || text.includes('stop')) {
    return { level: 'warn', action: '任务已停止' };
  }
  return { level: 'error', action: '查看详情并决定是否换号/换出口' };
}
