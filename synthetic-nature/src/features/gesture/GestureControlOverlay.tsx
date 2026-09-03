import { useEffect, useRef, useState, useCallback } from 'react';
import { GestureManager, GestureState } from './GestureManager';
import { ActionController, registerAppActions, unregisterAppActions } from './ActionController';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, CameraOff, HelpCircle, Activity, Sparkles, Eye, X } from 'lucide-react';
import * as keyVault from '../../lib/keyVault';

export function GestureControlOverlay() {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState<'idle' | 'initializing' | 'active' | 'error'>('idle');
  const [showGuide, setShowGuide] = useState(false);
  const [showCalibrate, setShowCalibrate] = useState(false);
  const [showVision, setShowVision] = useState(false);
  
  // Calibration states
  const [calibrateStep, setCalibrateStep] = useState(0);
  const [calibrateError, setCalibrateError] = useState<string | null>(null);
  const [calibrateSuccess, setCalibrateSuccess] = useState(false);
  const [recordedValues, setRecordedValues] = useState<Record<string, number>>({});

  // Vision states
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [visionResult, setVisionResult] = useState<string | null>(null);
  const [visionError, setVisionError] = useState<string | null>(null);

  // Virtual Cursor states
  const [virtualCursor, setVirtualCursor] = useState<{ x: number; y: number } | null>(null);
  const [isPinching, setIsPinching] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const managerRef = useRef<GestureManager | null>(null);
  const controllerRef = useRef<ActionController | null>(null);

  // Refs for low-pass smooth cursor filters
  const targetCursorRef = useRef<{ x: number; y: number } | null>(null);
  const currentCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastUpdateRef = useRef<number>(0);
  const wasPinchingRef = useRef<boolean>(false);
  const isScrollingRef = useRef<boolean>(false);

  const appActions = useCallback(() => {
    return {
      switchTab: (tab: 'marketplace' | 'terminal' | 'vault') => {
        window.dispatchEvent(new CustomEvent('gesture-switch-tab', { detail: { tab } }));
      },
      nextTab: () => {
        window.dispatchEvent(new CustomEvent('gesture-next-tab'));
      },
      prevTab: () => {
        window.dispatchEvent(new CustomEvent('gesture-prev-tab'));
      },
      cycleTheme: () => {
        window.dispatchEvent(new CustomEvent('gesture-cycle-theme'));
      },
      selectModel: (modelId: string) => {
        window.dispatchEvent(new CustomEvent('gesture-select-model', { detail: { modelId } }));
      },
      scroll: (offset: number) => {
        window.scrollBy({ top: offset, behavior: 'smooth' });
      },
      triggerSelect: (position?: { x: number; y: number }) => {
        window.dispatchEvent(new CustomEvent('gesture-select', { detail: { position } }));
      },
    };
  }, []);

  // Update cursor position loop
  useEffect(() => {
    let animId: number;

    const updateCursor = () => {
      if (isEnabled && targetCursorRef.current && !isScrollingRef.current) {
        // Reset/Hide if hand leaves screen for over 1 second
        if (Date.now() - lastUpdateRef.current > 1000) {
          setVirtualCursor(null);
          targetCursorRef.current = null;
        } else {
          // Low-pass filter smoothing (75% history + 25% new)
          currentCursorRef.current.x = currentCursorRef.current.x * 0.75 + targetCursorRef.current.x * 0.25;
          currentCursorRef.current.y = currentCursorRef.current.y * 0.75 + targetCursorRef.current.y * 0.25;
          
          setVirtualCursor({ x: currentCursorRef.current.x, y: currentCursorRef.current.y });

          // Simulate real hover elements
          const hoverElement = document.elementFromPoint(currentCursorRef.current.x, currentCursorRef.current.y);
          if (hoverElement) {
            const moveEvent = new MouseEvent('mousemove', {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: currentCursorRef.current.x,
              clientY: currentCursorRef.current.y
            });
            hoverElement.dispatchEvent(moveEvent);
          }
        }
      } else {
        setVirtualCursor(null);
      }
      animId = requestAnimationFrame(updateCursor);
    };

    updateCursor();
    return () => cancelAnimationFrame(animId);
  }, [isEnabled]);

  useEffect(() => {
    registerAppActions(appActions());

    if (isEnabled) {
      initGestureControl();
    } else {
      stopGestureControl();
    }
    return () => {
      stopGestureControl();
      unregisterAppActions();
    };
  }, [isEnabled, appActions]);

  const simulateClick = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    if (!element) return;

    if (element instanceof HTMLElement) {
      element.focus();
    }

    const downEvent = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
    });
    const upEvent = new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
    });
    const clickEvent = new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
    });

    element.dispatchEvent(downEvent);
    element.dispatchEvent(upEvent);
    element.dispatchEvent(clickEvent);
  };

  const initGestureControl = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setStatus('initializing');
    try {
      controllerRef.current = new ActionController();

      managerRef.current = new GestureManager(
        videoRef.current,
        canvasRef.current,
        (state: GestureState) => {
          controllerRef.current?.executeAction(state.gesture, state.handPosition);

          // Detect scroll gesture
          const isScrollActive = state.gesture === 'SCROLL_UP' || state.gesture === 'SCROLL_DOWN';
          isScrollingRef.current = isScrollActive;

          // Get index finger tip coordinate (landmark 8)
          const indexTip = state.landmarks?.[0]?.[8];
          const indexMcp = state.landmarks?.[0]?.[5];
          const middleTip = state.landmarks?.[0]?.[12];

          const indexExtended = indexTip && indexMcp && indexTip.y < indexMcp.y - 0.04;
          const middleFolded = indexTip && middleTip && middleTip.y > indexTip.y + 0.05;

          const isOnlyIndexPointing = indexExtended && middleFolded;

          if (isOnlyIndexPointing && !isScrollActive) {
            targetCursorRef.current = {
              x: (1 - indexTip.x) * window.innerWidth,
              y: indexTip.y * window.innerHeight
            };
            lastUpdateRef.current = Date.now();
          } else {
            targetCursorRef.current = null;
          }

          // Detect Pinch gesture for click tap selection
          const currentlyPinching = state.gesture === 'OPEN_SELECT';
          setIsPinching(currentlyPinching);

          if (currentlyPinching && !wasPinchingRef.current && !isScrollActive) {
            const x = currentCursorRef.current.x || targetCursorRef.current?.x;
            const y = currentCursorRef.current.y || targetCursorRef.current?.y;
            if (x && y) {
              simulateClick(x, y);
            }
          }
          wasPinchingRef.current = currentlyPinching;
        }
      );

      await managerRef.current.start();
      setStatus('active');
    } catch (error) {
      console.error('Failed to initialize gesture control:', error);
      setStatus('error');
      setIsEnabled(false);
    }
  };

  const stopGestureControl = async () => {
    if (managerRef.current) {
      await managerRef.current.stop();
      managerRef.current = null;
    }
    setStatus('idle');
  };

  const startCalibration = () => {
    if (!isEnabled) {
      setIsEnabled(true);
    }
    setCalibrateStep(0);
    setCalibrateError(null);
    setCalibrateSuccess(false);
    setRecordedValues({});
    setShowCalibrate(true);
  };

  const captureCalibrationGesture = () => {
    if (!managerRef.current) {
      setCalibrateError('Gesture processor is not ready.');
      return;
    }

    const landmarks = managerRef.current.getLatestLandmarks();
    if (!landmarks || landmarks.length === 0) {
      setCalibrateError('⚠️ Hand not detected in camera view. Adjust lighting or hold hand closer.');
      return;
    }

    setCalibrateError(null);

    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const wrist = landmarks[0];

    if (calibrateStep === 0) {
      const dist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      const pinchThreshold = Math.max(0.04, Math.min(0.08, dist + 0.02));
      setRecordedValues(prev => ({ ...prev, pinch: pinchThreshold }));
      setCalibrateStep(1);
    } else if (calibrateStep === 1) {
      const distY = Math.abs(middleTip.y - wrist.y);
      const scrollUpThreshold = Math.max(0.08, Math.min(0.22, distY * 0.45));
      setRecordedValues(prev => ({ ...prev, scrollUp: scrollUpThreshold }));
      setCalibrateStep(2);
    } else if (calibrateStep === 2) {
      const distY = Math.abs(middleTip.y - wrist.y);
      const scrollDownThreshold = Math.max(0.06, Math.min(0.18, distY * 0.35));
      
      const calibrationProfile = {
        pinch: recordedValues.pinch,
        scrollUp: recordedValues.scrollUp,
        scrollDown: scrollDownThreshold
      };

      localStorage.setItem('enzo.gesture.calibration', JSON.stringify(calibrationProfile));
      setCalibrateSuccess(true);
      setCalibrateStep(3);
    }
  };

  const resetCalibration = () => {
    localStorage.removeItem('enzo.gesture.calibration');
    setCalibrateSuccess(false);
    setCalibrateStep(0);
    setShowCalibrate(false);
  };

  const handleAnalyzePose = async () => {
    if (!canvasRef.current) return;
    
    setIsAnalyzing(true);
    setVisionResult(null);
    setVisionError(null);
    setShowVision(true);

    try {
      const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.85);

      const res = await fetch('/api/vision/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-groq-key': keyVault.getItem('enzo.keys.groq') || '',
          'x-nvidia-key': keyVault.getItem('enzo.keys.nvidia') || keyVault.getItem('enzo-nvidia-key') || '',
          'x-openrouter-key': keyVault.getItem('enzo.keys.openrouter') || keyVault.getItem('enzo-openrouter-key') || '',
        },
        body: JSON.stringify({ image: dataUrl })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to complete vision analysis.');
      }

      const data = await res.json();
      setVisionResult(data.analysis);
    } catch (err: any) {
      setVisionError(err.message || 'Vision analysis failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const calibrateStepsInfo = [
    { title: 'Open select / click', prompt: 'Touch thumb and index tips together (Pinch Pose) and click Capture.' },
    { title: 'Scroll Up', prompt: 'Point your index and middle fingers straight up, keeping ring/pinky folded, then click Capture.' },
    { title: 'Scroll Down', prompt: 'Point your index and middle fingers down, keeping ring/pinky folded, then click Capture.' },
  ];

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-4">
      {/* Virtual Cursor Target Reticle */}
      <AnimatePresence>
        {isEnabled && virtualCursor && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            style={{
              position: 'fixed',
              left: virtualCursor.x,
              top: virtualCursor.y,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 999999,
            }}
            className="flex items-center justify-center pointer-events-none"
          >
            {/* Custom glowing target circle */}
            <div 
              className={`
                rounded-full border-2 transition-all duration-150 flex items-center justify-center
                ${isPinching 
                  ? 'h-5 w-5 border-emerald-400 bg-emerald-500/40 scale-90 shadow-[0_0_15px_rgba(52,211,153,0.6)]' 
                  : 'h-9 w-9 border-cyan-400 bg-cyan-400/5 animate-pulse shadow-[0_0_10px_rgba(34,211,238,0.2)]'}
              `}
            >
              <div 
                className={`
                  h-1.5 w-1.5 rounded-full transition-colors
                  ${isPinching ? 'bg-emerald-300' : 'bg-cyan-300'}
                `}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Preview Canvas */}
      <AnimatePresence>
        {isEnabled && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="relative w-48 h-36 rounded-2xl overflow-hidden border border-white/20 bg-black/60 backdrop-blur-md shadow-2xl pointer-events-auto"
          >
            <video ref={videoRef} className="hidden" playsInline muted />
            <canvas ref={canvasRef} width={640} height={480} className="w-full h-full object-cover" />
            <div className="absolute top-2 left-2 px-2 py-1 rounded-full bg-black/50 backdrop-blur-md border border-white/10 text-[8px] font-mono-display text-white/60 uppercase tracking-widest font-bold">
              Live Tracking
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Guide panel */}
      <AnimatePresence>
        {showGuide && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            className="w-80 rounded-3xl border border-white/15 bg-[#0a0a0f]/90 backdrop-blur-2xl p-5 shadow-2xl flex flex-col text-left space-y-4 pointer-events-auto"
          >
            <div className="flex justify-between items-center border-b border-white/10 pb-2.5">
              <div className="flex items-center gap-2">
                <HelpCircle size={14} className="text-cyan-400" />
                <span className="font-mono-display text-xs uppercase tracking-wider text-white">Gesture Bindings</span>
              </div>
              <button onClick={() => setShowGuide(false)} className="text-white/40 hover:text-white transition-colors">
                <X size={14} />
              </button>
            </div>

            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1 text-xs">
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Point Index Only (Hover)</span>
                <span className="text-cyan-400 font-mono">Move Cursor</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Pinch (Thumb+Index)</span>
                <span className="text-cyan-400 font-mono">Select / Click</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Swipe Right (Open Palm)</span>
                <span className="text-cyan-400 font-mono">Next Tab</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Swipe Left (Open Palm)</span>
                <span className="text-cyan-400 font-mono">Prev Tab</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Swipe Up (Open Palm)</span>
                <span className="text-cyan-400 font-mono">Cycle Theme</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Point Up (Index + Middle)</span>
                <span className="text-cyan-400 font-mono">Scroll Up (Analog)</span>
              </div>
              <div className="flex justify-between border-b border-white/5 pb-1.5">
                <span className="text-white/50">Point Down (Index + Middle)</span>
                <span className="text-cyan-400 font-mono">Scroll Down (Analog)</span>
              </div>
              <div className="flex justify-between pb-0.5">
                <span className="text-white/50">Pinch + Middle/Ring Up</span>
                <span className="text-cyan-400 font-mono">Activate Model</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Vision analysis panel */}
      <AnimatePresence>
        {showVision && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            className="w-80 rounded-3xl border border-white/15 bg-[#0a0a0f]/95 backdrop-blur-2xl p-5 shadow-2xl flex flex-col text-left space-y-4 pointer-events-auto"
          >
            <div className="flex justify-between items-center border-b border-white/10 pb-2.5">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-cyan-400" />
                <span className="font-mono-display text-xs uppercase tracking-wider text-white">AI Pose Analyzer</span>
              </div>
              <button onClick={() => setShowVision(false)} className="text-white/40 hover:text-white transition-colors">
                <X size={14} />
              </button>
            </div>

            <div className="space-y-4 text-xs font-mono-display">
              {isAnalyzing ? (
                <div className="flex flex-col items-center justify-center py-6 space-y-3">
                  <div className="h-5 w-5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
                  <span className="text-[10px] text-white/50 uppercase tracking-widest animate-pulse">Running LLM Vision Analysis…</span>
                </div>
              ) : visionError ? (
                <div className="p-3 bg-red-500/15 border border-red-500/20 text-red-300 rounded-xl leading-relaxed">
                  <span className="font-bold block mb-1">⚠️ Analysis Failed</span>
                  {visionError}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-100 rounded-xl leading-relaxed text-[12px] font-sans">
                    {visionResult}
                  </div>
                  <button
                    onClick={handleAnalyzePose}
                    className="w-full rounded-xl bg-white/10 hover:bg-white/20 text-white py-2 text-center transition-all font-mono-display uppercase tracking-widest text-[9px] cursor-pointer"
                  >
                    Analyze Again
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Calibration panel */}
      <AnimatePresence>
        {showCalibrate && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            className="w-80 rounded-3xl border border-white/15 bg-[#0a0a0f]/95 backdrop-blur-2xl p-5 shadow-2xl flex flex-col text-left space-y-4 pointer-events-auto"
          >
            <div className="flex justify-between items-center border-b border-white/10 pb-2.5">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-emerald-400" />
                <span className="font-mono-display text-xs uppercase tracking-wider text-white">AI Hand calibration</span>
              </div>
              <button onClick={() => setShowCalibrate(false)} className="text-white/40 hover:text-white transition-colors">
                <X size={14} />
              </button>
            </div>

            {calibrateSuccess ? (
              <div className="space-y-4 text-xs">
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-xl leading-relaxed">
                  ✓ Calibration complete! Your unique hand model thresholds have been saved locally. Tracking is now optimized for your hand size.
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setCalibrateSuccess(false);
                      setCalibrateStep(0);
                    }}
                    className="flex-1 rounded-xl bg-white/10 hover:bg-white/20 text-white py-2 text-center transition-all font-mono-display uppercase tracking-widest text-[10px] cursor-pointer"
                  >
                    Recalibrate
                  </button>
                  <button
                    onClick={resetCalibration}
                    className="flex-1 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-300 py-2 text-center transition-all font-mono-display uppercase tracking-widest text-[10px] cursor-pointer"
                  >
                    Clear profile
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                <div className="flex justify-between text-[10px] font-mono-display uppercase tracking-wider text-white/50">
                  <span>Step {calibrateStep + 1} of 3</span>
                  <span className="text-cyan-400">{calibrateStepsInfo[calibrateStep].title}</span>
                </div>

                <p className="text-[12px] leading-relaxed text-white/80 font-sans">
                  {calibrateStepsInfo[calibrateStep].prompt}
                </p>

                {calibrateError && (
                  <div className="p-2.5 bg-red-500/15 border border-red-500/20 text-red-300 rounded-lg text-[11px] leading-relaxed">
                    {calibrateError}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={captureCalibrationGesture}
                    className="flex-1 rounded-xl bg-white text-black py-2.5 font-bold uppercase tracking-widest text-[10px] transition-all hover:bg-white/95 cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    <Activity size={12} />
                    Capture Pose
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Button Row */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setShowGuide(false);
            setShowCalibrate(false);
            handleAnalyzePose();
          }}
          disabled={!isEnabled}
          title="Analyze Pose with AI Vision Model"
          className={`
            p-3 rounded-full transition-all border backdrop-blur-xl pointer-events-auto cursor-pointer flex items-center justify-center
            ${isEnabled 
              ? 'bg-white/10 border-white/20 text-cyan-400 hover:bg-white/20' 
              : 'bg-black/20 border-white/5 text-white/20 cursor-not-allowed'}
          `}
        >
          <Eye size={16} />
        </button>

        <button
          onClick={() => {
            setShowGuide(false);
            setShowVision(false);
            startCalibration();
          }}
          title="Calibrate gestures"
          className="bg-white/10 hover:bg-white/20 text-white/80 p-3 rounded-full transition-all border border-white/20 backdrop-blur-xl pointer-events-auto cursor-pointer flex items-center justify-center"
        >
          <Sparkles size={16} />
        </button>

        <button
          onClick={() => {
            setShowCalibrate(false);
            setShowVision(false);
            setShowGuide(!showGuide);
          }}
          title="Gesture Bindings Guide"
          className="bg-white/10 hover:bg-white/20 text-white/80 p-3 rounded-full transition-all border border-white/20 backdrop-blur-xl pointer-events-auto cursor-pointer flex items-center justify-center"
        >
          <HelpCircle size={16} />
        </button>

        {/* Main Control Button */}
        <button
          onClick={() => setIsEnabled(!isEnabled)}
          className={`
            pointer-events-auto flex items-center gap-3 px-5 py-3 rounded-full transition-all duration-300 border shadow-xl cursor-pointer
            ${isEnabled
              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400 font-semibold'
              : 'bg-white/10 border-white/20 text-white/80 hover:bg-white/20'}
            backdrop-blur-xl
          `}
        >
          {isEnabled ? <CameraOff size={16} /> : <Camera size={16} />}
          <span className="font-mono-display text-[11px] uppercase tracking-widest">
            {isEnabled ? 'Disable Gestures' : 'Enable Gestures'}
          </span>
          {status === 'initializing' && (
            <div className="h-2 w-2 rounded-full bg-white animate-ping" />
          )}
        </button>
      </div>
    </div>
  );
}
