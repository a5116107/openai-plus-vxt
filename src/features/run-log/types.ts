export type RunLogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

export type RunLogStage =
  | 'system'
  | 'task'
  | 'account'
  | 'proxy'
  | 'bootstrap'
  | 'promotion'
  | 'provider'
  | 'checkout'
  | 'detect-methods'
  | 'final-url'
  | 'seed'
  | 'hit'
  | 'retry'
  | 'done';

export interface RunLogEvent {
  id: string;
  ts: number;
  level: RunLogLevel;
  /** Human account label e.g. 账号#3 / email */
  accountLabel: string;
  accountId: string;
  email: string;
  stage: RunLogStage | string;
  message: string;
  /** Machine code: WAIT_CODE / HTTP_409 / REQUIRE_ZERO / etc */
  code: string;
  /** Optional progress like 6/400 or round/index */
  progress: string;
  taskId: string;
  country: string;
  /** Free-form meta for export/debug */
  meta?: Record<string, string | number | boolean | null>;
  /** actionable hint for warn/error */
  action?: string;
}

export interface RunLogState {
  connected: boolean;
  autoScroll: boolean;
  events: RunLogEvent[];
  updatedAt: number;
}

export interface RunLogAppendMessage {
  type: 'opx:runlog-append';
  event: Partial<RunLogEvent> & { message: string; level?: RunLogLevel };
}

export interface RunLogListMessage {
  type: 'opx:runlog-list';
  limit?: number;
  accountId?: string;
  level?: RunLogLevel | 'all';
}

export interface RunLogClearMessage {
  type: 'opx:runlog-clear';
}

export interface RunLogExportMessage {
  type: 'opx:runlog-export';
  format?: 'csv' | 'jsonl';
}

export interface RunLogResponse {
  ok: boolean;
  message: string;
  state?: RunLogState;
  events?: RunLogEvent[];
  exportText?: string;
}
