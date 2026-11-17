import { useEffect, useImperativeHandle, useRef, useState, forwardRef, type ReactNode } from 'react'
import { Minus, Plus, Maximize2 } from 'lucide-react'
import { radarBounds, type RadarMapInfo } from './radarMaps'
import {
  IDENTITY,
  centreOn,
  clampTransform,
  fitView,
  transformView,
  zoomAt,
  type MapBounds,
  type RadarView,
  type ViewTransform,
} from './radarMath'
import { drawScene, hitPlayer, TOKEN_RADIUS, type Scene } from './renderScene'

/** Everything the scene needs except the view, which the canvas owns. */
export type SceneInput = Omit<Scene, 'view' | 'dpr' | 'width' | 'height'>

export type MapCanvasHandle = {
  zoomBy(factor: number): void
  reset(): void
}

type Props = {
  /** Read every animation frame, so playback doesn't need to re-render this component. */
  sceneRef: React.MutableRefObject<SceneInput | null>
  info?: RadarMapInfo
  fallbackBounds?: MapBounds
  follow: string | null
  onSelect: (steamid: string | null) => void
  onHover: (steamid: string | null) => void
  /** Called when the user moves the camera themselves while following someone. */
  onManualCamera: () => void
  children?: ReactNode
}

const PAD_SHARE = 0.03
const CLICK_SLOP = 5
const WHEEL_SPEED = 0.0016
const BUTTON_STEP = 1.5
const FOLLOW_ZOOM = 2.6

type Pointer = { x: number; y: number }

export const MapCanvas = forwardRef<MapCanvasHandle, Props>(function MapCanvas(
  { sceneRef, info, fallbackBounds, follow, onSelect, onHover, onManualCamera, children },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const baseRef = useRef<{ view: RadarView; dpr: number; w: number; h: number } | null>(null)
  const transformRef = useRef<ViewTransform>(IDENTITY)
  const followRef = useRef(follow)
  const [zoomPct, setZoomPct] = useState(100)

  followRef.current = follow
  const callbacks = useRef({ onSelect, onHover, onManualCamera })
  callbacks.current = { onSelect, onHover, onManualCamera }

  const setTransform = (t: ViewTransform) => {
    const b = baseRef.current
    if (!b) return
    const next = clampTransform(t, b.w, b.h)
    transformRef.current = next
    setZoomPct(Math.round(next.zoom * 100))
  }

  useImperativeHandle(ref, () => ({
    zoomBy: (f) => {
      const b = baseRef.current
      if (b) setTransform(zoomAt(transformRef.current, f, b.w / 2, b.h / 2, b.w, b.h))
    },
    reset: () => setTransform(IDENTITY),
  }))

  // canvas size and the fitted view; refit when the map (or the box) changes
  const bounds = info ? radarBounds(info) : fallbackBounds
  const boundsKey = bounds ? `${bounds.min[0]},${bounds.min[1]},${bounds.max[0]},${bounds.max[1]}` : ''
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas || !boundsKey) return
    const [x0, y0, x1, y1] = boundsKey.split(',').map(Number)
    const fitted: MapBounds = { min: [x0, y0, 0], max: [x1, y1, 0] }
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.max(1, Math.round(wrap.clientWidth * dpr))
      const h = Math.max(1, Math.round(wrap.clientHeight * dpr))
      const prev = baseRef.current
      if (prev && (prev.w !== w || prev.h !== h)) {
        const t = transformRef.current
        transformRef.current = clampTransform({ zoom: t.zoom, x: t.x * (w / prev.w), y: t.y * (h / prev.h) }, w, h)
      }
      canvas.width = w
      canvas.height = h
      baseRef.current = { view: fitView(fitted, w, h, Math.min(w, h) * PAD_SHARE), dpr, w, h }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [boundsKey])

  // draw loop
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const base = baseRef.current
      const input = sceneRef.current
      if (!base || !input) return
      // camera follow: ease towards the followed player
      const f = followRef.current
      if (f) {
        const p = input.players.find((pl) => pl.steamid === f)
        if (p) {
          const [px, py] = base.view.toCanvas(p.x, p.y)
          const cur = transformRef.current
          const target = centreOn(px, py, Math.max(cur.zoom, FOLLOW_ZOOM), base.w, base.h)
          const k = 0.18
          const next = {
            zoom: cur.zoom + (target.zoom - cur.zoom) * k,
            x: cur.x + (target.x - cur.x) * k,
            y: cur.y + (target.y - cur.y) * k,
          }
          transformRef.current = clampTransform(next, base.w, base.h)
          const pct = Math.round(transformRef.current.zoom * 100)
          setZoomPct((z) => (z === pct ? z : pct))
        }
      }
      drawScene(ctx, { ...input, view: transformView(base.view, transformRef.current), dpr: base.dpr, width: base.w, height: base.h })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [sceneRef])

  // wheel zoom (non-passive so the page doesn't scroll)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      const b = baseRef.current
      if (!b) return
      e.preventDefault()
      const [px, py] = toCanvasPx(canvas, e.clientX, e.clientY)
      setTransform(zoomAt(transformRef.current, Math.exp(-e.deltaY * WHEEL_SPEED), px, py, b.w, b.h))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const pointers = useRef(new Map<number, Pointer>())
  const gesture = useRef<{ moved: boolean; start: Pointer }>({ moved: false, start: { x: 0, y: 0 } })
  const [dragging, setDragging] = useState(false)
  const [hoverAny, setHoverAny] = useState(false)

  const viewNow = () => {
    const b = baseRef.current
    return b ? transformView(b.view, transformRef.current) : null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const p = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, p)
    if (pointers.current.size === 1) gesture.current = { moved: false, start: p }
    else gesture.current.moved = true
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    const b = baseRef.current
    if (!b) return
    const prev = pointers.current.get(e.pointerId)
    if (!prev) {
      // hover
      const v = viewNow()
      const input = sceneRef.current
      if (!v || !input) return
      const [px, py] = toCanvasPx(canvas, e.clientX, e.clientY)
      const hit = hitPlayer(input.players, v, px, py, TOKEN_RADIUS * 1.8 * b.dpr)
      setHoverAny(hit !== null)
      callbacks.current.onHover(hit)
      return
    }
    const k = canvas.width / (canvas.getBoundingClientRect().width || 1)
    const next = { x: e.clientX, y: e.clientY }
    const g = gesture.current
    if (pointers.current.size === 1) {
      if (!g.moved && Math.hypot(next.x - g.start.x, next.y - g.start.y) < CLICK_SLOP) return
      if (!g.moved) {
        g.moved = true
        setDragging(true)
        if (followRef.current) callbacks.current.onManualCamera()
      }
      pointers.current.set(e.pointerId, next)
      const t = transformRef.current
      setTransform({ zoom: t.zoom, x: t.x + (next.x - prev.x) * k, y: t.y + (next.y - prev.y) * k })
      return
    }
    const [a, bb] = [...pointers.current.values()]
    pointers.current.set(e.pointerId, next)
    const [c, d] = [...pointers.current.values()]
    const before = Math.hypot(a.x - bb.x, a.y - bb.y)
    const after = Math.hypot(c.x - d.x, c.y - d.y)
    if (before < 1) return
    const [mx, my] = toCanvasPx(canvas, (c.x + d.x) / 2, (c.y + d.y) / 2)
    const z = zoomAt(transformRef.current, after / before, mx, my, b.w, b.h)
    setTransform({ zoom: z.zoom, x: z.x + ((c.x + d.x - a.x - bb.x) / 2) * k, y: z.y + ((c.y + d.y - a.y - bb.y) / 2) * k })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const had = pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) setDragging(false)
    if (!had || pointers.current.size > 0 || gesture.current.moved) return
    const b = baseRef.current
    const v = viewNow()
    const input = sceneRef.current
    if (!b || !v || !input) return
    const [px, py] = toCanvasPx(e.currentTarget, e.clientX, e.clientY)
    const hit = hitPlayer(input.players, v, px, py, TOKEN_RADIUS * 1.8 * b.dpr)
    callbacks.current.onSelect(hit === input.selected ? null : hit)
  }

  const onPointerLeave = () => {
    setHoverAny(false)
    callbacks.current.onHover(null)
  }

  const zoomed = zoomPct > 101

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId)
          gesture.current.moved = true
          setDragging(false)
        }}
        onPointerLeave={onPointerLeave}
        aria-label="2D map"
        role="img"
        style={{ touchAction: 'none' }}
        className={`block h-full w-full ${dragging ? 'cursor-grabbing' : hoverAny ? 'cursor-pointer' : zoomed ? 'cursor-grab' : 'cursor-default'}`}
      />
      {children}
      <div className="absolute bottom-3 right-3 flex flex-col items-stretch overflow-hidden rounded-lg border border-white/10 bg-[#16181b]/85 shadow-lg backdrop-blur">
        <button
          type="button"
          title="Zoom in (+)"
          aria-label="Zoom in"
          className="flex h-8 w-8 items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white"
          onClick={() => {
            const b = baseRef.current
            if (b) setTransform(zoomAt(transformRef.current, BUTTON_STEP, b.w / 2, b.h / 2, b.w, b.h))
          }}
        >
          <Plus size={15} />
        </button>
        <div className="border-y border-white/10 py-1 text-center font-mono text-[10px] text-gray-400">{zoomPct}%</div>
        <button
          type="button"
          title="Zoom out (−)"
          aria-label="Zoom out"
          disabled={!zoomed}
          className="flex h-8 w-8 items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent"
          onClick={() => {
            const b = baseRef.current
            if (b) setTransform(zoomAt(transformRef.current, 1 / BUTTON_STEP, b.w / 2, b.h / 2, b.w, b.h))
          }}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          title="Fit map (0)"
          aria-label="Fit map"
          disabled={!zoomed}
          className="flex h-8 w-8 items-center justify-center border-t border-white/10 text-gray-300 hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent"
          onClick={() => {
            if (followRef.current) callbacks.current.onManualCamera()
            setTransform(IDENTITY)
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  )
})

function toCanvasPx(canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] {
  const r = canvas.getBoundingClientRect()
  return [((clientX - r.left) / (r.width || 1)) * canvas.width, ((clientY - r.top) / (r.height || 1)) * canvas.height]
}
