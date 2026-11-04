/**
 * DSH Chrome Bridge — Client half.
 *
 * One right-Sidebar tab, "Chrome Bridge": live bridge status (listening,
 * connected extension), the guided install steps for the bundled Chrome
 * extension, and the effective domain approval lists. Reads state through
 * the Host remote `chromeBridge.status()` and refreshes on
 * "chrome-bridge/changed" (plus a slow poll as a safety net).
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ID = 'dsh-chrome-bridge';
    const NAMESPACE = 'chromeBridgeSidebar';

    const zh = {
      'title': 'Chrome 桥接',
      'guide.description': '查看桥接状态、安装 Chrome 扩展、管理域名授权。',
      'state.loading': '读取状态中…',
      'state.connected': '已连接',
      'state.waiting': '等待扩展连接',
      'state.notListening': '桥接服务未监听',
      'card.endpoint': '端点',
      'card.extension': '扩展',
      'card.pending': '在途命令',
      'card.startError': '启动错误',
      'install.heading': '安装 Chrome 扩展',
      'install.step1': '在 Chrome 打开 chrome://extensions，开启右上角「开发者模式」。',
      'install.step2': '点击「加载已解压的扩展程序」，选择下面的目录：',
      'install.step3': '点扩展图标，确认显示 Connected to DSH（端口一致，默认 8765）。',
      'install.step4': '回到对话，让 Agent 使用 chrome_* 工具；首次接触域名时会征求你的批准。',
      'install.copy': '复制路径',
      'install.copied': '已复制',
      'domains.heading': '域名授权',
      'domains.allowed': '始终允许',
      'domains.blocked': '拒绝',
      'domains.none': '（空）',
      'domains.note': '「始终允许」的域名会持久保存；会话内允许只对当前会话生效。',
      'error.load': '读取桥接状态失败',
    };
    const en = {
      'title': 'Chrome Bridge',
      'guide.description': 'See bridge status, install the Chrome extension, and review domain approvals.',
      'state.loading': 'Reading status…',
      'state.connected': 'Connected',
      'state.waiting': 'Waiting for the extension',
      'state.notListening': 'Bridge server not listening',
      'card.endpoint': 'Endpoint',
      'card.extension': 'Extension',
      'card.pending': 'Pending commands',
      'card.startError': 'Start error',
      'install.heading': 'Install the Chrome extension',
      'install.step1': 'Open chrome://extensions in Chrome and enable Developer mode.',
      'install.step2': 'Click "Load unpacked" and select this directory:',
      'install.step3': 'Open the extension popup and confirm it shows Connected to DSH (same port, 8765 by default).',
      'install.step4': 'Back in the conversation, let the agent use the chrome_* tools; it asks before touching a new domain.',
      'install.copy': 'Copy path',
      'install.copied': 'Copied',
      'domains.heading': 'Domain approvals',
      'domains.allowed': 'Always allowed',
      'domains.blocked': 'Blocked',
      'domains.none': '(none)',
      'domains.note': '"Always allow" persists; per-session approval lasts for the current session only.',
      'error.load': 'Failed to read the bridge status',
    };

    const card = {
      background: 'var(--dsw-alias-bg-base, #fff)',
      border: '1px solid var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.12))',
      borderRadius: 8,
      padding: '10px 12px',
      marginBottom: 10,
    };
    const label = { margin: 0, fontSize: 12, lineHeight: 1.6 };

    function CopyButton({ text, t }) {
      const [copied, setCopied] = useState(false);
      const onClick = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }, [text]);
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            font: 'inherit',
            fontSize: 12,
            padding: '3px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary, inherit)',
            background: 'var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.06))',
            border: '1px solid var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.12))',
          },
        },
        copied ? t('install.copied') : t('install.copy')
      );
    }

    function Row({ k, v }) {
      return h('p', { style: label }, [
        h('span', { key: 'k', style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, `${k}: `),
        h('span', { key: 'v' }, v),
      ]);
    }

    function StateChip({ state, t }) {
      const color =
        state === 'connected'
          ? 'var(--dsw-alias-state-business-primary, #1a73e8)'
          : state === 'notListening' || state === 'error'
            ? 'var(--dsw-alias-state-error-primary, #d93025)'
            : 'var(--dsw-alias-label-tertiary, #888)';
      const text =
        state === 'connected'
          ? t('state.connected')
          : state === 'notListening'
            ? t('state.notListening')
            : state === 'loading'
              ? t('state.loading')
              : t('state.waiting');
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color,
          },
        },
        h('span', { style: { width: 8, height: 8, borderRadius: 4, background: color } }),
        text
      );
    }

    function InstallGuide({ status, t }) {
      const dir = status.extensionDir ?? '';
      return h('div', { style: card }, [
        h('h3', { key: 'h', style: { margin: '0 0 8px', fontSize: 13 } }, t('install.heading')),
        h('ol', { key: 'steps', style: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 } }, [
          h('li', { key: '1' }, t('install.step1')),
          h('li', { key: '2' }, [
            t('install.step2'),
            h(
              'div',
              {
                key: 'path',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 4,
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                  wordBreak: 'break-all',
                  background: 'var(--dsw-alias-bg-layer-1, rgba(15, 23, 42, 0.04))',
                  borderRadius: 6,
                  padding: '4px 8px',
                },
              },
              [h('code', { key: 'c' }, dir), dir ? h(CopyButton, { key: 'b', text: dir, t }) : null]
            ),
          ]),
          h('li', { key: '3' }, t('install.step3')),
          h('li', { key: '4' }, t('install.step4')),
        ]),
      ]);
    }

    function DomainList({ title, domains, t }) {
      return h('div', { key: title, style: { marginBottom: 6 } }, [
        h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12 } }, `${title}: `),
        h(
          'span',
          { style: { fontSize: 12 } },
          domains.length > 0 ? domains.join(', ') : t('domains.none')
        ),
      ]);
    }

    function Body(props) {
      const t = props.t;
      const [status, setStatus] = useState(undefined);
      const [error, setError] = useState(null);

      const refresh = useCallback(async () => {
        try {
          setStatus(await props.loadStatus());
          setError(null);
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }, [props.loadStatus]);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 5000);
        let unsubscribe = null;
        if (typeof props.subscribe === 'function') {
          try {
            unsubscribe = props.subscribe(() => refresh());
          } catch {
            /* events unavailable; the poll covers refreshes */
          }
        }
        return () => {
          clearInterval(timer);
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe();
            } catch {
              /* already gone */
            }
          }
        };
      }, [refresh]);

      if (error !== null) {
        return h('div', { style: { padding: 12, fontSize: 12 } }, [
          h('p', { style: label, key: 'e' }, `${t('error.load')}: ${error}`),
        ]);
      }
      if (status === undefined) {
        return h('div', { style: { padding: 12 } }, h(StateChip, { state: 'loading', t }));
      }

      const state = status.listening === false ? 'notListening' : status.connected ? 'connected' : 'waiting';
      return h('div', { style: { padding: 12, overflowY: 'auto', height: '100%', boxSizing: 'border-box' } }, [
        h('div', { key: 'status', style: card }, [
          h(StateChip, { key: 'chip', state, t }),
          h(Row, { key: 'endpoint', k: t('card.endpoint'), v: `ws://${status.host}:${status.port}` }),
          status.extension
            ? h(Row, {
                key: 'ext',
                k: t('card.extension'),
                v: `${status.extension.name} ${status.extension.version}`,
              })
            : null,
          status.pendingCommands > 0
            ? h(Row, { key: 'pending', k: t('card.pending'), v: String(status.pendingCommands) })
            : null,
          status.startError ? h(Row, { key: 'err', k: t('card.startError'), v: status.startError }) : null,
        ]),
        status.connected ? null : h(InstallGuide, { key: 'guide', status, t }),
        h('div', { key: 'domains', style: card }, [
          h('h3', { key: 'h', style: { margin: '0 0 8px', fontSize: 13 } }, t('domains.heading')),
          h(DomainList, {
            key: 'allowed',
            title: t('domains.allowed'),
            domains: status.allowedDomains ?? [],
            t,
          }),
          h(DomainList, {
            key: 'blocked',
            title: t('domains.blocked'),
            domains: status.blockedDomains ?? [],
            t,
          }),
          h('p', {
            key: 'note',
            style: { ...label, color: 'var(--dsw-alias-label-tertiary, #888)', marginTop: 8 },
          }, t('domains.note')),
        ]),
      ]);
    }

    function Title(props) {
      return h('span', null, (props.t ? props.t('title') : 'Chrome Bridge'));
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'remote'],
      apply(ctx) {
        const t = ctx.locale.bind(NAMESPACE);
        ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'chrome-bridge.locale');
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: ID,
              kind: 'chrome-bridge',
              multiple: false,
              title: () => t('title'),
              guide: [
                {
                  id: 'open',
                  order: 40,
                  title: () => t('title'),
                  description: () => t('guide.description'),
                },
              ],
            }),
          'chrome-bridge.tab'
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: ID,
                  locale: NAMESPACE,
                  inject: () => ({
                    t,
                    loadStatus: () => {
                      const namespace = ctx.remote && ctx.remote.chromeBridge;
                      if (namespace === undefined || typeof namespace.status !== 'function') {
                        throw new Error('the chromeBridge remote is not available yet');
                      }
                      return namespace.status();
                    },
                    subscribe: (listener) => {
                      ctx.remote.$on('chrome-bridge/changed', listener);
                      return () => {
                        try {
                          ctx.remote.$off('chrome-bridge/changed', listener);
                        } catch {
                          /* $off unavailable; the listener is harmless */
                        }
                      };
                    },
                  }),
                },
                Body
              )
            ),
          'chrome-bridge.body'
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: ID,
                  locale: NAMESPACE,
                  inject: () => ({ t }),
                },
                Title
              )
            ),
          'chrome-bridge.title'
        );
      },
    };
  },
});
