import { GestureType } from './GestureManager';

type TabId = 'marketplace' | 'terminal' | 'vault';

interface AppActions {
  switchTab: (tab: TabId) => void;
  nextTab: () => void;
  prevTab: () => void;
  cycleTheme: () => void;
  selectModel: (modelId: string) => void;
  scroll: (offset: number) => void;
  triggerSelect: () => void;
}

let appActions: AppActions | null = null;

export function registerAppActions(actions: AppActions) {
  appActions = actions;
}

export function unregisterAppActions() {
  appActions = null;
}

export class ActionController {
  private lastActionTime: number = 0;
  private lastScrollY: number | null = null;
  private readonly COOLDOWN_MS = 800;

  public executeAction(gesture: GestureType, handPosition?: { x: number; y: number }) {
    const now = Date.now();
    const isScroll = gesture === 'SCROLL_UP' || gesture === 'SCROLL_DOWN';

    if (isScroll) {
      if (handPosition) {
        if (this.lastScrollY === null) {
          this.lastScrollY = handPosition.y;
        } else {
          const dy = handPosition.y - this.lastScrollY;
          // Scale normalized y-movement to window height for smooth continuous scroll
          const scrollAmount = dy * window.innerHeight * 1.8;
          
          window.scrollBy({
            top: scrollAmount,
            behavior: 'auto' // Instant scroll for exact analog tracking
          });
          
          this.lastScrollY = handPosition.y;
        }
      }
      return;
    }

    // Reset scroll memory when not scrolling
    this.lastScrollY = null;

    if (now - this.lastActionTime < this.COOLDOWN_MS) return;
    this.lastActionTime = now;

    switch (gesture) {
      case 'OPEN_SELECT':
        this.triggerSelect(handPosition);
        break;
      case 'SWITCH_TAB_NEXT':
        appActions?.nextTab();
        break;
      case 'SWITCH_TAB_PREV':
        appActions?.prevTab();
        break;
      case 'SWITCH_THEME':
        appActions?.cycleTheme();
        break;
      case 'SELECT_MODEL':
        this.triggerModelSelect(handPosition);
        break;
      default:
        break;
    }
  }

  private triggerSelect(handPosition?: { x: number; y: number }) {
    const event = new CustomEvent('gesture-select', {
      detail: { timestamp: Date.now(), position: handPosition }
    });
    window.dispatchEvent(event);

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.click();
    }
    console.log('Gesture Action: Select/Open triggered');
  }

  private triggerModelSelect(handPosition?: { x: number; y: number }) {
    const event = new CustomEvent('gesture-select-model', {
      detail: { timestamp: Date.now(), position: handPosition }
    });
    window.dispatchEvent(event);
    console.log('Gesture Action: Select Model triggered at', handPosition);
  }
}
