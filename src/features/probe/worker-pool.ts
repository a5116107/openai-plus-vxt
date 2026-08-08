export interface ProbeProxyContext {
  proxyContextId: string;
  isolation: 'browser-global' | 'isolated';
  adapter: 'extension-profile' | 'external-worker';
  isolationProof: string;
}

export interface ProbeWorkerPlan {
  requestedConcurrency: number;
  effectiveConcurrency: number;
  contexts: ProbeProxyContext[];
  reason: string;
}

export const BROWSER_GLOBAL_PROXY_CONTEXT: ProbeProxyContext = {
  proxyContextId: 'browser-global',
  isolation: 'browser-global',
  adapter: 'extension-profile',
  isolationProof: '',
};

export function resolveProbeWorkerPlan(
  requestedConcurrency: number,
  availableContexts: ProbeProxyContext[],
): ProbeWorkerPlan {
  const requested = Math.max(1, Math.floor(Number(requestedConcurrency) || 1));
  const unique = [...new Map(availableContexts
    .filter((context) => context.proxyContextId)
    .map((context) => [context.proxyContextId, context])).values()];
  const isolated = unique.filter((context) => context.isolation === 'isolated' && context.isolationProof.trim());
  if (!isolated.length) {
    return {
      requestedConcurrency: requested,
      effectiveConcurrency: 1,
      contexts: [unique[0] || BROWSER_GLOBAL_PROXY_CONTEXT],
      reason: '浏览器扩展代理属于 profile 全局资源，相同 proxyContextId 必须串行',
    };
  }
  const contexts = isolated.slice(0, requested);
  return {
    requestedConcurrency: requested,
    effectiveConcurrency: contexts.length,
    contexts,
    reason: contexts.length > 1
      ? '代理适配器已证明上下文隔离，可按 proxyContextId 并发'
      : '当前只有一个可证明隔离的代理上下文',
  };
}

export class ProbeProxyContextScheduler {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(context: ProbeProxyContext, operation: () => Promise<T>): Promise<T> {
    const contextId = String(context.proxyContextId || '').trim();
    if (!contextId) throw new Error('proxyContextId is required for probe execution');
    const previous = this.tails.get(contextId) || Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = () => resolve(); });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(contextId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(contextId) === tail) this.tails.delete(contextId);
    }
  }
}

export async function runProbeWorkerPool<T, R>(input: {
  items: T[];
  plan: ProbeWorkerPlan;
  execute: (item: T, context: ProbeProxyContext, index: number) => Promise<R>;
  scheduler?: ProbeProxyContextScheduler;
}): Promise<R[]> {
  if (!input.items.length) return [];
  const scheduler = input.scheduler || new ProbeProxyContextScheduler();
  const results = new Array<R>(input.items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(input.plan.effectiveConcurrency, input.items.length));
  await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
    const context = input.plan.contexts[workerIndex % input.plan.contexts.length] || BROWSER_GLOBAL_PROXY_CONTEXT;
    while (cursor < input.items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await scheduler.run(context, () => input.execute(input.items[index], context, index));
    }
  }));
  return results;
}
