import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional compact fallback for scoped boundaries (e.g. a 3D canvas that
   *  can't get a WebGL context). When omitted, the full-screen reload UI
   *  is used — that's the app-level default. */
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

/**
 * App-level error boundary. Before this existed, ANY uncaught error — e.g. a
 * WebGL context failing to create inside a background-shader effect — unmounted
 * the whole React tree and left the user on a blank black page. This catches
 * render/effect errors, shows a minimal recoverable screen, and lets the user
 * reload or continue via state reset.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return <>{this.props.fallback}</>
      return (
        <div className="grid min-h-screen place-items-center bg-black px-6 text-white">
          <div className="max-w-md text-center">
            <div className="font-mono-display text-[10px] uppercase tracking-[0.3em] text-white/40">Something broke</div>
            <h1 className="mt-3 font-garamond text-3xl text-white/95">The workspace hit an error</h1>
            <p className="mt-3 break-words font-mono text-[11px] leading-relaxed text-[#f0b0a6]">
              {this.state.error.message.slice(0, 300)}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 cursor-pointer rounded-full bg-white px-6 py-2.5 font-mono-display text-[11px] uppercase tracking-[0.2em] text-black transition-all hover:bg-white/85"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
