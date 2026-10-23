// dsh-lineup-manager — client half.
//
// Adds a "线路管理 / Lineups" entry to the Settings dialog (through the native
// `settings.action` slot) that opens a panel listing every provider declared in
// the profile's cordis.patch.yml, with a checkbox per model lineup.
//
// The panel is a two-step editor: local checkbox state is the draft, and
// "保存 / Save" posts the draft to the host half. Nothing is written until the
// draft is explicitly saved, and the host keeps a timestamped backup of the
// file before every write.
//
// Loader id MUST equal package.json's `name`, otherwise the module table lookup
// fails and the plugin never activates.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-lineup-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-lineup-manager/api';
    const T = {
      zh: {
        title: '线路管理',
        subtitle: '勾选要在模型下拉菜单中显示的线路',
        open: '线路管理',
        loading: '读取配置中…',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        reload: '重新读取',
        close: '关闭',
        selectAll: '全选',
        selectNone: '全不选',
        onlyFree: '仅保留 free',
        all: '全部',
        none: '无',
        noneDeclared: '未声明线路（该供应商会显示全部线路）',
        restart: '已写入配置。需重启 DSH 后生效。',
        backupAt: '备份：',
        failed: '失败：',
        count: '已选',
        total: '共',
        dirty: '有未保存的修改',
        confirmDiscard: '有未保存的修改，确定放弃？',
        declaredHint: '该供应商未声明 models，菜单会显示其全部线路。保存后即受限。',
        refresh: '刷新',
        refreshing: '刷新中…',
        refreshAll: '全部刷新',
        refreshHint: '从平台实时拉取线路清单，标记新增与已下线',
        addedBadge: '新增',
        removedBadge: '已下线',
        refreshedAt: '已刷新',
        refreshFail: '刷新失败：',
        noChange: '与平台一致，无变化',
        applyAdded: '勾选全部新增',
        removeGone: '取消全部已下线',
        staleWarn: '配置中有线路平台已不再提供',
      },
      en: {
        title: 'Lineups',
        subtitle: 'Check the lineups shown in the model picker',
        open: 'Lineups',
        loading: 'Reading config…',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        reload: 'Reload',
        close: 'Close',
        selectAll: 'All',
        selectNone: 'None',
        onlyFree: 'Free only',
        all: 'all',
        none: 'none',
        noneDeclared: 'No lineups declared (this provider shows its full catalog)',
        restart: 'Written. Restart DSH to take effect.',
        backupAt: 'Backup: ',
        failed: 'Failed: ',
        count: 'selected',
        total: 'of',
        dirty: 'Unsaved changes',
        confirmDiscard: 'You have unsaved changes. Discard?',
        declaredHint: 'This provider declares no models, so the picker shows its whole catalog. Saving will constrain it.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        refreshAll: 'Refresh all',
        refreshHint: 'Pull the live lineup list from the platform; marks additions and removals',
        addedBadge: 'new',
        removedBadge: 'gone',
        refreshedAt: 'Refreshed',
        refreshFail: 'Refresh failed: ',
        noChange: 'Matches the platform, no changes',
        applyAdded: 'Check all new',
        removeGone: 'Uncheck all gone',
        staleWarn: 'Configured lineups the platform no longer offers',
      },
    };

    function lang() {
      const l = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
      return l.startsWith('zh') ? 'zh' : 'en';
    }

    async function api(payload) {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await r.text();
      try {
        return JSON.parse(raw);
      } catch {
        // Never invent an "HTTP <status>" message: the host may have answered
        // with a non-JSON body that carries the real reason, and replacing it
        // with a bare status sends every later diagnosis down the wrong path.
        return { ok: false, error: 'HTTP ' + r.status + (raw && raw.trim() ? ' — ' + raw.trim().slice(0, 300) : ' (empty body)') };
      }
    }

    // ---- styles (injected once) ------------------------------------------
    const CSS_ID = 'dsh-lineup-manager-css';
    function injectCss() {
      if (document.getElementById(CSS_ID)) return;
      const s = document.createElement('style');
      s.id = CSS_ID;
      s.textContent = `
.dlm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px}
.dlm-modal{background:var(--dsh-bg-elevated,#1e1e20);color:var(--dsh-fg,#e8e8ea);border:1px solid var(--dsh-border,#3a3a3d);border-radius:12px;width:min(880px,100%);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.dlm-head{padding:16px 20px;border-bottom:1px solid var(--dsh-border,#3a3a3d);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dlm-head h2{margin:0;font-size:16px;font-weight:600}
.dlm-sub{opacity:.65;font-size:12px}
.dlm-spacer{flex:1}
.dlm-body{padding:8px 20px 16px;overflow:auto;flex:1}
.dlm-prov{border:1px solid var(--dsh-border,#3a3a3d);border-radius:10px;margin:12px 0;overflow:hidden}
.dlm-prov-head{padding:10px 14px;background:rgba(127,127,127,.08);display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer;user-select:none}
.dlm-prov-name{font-weight:600;font-size:13px}
.dlm-badge{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.18)}
.dlm-badge.warn{background:rgba(230,160,40,.22)}
.dlm-list{padding:6px 8px 10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px}
.dlm-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:12.5px;cursor:pointer}
.dlm-item:hover{background:rgba(127,127,127,.12)}
.dlm-item input{margin:0;flex:none}
.dlm-id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}
.dlm-meta{opacity:.55;font-size:11px;margin-left:auto;flex:none}
.dlm-foot{padding:12px 20px;border-top:1px solid var(--dsh-border,#3a3a3d);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dlm-btn{background:rgba(127,127,127,.16);color:inherit;border:1px solid var(--dsh-border,#3a3a3d);border-radius:7px;padding:6px 12px;font-size:12.5px;cursor:pointer}
.dlm-btn:hover{background:rgba(127,127,127,.26)}
.dlm-btn[disabled]{opacity:.45;cursor:default}
.dlm-btn.primary{background:#3b6ef5;border-color:#3b6ef5;color:#fff}
.dlm-btn.primary:hover{background:#2f5fe0}
.dlm-msg{font-size:12px;padding:6px 10px;border-radius:6px}
.dlm-msg.ok{background:rgba(60,180,110,.16)}
.dlm-msg.err{background:rgba(220,80,80,.18);white-space:pre-wrap;word-break:break-all}
.dlm-msg.warn{background:rgba(230,160,40,.16)}
.dlm-dirty{font-size:12px;opacity:.7}
.dlm-badge.ok{background:rgba(60,180,110,.22)}
.dlm-badge.gone{background:rgba(160,160,160,.22);text-decoration:line-through}
.dlm-item.is-new{background:rgba(60,180,110,.10)}
.dlm-item.is-gone{opacity:.62}
.dlm-item.is-gone .dlm-id{text-decoration:line-through}
.dlm-refresh-state{font-size:11px;opacity:.6;margin-left:auto}
.dlm-item-meta{display:flex;flex-direction:column;gap:1px;margin-left:auto;flex:none;align-items:flex-end}
`;
      document.head.appendChild(s);
    }

    // ---- panel component --------------------------------------------------
    function Panel(props) {
      const [state, setState] = React.useState({ phase: 'loading', providers: [], file: '', error: '' });
      const [draft, setDraft] = React.useState({});      // provider -> Set(ids)
      const [collapsed, setCollapsed] = React.useState({});
      const [msg, setMsg] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [dirty, setDirty] = React.useState(false);
      // provider -> { added:Set, removed:Set, live:[{id,name}], at:number } | { error }
      const [fresh, setFresh] = React.useState({});
      const [refreshing, setRefreshing] = React.useState({});
      const t = T[lang()];

      const load = React.useCallback(async () => {
        setState((s) => ({ ...s, phase: 'loading', error: '' }));
        const r = await api({ op: 'read' });
        if (!r.ok) {
          setState({ phase: 'error', providers: [], file: r.file || '', error: r.error || 'unknown' });
          return;
        }
        const d = {};
        for (const p of r.providers) d[p.name] = new Set(p.models.map((m) => m.id));
        setDraft(d);
        setState({ phase: 'ready', providers: r.providers, file: r.file, error: '' });
        setDirty(false);
        setMsg(null);
      }, []);

      React.useEffect(() => { injectCss(); load(); }, [load]);

      const toggle = (prov, id) => {
        setDraft((d) => {
          const next = { ...d };
          const s = new Set(next[prov] || []);
          if (s.has(id)) s.delete(id); else s.add(id);
          next[prov] = s;
          return next;
        });
        setDirty(true);
        setMsg(null);
      };

      const bulk = (prov, mode, allIds) => {
        setDraft((d) => {
          const next = { ...d };
          if (mode === 'all') next[prov] = new Set(allIds);
          else if (mode === 'none') next[prov] = new Set();
          else if (mode === 'free') next[prov] = new Set(allIds.filter((x) => /free/i.test(x)));
          return next;
        });
        setDirty(true);
        setMsg(null);
      };

      const save = async (prov, orderedIds) => {
        setBusy(true);
        setMsg(null);
        const r = await api({ op: 'write', provider: prov, ids: orderedIds });
        setBusy(false);
        if (!r.ok) { setMsg({ kind: 'err', text: t.failed + (r.error || '') }); return; }
        setMsg({ kind: 'ok', text: t.saved + ' · ' + prov + ' (' + r.count + ') — ' + t.restart + (r.backup ? '  ' + t.backupAt + r.backup.split(/[\\/]/).pop() : '') });
        setDirty(false);
        await load();
      };

      // ---- refresh: pull the live catalog and only MARK differences ----
      const applyRefresh = (prov, r) => {
        if (!r || r.ok !== true) {
          // Keep the diagnostic detail: a bare "HTTP 400" cannot be acted on,
          // while code/cause/apiKeySource pinpoint which layer refused.
          const d = r && r.diag;
          const detail = d
            ? [r.error, 'code=' + (d.code || '-'), 'cause=' + (d.causeMessage || '-'), 'api=' + (d.api || '-'), 'key=' + (d.apiKeySource || '-')].join(' | ')
            : ((r && r.error) || 'unknown');
          setFresh((f) => ({ ...f, [prov]: { error: detail } }));
          return;
        }
        const res = r.result || {};
        setFresh((f) => ({
          ...f,
          [prov]: {
            added: new Set(res.added || []),
            removed: new Set(res.removed || []),
            live: res.live || [],
            at: Date.now(),
          },
        }));
      };

      const refreshOne = async (prov) => {
        setRefreshing((x) => ({ ...x, [prov]: true }));
        setMsg(null);
        try {
          const r = await api({ op: 'refresh', provider: prov });
          applyRefresh(prov, r);
        } catch (err) {
          setFresh((f) => ({ ...f, [prov]: { error: String(err && err.message ? err.message : err) } }));
        } finally {
          setRefreshing((x) => ({ ...x, [prov]: false }));
        }
      };

      const refreshAll = async () => {
        setBusy(true);
        setRefreshing({});
        setMsg(null);
        try {
          const r = await api({ op: 'refreshAll' });
          if (!r.ok) { setMsg({ kind: 'err', text: t.refreshFail + (r.error || '') }); return; }
          const next = {};
          for (const item of r.results || []) {
            if (item.ok) {
              const res = item.result || {};
              next[item.provider] = {
                added: new Set(res.added || []),
                removed: new Set(res.removed || []),
                live: res.live || [],
                at: Date.now(),
              };
            } else {
              next[item.provider] = { error: item.error || 'unknown' };
            }
          }
          setFresh(next);
          const failedItems = (r.results || []).filter((x) => !x.ok);
          setMsg(failedItems.length
            ? { kind: 'err', text: t.refreshFail + failedItems.map((x) => x.provider + ' → ' + (x.error || 'unknown') + (x.diag ? ' [' + ['code=' + (x.diag.code || '-'), 'cause=' + (x.diag.causeMessage || '-'), 'api=' + (x.diag.sentApi || '-'), 'key=' + (x.diag.apiKeySource || '-')].join(' ') + ']' : '')).join('  ;  ') }
            : { kind: 'ok', text: t.refreshedAt + ' · ' + (r.results || []).length });
        } catch (err) {
          setMsg({ kind: 'err', text: t.refreshFail + String(err && err.message ? err.message : err) });
        } finally {
          setBusy(false);
        }
      };

      const close = () => {
        if (dirty && !window.confirm(t.confirmDiscard)) return;
        props.onClose();
      };

      return h('div', { className: 'dlm-overlay', onClick: (e) => { if (e.target === e.currentTarget) close(); } },
        h('div', { className: 'dlm-modal' },
          h('div', { className: 'dlm-head' },
            h('h2', null, t.title),
            h('span', { className: 'dlm-sub' }, t.subtitle),
            h('div', { className: 'dlm-spacer' }),
            dirty ? h('span', { className: 'dlm-dirty' }, t.dirty) : null,
            h('button', { className: 'dlm-btn', onClick: close }, t.close),
          ),
          h('div', { className: 'dlm-body' },
            state.phase === 'loading' ? h('p', { className: 'dlm-sub' }, t.loading) : null,
            state.phase === 'error'
              ? h('div', { className: 'dlm-msg err' }, state.error + (state.file ? '\n' + state.file : ''))
              : null,
            state.phase === 'ready'
              ? state.providers.map((p) => {
                  const sel = draft[p.name] || new Set();
                  const configuredIds = p.models.map((m) => m.id);
                  const isCollapsed = collapsed[p.name];
                  const f = fresh[p.name];
                  const isRefreshing = !!refreshing[p.name];
                  // After a refresh the live list drives the rows, so a lineup the
                  // platform added becomes selectable before it exists in the config.
                  const liveIds = f && f.live ? f.live.map((m) => m.id) : null;
                  const rowIds = liveIds
                    ? Array.from(new Set([...liveIds, ...configuredIds]))
                    : configuredIds;
                  const newSet = f && f.added ? f.added : null;
                  const goneSet = f && f.removed ? f.removed : null;
                  const liveById = f && f.live ? Object.fromEntries(f.live.map((m) => [m.id, m])) : {};
                  return h('div', { className: 'dlm-prov', key: p.name },
                    h('div', { className: 'dlm-prov-head', onClick: () => setCollapsed((c) => ({ ...c, [p.name]: !isCollapsed })) },
                      h('span', { className: 'dlm-prov-name' }, p.name),
                      h('span', { className: 'dlm-badge' }, sel.size + ' / ' + rowIds.length),
                      p.hasModels ? null : h('span', { className: 'dlm-badge warn' }, t.none),
                      newSet && newSet.size ? h('span', { className: 'dlm-badge ok' }, '+' + newSet.size + ' ' + t.addedBadge) : null,
                      goneSet && goneSet.size ? h('span', { className: 'dlm-badge gone' }, '-' + goneSet.size + ' ' + t.removedBadge) : null,
                      f && f.error ? h('span', { className: 'dlm-badge warn', title: String(f.error) }, t.refreshFail + String(f.error)) : null,
                      p.hasModels ? null : h('span', { className: 'dlm-sub' }, t.declaredHint),
                      h('div', { className: 'dlm-spacer' }),
                      h('button', { className: 'dlm-btn', onClick: (e) => { e.stopPropagation(); bulk(p.name, 'all', rowIds); } }, t.selectAll),
                      h('button', { className: 'dlm-btn', onClick: (e) => { e.stopPropagation(); bulk(p.name, 'none', rowIds); } }, t.selectNone),
                      h('button', { className: 'dlm-btn', onClick: (e) => { e.stopPropagation(); bulk(p.name, 'free', rowIds); } }, t.onlyFree),
                      h('button', {
                        className: 'dlm-btn',
                        disabled: busy || isRefreshing,
                        title: t.refreshHint,
                        onClick: (e) => { e.stopPropagation(); refreshOne(p.name); },
                      }, isRefreshing ? t.refreshing : t.refresh),
                      h('button', {
                        className: 'dlm-btn primary',
                        disabled: busy,
                        onClick: (e) => { e.stopPropagation(); save(p.name, rowIds.filter((id) => sel.has(id))); },
                      }, busy ? t.saving : t.save),
                    ),
                    isCollapsed ? null : h('div', { className: 'dlm-list' },
                      rowIds.length === 0
                        ? h('span', { className: 'dlm-sub' }, t.noneDeclared)
                        : rowIds.map((id) => {
                            const meta = p.models.find((m) => m.id === id) || liveById[id] || {};
                            const isNew = !!(newSet && newSet.has(id));
                            const isGone = !!(goneSet && goneSet.has(id));
                            const cls = 'dlm-item' + (isNew ? ' is-new' : '') + (isGone ? ' is-gone' : '');
                            return h('label', { className: cls, key: id },
                              h('input', {
                                type: 'checkbox',
                                checked: sel.has(id),
                                onChange: () => toggle(p.name, id),
                              }),
                              h('span', { className: 'dlm-id' }, id),
                              h('span', { className: 'dlm-item-meta' },
                                isNew ? h('span', { className: 'dlm-badge ok' }, t.addedBadge) : null,
                                isGone ? h('span', { className: 'dlm-badge gone' }, t.removedBadge) : null,
                                meta.contextWindow ? h('span', { className: 'dlm-meta' }, Math.round(meta.contextWindow / 1000) + 'k') : null,
                              ),
                            );
                          },
                        ),
                    ),
                  );
                })
              : null,
          ),
          h('div', { className: 'dlm-foot' },
            h('button', { className: 'dlm-btn', onClick: load, disabled: busy }, t.reload),
            h('button', { className: 'dlm-btn', onClick: refreshAll, disabled: busy || state.phase !== 'ready' }, busy ? t.refreshing : t.refreshAll),
            h('span', { className: 'dlm-sub' }, t.refreshHint),
            msg ? h('div', { className: 'dlm-msg ' + msg.kind }, msg.text) : null,
          ),
        ),
      );
    }

    // ---- settings entry button -------------------------------------------
    function EntryButton() {
      const [open, setOpen] = React.useState(false);
      const t = T[lang()];
      return h(React.Fragment, null,
        h('button', {
          className: 'dlm-btn',
          title: t.subtitle,
          onClick: () => { injectCss(); setOpen(true); },
        }, t.open),
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action',
  id: '@dsh-external/dsh-lineup-manager',
          order: 10,
        }, EntryButton));
      },
    };
  },
});
