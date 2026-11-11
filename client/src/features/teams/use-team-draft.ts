import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TeamDetail } from '@shared/team-workspace.interface';
import { teamKeys, teamsApi } from '@/api/teams';
import { friendlyError } from '@/utils/error-message';
import { commitTeamEdit, createTeamHistory, redoTeamEdit, undoTeamEdit, type TeamEditorState, type TeamHistory } from './team-graph';

export interface SavedTeamDraft { schemaVersion: 1; teamId: string; savedAt: string; semanticRevision: number; layoutRevision: number; displayRevision: number; state: TeamEditorState }
function editorState(team: TeamDetail): TeamEditorState { return { config: team.draft.config, display: team.display, layout: team.layout }; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    if (value.every(item => typeof item === 'string')) return [...items].sort();
    if (value.every(item => item && typeof item === 'object' && 'id' in item)) return [...items].sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));
    return items;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function draftKey(id: string): string { return `squabble.team-draft.${id}`; }
function readRecovery(id: string): SavedTeamDraft | null {
  try { const value: unknown = JSON.parse(window.sessionStorage.getItem(draftKey(id)) ?? 'null'); if (!value || typeof value !== 'object') return null; const saved = value as SavedTeamDraft; return saved.schemaVersion === 1 && saved.teamId === id && saved.state?.config?.schemaVersion === 1 && saved.state?.layout?.schemaVersion === 1 && typeof saved.state?.display?.name === 'string' ? saved : null; } catch { return null; }
}
/** Each persistence layer owns its CAS revision. Failed writes keep their exact idempotency key. */
export function useTeamDraft(team: TeamDetail, zh: boolean) {
  const client = useQueryClient();
  const [baseline, setBaseline] = useState(team);
  const baselineRef = useRef(team);
  const [history, setHistory] = useState<TeamHistory>(() => createTeamHistory(editorState(team)));
  const stateRef = useRef(history.present); stateRef.current = history.present;
  const [recovery, setRecovery] = useState<SavedTeamDraft | null>(() => { const saved = readRecovery(team.id); return saved && !same(saved.state, editorState(team)) ? saved : null; });
  const [conflict, setConflict] = useState<TeamDetail | null>(null);
  const [message, setMessage] = useState('');
  const [online, setOnline] = useState(() => typeof window === 'undefined' || window.navigator.onLine !== false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const intents = useRef(new Map<string, { digest: string; requestKey: string }>());
  const semanticDirty = !same(history.present.config, baseline.draft.config);
  const layoutDirty = !same(history.present.layout, baseline.layout);
  const displayDirty = !same(history.present.display, baseline.display);
  const dirty = semanticDirty || layoutDirty || displayDirty;
  const applyBaseline = useCallback((next: TeamDetail): void => { baselineRef.current = next; setBaseline(next); client.setQueryData(teamKeys.detail(next.id), next); }, [client]);
  const intent = (layer: string, payload: unknown): string => { const digest = JSON.stringify(payload); const old = intents.current.get(layer); if (old?.digest === digest) return old.requestKey; const requestKey = crypto.randomUUID(); intents.current.set(layer, { digest, requestKey }); return requestKey; };
  useEffect(() => {
    const update = (): void => { setOnline(window.navigator.onLine !== false); if (window.navigator.onLine !== false) { setNeedsReconcile(true); setMessage(zh ? '已联网。请先核对服务器版本，再继续保存。' : 'Back online. Check the server revisions before saving.'); } };
    window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, [zh]);
  useEffect(() => {
    if (!dirty || recovery) return;
    try { window.sessionStorage.setItem(draftKey(team.id), JSON.stringify({ schemaVersion: 1, teamId: team.id, savedAt: new Date().toISOString(), semanticRevision: baseline.semanticRevision, layoutRevision: baseline.layoutRevision, displayRevision: baseline.displayRevision, state: history.present } satisfies SavedTeamDraft)); }
    catch { setMessage(zh ? '浏览器暂存失败，请保持页面打开并保存到服务器。' : 'Browser recovery storage failed. Keep this page open and save to the server.'); }
  }, [dirty, history.present, baseline.semanticRevision, baseline.layoutRevision, baseline.displayRevision, recovery, team.id, zh]);
  useEffect(() => {
    if (!dirty) return; const guard = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const save = useMutation({ retry: false, mutationFn: async (layers: 'all' | 'layout' = 'all'): Promise<TeamDetail> => {
    if (!online) throw new Error(zh ? '当前离线，改动仅在此浏览器会话暂存。' : 'Offline. Edits are only stored in this browser session.');
    if (needsReconcile) throw new Error(zh ? '联网后须先核对服务器修订。' : 'Reconcile server revisions after reconnecting.');
    if (conflict) throw new Error(zh ? '请先处理版本冲突。' : 'Resolve the revision conflict first.');
    const snapshot = stateRef.current;
    let next = baselineRef.current;
    if (layers === 'all' && !same(snapshot.config, next.draft.config)) { const payload = { expectedSemanticRevision: next.semanticRevision, config: snapshot.config }; next = await teamsApi.saveDraft(team.id, { ...payload, requestKey: intent('semantic', payload) }); intents.current.delete('semantic'); applyBaseline(next); }
    if (layers === 'all' && !same(snapshot.display, next.display)) { const payload = { expectedDisplayRevision: next.displayRevision, display: snapshot.display }; next = await teamsApi.saveDisplay(team.id, { ...payload, requestKey: intent('display', payload) }); intents.current.delete('display'); applyBaseline(next); }
    if (!same(snapshot.layout, next.layout)) { const payload = { expectedLayoutRevision: next.layoutRevision, layout: snapshot.layout }; next = await teamsApi.saveLayout(team.id, { ...payload, requestKey: intent('layout', payload) }); intents.current.delete('layout'); applyBaseline(next); }
    setMessage(layers === 'layout' ? (zh ? '布局已保存；运行草稿需单独保存。' : 'Layout saved. Save the execution draft separately.') : (zh ? '草稿已保存，尚未发布。' : 'Draft saved; not published.'));
    const current = stateRef.current, saved = editorState(next);
    const reconciled: TeamEditorState = {
      config: layers === 'all' && same(current.config, snapshot.config) ? saved.config : current.config,
      display: layers === 'all' && same(current.display, snapshot.display) ? saved.display : current.display,
      layout: same(current.layout, snapshot.layout) ? saved.layout : current.layout,
    };
    stateRef.current = reconciled;
    setHistory(value => ({ ...value, present: reconciled }));
    if (same(stateRef.current, editorState(next))) { window.sessionStorage.removeItem(draftKey(team.id)); setRecovery(null); }
    await client.invalidateQueries({ queryKey: teamKeys.all }); return next;
  }, onError: async (error: unknown): Promise<void> => {
    setMessage(friendlyError(error, zh, { zh: '保存未确认，改动已保留。请核对服务器回执。', en: 'Save was not confirmed. Edits are retained. Check the server receipt.' }));
    try { const current = await teamsApi.detail(team.id); if (current.semanticRevision !== baselineRef.current.semanticRevision || current.layoutRevision !== baselineRef.current.layoutRevision || current.displayRevision !== baselineRef.current.displayRevision) setConflict(current); } catch { /* The original visible error remains and local edits are preserved. */ }
  } });
  useEffect(() => {
    const hierarchy = (value: TeamEditorState['config']): unknown => [value.departments.map(d => [d.id, d.parentDepartmentId]), value.roles.map(r => [r.id, r.departmentId])];
    if (!layoutDirty || !online || needsReconcile || !same(hierarchy(history.present.config), hierarchy(baseline.draft.config)) || conflict || recovery || save.isPending || save.isError || baseline.status === 'archived' || !baseline.capabilities.workspaceEnabled) return;
    const timer = window.setTimeout(() => { void save.mutateAsync('layout').catch(() => undefined); }, 1400); return () => window.clearTimeout(timer);
  }, [history.present.layout, history.present.config, layoutDirty, online, needsReconcile, conflict, recovery, save.isPending, save.isError, baseline.status, baseline.capabilities.workspaceEnabled]);
  const checkServer = async (): Promise<void> => {
    const current = await teamsApi.detail(team.id);
    setNeedsReconcile(false);
    if (same(editorState(current), stateRef.current)) { applyBaseline(current); setConflict(null); setMessage(zh ? '服务器回执已核对，草稿已保存。' : 'Server receipt checked. Draft saved.'); window.sessionStorage.removeItem(draftKey(team.id)); }
    else if (current.semanticRevision !== baselineRef.current.semanticRevision || current.layoutRevision !== baselineRef.current.layoutRevision || current.displayRevision !== baselineRef.current.displayRevision) { setConflict(current); setMessage(zh ? '服务器已有其他修订，请手动合并。' : 'The server has other revisions. Merge them explicitly.'); }
    else setMessage(zh ? '服务器修订未变，可继续保存本地改动。' : 'Server revisions are unchanged. Local edits can be saved.');
  };
  return { state: history.present, baseline, history, dirty, semanticDirty, layoutDirty, displayDirty, online, needsReconcile, conflict, recovery, message, setMessage, save,
    edit: (next: TeamEditorState | ((value: TeamEditorState) => TeamEditorState)): void => { setHistory(current => commitTeamEdit(current, typeof next === 'function' ? next(current.present) : next)); },
    undo: (): void => setHistory(undoTeamEdit), redo: (): void => setHistory(redoTeamEdit), checkServer,
    restore: (): void => { if (recovery) { setHistory(createTeamHistory(recovery.state)); if (recovery.semanticRevision !== baseline.semanticRevision || recovery.layoutRevision !== baseline.layoutRevision || recovery.displayRevision !== baseline.displayRevision) setConflict(baseline); setRecovery(null); } },
    discardRecovery: (): void => { window.sessionStorage.removeItem(draftKey(team.id)); setRecovery(null); },
    useServer: (): void => { if (conflict) { applyBaseline(conflict); setHistory(createTeamHistory(editorState(conflict))); setConflict(null); intents.current.clear(); window.sessionStorage.removeItem(draftKey(team.id)); } },
    mergeLocal: (): void => { if (conflict) { applyBaseline(conflict); setConflict(null); intents.current.clear(); setMessage(zh ? '已以最新服务器修订为基准。请在属性中逐项合并后保存；尚未写入。' : 'Using the latest server revisions. Merge fields in the inspector before saving; nothing has been written.'); } },
    replace: (next: TeamDetail): void => { applyBaseline(next); setHistory(createTeamHistory(editorState(next))); setConflict(null); intents.current.clear(); },
    acceptServer: applyBaseline,
    reset: (): void => { setHistory(createTeamHistory(editorState(baselineRef.current))); window.sessionStorage.removeItem(draftKey(team.id)); },
  };
}
