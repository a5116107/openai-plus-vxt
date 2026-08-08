import './style.css';

import type {
  ProbeArchiveEntity,
  ProbeArchivePage,
  ProbeArchiveResponse,
} from '../../src/features/probe/types';

const app = document.querySelector<HTMLElement>('#app');
let entity: ProbeArchiveEntity = 'observations';
let page = 1;
let latest: ProbeArchivePage | undefined;

if (app) {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">OPENAI PLUS VXT</p>
        <h1>探测运营控制台</h1>
      </div>
      <div class="actions">
        <label class="retention"><span>保留天数</span><input id="retention-days" type="number" min="1" max="3650" value="90" /></label>
        <button id="prune" type="button">执行保留策略</button>
        <button id="refresh" type="button">刷新</button>
        <button id="export" type="button">导出 JSON</button>
        <button id="clear" class="danger" type="button">清理当前归档</button>
      </div>
    </header>
    <section class="status-band" aria-live="polite">
      <div><span>存储</span><strong id="backend">-</strong></div>
      <div><span>观测</span><strong id="observation-count">0</strong></div>
      <div><span>命中</span><strong id="hit-count">0</strong></div>
      <div><span>运行</span><strong id="run-count">0</strong></div>
      <p id="status-message">正在加载</p>
    </section>
    <nav class="tabs" aria-label="归档类型">
      <button type="button" data-entity="observations" class="active">观测记录</button>
      <button type="button" data-entity="hits">命中记录</button>
      <button type="button" data-entity="runs">运行历史</button>
    </nav>
    <section class="toolbar">
      <label><span>搜索</span><input id="query" type="search" autocomplete="off" placeholder="账号、国家、运行或消息" /></label>
      <label><span>国家</span><input id="country" type="text" maxlength="2" placeholder="US" /></label>
      <label><span>结果</span><input id="outcome" type="text" placeholder="hit / miss / error" /></label>
      <button id="apply" type="button">应用筛选</button>
    </section>
    <section class="data-region">
      <div class="table-wrap">
        <table>
          <thead><tr id="columns"></tr></thead>
          <tbody id="records"></tbody>
        </table>
      </div>
      <footer class="pager">
        <span id="page-summary">0 条</span>
        <div><button id="previous" type="button">上一页</button><button id="next" type="button">下一页</button></div>
      </footer>
    </section>`;
  bindEvents();
  void loadPage();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-entity]').forEach((button) => {
    button.addEventListener('click', () => {
      entity = button.dataset.entity as ProbeArchiveEntity;
      page = 1;
      document.querySelectorAll('[data-entity]').forEach((item) => item.classList.toggle('active', item === button));
      void loadPage();
    });
  });
  byId('refresh').addEventListener('click', () => void loadPage());
  byId('apply').addEventListener('click', () => { page = 1; void loadPage(); });
  byId('query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { page = 1; void loadPage(); }
  });
  byId('previous').addEventListener('click', () => { if (page > 1) { page -= 1; void loadPage(); } });
  byId('next').addEventListener('click', () => {
    if (latest && page * latest.pageSize < latest.total) { page += 1; void loadPage(); }
  });
  byId('export').addEventListener('click', () => void exportArchive());
  byId('clear').addEventListener('click', () => void clearArchive());
  byId('prune').addEventListener('click', () => void pruneArchive());
}

async function loadPage(): Promise<void> {
  setStatus('正在读取归档');
  const response = await browser.runtime.sendMessage({
    type: 'opx:probe-archive-query',
    query: {
      entity,
      page,
      pageSize: 50,
      query: inputValue('query'),
      country: inputValue('country'),
      outcome: inputValue('outcome'),
    },
  }) as ProbeArchiveResponse;
  latest = response.page;
  if (response.status) renderStatus(response.status);
  if (!response.page) {
    setStatus(response.message || '归档读取失败', true);
    renderRecords(undefined);
    return;
  }
  renderRecords(response.page);
  setStatus(response.message, !response.ok);
}

function renderStatus(status: NonNullable<ProbeArchiveResponse['status']>): void {
  byId('backend').textContent = status.degraded ? '本地热数据（降级）' : `IndexedDB v${status.schemaVersion}`;
  byId('observation-count').textContent = String(status.observationCount);
  byId('hit-count').textContent = String(status.hitCount);
  byId('run-count').textContent = String(status.runCount);
  if (status.retentionDays > 0) (byId('retention-days') as HTMLInputElement).value = String(status.retentionDays);
  document.body.classList.toggle('degraded', status.degraded);
}

function renderRecords(result?: ProbeArchivePage): void {
  const columns = columnDefinitions(entity);
  const head = byId('columns');
  const body = byId('records');
  head.replaceChildren(...columns.map(([label]) => element('th', label)));
  body.replaceChildren();
  for (const record of result?.records || []) {
    const source = record as unknown as Record<string, unknown>;
    const row = document.createElement('tr');
    for (const [, key] of columns) row.append(element('td', formatCell(source[key], key)));
    body.append(row);
  }
  if (!result?.records.length) {
    const cell = element('td', '暂无记录');
    cell.colSpan = columns.length;
    cell.className = 'empty';
    const row = document.createElement('tr');
    row.append(cell);
    body.append(row);
  }
  const totalPages = Math.max(1, Math.ceil((result?.total || 0) / (result?.pageSize || 50)));
  byId('page-summary').textContent = `${result?.total || 0} 条 · 第 ${result?.page || 1}/${totalPages} 页`;
  (byId('previous') as HTMLButtonElement).disabled = page <= 1;
  (byId('next') as HTMLButtonElement).disabled = !result || page * result.pageSize >= result.total;
}

function columnDefinitions(value: ProbeArchiveEntity): Array<[string, string]> {
  if (value === 'hits') return [['保存时间', 'savedAt'], ['账号', 'email'], ['国家', 'country'], ['类型', 'hitKind'], ['金额', 'amountHint'], ['资格', 'qualificationVerified'], ['链接', 'link']];
  if (value === 'runs') return [['更新时间', 'updatedAt'], ['任务', 'taskName'], ['运行', 'runId'], ['状态', 'status'], ['进度', 'completedUnits'], ['命中', 'hits'], ['错误', 'errors']];
  return [['观测时间', 'observedAt'], ['账号', 'accountId'], ['国家', 'probeCountry'], ['结果', 'outcome'], ['类型', 'hitKind'], ['轮次', 'round'], ['消息', 'message']];
}

function formatCell(value: unknown, key: string): string {
  if (key.endsWith('At')) return Number(value) ? new Date(Number(value)).toLocaleString('zh-CN') : '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return String(value.length);
  return String(value ?? '-');
}

async function exportArchive(): Promise<void> {
  setStatus('正在生成导出');
  const response = await browser.runtime.sendMessage({
    type: 'opx:probe-archive-export',
    query: { entity, query: inputValue('query'), country: inputValue('country'), outcome: inputValue('outcome') },
  }) as ProbeArchiveResponse;
  if (!response.exportText) { setStatus(response.message || '导出失败', true); return; }
  const url = URL.createObjectURL(new Blob([response.exportText], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `probe-${entity}-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus(response.message);
}

async function clearArchive(): Promise<void> {
  if (!window.confirm('确认清理当前归档？本地热数据不受影响。')) return;
  const response = await browser.runtime.sendMessage({ type: 'opx:probe-archive-clear', entity }) as ProbeArchiveResponse;
  setStatus(response.message, !response.ok);
  page = 1;
  await loadPage();
}

async function pruneArchive(): Promise<void> {
  const retentionDays = Number((byId('retention-days') as HTMLInputElement).value || 90);
  const response = await browser.runtime.sendMessage({ type: 'opx:probe-archive-prune', retentionDays }) as ProbeArchiveResponse;
  setStatus(response.message, !response.ok);
  await loadPage();
}

function setStatus(message: string, error = false): void {
  const target = byId('status-message');
  target.textContent = message;
  target.classList.toggle('error', error);
}

function inputValue(id: string): string { return (byId(id) as HTMLInputElement).value.trim(); }
function byId(id: string): HTMLElement { return document.getElementById(id) as HTMLElement; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
