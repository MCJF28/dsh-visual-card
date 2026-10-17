/**
 * dsh-visual —— Host 半区
 *
 * 工具 `render_visual`：AI 交一段 HTML，插件把它作为**可交互卡片**
 * 渲染在本轮正文下方（`conversation.chat.turnTail` 槽位，不折叠）。
 *
 * 为什么用 turnTail 而不是别处：
 *   宿主的对话节点固定 19 种，插件无法新增节点类型；`turn-tail` 是本轮唯一
 *   提供的、不折叠的扩展位。工具调用卡片位于「思考过程/已调用工具」折叠区，
 *   用户默认看不到，所以不能只放在那里。
 *
 * 交互能力：卡片内容写入 iframe 后保留内联脚本，因此 AI 写的按钮、小游戏、
 * 图表动画都能真正运行。代价是 AI 生成的代码会执行，可在设置里关掉。
 *
 * 数据流：工具把卡片存进内存并落盘 → 客户端按 session + turn 拉取 → turnTail 渲染。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-visual'

/** 需要的服务：工具注册 + HTTP 路由（供客户端取卡片、改设置）+ 斜杠命令。 */
export const inject = ['tools', 'webServer', 'commands']

/** 单次 HTML 上限，防止把巨大内容塞进对话。 */
const MAX_HTML_CHARS = 200000

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(DSH_HOME, 'visual')
const STORE_FILE = join(STORE_DIR, 'cards.json')
const SETTINGS_FILE = join(STORE_DIR, 'settings.json')

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

/**
 * 设置项。
 *
 *   maxHeightPercent —— 卡片内容区的高度上限（占视口百分比）。内容多高就多高，
 *                      但再高也不该逼用户滚动整个对话才看得到全貌；
 *                      超过这个比例就只在卡片内部滚动。
 *                      默认 50 而不是更高：这个比例只管内容区，实际还会叠加
 *                      卡片自己的标题栏（全屏/复制/下载）和对话底部的工具栏，
 *                      取 62 时两者相加刚好把一屏占满，底部按钮被挤出视口；
 *   allowScripts     —— 脚本能跑小游戏，但也是唯一的安全风险来源，必须可关；
 *   keepTurns        —— cards.json 会随使用一直长，给用户一个上限；
 *   maxPerTurn       —— 一轮里模型可能连着画七八张，超出部分挤在一起看不清。
 */
const DEFAULT_SETTINGS = {
  maxHeightPercent: 50,
  allowScripts: true,
  keepTurns: 200,
  maxPerTurn: 20,
}

/** 数值型设置的合法区间，保存时统一夹紧。 */
const LIMITS = {
  maxHeightPercent: [30, 100],
  keepTurns: [10, 2000],
  maxPerTurn: [1, 50],
}

let settings = { ...DEFAULT_SETTINGS }

function clampInt(value, fallback, [min, max]) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  return {
    maxHeightPercent: clampInt(
      raw.maxHeightPercent,
      DEFAULT_SETTINGS.maxHeightPercent,
      LIMITS.maxHeightPercent,
    ),
    allowScripts: raw.allowScripts !== false,
    keepTurns: clampInt(raw.keepTurns, DEFAULT_SETTINGS.keepTurns, LIMITS.keepTurns),
    maxPerTurn: clampInt(raw.maxPerTurn, DEFAULT_SETTINGS.maxPerTurn, LIMITS.maxPerTurn),
  }
}

function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    settings = normalizeSettings(parsed)
  } catch {
    /* 文件不存在或损坏：用默认值 */
  }
}

function saveSettings() {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, undefined, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 卡片存储：sessionId → turn(String) → 卡片数组。
 *
 * 仅按 turn 精确定位，**不做"最近一轮"兜底**：
 * 兜底会让没有调用可视化的回合也把历史卡片显示出来，比不显示更糟。
 */
const visualsBySession = new Map()

/** 每个会话当前进行到第几轮（按会话隔离，避免多会话互相覆盖）。 */
const currentTurnBySession = new Map()

/** 读盘恢复：启动时把上次保存的卡片装回内存。 */
function loadStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return
    for (const [sessionId, byTurn] of Object.entries(parsed)) {
      if (byTurn === null || typeof byTurn !== 'object') continue
      const map = new Map()
      for (const [turn, list] of Object.entries(byTurn)) {
        if (Array.isArray(list) && list.length > 0) map.set(turn, list)
      }
      if (map.size > 0) visualsBySession.set(sessionId, map)
    }
  } catch {
    /* 文件不存在或损坏：从空开始即可 */
  }
}

/** 写盘：卡片变化后保存；失败不影响工具调用。 */
function saveStore() {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const out = {}
    const keepTurns = settings.keepTurns
    for (const [sessionId, byTurn] of visualsBySession) {
      const turns = [...byTurn.keys()].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      const keep = new Set(turns.slice(-keepTurns).map(String))
      const obj = {}
      for (const [turn, list] of byTurn) {
        if (keep.has(turn)) obj[turn] = list
      }
      out[sessionId] = obj
    }
    writeFileSync(STORE_FILE, JSON.stringify(out), 'utf8')
  } catch {
    /* 写盘失败不应影响对话 */
  }
}

/** 当前存储占用统计，供设置页展示。 */
function storeStats() {
  let turns = 0
  let cards = 0
  for (const byTurn of visualsBySession.values()) {
    turns += byTurn.size
    for (const list of byTurn.values()) cards += list.length
  }
  let bytes = 0
  try {
    if (existsSync(STORE_FILE)) bytes = statSync(STORE_FILE).size
  } catch {
    /* 读不到就当 0 */
  }
  return { sessions: visualsBySession.size, turns, cards, bytes }
}

function storeVisual(sessionId, value, turn) {
  let byTurn = visualsBySession.get(sessionId)
  if (byTurn === undefined) {
    byTurn = new Map()
    visualsBySession.set(sessionId, byTurn)
  }
  const key = String(turn)
  const list = byTurn.get(key) ?? []
  list.push(value)
  // 单轮上限由设置决定，超出时丢最早的，保证最新的始终可见。
  if (list.length > settings.maxPerTurn) list.splice(0, list.length - settings.maxPerTurn)
  byTurn.set(key, list)
  saveStore()
}

function readVisuals(sessionId, turn) {
  const byTurn = visualsBySession.get(sessionId)
  if (byTurn === undefined) return []
  return byTurn.get(String(turn)) ?? []
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

loadSettings()
loadStore()

export function apply(ctx) {
  /**
   * `/visual`：查看卡片存储情况。
   *
   * 命令只做「查询并回报」，不做设置修改 —— 改上限、清空都要点界面，
   * 在命令里做会绕过二次确认，清空历史尤其不能一键发生。
   */
  ctx.commands.register({
    name: 'visual',
    description: '查看可视化卡片的存储占用',
    handler: () => {
      const s = storeStats()
      const kb = s.bytes < 1024
        ? `${s.bytes} B`
        : s.bytes < 1024 * 1024
          ? `${(s.bytes / 1024).toFixed(1)} KB`
          : `${(s.bytes / 1024 / 1024).toFixed(1)} MB`
      const lines = s.cards === 0
        ? ['还没有保存过可视化卡片。']
        : [
            `已保存 ${s.cards} 张卡片，分布在 ${s.sessions} 个会话、${s.turns} 轮里，占用 ${kb}。`,
            `上限：每个会话保留 ${settings.keepTurns} 轮，每轮最多 ${settings.maxPerTurn} 张，`
              + `卡片高度不超过视口的 ${settings.maxHeightPercent}%。`,
            `卡片脚本：${settings.allowScripts ? '允许执行' : '已禁用'}。`,
          ]
      lines.push('在「设置 → 可视化」里调整上限或清空历史。')
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.tools.register(defineTool({
    name: 'render_visual',
    description:
      '把一段 HTML 渲染成对话中**可交互**的可视化卡片，出现在本轮回答下方（不折叠）。'
      + '支持图表、色块、布局、动画，以及**可点击按钮和完整的小游戏**（脚本会真正执行）。\n'
      + '什么时候用：用户要求"可视化""画个图""做个演示"，需要展示颜色/布局/数据，'
      + '或文字描述不如一张图清楚时。\n'
      + '写法要求：\n'
      + '1) 只写片段，不要 html/head/body 外壳，不要引用外部图片或脚本；\n'
      + '2) 颜色用主题变量：var(--v-bg-base) 底色、var(--v-bg-layer-1)/var(--v-bg-layer-2) 层级背景、'
      + 'var(--v-border) 边框、var(--v-text) 主文字、var(--v-text-dim) 次文字、'
      + 'var(--v-brand) 强调色、var(--v-success)/var(--v-warn)/var(--v-error) 状态色；\n'
      + '3) **可读性第一，这是硬要求**：\n'
      + '   - 不要给文字设过淡的颜色，绝不要用接近背景色的文字；\n'
      + '   - 不要叠加半透明层导致文字发灰；需要强调就用字重或字号，不要靠降低对比度；\n'
      + '   - 图表里的标签、坐标轴、图例，都必须和背景有足够反差；\n'
      + '   - 如果不确定背景是什么颜色，就给文字显式设 var(--v-text)，\n'
      + '     并给容器显式设 var(--v-bg-base) 作为背景，不要留透明；\n'
      + '4) 需要交互就在片段里写内联 script（用 addEventListener 绑定）；\n'
      + '5) 用一个包裹元素承载全部内容，宽度自适应，高度由内容决定。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '卡片标题，一句话说明这张图展示什么。',
      },
      html: {
        type: 'string',
        required: true,
        description: 'HTML 片段（不含外壳），可用 <style> 与内联 <script>。',
      },
      height: {
        type: 'integer',
        description: '可选。不给就让卡片按内容自动定高（推荐）。'
          + '只有内容高度明显不合预期时才显式指定，单位像素。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          // 不给高度时这个字段不出现，客户端据此走「按内容自动定高」。
          height: { type: 'integer' },
          html: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已生成可视化「${value.title}」，见本轮回答下方。` },
      ],
    },
    async execute(args, exec) {
      const html = String(args.html ?? '')
      if (html.length === 0) throw new Error('html 不能为空')
      if (html.length > MAX_HTML_CHARS) {
        throw new Error(`html 过长（${html.length} 字符），请精简到 ${MAX_HTML_CHARS} 以内`)
      }

      // 高度：模型给了就用（夹到合理区间），没给就不下发 —— 客户端会按内容实测高度。
      const rawHeight = Number(args.height)
      const height = Number.isFinite(rawHeight) && rawHeight > 0
        ? Math.min(900, Math.max(120, Math.round(rawHeight)))
        : undefined

      const value = {
        title: String(args.title ?? '可视化').slice(0, 200),
        html,
        ...(height === undefined ? {} : { height }),
      }

      // 挂到本轮上，供 turnTail 槽位渲染在正文下方。
      try {
        const session = exec?.agent?.session
        const sessionId = session?.id ?? exec?.agent?.id
        if (sessionId !== undefined) {
          const key = String(sessionId)
          // 优先用会话面给出的当前 turn；没有就用本会话记录的最近 turn。
          const turn = session?.surface?.turn ?? currentTurnBySession.get(key) ?? 0
          storeVisual(key, value, turn)
        }
      } catch {
        /* 存储失败不应让工具调用失败 */
      }

      return value
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `生成可视化：${args && args.title ? String(args.title) : ''}`,
      kind: 'other',
    }),
  }))

  // 跟踪每个会话当前进行到第几轮：工具执行时用它把卡片归到正确的一轮。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    const turn = event.data?.turn
    if (typeof turn !== 'number') return
    const sessionId = session?.id ?? session
    if (sessionId !== undefined) currentTurnBySession.set(String(sessionId), turn)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId === undefined) return
    // 只清「当前轮次」这个运行态；卡片本身要保留，
    // 否则切换会话再回来（或重启后）历史可视化就没了。
    currentTurnBySession.delete(String(sessionId))
  })

  // 客户端按 session + turn 取卡片。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-visual/cards',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const turn = Number(url.searchParams.get('turn'))

        // 严格按 turn 精确匹配：没有就是没有。
        // 之前加过"取最近一轮"的兜底，结果每一轮都会冒出历史卡片，比不显示更糟。
        const cards = sessionId.length > 0 && Number.isFinite(turn)
          ? readVisuals(sessionId, turn)
          : []

        res.writeHead(200, JSON_HEADERS)
        // allowScripts / maxHeightPercent 随卡片下发，客户端据此决定脚本开关与高度封顶。
        res.end(JSON.stringify({
          ok: true,
          cards,
          allowScripts: settings.allowScripts,
          maxHeightPercent: settings.maxHeightPercent,
        }))
      } catch (error) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    },
  })

  // 设置读写。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-visual/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}')
          settings = normalizeSettings({ ...settings, ...body })
          const saved = saveSettings()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, saved, settings, limits: LIMITS, stats: storeStats() }))
          return
        }

        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          settings,
          defaults: DEFAULT_SETTINGS,
          limits: LIMITS,
          stats: storeStats(),
        }))
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    },
  })

  // 清空历史卡片：只删卡片数据，不动设置。
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-visual/clear',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '只支持 POST' }))
          return
        }
        visualsBySession.clear()
        try {
          rmSync(STORE_FILE, { force: true })
        } catch {
          /* 文件可能本来就不存在 */
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, stats: storeStats() }))
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    },
  })
}

export { DEFAULT_SETTINGS, LIMITS }
