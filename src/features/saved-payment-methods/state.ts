import { scopedStorageKey } from '../../app/storage-scope';
import { sanitizeSavedPaymentMessage } from './element-bridge';
import type { SavedPaymentAttemptRecord, SavedPaymentOrchestratorResult } from './orchestrator';
import type { SavedPaymentMethodList, SavedPaymentMethodSummary } from './transport';

const STORAGE_KEY = 'opx.savedPaymentMethods.state';
export const SAVED_PAYMENT_FEATURE_STORAGE_KEY = 'opx.savedPaymentMethods.feature';
const MAX_ATTEMPTS = 50;
const MAX_AUDIT_EVENTS = 100;

export interface SavedPaymentFeatureSettings {
  enabled: boolean;
  environment: 'test';
  allowedMethods: ['card'];
  updatedAt: number;
}

export interface SavedPaymentFeatureGate {
  ok: boolean;
  code: 'SAVED_PAYMENT_ENABLED' | 'SAVED_PAYMENT_DISABLED' | 'SAVED_PAYMENT_TEST_KEY_REQUIRED';
  message: string;
}

export const DEFAULT_SAVED_PAYMENT_FEATURE_SETTINGS: SavedPaymentFeatureSettings = {
  enabled: false,
  environment: 'test',
  allowedMethods: ['card'],
  updatedAt: 0,
};

export interface SavedPaymentAuditEvent {
  id: string;
  accountId: string;
  attemptId: string;
  phase: string;
  code: string;
  message: string;
  createdAt: number;
}

export interface SavedPaymentAccountState {
  accountId: string;
  email: string;
  paymentMethods: SavedPaymentMethodSummary[];
  defaultPaymentMethodId: string;
  attempts: SavedPaymentAttemptRecord[];
  audit: SavedPaymentAuditEvent[];
  updatedAt: number;
}

export interface SavedPaymentState {
  schemaVersion: 1;
  accounts: Record<string, SavedPaymentAccountState>;
  updatedAt: number;
}

const EMPTY_STATE: SavedPaymentState = { schemaVersion: 1, accounts: {}, updatedAt: 0 };

export async function loadSavedPaymentState(): Promise<SavedPaymentState> {
  const key = scopedStorageKey(STORAGE_KEY);
  const data = await browser.storage.local.get(key);
  return normalizeSavedPaymentState(data[key]);
}

export async function loadSavedPaymentFeatureSettings(): Promise<SavedPaymentFeatureSettings> {
  const key = scopedStorageKey(SAVED_PAYMENT_FEATURE_STORAGE_KEY);
  const data = await browser.storage.local.get(key);
  return normalizeSavedPaymentFeatureSettings(data[key]);
}

export async function saveSavedPaymentFeatureSettings(
  patch: Pick<Partial<SavedPaymentFeatureSettings>, 'enabled'>,
): Promise<SavedPaymentFeatureSettings> {
  const current = await loadSavedPaymentFeatureSettings();
  const next = normalizeSavedPaymentFeatureSettings({
    ...current,
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    updatedAt: Date.now(),
  });
  await browser.storage.local.set({ [scopedStorageKey(SAVED_PAYMENT_FEATURE_STORAGE_KEY)]: next });
  return next;
}

export function normalizeSavedPaymentFeatureSettings(value: unknown): SavedPaymentFeatureSettings {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === true,
    environment: 'test',
    allowedMethods: ['card'],
    updatedAt: Number(source.updatedAt || 0),
  };
}

export function evaluateSavedPaymentFeatureGate(
  settings: SavedPaymentFeatureSettings,
  publishableKey: string,
): SavedPaymentFeatureGate {
  if (!settings.enabled) {
    return {
      ok: false,
      code: 'SAVED_PAYMENT_DISABLED',
      message: '测试卡保存功能尚未启用',
    };
  }
  if (!/^pk_test_[A-Za-z0-9_-]+$/.test(String(publishableKey || ''))) {
    return {
      ok: false,
      code: 'SAVED_PAYMENT_TEST_KEY_REQUIRED',
      message: '当前 rollout 仅接受 Stripe 测试环境 PK',
    };
  }
  return {
    ok: true,
    code: 'SAVED_PAYMENT_ENABLED',
    message: '测试卡保存功能已启用',
  };
}

export async function saveSavedPaymentMethodList(
  accountId: string,
  email: string,
  list: SavedPaymentMethodList,
): Promise<SavedPaymentAccountState> {
  return updateAccount(accountId, (current) => ({
    ...current,
    email: String(email || '').trim().slice(0, 254),
    paymentMethods: list.paymentMethods.map(normalizePaymentMethod).filter(isPresent),
    defaultPaymentMethodId: normalizePaymentMethodId(list.defaultPaymentMethodId),
    updatedAt: Date.now(),
  }));
}

export async function recordSavedPaymentAttempt(
  result: SavedPaymentOrchestratorResult,
): Promise<SavedPaymentAccountState> {
  const attempt = normalizeAttempt(result.attempt);
  if (!attempt) throw new Error('saved payment attempt is invalid');
  return updateAccount(attempt.chatgptAccountId, (current) => {
    const attempts = [attempt, ...current.attempts.filter((item) => item.id !== attempt.id)].slice(0, MAX_ATTEMPTS);
    const auditEvent: SavedPaymentAuditEvent = {
      id: `${attempt.id}:${attempt.updatedAt}:${String(result.code || '').slice(0, 60)}`,
      accountId: attempt.chatgptAccountId,
      attemptId: attempt.id,
      phase: attempt.state,
      code: String(result.code || 'UNKNOWN').slice(0, 80),
      message: sanitizeSavedPaymentMessage(result.message),
      createdAt: attempt.updatedAt,
    };
    return {
      ...current,
      attempts,
      audit: [auditEvent, ...current.audit].slice(0, MAX_AUDIT_EVENTS),
      updatedAt: Date.now(),
    };
  });
}

export function normalizeSavedPaymentState(value: unknown): SavedPaymentState {
  const source = isRecord(value) ? value : {};
  const accountsSource = isRecord(source.accounts) ? source.accounts : {};
  const accounts: Record<string, SavedPaymentAccountState> = {};
  for (const [key, raw] of Object.entries(accountsSource)) {
    const normalized = normalizeAccount(raw, key);
    if (normalized) accounts[normalized.accountId] = normalized;
  }

  // Pre-v1 fixtures stored attempts at the root. Migrate only already-sanitized records.
  if (Array.isArray(source.attempts)) {
    for (const rawAttempt of source.attempts) {
      const attempt = normalizeAttempt(rawAttempt);
      if (!attempt) continue;
      const account = accounts[attempt.chatgptAccountId] || emptyAccount(attempt.chatgptAccountId);
      account.attempts = [attempt, ...account.attempts.filter((item) => item.id !== attempt.id)].slice(0, MAX_ATTEMPTS);
      account.updatedAt = Math.max(account.updatedAt, attempt.updatedAt);
      accounts[account.accountId] = account;
    }
  }
  return {
    schemaVersion: 1,
    accounts,
    updatedAt: Number(source.updatedAt || 0),
  };
}

export function exportSavedPaymentAuditJson(state: SavedPaymentState, accountId = ''): string {
  const accounts = selectAccounts(state, accountId).map((account) => ({
    accountId: account.accountId,
    email: account.email,
    paymentMethods: account.paymentMethods,
    defaultPaymentMethodId: account.defaultPaymentMethodId,
    attempts: account.attempts,
    audit: account.audit,
    updatedAt: account.updatedAt,
  }));
  return JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), accounts }, null, 2);
}

export function exportSavedPaymentAuditCsv(state: SavedPaymentState, accountId = ''): string {
  const rows = [['accountId', 'attemptId', 'phase', 'code', 'message', 'createdAt']];
  for (const account of selectAccounts(state, accountId)) {
    for (const event of account.audit) {
      rows.push([
        event.accountId,
        event.attemptId,
        event.phase,
        event.code,
        sanitizeSavedPaymentMessage(event.message),
        String(event.createdAt),
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

async function updateAccount(
  accountId: string,
  update: (current: SavedPaymentAccountState) => SavedPaymentAccountState,
): Promise<SavedPaymentAccountState> {
  const normalizedId = normalizeAccountId(accountId);
  if (!normalizedId) throw new Error('ChatGPT account id is required');
  const currentState = await loadSavedPaymentState();
  const nextAccount = normalizeAccount(update(currentState.accounts[normalizedId] || emptyAccount(normalizedId)), normalizedId);
  if (!nextAccount) throw new Error('saved payment account state is invalid');
  const next: SavedPaymentState = {
    schemaVersion: 1,
    accounts: { ...currentState.accounts, [normalizedId]: nextAccount },
    updatedAt: Date.now(),
  };
  await browser.storage.local.set({ [scopedStorageKey(STORAGE_KEY)]: next });
  return nextAccount;
}

function normalizeAccount(value: unknown, fallbackId = ''): SavedPaymentAccountState | null {
  const source = isRecord(value) ? value : {};
  const accountId = normalizeAccountId(source.accountId || fallbackId);
  if (!accountId) return null;
  return {
    accountId,
    email: String(source.email || '').trim().slice(0, 254),
    paymentMethods: Array.isArray(source.paymentMethods)
      ? source.paymentMethods.map(normalizePaymentMethod).filter(isPresent).slice(0, 50)
      : [],
    defaultPaymentMethodId: normalizePaymentMethodId(source.defaultPaymentMethodId),
    attempts: Array.isArray(source.attempts)
      ? source.attempts.map(normalizeAttempt).filter(isPresent).slice(0, MAX_ATTEMPTS)
      : [],
    audit: Array.isArray(source.audit)
      ? source.audit.map((event) => normalizeAuditEvent(event, accountId)).filter(isPresent).slice(0, MAX_AUDIT_EVENTS)
      : [],
    updatedAt: Number(source.updatedAt || 0),
  };
}

function normalizeAttempt(value: unknown): SavedPaymentAttemptRecord | null {
  if (!isRecord(value)) return null;
  const id = normalizeIdentifier(value.id);
  const chatgptAccountId = normalizeAccountId(value.chatgptAccountId);
  if (!id || !chatgptAccountId || value.method !== 'card') return null;
  const states = new Set([
    'session', 'createSetupIntent', 'resolveMerchantKey', 'mountElement', 'confirmSetup',
    'retrieveIntent', 'listPaymentMethods', 'verifyAttachedAndDefault', 'completed', 'failed',
    'invalidated', 'cancelled',
  ]);
  const state = states.has(String(value.state)) ? String(value.state) as SavedPaymentAttemptRecord['state'] : 'failed';
  const trace = Array.isArray(value.trace)
    ? value.trace.filter((item): item is SavedPaymentAttemptRecord['trace'][number] => states.has(String(item)) && item !== 'completed' && item !== 'failed' && item !== 'invalidated' && item !== 'cancelled')
    : [];
  const fingerprint = String(value.keyFingerprint || '');
  return {
    id,
    chatgptAccountId,
    method: 'card',
    state,
    ...(normalizeSetupIntentId(value.setupIntentId) ? { setupIntentId: normalizeSetupIntentId(value.setupIntentId) } : {}),
    ...(normalizePaymentMethodId(value.paymentMethodId) ? { paymentMethodId: normalizePaymentMethodId(value.paymentMethodId) } : {}),
    ...(/^pk_(?:live|test)\.\.\.[A-Za-z0-9_-]{1,12}$/.test(fingerprint) ? { keyFingerprint: fingerprint } : {}),
    confirmSubmitted: Boolean(value.confirmSubmitted),
    attachedVerified: Boolean(value.attachedVerified),
    reusableVerified: Boolean(value.reusableVerified),
    defaultVerified: Boolean(value.defaultVerified),
    trace,
    createdAt: Number(value.createdAt || 0),
    updatedAt: Number(value.updatedAt || 0),
  };
}

function normalizePaymentMethod(value: unknown): SavedPaymentMethodSummary | null {
  if (!isRecord(value)) return null;
  const id = normalizePaymentMethodId(value.id);
  if (!id) return null;
  const card = isRecord(value.card) ? value.card : null;
  return {
    id,
    type: String(value.type || 'unknown').slice(0, 40),
    ...(card ? {
      card: {
        brand: String(card.brand || '').slice(0, 30),
        last4: /^\d{4}$/.test(String(card.last4 || '')) ? String(card.last4) : '',
        expMonth: boundedNumber(card.expMonth, 1, 12),
        expYear: boundedNumber(card.expYear, 0, 9999),
      },
    } : {}),
    isDefault: Boolean(value.isDefault),
  };
}

function normalizeAuditEvent(value: unknown, accountId: string): SavedPaymentAuditEvent | null {
  if (!isRecord(value)) return null;
  const attemptId = normalizeIdentifier(value.attemptId);
  if (!attemptId) return null;
  return {
    id: normalizeIdentifier(value.id) || `${attemptId}:${Number(value.createdAt || 0)}`,
    accountId,
    attemptId,
    phase: String(value.phase || 'unknown').slice(0, 80),
    code: String(value.code || 'UNKNOWN').slice(0, 80),
    message: sanitizeSavedPaymentMessage(value.message),
    createdAt: Number(value.createdAt || 0),
  };
}

function emptyAccount(accountId: string): SavedPaymentAccountState {
  return { accountId, email: '', paymentMethods: [], defaultPaymentMethodId: '', attempts: [], audit: [], updatedAt: 0 };
}

function selectAccounts(state: SavedPaymentState, accountId: string): SavedPaymentAccountState[] {
  const selected = normalizeAccountId(accountId);
  return selected ? (state.accounts[selected] ? [state.accounts[selected]] : []) : Object.values(state.accounts);
}

function normalizeAccountId(value: unknown): string {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9:_-]{1,160}$/.test(id) ? id : '';
}

function normalizeIdentifier(value: unknown): string {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9:_-]{1,180}$/.test(id) ? id : '';
}

function normalizeSetupIntentId(value: unknown): string {
  const id = String(value || '').trim();
  return /^seti_[A-Za-z0-9]+$/.test(id) ? id : '';
}

function normalizePaymentMethodId(value: unknown): string {
  const id = String(value || '').trim();
  return /^pm_[A-Za-z0-9]+$/.test(id) ? id : '';
}

function boundedNumber(value: unknown, min: number, max: number): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= min && number <= max ? number : 0;
}

function csvCell(value: string): string {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
