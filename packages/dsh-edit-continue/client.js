/**
 * Edit & continue — browser half.
 *
 * Two additive extensions over the shipped Chat UI, without replacing the
 * composer or the transcript:
 *
 * 1. The keyed `conversation.chat.node` renderer for `user` is shadowed at a
 *    lower priority by one that renders the same host content Factory plus a
 *    third action beside copy: Edit. Editing happens inline; saving forks the
 *    Session at the event immediately before that Turn and sends the edited
 *    text into the child, then navigates there. The source session is never
 *    rewritten, which is why the operation is a branch and not a mutation.
 *
 * 2. A triangle button in `conversation.input.activity` (the seat directly
 *    beside Send) appears when the latest Turn ended by a stop, a truncated
 *    output, or crash recovery, and no Turn is running. It sends one ordinary
 *    follow-up prompt asking the model to continue from the cut, using the same
 *    `session.prompt` path as Send.
 *
 * Everything visible is theme-token styled and localized through the Client
 * locale service. No host runtime module is imported; the only dependency is
 * the platform React instance.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-edit-continue',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'edit-continue'

    const zh = {
      'edit.action': '编辑并重发',
      'edit.cancel': '取消',
      'edit.resend': '发送',
      'edit.sending': '发送中…',
      'edit.copy': '复制',
      'edit.copied': '已复制',
      'edit.attachmentsNote': '原消息中的附件不会随编辑重发，只会发送编辑后的文本。',
      'edit.failed': '重发失败：',
      'edit.unavailable.running': '本轮正在运行，停止后才能编辑',
      'edit.unavailable.subagent': '子会话的消息暂不支持编辑',
      'edit.unavailable.window': '这条消息所在轮次的开头不在当前加载的历史窗口中',
      'edit.unavailable.empty': '这条消息没有可编辑的文本',
      'continue.action': '继续生成',
      'continue.prompt': '继续（从上次中断的地方接着输出，不要重复已经写过的内容）',
    }

    const en = {
      'edit.action': 'Edit and resend',
      'edit.cancel': 'Cancel',
      'edit.resend': 'Send',
      'edit.sending': 'Sending…',
      'edit.copy': 'Copy',
      'edit.copied': 'Copied',
      'edit.attachmentsNote': 'Attachments from the original message are not resent; only the edited text is sent.',
      'edit.failed': 'Resend failed: ',
      'edit.unavailable.running': 'This turn is running; stop it before editing',
      'edit.unavailable.subagent': 'Messages in subagent sessions cannot be edited yet',
      'edit.unavailable.window': 'The start of this turn is outside the loaded history window',
      'edit.unavailable.empty': 'This message has no editable text',
      'continue.action': 'Continue generating',
      'continue.prompt': 'Continue from where you left off. Do not repeat text already written.',
    }

    /**
     * Synthetic continue prompts, in every shipped language. The message must
     * reach the model, but it is not something the user wrote, so the user
     * renderer hides exactly these texts instead of drawing a bubble. Matching
     * the text (rather than a client-side id) survives reload, and covering
     * both dictionaries survives a UI-language switch after the fact.
     */
    const CONTINUE_PROMPTS = [zh['continue.prompt'], en['continue.prompt']]

    const STYLES = `.dec-userRow{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}
.dec-actions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}
.dec-time{padding-right:12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dec-action{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dec-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.dec-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dec-action[data-unavailable]{cursor:default;opacity:.4}
.dec-action[data-unavailable]:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.dec-edit{display:flex;flex-direction:column;gap:8px;width:min(calc(var(--dsh-chat-content-width,748px) * 0.78),92%);align-items:stretch}
.dec-textarea{box-sizing:border-box;width:100%;min-height:76px;max-height:320px;resize:vertical;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);outline:none;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;word-break:break-word}
.dec-textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.dec-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dec-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dec-editActions{display:flex;justify-content:flex-end;gap:8px}
.dec-secondary{height:28px;padding:0 12px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
.dec-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dec-primary{height:28px;padding:0 14px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-info-fill);color:#fff;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}
.dec-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.dec-primary:disabled,.dec-secondary:disabled{opacity:.4;cursor:default}
.dec-continue{display:grid;place-items:center;flex:none;width:34px;height:34px;border:none;border-radius:999px;corner-shape:round;background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer;transform:translateY(-2px);transition:background-color 100ms ease}
.dec-continue:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dec-continue:disabled{opacity:.5;cursor:default}
.dec-continue svg{width:14px;height:14px}
.dec-pending{width:10px;height:10px;border-radius:50%;corner-shape:round;background:currentColor;animation:dec-pending 700ms ease-in-out infinite alternate}
@keyframes dec-pending{from{opacity:.3}to{opacity:1}}
@media (hover:hover){
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]) .dec-actions{opacity:0;transition:opacity 80ms ease}
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]):hover .dec-actions,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]):focus-within .dec-actions{opacity:1}
}
@media (prefers-reduced-motion:reduce){
  .dec-continue{transition:none}
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]) .dec-actions{transition:none}
}
`

    function installStyles() {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', '@local/dsh-edit-continue')
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    function IconCopy() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        h('rect', { x: 1.52, y: 4.07, width: 10.39, height: 10.39, rx: 2, stroke: 'currentColor' }),
        h('path', {
          d: 'M11.98 1.53c1.38 0 2.5 1.12 2.5 2.5v5.4c0 .95-.53 1.77-1.3 2.19v-1.29c.19-.25.3-.56.3-.9v-5.4c0-.83-.67-1.5-1.5-1.5H6.58c-.3 0-.58.09-.82.25H4.42c.43-.75 1.24-1.25 2.16-1.25h5.4Z',
          fill: 'currentColor',
        }),
      )
    }

    function IconCheck() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', { d: 'M2.25 8.5 5.5 11.75a1 1 0 0 0 1.45-.05L13.75 4', stroke: 'currentColor' }),
      )
    }

    function IconEdit() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', strokeWidth: 1 },
        h('path', {
          d: 'M8.86 2.7H4.2A1.5 1.5 0 0 0 2.7 4.2v7.6a1.5 1.5 0 0 0 1.5 1.5h7.6a1.5 1.5 0 0 0 1.5-1.5V7.9h1v3.9a2.5 2.5 0 0 1-2.5 2.5H4.2a2.5 2.5 0 0 1-2.5-2.5V4.2a2.5 2.5 0 0 1 2.5-2.5h4.66v1Z',
          fill: 'currentColor',
        }),
        h('path', { d: 'm7.78 8.24 6.1-6.1', stroke: 'currentColor' }),
      )
    }

    function IconTriangle() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5.2 3.4 12.2 8l-7 4.6Z',
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
        }),
      )
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function clockOf(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return ''
      const date = new Date(time)
      const now = new Date()
      const clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()) return clock
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock
    }

    async function writeClipboard(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the selection fallback */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    function contentParts(content) {
      const texts = []
      const attachments = []
      const rest = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block && block.type === 'image' && block.attachment !== undefined) {
          attachments.push({ type: 'image', image: { attachment: block.attachment } })
        } else if (block && block.type === 'file' && block.attachment !== undefined) {
          attachments.push({ type: 'file', file: block.attachment })
        } else rest.push(block)
      }
      return { text: texts.join(''), attachments, rest }
    }

    function errorText(caught) {
      if (typeof caught === 'string') return caught
      if (caught && typeof caught.message === 'string' && caught.message !== '') return caught.message
      return String(caught)
    }

    /**
     * Keyed `user` renderer: host content Factory plus copy / edit actions.
     * @param props - keyed Chat-node props, standard session props, and inject.
     */
    function UserMessageView(props) {
      const { node, renderFactorySlot, loadImage, t, useSession, useChat, editMessage } = props
      const data = node.data || {}
      const parts = useMemo(() => contentParts(data.content || []), [data.content])
      const content = useMemo(() => ({
        text: parts.text,
        attachments: parts.attachments,
        extraBlocks: parts.rest,
        ...(data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
      }), [parts, data.referenceLabels])
      const facts = useMemo(() => ({
        ...(data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
        ...(data.skillNames === undefined ? {} : { skillNames: data.skillNames }),
      }), [data.referenceLabels, data.skillNames])

      const running = useSession((snapshot) => snapshot.running) || false
      const subagent = useSession((snapshot) => snapshot.subagent) || null
      const location = node.location
      const turn = location && (location.kind === 'turn' || location.kind === 'step') ? location.turn : undefined
      const startSeq = turn && turn.start ? turn.start.seq : undefined
      // The durable user message is spliced into the turn-claim inbox BEFORE
      // turn/start, so a cut at `turn.start.seq - 1` would carry the original
      // message into the child and replay it. Cutting at the PREVIOUS turn's
      // end excludes the whole claim; the first turn has no such boundary, so
      // editing it starts a fresh Session instead.
      const turnNumber = turn && typeof turn.turn === 'number' ? turn.turn : undefined
      const previousEndSeq = useChat((snapshot) => {
        if (turnNumber === undefined || turnNumber <= 1) return undefined
        const previous = snapshot.timeline.turns.get(turnNumber - 1)
        const end = previous && previous.end ? previous.end.seq : undefined
        return typeof end === 'number' ? end : undefined
      })
      const text = parts.text

      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(text)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [copied, setCopied] = useState(false)
      const areaRef = useRef(null)
      const copyTimer = useRef(null)
      const copyEpoch = useRef(0)
      const busyRef = useRef(false)
      busyRef.current = busy

      useEffect(() => () => {
        copyEpoch.current += 1
        if (copyTimer.current !== null) {
          window.clearTimeout(copyTimer.current)
          copyTimer.current = null
        }
      }, [])

      useEffect(() => {
        if (!editing) return
        const area = areaRef.current
        if (area === null) return
        area.focus()
        const end = area.value.length
        try { area.setSelectionRange(end, end) } catch { /* selection is best-effort */ }
      }, [editing])

      const onCopy = useCallback(() => {
        if (copied || text === '') return
        const epoch = copyEpoch.current
        void writeClipboard(text).then((ok) => {
          if (!ok || epoch !== copyEpoch.current) return
          setCopied(true)
          copyTimer.current = window.setTimeout(() => {
            copyTimer.current = null
            setCopied(false)
          }, 1000)
        })
      }, [copied, text])

      const forkBoundary = turnNumber === undefined || turnNumber <= 1 ? undefined : previousEndSeq
      const firstTurn = turnNumber === 1
      const canEdit = typeof startSeq === 'number' && !running && subagent === null && text.trim() !== ''
        && (firstTurn || typeof forkBoundary === 'number')
      let editHint = t('edit.action')
      if (running) editHint = t('edit.unavailable.running')
      else if (subagent !== null) editHint = t('edit.unavailable.subagent')
      else if (typeof startSeq !== 'number' || (!firstTurn && typeof forkBoundary !== 'number')) {
        editHint = t('edit.unavailable.window')
      } else if (text.trim() === '') editHint = t('edit.unavailable.empty')

      const openEditor = () => {
        if (!canEdit) return
        setDraft(text)
        setError(null)
        setEditing(true)
      }
      const closeEditor = () => {
        if (busyRef.current) return
        setEditing(false)
        setError(null)
      }
      const save = async () => {
        if (busyRef.current || draft.trim() === '' || !canEdit) return
        setBusy(true)
        setError(null)
        try {
          await editMessage(firstTurn
            ? { freshSession: true, text: draft }
            : { atSeq: forkBoundary, text: draft })
        } catch (caught) {
          setError(t('edit.failed') + errorText(caught))
          setBusy(false)
        }
      }
      const onEditorKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeEditor()
          return
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          void save()
        }
      }

      // The Continue seat's instruction is synthetic: it must reach the model,
      // but it is not a user message, so it renders nothing. All hooks above
      // have already run, so returning null here is order-safe.
      if (text.trim() !== '' && CONTINUE_PROMPTS.includes(text.trim())) return null

      if (editing) {
        return h('div', { className: 'dec-userRow' },
          h('div', { className: 'dec-edit' },
            h('textarea', {
              ref: areaRef,
              className: 'dec-textarea',
              value: draft,
              rows: Math.min(12, Math.max(2, draft.split('\n').length)),
              'aria-label': t('edit.action'),
              disabled: busy,
              onChange: (event) => { setDraft(event.target.value) },
              onKeyDown: onEditorKeyDown,
            }),
            parts.attachments.length > 0 ? h('div', { className: 'dec-note' }, t('edit.attachmentsNote')) : null,
            error === null ? null : h('div', { className: 'dec-error', role: 'alert' }, error),
            h('div', { className: 'dec-editActions' },
              h('button', {
                type: 'button',
                className: 'dec-secondary',
                disabled: busy,
                onClick: closeEditor,
              }, t('edit.cancel')),
              h('button', {
                type: 'button',
                className: 'dec-primary',
                disabled: busy || draft.trim() === '',
                onClick: () => { void save() },
              }, busy ? t('edit.sending') : t('edit.resend')),
            ),
          ),
        )
      }

      const contentNode = typeof renderFactorySlot === 'function'
        ? renderFactorySlot('conversation.chat.user.content', {
          content,
          loadImage,
          facts,
          interactive: true,
        })
        : h('div', null, text)

      return h('div', { className: 'dec-userRow' },
        contentNode,
        h('div', { className: 'dec-actions' },
          clockOf(data.time) === '' ? null : h('span', { className: 'dec-time' }, clockOf(data.time)),
          h('button', {
            type: 'button',
            className: 'dec-action',
            title: copied ? t('edit.copied') : t('edit.copy'),
            'aria-label': copied ? t('edit.copied') : t('edit.copy'),
            onClick: onCopy,
          }, copied ? h(IconCheck) : h(IconCopy)),
          h('button', {
            type: 'button',
            className: 'dec-action',
            title: editHint,
            'aria-label': t('edit.action'),
            'aria-disabled': canEdit ? undefined : true,
            'data-unavailable': canEdit ? undefined : true,
            onClick: canEdit ? openEditor : undefined,
          }, h(IconEdit)),
        ),
      )
    }

    /**
     * Triangle Continue seat: visible only for the idle tail of a stopped,
     * truncated, or crash-closed Turn.
     * @param props - session standard props, locale seat, and inject.
     */
    function ContinueButton(props) {
      const { t, useSession, useChat, continueTurn } = props
      const running = useSession((snapshot) => snapshot.running) || false
      const removed = useSession((snapshot) => snapshot.removed) || false
      const subagent = useSession((snapshot) => snapshot.subagent) || null
      const ended = useChat((snapshot) => {
        const order = snapshot.timeline.turnOrder
        if (order.length === 0) return undefined
        const turn = snapshot.timeline.turns.get(order[order.length - 1])
        const reason = turn && turn.end ? turn.end.data.reason : undefined
        const kind = reason ? reason.kind : undefined
        return kind === 'aborted' || kind === 'max-tokens' || kind === 'interrupted' ? kind : undefined
      })
      const [busy, setBusy] = useState(false)
      if (running || removed || subagent !== null || ended === undefined) return null
      const click = async () => {
        if (busy) return
        setBusy(true)
        try {
          await continueTurn(t('continue.prompt'))
        } catch (caught) {
          console.warn('[edit-continue] continue failed:', caught)
        } finally {
          setBusy(false)
        }
      }
      return h('button', {
        type: 'button',
        className: 'dec-continue',
        title: t('continue.action'),
        'aria-label': t('continue.action'),
        disabled: busy,
        onClick: () => { void click() },
      }, busy ? h('span', { className: 'dec-pending' }) : h(IconTriangle))
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'edit-continue: locale dictionaries',
      )
      ctx.effect(() => installStyles(), 'edit-continue: styles')

      const openSession = (sessionId) => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace !== undefined && typeof workspace.openSession === 'function') {
          workspace.openSession(sessionId)
        }
      }

      const resendEdited = async (sessionId, request) => {
        let targetId
        if (request.freshSession === true) {
          // Editing the first turn: there is no earlier boundary, and cutting
          // before turn/start would replay the original message from the claim
          // splice. A fresh Session in the same Workspace is the clean equivalent.
          const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
          const options = {}
          if (summary !== undefined && typeof summary.cwd === 'string' && summary.cwd !== '') options.cwd = summary.cwd
          const preset = summary === undefined || summary.projectionValues === undefined
            ? undefined
            : summary.projectionValues.agentPreset
          if (typeof preset === 'string' && preset !== '') options.agentPreset = preset
          targetId = await ctx.sessions.create(options)
        } else {
          targetId = await ctx.sessions.fork({
            sessionId,
            atSeq: request.atSeq,
            increaseTitle: true,
          })
        }
        // Navigate first so a failed prompt reports in the target's own composer;
        // the reference below is the same shared Session generation the view uses.
        openSession(targetId)
        await ctx.sessions.using(targetId, { source: 'gateway' }, async (reference) => {
          const binding = await reference.ready
          const result = await binding.session.prompt([{ type: 'text', text: request.text }], 'queue')
          if (!result.ok) {
            throw new Error(result.error.message + ' (' + result.error.code + ')')
          }
        })
        return targetId
      }

      const continueTurn = async (sessionId, text) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error('session ' + sessionId + ' is not retained')
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error.message + ' (' + result.error.code + ')')
      }

      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'user',
        priority: -1,
        locale: NS,
        inject: (sessionId) => ({
          editMessage: (request) => resendEdited(sessionId, request),
        }),
      }, UserMessageView))

      // The activity seat is the composer's one compact action between the
      // model selector and Send, which puts the triangle directly beside the
      // Send/Stop circle. priority 10 yields to a shipped occupant (voice
      // input registers at the default 0) instead of contending for the cell.
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity',
        priority: 10,
        locale: NS,
        inject: (sessionId) => ({
          continueTurn: (text) => continueTurn(sessionId, text),
        }),
      }, ContinueButton))
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
