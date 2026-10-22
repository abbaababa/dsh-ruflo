/**
 * dsh-ruflo Client 半身：Web 左侧「Ruflo」面板 + 主区状态页。
 *
 * 数据来自 Host 注册的 GET /dsh-ruflo/status（同一套 Connection 鉴权），
 * 页面每 15 秒自动刷新，也可手动点「刷新」。
 *
 * 约束（来自 DSH Client 插件规范）：
 *   - 只 require('react')，不加载任何 Host Client 包；
 *   - 颜色只用 --dsw-alias-* token，保证明暗主题一致；
 *   - 资源（样式、槽位）都包在 ctx.effect / slots.inject 里，卸载即清理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ruflo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-ruflo';
    const PANEL_ID = 'ruflo';
    const CSS_ID = 'dsh-ruflo/client.css';
    const STATUS_URL = '/dsh-ruflo/status';
    const REFRESH_MS = 15_000;

    const LOCALE = {
      zh: {
        'panel': 'Ruflo 状态',
        'title': 'Ruflo 状态',
        'subtitle': '官方 Ruflo 多智能体编排运行时 · 与本机 DSH 的实时连接情况',
        'refresh': '刷新',
        'refreshing': '刷新中…',
        'loading': '正在读取 Ruflo 状态…',
        'error.title': '读取失败',
        'error.unauthorized': '没有权限读取状态，请从 DSH 页面打开后重试',
        'error.http': '状态接口返回 HTTP {status}',
        'retry': '重试',
        'card.mcp': 'MCP 工具',
        'card.mcpHint': 'mcp__ruflo__*',
        'card.cli': 'CLI 版本',
        'card.plugin': '插件版本',
        'card.pluginHint': 'dsh-ruflo · 已安装 v{version}',
        'card.cwd': '工作目录',
        'status.connected': '已连接',
        'status.disconnected': '未连接',
        'status.degraded': 'CLI 异常',
        'reload.title': '插件已更新，等待重载',
        'reload.body':
          '磁盘上是 v{installed}，当前进程仍运行 v{running}。重启 dsh web，或在插件页把 dsh-ruflo-plugin 行关掉再打开。',
        'families.title': '工具家族',
        'families.hint': '按工具名前缀统计，共 {count} 个工具',
        'families.empty': '尚未发现 mcp__ruflo__* 工具',
        'footer': '最近检查 {time} · 每 15 秒自动刷新',
        'hint': '在对话里用 ruflo_status / ruflo_cli，或输入 /ruflo 执行命令。',
        'stale': '当前显示的是上一次成功结果',
      },
      en: {
        'panel': 'Ruflo Status',
        'title': 'Ruflo Status',
        'subtitle': 'Official Ruflo orchestration runtime · live connection state for this DSH',
        'refresh': 'Refresh',
        'refreshing': 'Refreshing…',
        'loading': 'Reading Ruflo status…',
        'error.title': 'Could not read status',
        'error.unauthorized': 'Not authorized to read status; open this from the DSH page and retry',
        'error.http': 'Status endpoint returned HTTP {status}',
        'retry': 'Retry',
        'card.mcp': 'MCP tools',
        'card.mcpHint': 'mcp__ruflo__*',
        'card.cli': 'CLI version',
        'card.plugin': 'Plugin version',
        'card.pluginHint': 'dsh-ruflo · installed v{version}',
        'card.cwd': 'Working directory',
        'status.connected': 'Connected',
        'status.disconnected': 'Disconnected',
        'status.degraded': 'CLI error',
        'reload.title': 'Plugin updated, reload pending',
        'reload.body':
          'Disk has v{installed}, the running process still uses v{running}. Restart dsh web, or toggle the dsh-ruflo-plugin row off and on.',
        'families.title': 'Tool families',
        'families.hint': '{count} tools, grouped by name prefix',
        'families.empty': 'No mcp__ruflo__* tools found yet',
        'footer': 'Checked {time} · refreshes every 15s',
        'hint': 'Use ruflo_status / ruflo_cli in chat, or type /ruflo to run a command.',
        'stale': 'Showing the last successful result',
      },
    };

    const CSS = `
.dsh-ruflo-page{height:100%;overflow:auto;box-sizing:border-box;padding:28px 32px 48px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
.dsh-ruflo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px}
.dsh-ruflo-heading{min-width:0}
.dsh-ruflo-title{margin:0;font-size:22px;font-weight:650;line-height:1.3;letter-spacing:-.01em}
.dsh-ruflo-subtitle{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}
.dsh-ruflo-actions{display:flex;align-items:center;gap:10px;flex:none;padding-top:2px}
.dsh-ruflo-pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dsh-ruflo-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsh-ruflo-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dsh-ruflo-dot-bad{background:var(--dsw-alias-state-error-primary)}
.dsh-ruflo-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.dsh-ruflo-btn{appearance:none;font:inherit;font-size:13px;height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:background .16s,color .16s,border-color .16s}
.dsh-ruflo-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-ruflo-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ruflo-btn:disabled{opacity:.45;cursor:default}
.dsh-ruflo-banner{display:flex;align-items:flex-start;gap:10px;margin:0 0 16px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-ruflo-banner strong{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-ruflo-banner-actions{margin-left:auto;flex:none}
.dsh-ruflo-banner-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.dsh-ruflo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.dsh-ruflo-card{min-width:0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-ruflo-card-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4}
.dsh-ruflo-card-value{margin:8px 0 0;font-size:22px;font-weight:620;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ruflo-card-value-sm{font-size:15px;font-weight:560;line-height:1.4;white-space:normal;overflow-wrap:anywhere}
.dsh-ruflo-card-hint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ruflo-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.dsh-ruflo-section{margin-top:24px}
.dsh-ruflo-section-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-ruflo-section-hint{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-ruflo-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dsh-ruflo-chip{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ruflo-chip b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dsh-ruflo-empty{margin-top:12px;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-ruflo-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:26px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ruflo-loading{display:flex;align-items:center;gap:10px;padding:34px 4px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-ruflo-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-ruflo-spin .8s linear infinite;flex:none}
@keyframes dsh-ruflo-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){.dsh-ruflo-page{padding:20px 16px 40px}.dsh-ruflo-head{flex-direction:column}.dsh-ruflo-actions{padding-top:0}}
`;

    function injectStyles() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.querySelector(`style[data-plugin-css='${CSS_ID}']`);
      if (existing) return () => {};
      const style = document.createElement('style');
      style.dataset.plugin = NS;
      style.dataset.pluginCss = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => style.remove();
    }

    /** 侧栏图标：六边形节点，与插件封面同构。 */
    function RufloPanelIcon({ size }) {
      const edge = Number.isFinite(size) ? size : 18;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 3.1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12, cy: 3.6, r: 1.7 }),
        h('circle', { cx: 19.3, cy: 7.8, r: 1.7 }),
        h('circle', { cx: 19.3, cy: 16.2, r: 1.7 }),
        h('circle', { cx: 12, cy: 20.4, r: 1.7 }),
        h('circle', { cx: 4.7, cy: 16.2, r: 1.7 }),
        h('circle', { cx: 4.7, cy: 7.8, r: 1.7 }),
        h('path', { d: 'M12 5.3v3.6M14.6 9.3l3-1.5M14.6 14.7l3 1.5M12 15.4v3.6M9.4 14.7l-3 1.5M9.4 9.3l-3-1.5' }),
      );
    }

    function Card(props) {
      return h(
        'div',
        { className: 'dsh-ruflo-card' },
        h(
          'div',
          { className: 'dsh-ruflo-card-label' },
          h('span', null, props.label),
          props.badge ?? null,
        ),
        h(
          'p',
          { className: props.small ? 'dsh-ruflo-card-value dsh-ruflo-card-value-sm' : 'dsh-ruflo-card-value' },
          props.value,
        ),
        props.hint ? h('p', { className: 'dsh-ruflo-card-hint' }, props.hint) : null,
      );
    }

    function RufloPage(props) {
      const t = props.t;
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' });
      const [busy, setBusy] = React.useState(false);
      const alive = React.useRef(true);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = React.useCallback(async () => {
        setBusy(true);
        try {
          const response = await fetch(STATUS_URL, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) {
            const message =
              response.status === 401 || response.status === 403
                ? t('error.unauthorized')
                : t('error.http', { status: response.status });
            if (alive.current) {
              setState((prev) => ({ phase: prev.data ? 'stale' : 'error', data: prev.data, error: message }));
            }
            return;
          }
          const data = await response.json();
          if (alive.current) setState({ phase: 'ready', data, error: '' });
        } catch (error) {
          if (alive.current) {
            setState((prev) => ({
              phase: prev.data ? 'stale' : 'error',
              data: prev.data,
              error: error?.message || String(error),
            }));
          }
        } finally {
          if (alive.current) setBusy(false);
        }
      }, [t]);

      React.useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), REFRESH_MS);
        return () => window.clearInterval(timer);
      }, [load]);

      const data = state.data;
      const connected = Boolean(data?.mcpConnected);
      const cliBad = Boolean(data) && data.cliOk === false;
      const pillTone = !data ? 'idle' : connected && !cliBad ? 'ok' : connected ? 'warn' : 'bad';
      const pillText = !data ? t('loading') : connected ? t('status.connected') : t('status.disconnected');
      const checked = data?.checkedAt ? new Date(data.checkedAt) : null;
      const checkedText = checked && !Number.isNaN(checked.getTime()) ? checked.toLocaleTimeString() : '—';

      const header = h(
        'div',
        { className: 'dsh-ruflo-head' },
        h(
          'div',
          { className: 'dsh-ruflo-heading' },
          h('h1', { className: 'dsh-ruflo-title' }, t('title')),
          h('p', { className: 'dsh-ruflo-subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'dsh-ruflo-actions' },
          h(
            'span',
            { className: 'dsh-ruflo-pill' },
            h('span', { className: `dsh-ruflo-dot dsh-ruflo-dot-${pillTone}` }),
            pillText,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ruflo-btn',
              onClick: () => void load(),
              disabled: busy,
            },
            busy ? t('refreshing') : t('refresh'),
          ),
        ),
      );

      if (!data && state.phase === 'loading') {
        return h(
          'div',
          { className: 'dsh-ruflo-page' },
          header,
          h(
            'div',
            { className: 'dsh-ruflo-loading' },
            h('span', { className: 'dsh-ruflo-spinner' }),
            t('loading'),
          ),
        );
      }

      const banner = state.error
        ? h(
            'div',
            { className: 'dsh-ruflo-banner', role: 'alert' },
            h(
              'div',
              null,
              h('strong', null, t('error.title')),
              h('div', null, state.error),
              state.phase === 'stale' ? h('div', null, t('stale')) : null,
            ),
            h(
              'div',
              { className: 'dsh-ruflo-banner-actions' },
              h(
                'button',
                { type: 'button', className: 'dsh-ruflo-btn', onClick: () => void load(), disabled: busy },
                t('retry'),
              ),
            ),
          )
        : null;

      const reloadBanner = data?.reloadRequired
        ? h(
            'div',
            { className: 'dsh-ruflo-banner dsh-ruflo-banner-warn', role: 'status' },
            h(
              'div',
              null,
              h('strong', null, t('reload.title')),
              h('div', null, t('reload.body', { installed: data.installedVersion, running: data.pluginVersion })),
            ),
          )
        : null;

      const families = Array.isArray(data?.families) ? data.families : [];
      const cards = h(
        'div',
        { className: 'dsh-ruflo-grid' },
        h(Card, {
          label: t('card.mcp'),
          value: data ? String(data.mcpTools) : '—',
          hint: t('card.mcpHint'),
          badge: h('span', { className: `dsh-ruflo-dot ${connected ? 'dsh-ruflo-dot-ok' : 'dsh-ruflo-dot-bad'}` }),
        }),
        h(Card, {
          label: t('card.cli'),
          value: data?.version ? String(data.version) : data?.cliOk === false ? t('status.degraded') : '—',
          hint: data?.cli ?? '',
          small: true,
        }),
        h(Card, {
          label: t('card.plugin'),
          value: data?.pluginVersion ? `v${data.pluginVersion}` : '—',
          hint: data?.installedVersion ? t('card.pluginHint', { version: data.installedVersion }) : 'dsh-ruflo',
        }),
        h(Card, {
          label: t('card.cwd'),
          value: h('span', { className: 'dsh-ruflo-mono' }, data?.cwd || '—'),
          small: true,
        }),
      );

      const familiesBlock = h(
        'section',
        { className: 'dsh-ruflo-section' },
        h('h2', { className: 'dsh-ruflo-section-title' }, t('families.title')),
        h('p', { className: 'dsh-ruflo-section-hint' }, t('families.hint', { count: data?.mcpTools ?? 0 })),
        families.length === 0
          ? h('div', { className: 'dsh-ruflo-empty' }, t('families.empty'))
          : h(
              'div',
              { className: 'dsh-ruflo-chips' },
              families.map((family) =>
                h(
                  'span',
                  { key: family.name, className: 'dsh-ruflo-chip' },
                  h('span', { className: 'dsh-ruflo-mono' }, family.name),
                  h('b', null, String(family.count)),
                ),
              ),
            ),
      );

      return h(
        'div',
        { className: 'dsh-ruflo-page' },
        header,
        banner,
        reloadBanner,
        cards,
        familiesBlock,
        h(
          'div',
          { className: 'dsh-ruflo-foot' },
          h('span', null, t('footer', { time: checkedText })),
          h('span', null, t('hint')),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(injectStyles);

        ctx.effect(() => {
          const disposeZh = ctx.locale.register(NS, 'zh', LOCALE.zh);
          const disposeEn = ctx.locale.register(NS, 'en', LOCALE.en);
          return () => {
            disposeZh();
            disposeEn();
          };
        });

        const t = ctx.locale.bind(NS);

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 5,
              label: () => t('panel'),
              locale: NS,
            },
            RufloPanelIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t }),
            },
            RufloPage,
          ),
        );
      },
    };
  },
});
