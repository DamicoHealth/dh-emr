/**
 * Counted body scroll lock - component-level probes with real React
 * StrictMode and real commit ordering. A-C assert; D-F are diagnostic probes
 * that only console.log (error paths where React's cleanup guarantees are
 * the thing under observation, not our code).
 */
import React from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { __lockDepth, useBodyScrollLock } from '../src/ui/lib/scrollLock'

const h = React.createElement

function Panel({ label }: { label: string }) {
  useBodyScrollLock(true)
  return h('div', null, label)
}

function styles() {
  const s = document.body.style
  return { overflow: s.overflow, position: s.position, top: s.top, width: s.width }
}

const CLEAN = { overflow: '', position: '', top: '', width: '' }

beforeEach(() => {
  document.body.setAttribute('style', '')
})

describe('probe', () => {
  it('A: REAL StrictMode, single panel mount/unmount', () => {
    expect(__lockDepth()).toBe(0)
    const r = render(h(React.StrictMode, null, h(Panel, { label: 'chart' })))
    console.log('A mounted:', __lockDepth(), styles())
    r.unmount()
    expect(__lockDepth()).toBe(0)
    expect(styles()).toEqual(CLEAN)
  })

  it('B: REAL StrictMode, chart -> Edit swap in ONE commit', () => {
    let setView: (v: string) => void = () => {}
    function Host() {
      const [view, sv] = React.useState('chart')
      setView = sv
      return view === 'chart'
        ? h(Panel, { key: 'chart', label: 'chart' })
        : view === 'form'
          ? h(Panel, { key: 'form', label: 'form' })
          : null
    }
    const r = render(h(React.StrictMode, null, h(Host)))
    act(() => {
      setView('form')
    })
    expect(styles().position).toBe('fixed')
    r.unmount()
    expect(__lockDepth()).toBe(0)
    expect(styles()).toEqual(CLEAN)
  })

  it('C: both panels overlap then unmount in odd order', () => {
    let set: (s: { chart: boolean; form: boolean }) => void = () => {}
    function Host() {
      const [s, ss] = React.useState({ chart: true, form: false })
      set = ss
      return h(
        React.Fragment,
        null,
        s.chart ? h(Panel, { key: 'chart', label: 'chart' }) : null,
        s.form ? h(Panel, { key: 'form', label: 'form' }) : null,
      )
    }
    const r = render(h(Host))
    act(() => set({ chart: true, form: true }))
    act(() => set({ chart: false, form: true }))
    expect(styles().position).toBe('fixed')
    act(() => set({ chart: false, form: false }))
    expect(__lockDepth()).toBe(0)
    expect(styles()).toEqual(CLEAN)
    r.unmount()
  })

  it('D: error boundary catches a throw from a sibling while lock is held', () => {
    class EB extends React.Component<{ children?: React.ReactNode }, { failed: boolean }> {
      override state = { failed: false }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      override render() {
        return this.state.failed ? h('div', null, 'fallback') : this.props.children
      }
    }
    let boom: (b: boolean) => void = () => {}
    function Bomb() {
      const [on, set] = React.useState(false)
      boom = set
      if (on) throw new Error('render blew up')
      return null
    }
    function Host() {
      return h(EB, null, h(Panel, { label: 'form' }), h(Bomb))
    }
    const r = render(h(Host))
    console.log('D mounted:', __lockDepth(), styles())
    act(() => boom(true))
    console.log('D after crash:', __lockDepth(), styles())
    r.unmount()
    console.log('D after unmount:', __lockDepth(), styles())
  })

  it('E: sibling cleanup throws during unmount', () => {
    // Bad declared BEFORE Panel so its destroy runs first.
    function Bad() {
      React.useEffect(() => {
        return () => {
          throw new Error('cleanup blew up')
        }
      }, [])
      return null
    }
    function Host() {
      return h(React.Fragment, null, h(Bad), h(Panel, { label: 'form' }))
    }
    const r = render(h(Host))
    console.log('E mounted:', __lockDepth(), styles())
    try {
      r.unmount()
    } catch (e) {
      console.log('E unmount threw:', (e as Error).message)
    }
    console.log('E after unmount:', __lockDepth(), styles())
  })

  it('F: mount and unmount before passive effects flush', () => {
    function Host() {
      const [show, set] = React.useState(true)
      React.useLayoutEffect(() => {
        set(false)
      }, [])
      return show ? h(Panel, { label: 'form' }) : null
    }
    const r = render(h(Host))
    console.log('F:', __lockDepth(), styles())
    r.unmount()
    console.log('F after unmount:', __lockDepth(), styles())
  })
})
