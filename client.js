/**
 * dsh-visual —— Client 半区
 *
 * 在 `conversation.chat.turnTail` 槽位渲染**可交互窗口式卡片**。
 *
 * 交互设计（对应"窗口"语义）：
 *   - 卡片是一个可聚焦的窗口：**点击后才接管键盘**，用于 WASD、方向键等。
 *     鼠标始终"在里面就是在里面"，不需要点击也能悬停、滚动、点击。
 *   - 焦点在窗口内时，键盘事件在捕获阶段被拦下，不会触发宿主的输入框或快捷键；
 *     焦点在外面则一切照常。Esc 退出键盘接管。
 *   - 顶部工具条：标题 + 全屏 / 复制 HTML / 下载 HTML。
 *   - 全屏用浏览器 Fullscreen API，只把这张卡片放到全屏，不影响宿主。
 *
 * 脚本执行：innerHTML 插入的 <script> 不会执行，这里手动重建节点，
 * 因此 AI 写的按钮、canvas 小游戏、定时器都能真正跑起来。
 *
 * 安全边界：脚本运行在宿主页面里（非沙箱），这是使用方要求的能力。
 */

window.__ModuleLoader__.load({
  id: 'dsh-visual',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const CARD_CSS = `
.dshv-list{display:flex;flex-direction:column;gap:14px;margin:12px 0}
.dshv-win{
  display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-panel);
  background:var(--dsw-alias-bg-layer-1);
  overflow:hidden;
  outline:none;
  transition:box-shadow .12s,border-color .12s;
}
.dshv-win[data-focused="true"]{
  border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent);
}
.dshv-bar{
  display:flex;align-items:center;gap:8px;
  padding:8px 12px;
  background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l2);
  flex:none;
}
.dshv-name{
  flex:1;min-width:0;
  font-size:13px;font-weight:600;
  color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* 提示用主文字色 + 半粗，保证在任何主题下都读得清。 */
.dshv-focus-hint{font-size:12px;font-weight:500;flex:none;color:var(--dsw-alias-label-primary)}
.dshv-focus-hint[data-on="true"]{color:var(--dsw-alias-state-warn-primary);font-weight:600}
.dshv-btn{
  appearance:none;flex:none;
  height:26px;padding:0 10px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:transparent;
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-weight:500;
  cursor:pointer;
}
.dshv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.dshv-stage{
  display:block;
  width:100%;
  /* 高度由内联 style 给出（内容自适应 + min(…, 62vh) 封顶），这里不设固定值。 */
  border:0;
  background:var(--dsw-alias-bg-base);
  box-sizing:border-box;
}
/* 全屏：卡片铺满视口，内容区吃掉标题栏以外的全部空间。 */
.dshv-win:fullscreen{width:100vw;height:100vh;border-radius:0;border:0}
.dshv-win:fullscreen .dshv-bar{flex:none}
.dshv-win:fullscreen .dshv-stage{height:auto !important;flex:1;min-height:0;width:100%}
/* 全屏时隐藏焦点提示：此时键盘一定归窗口，没必要再提示。 */
.dshv-win:fullscreen .dshv-focus-hint{display:none}
`

    /** 宿主主题变量 → iframe 里可用的名字。 */
    const THEME_MAP = [
      ['--v-bg-base', '--dsw-alias-bg-base'],
      ['--v-bg-layer-1', '--dsw-alias-bg-layer-1'],
      ['--v-bg-layer-2', '--dsw-alias-bg-layer-2'],
      ['--v-border', '--dsw-alias-border-l1'],
      ['--v-border-strong', '--dsw-alias-border-l2'],
      ['--v-brand', '--dsw-alias-brand-primary'],
      ['--v-text', '--dsw-alias-label-primary'],
      ['--v-text-dim', '--dsw-alias-label-secondary'],
      ['--v-success', '--dsw-alias-state-success-primary'],
      ['--v-warn', '--dsw-alias-state-warn-primary'],
      ['--v-error', '--dsw-alias-state-error-primary'],
    ]

    /**
     * 读一次宿主当前主题的实际颜色值。
     * iframe 是独立文档，继承不到宿主的 `--dsw-*`，必须手动搬过去。
     *
     * 读取顺序：卡片所在的容器 → body → documentElement。
     * 只读 documentElement 不够：实测某些主题把变量定义在更内层的容器上，
     * 那样读到的就是空串，表现为 iframe 里 var(--v-brand) 取不到值、色块变空白。
     */
    function readThemeColors(anchor) {
      const colors = {}
      const scopes = []
      if (anchor !== null && anchor !== undefined) scopes.push(anchor)
      scopes.push(document.body, document.documentElement)

      for (const scope of scopes) {
        if (scope === null || scope === undefined) continue
        const styles = window.getComputedStyle(scope)
        for (const [target, source] of THEME_MAP) {
          if (colors[target] !== undefined) continue
          const value = styles.getPropertyValue(source).trim()
          if (value.length > 0) colors[target] = value
        }
      }

      // 最后兜底：用一套固定色板，保证任何情况下色块都有颜色
      // （否则 var(--v-brand) 解析失败会退化成透明，看起来"没有颜色"）。
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const fallback = dark
        ? { '--v-brand': '#4d6bfe', '--v-success': '#22c55e', '--v-error': '#ef4444', '--v-warn': '#f59e0b' }
        : { '--v-brand': '#3b5bdb', '--v-success': '#16a34a', '--v-error': '#dc2626', '--v-warn': '#d97706' }
      for (const [key, value] of Object.entries(fallback)) {
        if (colors[key] === undefined) colors[key] = value
      }
      return colors
    }

    /** 复制到剪贴板；不可用时退回 execCommand，避免静默失败。 */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const area = document.createElement('textarea')
          area.value = text
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
    }

    /** 下载为独立 HTML 文件，可脱机打开。 */
    function downloadHtml(title, html) {
      const doc = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
font-size:13px;line-height:1.6;background:#1a1a1a;color:#e6e6e6}
</style></head><body>${html}</body></html>`
      const blob = new Blob([doc], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${String(title).replace(/[\\/:*?"<>|]/gu, '_') || 'visual'}.html`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    /**
     * 剥掉脚本标签与内联事件属性。
     *
     * 用于「禁止执行脚本」这个设置：脚本能跑小游戏，也是唯一的安全风险来源。
     * 用 DOMParser 而不是正则，一是更彻底（内联事件属性也一起去掉），
     * 二是避免在源码里写出 script 的闭合标签字面量 —— 那会截断整个打包脚本。
     */
    function stripScripts(html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        for (const el of doc.querySelectorAll('script')) el.remove()
        for (const el of doc.querySelectorAll('*')) {
          for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase()
            // onclick / onload / onerror 这类全部去掉
            if (name.startsWith('on')) el.removeAttribute(attr.name)
          }
        }
        return doc.body.innerHTML
      } catch {
        return html
      }
    }

    /**
     * 一个可视化窗口。
     *
     * 键盘隔离为什么必须用 iframe：
     * AI 生成的脚本通常监听 `document`/`window` 的 keydown，插件无法约束它。
     * 只要它与宿主共用同一个 document，无论焦点在哪按键都会传到脚本里，
     * 于是出现"窗口外也能操作"，甚至抢走输入框的方向键。
     * iframe 有独立的 document 与事件作用域：只有焦点在 iframe 内时它才收到按键，
     * 这正好实现"点击窗口后才能操作"。
     *
     * 为什么用 document.write 而不是 srcdoc：
     * 实测 srcdoc 在本宿主的 `dsh-app://` 协议下「有尺寸、有内容却不可见」，
     * 而 document.write 写入同一文档可以正常渲染。
     */
    function VisualWindow(props) {
      const frameRef = useRef(null)
      const winRef = useRef(null)
      const [focused, setFocused] = useState(false)
      const [toast, setToast] = useState(null)
      /**
       * 内容实测高度。
       *
       * 模型没指定高度时，卡片高度应当由内容自己决定 —— 宽度固定后，
       * 一段话多高就是多高，不该硬套一个 360px 的框。
       * 写入后立刻量一次，再在图片/字体加载完的 120ms、500ms 各补量一次。
       */
      const [contentHeight, setContentHeight] = useState(0)
      // 设置里关掉脚本时，写入前就把脚本与内联事件剥离，彻底不执行。
      const rawHtml = typeof props.html === 'string' ? props.html : ''
      const html = props.allowScripts === false ? stripScripts(rawHtml) : rawHtml
      const title = props.title || '可视化'

      // 每次内容变化都重写 iframe 文档，并注入当前主题的实际颜色。
      useEffect(() => {
        const frame = frameRef.current
        if (frame === null) return undefined
        const doc = frame.contentDocument
        if (doc === null) return undefined

        // 以卡片自身为锚点读主题：变量可能不在 <html> 上。
        const colors = readThemeColors(winRef.current)
        // 判断亮/暗：读背景色亮度，比依赖某个变量更可靠。
        // iframe 里 readThemeColors 可能取到空值，那就按宿主 <html> 的 class 判断。
        let dark = true
        const bg = colors['--v-bg-base'] || ''
        const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/u.exec(bg)
        if (rgb !== null) {
          const lum = 0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3])
          dark = lum < 128
        } else {
          dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        }

        // 兜底色：变量缺失时也要保证对比度，否则会出现白底白字。
        const fb = dark
          ? { bg: '#1a1a1a', text: '#e8e8e8', dim: '#a0a0a0', border: '#3a3a3a', brand: '#4d6bfe' }
          : { bg: '#ffffff', text: '#1a1a1a', dim: '#5a5a5a', border: '#d0d0d0', brand: '#3b5bdb' }

        const varLines = Object.entries(colors)
          .map(([name, value]) => `${name}: ${value};`)
          .join('')

        doc.open()
        // 注意：模板里不能出现字面量的 script 闭合标签（会截断外层脚本）。
        doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
:root{${varLines}}
*{box-sizing:border-box}
html,body{
  margin:0;padding:8px;
  /* 背景与文字都显式给值 + 兜底，任何主题下都保证可读。 */
  background:var(--v-bg-base,${fb.bg});
  color:var(--v-text,${fb.text});
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  font-size:14px;line-height:1.7;
  width:100%;
  /* 刻意不设 min-height:100vh —— 那会让 content 永远至少填满 iframe，
     父级就测不出内容的真实高度，"按内容自动定高"也就无从谈起。 */
}
/* 段落与次要文字也显式设色，避免继承到不可见颜色。 */
h1,h2,h3,h4,h5,h6,p,span,div,li,td,th,label{color:inherit}
b,strong{color:var(--v-text,${fb.text});font-weight:700}
small,.dim{color:var(--v-text-dim,${fb.dim})}
img,canvas,svg,video{max-width:100%;height:auto}
button{
  font:inherit;cursor:pointer;
  color:var(--v-text,${fb.text});
  background:var(--v-bg-layer-2,${dark ? '#2a2a2a' : '#f0f0f0'});
  border:1px solid var(--v-border-strong,${fb.border});
  border-radius:6px;padding:5px 12px;
}
button:hover{background:var(--v-bg-layer-1,${dark ? '#333' : '#e4e4e4'})}
</style></head><body>${html}
<script>
/* Esc 释放键盘：把焦点交回宿主页面。 */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    try { window.parent && window.parent.focus() } catch (err) { /* 跨源时忽略 */ }
  }
}, true)
<\/script>
</body></html>`)
        doc.close()

        // 写入后量一次内容高度，并在图片/字体加载完成的稍后时刻补量。
        const measure = () => {
          try {
            const d = frame.contentDocument
            if (d === null) return
            // 用 body 的盒高，而不是 documentElement.scrollHeight：
            // 后者在内容比 iframe 矮时会返回视口高度（元素撑满视口），
            // 那样永远测不到「内容其实只有 100px」，自动定高就失效了。
            const body = d.body
            const h = body === null || body === undefined
              ? 0
              : Math.ceil(body.getBoundingClientRect().height)
            if (h > 0) setContentHeight(h)
          } catch {
            /* 量不到就保持原值 */
          }
        }
        measure()
        const at1 = setTimeout(measure, 120)
        const at2 = setTimeout(measure, 500)

        return () => {
          clearTimeout(at1)
          clearTimeout(at2)
          try {
            doc.open()
            doc.write('')
            doc.close()
          } catch {
            /* 卸载时忽略 */
          }
        }
      }, [html])

      useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => setToast(null), 2200)
        return () => clearTimeout(timer)
      }, [toast])

      /**
       * 焦点检测。
       *
       * 点击发生在 iframe **内部**，React 绑在 iframe 元素上的 onMouseDown / onFocus
       * 都收不到（事件被 iframe 的文档吃掉了）。所以这里换一种可靠的判断：
       *   - 宿主的 document 失去焦点（`document.activeElement === iframe`）或
       *     宿主 window 触发 blur，就认为键盘交给了 iframe；
       *   - 用户在 iframe 内点外面，宿主的 document 重新获得焦点，就清除状态。
       *
       * 直接读 `document.activeElement` 是最稳的：点击 iframe 后浏览器会把
       * 焦点移到那个 iframe 元素上，无需依赖事件冒泡。
       */
      useEffect(() => {
        const frame = frameRef.current
        if (frame === null) return undefined

        const sync = () => {
          const active = document.activeElement
          setFocused(active === frame)
        }

        // 轮询兜底：焦点变化在跨文档场景下不一定有事件可听，
        // 这个检查很轻（每 300ms 读一次 activeElement），足以覆盖所有情况。
        const timer = setInterval(sync, 300)
        window.addEventListener('focus', sync)
        window.addEventListener('blur', sync)
        document.addEventListener('click', sync, true)

        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', sync)
          window.removeEventListener('blur', sync)
          document.removeEventListener('click', sync, true)
        }
      }, [])

      // Esc 退出键盘接管：把焦点从 iframe 移回宿主，按键自然回去。
      useEffect(() => {
        if (!focused) return undefined
        const onEsc = (event) => {
          if (event.key === 'Escape') {
            const frame = frameRef.current
            frame?.blur()
            winRef.current?.focus()
            setFocused(false)
          }
        }
        // 既听宿主窗口（焦点已在外面时），也听 iframe 内部（Esc 在卡片里按下）。
        window.addEventListener('keydown', onEsc)
        return () => window.removeEventListener('keydown', onEsc)
      }, [focused])

      const toggleFullscreen = useCallback(() => {
        const node = winRef.current
        if (node === null) return
        if (document.fullscreenElement === node) {
          void document.exitFullscreen()
        } else {
          void node.requestFullscreen?.()
        }
      }, [])

      const onCopy = useCallback(async () => {
        const ok = await copyText(html)
        setToast(ok ? '已复制 HTML' : '复制失败，请手动选中')
      }, [html])

      const onDownload = useCallback(() => {
        downloadHtml(title, html)
        setToast('已下载 HTML')
      }, [title, html])

      return h('div', {
        className: 'dshv-win',
        ref: winRef,
        tabIndex: -1,
        'data-focused': focused ? 'true' : 'false',
      },
        h('div', { className: 'dshv-bar' },
          h('span', { className: 'dshv-name' }, title),
          h('span', {
            className: 'dshv-focus-hint',
            'data-on': focused ? 'true' : 'false',
          }, focused ? '键盘已交给窗口 · Esc 退出' : '点击窗口可操作'),
          h('button', { type: 'button', className: 'dshv-btn', onClick: toggleFullscreen, title: '全屏' }, '全屏'),
          h('button', { type: 'button', className: 'dshv-btn', onClick: () => { void onCopy() }, title: '复制 HTML' }, '复制'),
          h('button', { type: 'button', className: 'dshv-btn', onClick: onDownload, title: '下载 HTML' }, '下载')
        ),
        h('iframe', {
          ref: frameRef,
          className: 'dshv-stage',
          // 高度规则：
          //   模型指定了 height → 用指定值；
          //   没指定 → 用实测的内容高度，内容多高就多高；
          //   两者都再用 min(…, 62vh) 夹一次 —— 卡片再高也不该超出一屏，
          //   超过就只在卡片内部滚动，不逼用户滚动整个对话才能看全。
          style: (() => {
            const wanted = typeof props.height === 'number' && props.height > 0
              ? props.height
              : (contentHeight > 0 ? contentHeight : 240)
            const pct = typeof props.maxHeightPercent === 'number' ? props.maxHeightPercent : 62
            return { height: `min(${Math.max(120, Math.round(wanted))}px, ${pct}vh)` }
          })(),
          title,
          // 显式设置 tabIndex，确保点击后浏览器会把焦点移到这个 iframe 元素上，
          // 状态检测依赖 document.activeElement === frame。
          tabIndex: 0,
          // 不加 sandbox：需要脚本运行；iframe 天然隔离 document 与键盘事件。
        }),
        toast === null
          ? null
          : h('div', {
              style: {
                padding: '4px 10px 6px',
                fontSize: '11px',
                color: 'var(--dsw-alias-state-success-primary)',
              },
            }, toast)
      )
    }

    /** 正文区渲染器：按 session + turn 拉取本轮卡片。 */
    function TurnVisuals(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const turn = props.turn && typeof props.turn.turn === 'number' ? props.turn.turn : undefined
      const [cards, setCards] = useState([])
      // 脚本开关与高度上限由 Host 随卡片一起下发，客户端不另外拉一次设置。
      const [allowScripts, setAllowScripts] = useState(true)
      const [maxHeightPercent, setMaxHeightPercent] = useState(62)

      useEffect(() => {
        if (sessionId === undefined || turn === undefined) {
          setCards([])
          return undefined
        }
        let alive = true
        let timer

        const load = async () => {
          try {
            const response = await fetch(
              `/dsh-visual/cards?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}`,
            )
            const data = await response.json()
            if (!alive || !data || !Array.isArray(data.cards)) return
            if (data.allowScripts === false) setAllowScripts(false)
            if (typeof data.maxHeightPercent === 'number') setMaxHeightPercent(data.maxHeightPercent)
            setCards((previous) => {
              // 内容没变就保持同一引用，避免重渲染打断窗口里的交互。
              if (previous.length === data.cards.length) {
                const same = previous.every((card, index) => card.title === data.cards[index].title
                  && card.html === data.cards[index].html)
                if (same) return previous
              }
              return data.cards
            })
            // 已经拿到卡片就停止轮询，不再打扰正在运行的交互。
            if (data.cards.length > 0 && timer !== undefined) clearInterval(timer)
          } catch {
            /* 取不到就等下一次 */
          }
        }

        void load()
        timer = setInterval(load, 1200)
        // 最多轮询 20 秒，避免长期占用。
        const stop = setTimeout(() => clearInterval(timer), 20000)

        return () => {
          alive = false
          clearInterval(timer)
          clearTimeout(stop)
        }
      }, [sessionId, turn])

      if (cards.length === 0) return null

      return h('div', { className: 'dshv-list' },
        h('style', null, CARD_CSS),
        cards.map((card, index) => h(VisualWindow, {
          key: `${card.title}-${index}`,
          title: card.title,
          html: card.html,
          height: card.height,
          allowScripts,
          maxHeightPercent,
        }))
      )
    }

    // ── 设置页 ────────────────────────────────────────────────────────────

    const PAGE_CSS = `
.dshv-page{display:flex;flex-direction:column;gap:22px;padding:2px 0 10px;width:100%}
.dshv-sec{display:flex;flex-direction:column;gap:10px}
/* 区块标题前的品牌蓝竖线：整页只在少数位置用蓝色做点缀 */
.dshv-sec-title{
  display:flex;align-items:center;gap:8px;
  font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);
}
.dshv-sec-title::before{
  content:'';flex:none;width:3px;height:14px;border-radius:2px;
  background:var(--dsw-alias-brand-primary);
}
.dshv-hint{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dshv-card{
  padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-panel);
  background:var(--dsw-alias-bg-layer-1);
  display:flex;flex-direction:column;gap:10px;
}
.dshv-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.dshv-row-label{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshv-row-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshv-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
/* 数字输入 */
.dshv-num{
  width:86px;height:34px;padding:0 10px;flex:none;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;text-align:right;
}
.dshv-num:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
/* 开关：参数照抄原厂设置页的（40×24 / 圆点 20 / 位移 16）。 */
.dshv-switch{
  position:relative;flex:none;
  width:40px;height:24px;padding:0;
  border:0;border-radius:999px;
  background:var(--dsw-alias-border-l2);
  cursor:pointer;
  transition:background-color .15s;
}
.dshv-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}
.dshv-switch:disabled{opacity:.5;cursor:default}
.dshv-knob{
  position:absolute;top:2px;left:2px;
  width:20px;height:20px;border-radius:999px;
  background:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.2);
  transition:transform .15s;
}
.dshv-switch[aria-checked="true"] .dshv-knob{transform:translateX(16px)}
/* 按钮 */
.dshv-btn{
  appearance:none;height:32px;padding:0 14px;flex:none;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:transparent;
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;font-weight:500;
  cursor:pointer;
}
.dshv-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshv-btn:disabled{opacity:.5;cursor:default}
.dshv-btn[data-danger="true"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshv-btn[data-danger="true"]:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.dshv-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshv-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.dshv-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}
`

    /** 开关：与原厂设置页同款（40×24，aria-checked 驱动）。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'dshv-switch',
        role: 'switch',
        'aria-checked': props.value === true,
        disabled: props.disabled === true,
        onClick: () => props.onChange(props.value !== true),
        title: props.title,
      }, h('span', { className: 'dshv-knob' }))
    }

    /** 一行「名称 + 说明 + 右侧控件」。 */
    function Row(props) {
      return h('div', { className: 'dshv-row' },
        h('div', { className: 'dshv-row-label' },
          h('div', { className: 'dshv-row-name' }, props.name),
          props.desc === undefined ? null : h('div', { className: 'dshv-row-desc' }, props.desc)
        ),
        props.children
      )
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    async function readVisualSettings() {
      const response = await fetch('/dsh-visual/settings')
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${response.status}`)
      }
      return data
    }

    async function saveVisualSettings(patch) {
      const response = await fetch('/dsh-visual/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${response.status}`)
      }
      return data
    }

    async function clearVisualStore() {
      const response = await fetch('/dsh-visual/clear', { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${response.status}`)
      }
      return data
    }

    function SettingsPage() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      // 清空是破坏性操作，点第一次只进入待确认态。
      const [confirmClear, setConfirmClear] = useState(false)

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const loaded = await readVisualSettings()
            if (alive) setData(loaded)
          } catch (err) {
            if (alive) setError(String(err && err.message ? err.message : err))
          }
        })()
        return () => { alive = false }
      }, [])

      /** 改一项就保存。写的是本地文件，毫秒级，不需要忙碌态。 */
      const persist = useCallback(async (patch) => {
        setData((previous) => (previous === null
          ? previous
          : { ...previous, settings: { ...previous.settings, ...patch } }))
        setStatus(null)
        try {
          const saved = await saveVisualSettings(patch)
          setData((previous) => (previous === null
            ? previous
            : { ...previous, settings: saved.settings, stats: saved.stats }))
          setStatus({
            kind: saved.saved ? 'ok' : 'err',
            text: saved.saved ? '已保存' : '已应用，但写入文件失败，重启后可能不保留',
          })
        } catch (err) {
          setStatus({ kind: 'err', text: String(err && err.message ? err.message : err) })
        }
      }, [])

      const doClear = useCallback(async () => {
        setStatus(null)
        try {
          const result = await clearVisualStore()
          setData((previous) => (previous === null ? previous : { ...previous, stats: result.stats }))
          setStatus({ kind: 'ok', text: '已清空历史卡片' })
        } catch (err) {
          setStatus({ kind: 'err', text: String(err && err.message ? err.message : err) })
        } finally {
          setConfirmClear(false)
        }
      }, [])

      if (error !== null) {
        return h('div', { className: 'dshv-page' },
          h('style', null, PAGE_CSS),
          h('div', { className: 'dshv-status', 'data-kind': 'err' }, `读取设置失败：${error}`)
        )
      }
      if (data === null) {
        return h('div', { className: 'dshv-page' },
          h('style', null, PAGE_CSS),
          h('div', { className: 'dshv-status' }, '正在读取…')
        )
      }

      const s = data.settings
      const lim = data.limits
      const stats = data.stats
      const num = (key) => (event) => {
        const raw = event.target.value
        if (raw === '') return
        void persist({ [key]: Number(raw) })
      }

      return h('div', { className: 'dshv-page' },
        h('style', null, PAGE_CSS),

        // 卡片外观
        h('div', { className: 'dshv-sec' },
          h('div', { className: 'dshv-sec-title' }, '卡片外观'),
          h('div', { className: 'dshv-card' },
            h(Row, {
              name: '高度上限',
              desc: '卡片高度按内容自动决定；超过这个比例时改成卡片内部滚动，'
                + `不让你为了看全貌去滚动整个对话（${lim.maxHeightPercent[0]}–${lim.maxHeightPercent[1]}% 视口高度）。`,
            }, h('input', {
              type: 'number',
              className: 'dshv-num',
              value: s.maxHeightPercent,
              min: lim.maxHeightPercent[0],
              max: lim.maxHeightPercent[1],
              step: 2,
              onChange: num('maxHeightPercent'),
            }))
          )
        ),

        // 脚本
        h('div', { className: 'dshv-sec' },
          h('div', { className: 'dshv-sec-title' }, '交互与安全'),
          h('div', { className: 'dshv-card' },
            h(Row, {
              name: '允许执行卡片里的脚本',
              desc: '关掉后按钮、动画、小游戏都不会运行，只显示静态内容。'
                + '脚本运行在宿主页面里，这是唯一的安全风险来源；不信任模型输出时建议关掉。',
            }, h(Switch, {
              value: s.allowScripts,
              onChange: (value) => { void persist({ allowScripts: value }) },
            }))
          )
        ),

        // 存储
        h('div', { className: 'dshv-sec' },
          h('div', { className: 'dshv-sec-title' }, '历史卡片'),
          h('div', { className: 'dshv-card' },
            h(Row, {
              name: '每个会话保留轮数',
              desc: `超出的旧轮次会在写入时丢弃（${lim.keepTurns[0]}–${lim.keepTurns[1]}）。`,
            }, h('input', {
              type: 'number',
              className: 'dshv-num',
              value: s.keepTurns,
              min: lim.keepTurns[0],
              max: lim.keepTurns[1],
              step: 10,
              onChange: num('keepTurns'),
            })),
            h(Row, {
              name: '每轮最多卡片数',
              desc: `一轮里生成超过这个数量时，只留最新的（${lim.maxPerTurn[0]}–${lim.maxPerTurn[1]}）。`,
            }, h('input', {
              type: 'number',
              className: 'dshv-num',
              value: s.maxPerTurn,
              min: lim.maxPerTurn[0],
              max: lim.maxPerTurn[1],
              step: 1,
              onChange: num('maxPerTurn'),
            })),
            h(Row, {
              name: '当前占用',
              desc: `${stats.sessions} 个会话 · ${stats.turns} 轮 · ${stats.cards} 张卡片 · ${formatBytes(stats.bytes)}`,
            }, confirmClear
              ? h('div', { style: { display: 'flex', gap: '8px', flex: 'none' } },
                  h('button', {
                    type: 'button',
                    className: 'dshv-btn',
                    'data-danger': 'true',
                    onClick: () => { void doClear() },
                  }, '确认清空'),
                  h('button', {
                    type: 'button',
                    className: 'dshv-btn',
                    onClick: () => setConfirmClear(false),
                  }, '取消')
                )
              : h('button', {
                  type: 'button',
                  className: 'dshv-btn',
                  'data-danger': 'true',
                  disabled: stats.cards === 0,
                  onClick: () => setConfirmClear(true),
                }, '清空历史'))
          )
        ),

        status === null
          ? null
          : h('div', { className: 'dshv-status', 'data-kind': status.kind }, status.text)
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-visual-turn',
          order: 50,
          label: () => '可视化',
        }, TurnVisuals))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-visual',
          order: 47,
          label: () => '可视化',
        }, SettingsPage))
      },
    }
  },
})
