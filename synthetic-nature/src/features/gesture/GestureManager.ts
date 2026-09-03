import { Hands, HAND_CONNECTIONS } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';

export type GestureType =
  | 'SCROLL_UP'
  | 'SCROLL_DOWN'
  | 'OPEN_SELECT'
  | 'SWITCH_TAB_NEXT'
  | 'SWITCH_TAB_PREV'
  | 'SWITCH_THEME'
  | 'SELECT_MODEL'
  | 'NONE';

export interface GestureState {
  gesture: GestureType;
  landmarks: any[];
  handPosition?: { x: number; y: number };
  confidence?: number;
}

export class GestureManager {
  private hands: Hands;
  private camera: Camera | null = null;
  private onGestureCallback: (state: GestureState) => void;
  private videoElement: HTMLVideoElement;
  private canvasElement: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private isRunning: boolean = false;
  private handsInitialized: boolean = false;
  private latestLandmarks: any[] = [];

  public getLatestLandmarks(): any[] {
    return this.latestLandmarks;
  }

  // Gesture state tracking
  private gestureCooldowns: Map<GestureType, number> = new Map();
  private readonly COOLDOWN_MS = 800;

  // Hand position history for swipe detection
  private wristHistory: { x: number; y: number; time: number }[] = [];
  private readonly HISTORY_MAX = 10;

  constructor(
    videoElement: HTMLVideoElement,
    canvasElement: HTMLCanvasElement,
    onGesture: (state: GestureState) => void
  ) {
    this.videoElement = videoElement;
    this.canvasElement = canvasElement;
    this.ctx = canvasElement.getContext('2d')!;
    this.onGestureCallback = onGesture;

    this.hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });

    this.hands.onResults(this.onResults.bind(this));
  }

  private onResults(results: any) {
    if (!this.isRunning) return;
    if (!this.ctx) return;

    try {
      this.ctx.save();
      this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);

      if (results.image) {
        this.ctx.drawImage(results.image, 0, 0, this.canvasElement.width, this.canvasElement.height);
      }

      let gesture: GestureType = 'NONE';
      let handPosition: { x: number; y: number } | undefined;
      let confidence = 0;

      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        this.latestLandmarks = landmarks;

        if (landmarks && landmarks.length >= 21) {
          // Draw landmarks
          drawConnectors(this.ctx, landmarks, HAND_CONNECTIONS, { color: '#00FFCC', lineWidth: 2 });
          drawLandmarks(this.ctx, landmarks, { color: '#FFFFFF', lineWidth: 1, radius: 2 });

          // Get wrist position for hand tracking
          const wrist = landmarks[0];
          handPosition = { x: wrist.x, y: wrist.y };

          // Track wrist position history
          this.wristHistory.push({ x: wrist.x, y: wrist.y, time: Date.now() });
          if (this.wristHistory.length > this.HISTORY_MAX) {
            this.wristHistory.shift();
          }

          gesture = this.detectGesture(landmarks);
          confidence = this.calculateConfidence(landmarks, gesture);
        }
      } else {
        this.latestLandmarks = [];
      }

      this.ctx.restore();
      this.onGestureCallback({ gesture, landmarks: results.multiHandLandmarks || [], handPosition, confidence });
    } catch (error) {
      console.error('Error in onResults:', error);
      this.ctx.restore();
    }
  }

  private calculateConfidence(landmarks: any[], gesture: GestureType): number {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const pinkyTip = landmarks[20];
    const wrist = landmarks[0];
    const thumbMcp = landmarks[2];
    const indexMcp = landmarks[5];
    const middleMcp = landmarks[9];
    const ringMcp = landmarks[13];
    const pinkyMcp = landmarks[17];

    if (!thumbTip || !indexTip || !middleTip || !wrist) return 0;

    // Pinch confidence
    if (gesture === 'OPEN_SELECT') {
      const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      return Math.max(0, 1 - pinchDist / 0.08);
    }

    // Swipe confidence - check finger extension
    if (gesture === 'SWITCH_TAB_NEXT' || gesture === 'SWITCH_TAB_PREV' || gesture === 'SWITCH_THEME') {
      const indexExtended = indexTip.y < indexMcp.y - 0.05;
      const middleExtended = middleTip.y < middleMcp.y - 0.05;
      const ringExtended = ringTip.y < ringMcp.y - 0.05;
      const pinkyExtended = pinkyTip.y < pinkyMcp.y - 0.05;

      const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended].filter(Boolean).length;
      const thumbFolded = thumbTip.x > thumbMcp.x;

      if (extendedCount >= 3 && thumbFolded) return 0.8;
      return 0.3;
    }

    // Scroll confidence
    if (gesture === 'SCROLL_UP' || gesture === 'SCROLL_DOWN') {
      const tipY = middleTip.y;
      const wristY = wrist.y;
      const diff = Math.abs(tipY - wristY);
      return Math.min(1, diff / 0.3);
    }

    // Select model - pinch with extended other fingers
    if (gesture === 'SELECT_MODEL') {
      const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
      const middleExtended = middleTip.y < middleMcp.y - 0.03;
      const ringExtended = ringTip.y < ringMcp.y - 0.03;
      if (pinchDist < 0.06 && middleExtended && ringExtended) return 0.85;
      return 0.2;
    }

    return 0;
  }

  private detectGesture(landmarks: any[]): GestureType {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const pinkyTip = landmarks[20];
    const wrist = landmarks[0];
    const thumbMcp = landmarks[2];
    const indexMcp = landmarks[5];
    const middleMcp = landmarks[9];
    const ringMcp = landmarks[13];
    const pinkyMcp = landmarks[17];

    if (!thumbTip || !indexTip || !middleTip || !wrist) return 'NONE';

    // Check cooldown
    const now = Date.now();
    const isCooldown = (g: GestureType) => {
      const lastTime = this.gestureCooldowns.get(g) || 0;
      const cooldown = (g === 'SCROLL_UP' || g === 'SCROLL_DOWN') ? 16 : this.COOLDOWN_MS;
      return now - lastTime < cooldown;
    };

    // Load calibrated thresholds
    let calibratedPinch = 0.05;
    let calibratedScrollUp = 0.15;
    let calibratedScrollDown = 0.1;

    try {
      const stored = localStorage.getItem('enzo.gesture.calibration');
      if (stored) {
        const profile = JSON.parse(stored);
        if (profile.pinch) calibratedPinch = profile.pinch;
        if (profile.scrollUp) calibratedScrollUp = profile.scrollUp;
        if (profile.scrollDown) calibratedScrollDown = profile.scrollDown;
      }
    } catch (e) {
      console.error('Failed to parse calibration:', e);
    }

    // 1. Pinch (Open/Select): thumb + index tips close
    const pinchDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
    if (pinchDist < calibratedPinch) {
      // Check if it's a SELECT_MODEL gesture (pinch + other fingers extended)
      const middleExtended = middleTip && middleMcp && middleTip.y < middleMcp.y - 0.03;
      const ringExtended = ringTip && ringMcp && ringTip.y < ringMcp.y - 0.03;
      const pinkyFolded = pinkyTip && pinkyMcp && pinkyTip.y > pinkyMcp.y;

      if (middleExtended && ringExtended && pinkyFolded && !isCooldown('SELECT_MODEL')) {
        this.gestureCooldowns.set('SELECT_MODEL', now);
        return 'SELECT_MODEL';
      }

      if (!isCooldown('OPEN_SELECT')) {
        this.gestureCooldowns.set('OPEN_SELECT', now);
        return 'OPEN_SELECT';
      }
      return 'NONE';
    }

    // 2. Swipe gestures - detect horizontal hand movement
    if (this.wristHistory.length >= 5) {
      const oldest = this.wristHistory[0];
      const newest = this.wristHistory[this.wristHistory.length - 1];
      const dx = newest.x - oldest.x;
      const dt = newest.time - oldest.time;

      // Significant horizontal movement (swipe)
      if (Math.abs(dx) > 0.15 && dt < 500) {
        // Check hand orientation - fingers extended, thumb folded
        const indexExtended = indexTip.y < indexMcp.y - 0.05;
        const middleExtended = middleTip.y < middleMcp.y - 0.05;
        const ringExtended = ringTip && ringMcp && ringTip.y < ringMcp.y - 0.05;
        const pinkyExtended = pinkyTip && pinkyMcp && pinkyTip.y < pinkyMcp.y - 0.05;
        const thumbFolded = thumbTip.x > thumbMcp.x + 0.02;

        const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended].filter(Boolean).length;

        if (extendedCount >= 3 && thumbFolded) {
          if (dx > 0 && !isCooldown('SWITCH_TAB_NEXT')) {
            this.gestureCooldowns.set('SWITCH_TAB_NEXT', now);
            return 'SWITCH_TAB_NEXT'; // Swipe right -> next tab
          }
          if (dx < 0 && !isCooldown('SWITCH_TAB_PREV')) {
            this.gestureCooldowns.set('SWITCH_TAB_PREV', now);
            return 'SWITCH_TAB_PREV'; // Swipe left -> prev tab
          }
        }
      }
    }

    // 3. Theme switch - vertical swipe with open palm
    if (this.wristHistory.length >= 5) {
      const oldest = this.wristHistory[0];
      const newest = this.wristHistory[this.wristHistory.length - 1];
      const dt = newest.time - oldest.time;
      const dy = newest.y - oldest.y;

      if (Math.abs(dy) > 0.15 && dt < 500) {
        // Open palm - all fingers extended
        const indexExtended = indexTip.y < indexMcp.y - 0.05;
        const middleExtended = middleTip.y < middleMcp.y - 0.05;
        const ringExtended = ringTip && ringMcp && ringTip.y < ringMcp.y - 0.05;
        const pinkyExtended = pinkyTip && pinkyMcp && pinkyTip.y < pinkyMcp.y - 0.05;
        const thumbExtended = thumbTip.x < thumbMcp.x - 0.02;

        const extendedCount = [indexExtended, middleExtended, ringExtended, pinkyExtended, thumbExtended].filter(Boolean).length;

        if (extendedCount >= 4 && !isCooldown('SWITCH_THEME')) {
          this.gestureCooldowns.set('SWITCH_THEME', now);
          return 'SWITCH_THEME';
        }
      }
    }

    // 4. Scroll Up/Down based on finger orientation relative to wrist
    const avgTipY = (indexTip.y + middleTip.y) / 2;
    const wristY = wrist.y;

    // Pointing up (index + middle extended up, ring + pinky folded)
    const indexUp = indexTip.y < indexMcp.y - 0.05;
    const middleUp = middleTip.y < middleMcp.y - 0.05;
    const twoFingersUp = indexUp && middleUp;
    const ringPinkyFoldedUp = (ringTip.y > indexTip.y + 0.05) && (pinkyTip.y > indexTip.y + 0.05);

    if (twoFingersUp && ringPinkyFoldedUp && avgTipY < wristY - calibratedScrollUp) {
      if (!isCooldown('SCROLL_UP')) {
        this.gestureCooldowns.set('SCROLL_UP', now);
        return 'SCROLL_UP';
      }
    }

    // Pointing down (index + middle pointing down, ring + pinky folded/higher)
    const indexDown = indexTip.y > indexMcp.y + 0.05;
    const middleDown = middleTip.y > middleMcp.y + 0.05;
    const twoFingersDown = indexDown && middleDown;
    const ringPinkyFoldedDown = (ringTip.y < indexTip.y - 0.05) && (pinkyTip.y < indexTip.y - 0.05);

    if (twoFingersDown && ringPinkyFoldedDown && avgTipY > wristY + calibratedScrollDown) {
      if (!isCooldown('SCROLL_DOWN')) {
        this.gestureCooldowns.set('SCROLL_DOWN', now);
        return 'SCROLL_DOWN';
      }
    }

    return 'NONE';
  }

  public async start() {
    if (this.isRunning) return;

    this.isRunning = true;

    try {
      this.camera = new Camera(this.videoElement, {
        onFrame: async () => {
          if (!this.isRunning || !this.hands) return;
          try {
            await this.hands.send({ image: this.videoElement });
          } catch (error) {
            console.error('Error sending frame to hands:', error);
          }
        },
        width: 640,
        height: 480,
      });

      await this.camera.start();
      this.handsInitialized = true;
    } catch (error) {
      this.isRunning = false;
      this.handsInitialized = false;
      throw error;
    }
  }

  public async stop() {
    this.isRunning = false;

    if (this.camera) {
      try {
        await this.camera.stop();
      } catch (error) {
        console.error('Error stopping camera:', error);
      }
      this.camera = null;
    }

    if (this.hands && this.handsInitialized) {
      try {
        this.hands.close();
      } catch (error) {
        console.error('Error closing hands:', error);
      }
      this.handsInitialized = false;
    }
  }
}