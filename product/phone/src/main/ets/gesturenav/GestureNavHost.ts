//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Launcher-side bottom-edge swipe-up gesture host (HOME / RECENTS /
 * Overview). A port of systemui's gesture-nav ServiceExtAbility MINUS the
 * side-edge BACK gesture (which stays in systemui — see the migration plan
 * §7). Instantiated from MainAbility.initLauncher() once the desktop grid is
 * ready. It lives in the launcher because the go-home shrink (Phase 3)
 * targets the real app icon rect, which only the launcher knows.
 *
 * Owns the OniroDragOverlay window (which doubles as the Quickstep-style
 * Overview surface on RECENTS commit) and delegates all swipe recognition to
 * SwipeRecognizer (a port of AOSP Launcher3 Quickstep). This file only wires
 * inputMonitor events into the recognizer and translates its callbacks into
 * window operations.
 *
 * Differences from the systemui original (parity-only Phase 2):
 *   - No BackPanel / side-edge BACK (stays in systemui).
 *   - Foreground tracking is PUSHED in via setForegroundIsLauncher() from the
 *     launcher's own desktop WINDOW_ACTIVE/INACTIVE event (no
 *     abilityForegroundState observer, no getTopAbility sync binder).
 *   - HOME commit is windowManager.minimizeAllApps() (the launcher's native
 *     go-home) instead of startAbility(com.ohos.launcher).
 *   - Nav-mode comes from the launcher's SettingsModel + the
 *     EVENT_NAVIGATOR_BAR_STATUS_CHANGE local event instead of a fresh
 *     dataShare helper.
 */

import inputMonitor from '@ohos.multimodalInput.inputMonitor';
import display from '@ohos.display';
import window from '@ohos.window';
import { Log, SettingsModel, localEventManager, EventConstants, windowManager } from '@ohos/common';
import {
  SwipeRecognizer,
  GestureEndTarget,
  RecognizerConfig,
  CommitInfo,
  ProgressMode,
} from './recognizer/SwipeRecognizer';
import { DEFAULT_MOTION_PAUSE_CONFIG } from './recognizer/MotionPauseDetector';
import { SnapshotCapture } from './animation/SnapshotCapture';
import { DragController } from './animation/DragController';
import { WallpaperCache } from './animation/WallpaperCache';
import { RecentsLoader } from './animation/RecentsLoader';
import { findIconRect } from './findIconRect';

const TAG = 'GestureNavHost';

// Hot-zone, dock, and commit thresholds — identical to the systemui original
// (reverse-engineered StyleConstants defaults + AOSP Launcher3 Quickstep
// dimens). See systemui ServiceExtAbility for the per-value provenance.
const HOT_ZONE_VP = 32;
const TOUCH_SLOP_VP = 12;
const DOCK_SHOW_AFTER_VP = 16;
const MIN_DELTA_HOME_VP = 120;
const MIN_DELTA_RECENTS_VP = 200;
const FLING_VP_PER_MS = 0.5;
const OVERVIEW_MIN_DEGREES = 15;
const HOLD_MS = 250;
const HOLD_DRIFT_VP = 24;

// settings.display.navigationbar_status: '0' = gesture mode (nav bar hidden).
const NAV_MODE_GESTURE = '0';

// Written by systemui's phone_dropdownpanel when the panel is interactive.
// In the launcher process this is a CROSS-process read now, so it stays
// undefined until the migration plan §8 routes it via a CommonEvent/dataShare
// channel — harmless: the read just never suppresses here for now.
const APP_KEY_DROPDOWN_PANEL_OPEN = 'OniroDropdownPanelOpen';

// Touch action codes per @ohos.multimodalInput.touchEvent.Action
const TOUCH_CANCEL = 0;
const TOUCH_DOWN = 1;
const TOUCH_MOVE = 2;
const TOUCH_UP = 3;

// Mouse action codes per @ohos.multimodalInput.mouseEvent.Action
const MOUSE_CANCEL = 0;
const MOUSE_MOVE = 1;
const MOUSE_BUTTON_DOWN = 2;
const MOUSE_BUTTON_UP = 3;
const MOUSE_BUTTON_LEFT = 0;

// Mouse events don't carry a pointer ID. Use a synthetic one that can't
// collide with any real touch pointer (touch IDs are small, starting at 0).
const MOUSE_POINTER_ID = 1000;

enum PanGestureType {
  DEFAULT = 0,
  GAME_OPERATE = 1,
}

export class GestureNavHost {
  private context;
  private screenHeightPx = 0;
  private screenWidthPx = 0;
  private vpToPx = 1;

  private recognizer: SwipeRecognizer | null = null;

  private touchReceiver = (ev) => this.handleTouch(ev);
  private mouseReceiver = (ev) => this.handleMouse(ev);
  private monitorActive = false;
  private mouseButtonDown = false;
  // Once we accept a DOWN in the bottom hot zone, every subsequent MOVE/UP
  // for that pointer is also consumed so the foreground app doesn't see half
  // a touch stream. Reset to null on UP / CANCEL. Single-pointer model.
  private consumingPointerId: number | null = null;

  // Is the launcher (home screen) the current foreground? PUSHED in by
  // MainAbility from the desktop window's WINDOW_ACTIVE/INACTIVE event — no
  // sync binder, no observer. Used only to decide whether a swipe started on
  // the launcher (Overview = recents only, no foreground card). Defaults true:
  // the host starts on the home screen.
  private foregroundIsLauncher = true;

  private dragWindow: window.Window | null = null;
  private dragShown = false;
  private snapshotCapture: SnapshotCapture = new SnapshotCapture();
  private dragController: DragController | null = null;
  private wallpaperCache: WallpaperCache = new WallpaperCache();
  private recentsLoader: RecentsLoader = new RecentsLoader();
  // True from onCommit until the post-spring teardown completes — suppresses
  // the synchronous onReset path so the spring runs to settle.
  private commitAnimating = false;
  // True from a RECENTS commit's spring settle until the user dismisses — the
  // drag overlay is "live" as the Overview surface.
  private inRecentsMode = false;

  private navMode: string = '1';
  private navListener = null;

  constructor(context) {
    this.context = context;
  }

  start(): void {
    Log.showInfo(TAG, 'start');
    try {
      const d = display.getDefaultDisplaySync();
      this.screenHeightPx = d.height;
      this.screenWidthPx = d.width;
      this.vpToPx = d.densityPixels;
      Log.showInfo(TAG, `display ${d.width}x${d.height} densityPx=${d.densityPixels}`);
    } catch (err) {
      Log.showError(TAG, `getDefaultDisplaySync failed: ${JSON.stringify(err)}`);
    }
    this.dragController = new DragController({
      vpToPx: this.vpToPx,
      screenWidthPx: this.screenWidthPx,
      screenHeightPx: this.screenHeightPx,
    });
    // Wallpaper is best-effort; if the fetch fails the wallpaper layer in
    // DragOverlay.ets just doesn't paint.
    this.wallpaperCache.load();
    this.recognizer = this.buildRecognizer();
    this.initDragWindow();
    this.initNavModeSubscription();
  }

  destroy(): void {
    Log.showInfo(TAG, 'destroy');
    this.stopMonitor();
    if (this.navListener) {
      try {
        localEventManager.unregisterEventListener(this.navListener);
      } catch (e) {
        Log.showWarn(TAG, `unregister nav listener failed: ${JSON.stringify(e)}`);
      }
      this.navListener = null;
    }
    if (this.dragWindow) {
      this.dragWindow.destroyWindow().catch((e) => {
        Log.showWarn(TAG, `destroy drag failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow = null;
    }
    this.wallpaperCache.stop();
    this.snapshotCapture.clear();
  }

  /**
   * Pushed by MainAbility on the desktop window's WINDOW_ACTIVE (launcher
   * foreground → true) / WINDOW_INACTIVE (an app foreground → false). Replaces
   * systemui's abilityForegroundState observer + getTopAbility seed.
   */
  setForegroundIsLauncher(isLauncher: boolean): void {
    if (isLauncher !== this.foregroundIsLauncher) {
      this.foregroundIsLauncher = isLauncher;
      Log.showInfo(TAG, `foregroundIsLauncher -> ${isLauncher}`);
    }
  }

  // ---- Recognizer wiring ------------------------------------------------

  private resetOverlayForGesture(): void {
    if (this.dragWindow && (this.inRecentsMode || this.dragShown)) {
      this.dragWindow.setWindowFocusable(false).catch((e) => {
        Log.showWarn(TAG, `pre-gesture setFocusable failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow.setWindowTouchable(false).catch((e) => {
        Log.showWarn(TAG, `pre-gesture setTouchable failed: ${JSON.stringify(e)}`);
      });
    }
    this.inRecentsMode = false;
    this.dragShown = false;
  }

  private buildRecognizer(): SwipeRecognizer {
    const cfg: RecognizerConfig = {
      vpToPx: this.vpToPx,
      screenHeightPx: this.screenHeightPx,
      hotZoneVp: HOT_ZONE_VP,
      touchSlopVp: TOUCH_SLOP_VP,
      dockShowAfterVp: DOCK_SHOW_AFTER_VP,
      minDeltaHomeVp: MIN_DELTA_HOME_VP,
      minDeltaRecentsVp: MIN_DELTA_RECENTS_VP,
      flingVpPerMs: FLING_VP_PER_MS,
      overviewMinDegrees: OVERVIEW_MIN_DEGREES,
      holdMs: HOLD_MS,
      holdDriftVp: HOLD_DRIFT_VP,
      motionPause: DEFAULT_MOTION_PAUSE_CONFIG,
    };
    return new SwipeRecognizer(cfg, {
      onTrackingStart: (_sx: number, _sy: number) => {
        Log.showDebug(TAG, 'recognizer: tracking start (slop passed)');
        this.resetOverlayForGesture();
        // Starting on the launcher? Then there's no foreground app to peel:
        // the row is the recents only, centered on the most-recent.
        const fromLauncher = this.foregroundIsLauncher;
        AppStorage.SetOrCreate('OniroDragFromLauncher', fromLauncher);
        this.dragController?.setHasForegroundCard(!fromLauncher);
        this.dragController?.start();
        this.recentsLoader.load(fromLauncher).then(() => {
          this.dragController?.setRecentsCount(this.recentsLoader.count());
        });
        this.snapshotCapture.capture(this.screenWidthPx, this.screenHeightPx)
          .then((elapsed) => {
            if (elapsed < 0) return;          // capture failed
            if (!this.recognizer?.isActive()) return; // gesture already over
            this.showDragOverlay();
          });
      },
      onProgress: (deltaVp: number, _mode: ProgressMode, lastX: number, lastY: number) => {
        this.dragController?.onProgress(deltaVp, lastX, lastY);
      },
      onCommit: (target: GestureEndTarget, info: CommitInfo) => {
        this.handleCommit(target, info);
      },
      onReset: () => {
        if (!this.commitAnimating) {
          this.dragController?.reset();
          this.hideDragOverlay();
          this.snapshotCapture.clear();
        }
      },
    });
  }

  // ---- Nav-mode subscription (launcher SettingsModel + local event) -----

  private initNavModeSubscription(): void {
    try {
      this.refreshNavMode(SettingsModel.getInstance().getValue());
    } catch (e) {
      Log.showWarn(TAG, `initial getValue failed: ${JSON.stringify(e)}`);
    }
    this.navListener = {
      onReceiveEvent: (event: string, params: string) => {
        if (event === EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE) {
          this.refreshNavMode(params);
        }
      },
    };
    localEventManager.registerEventListener(this.navListener,
      [EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE]);
  }

  private refreshNavMode(raw: string): void {
    if (raw && raw !== this.navMode) {
      Log.showInfo(TAG, `navMode changed -> ${raw}`);
      this.navMode = raw;
    }
    if (this.navMode === NAV_MODE_GESTURE) {
      this.startMonitor();
    } else {
      this.stopMonitor();
    }
  }

  // ---- Input monitor ---------------------------------------------------

  private startMonitor(): void {
    if (this.monitorActive) return;
    try {
      inputMonitor.on('touch', this.touchReceiver);
      // Mouse channel is harmless on real phones; mandatory on x86 emulator.
      inputMonitor.on('mouse', this.mouseReceiver);
      this.monitorActive = true;
      Log.showInfo(TAG, 'inputMonitor registered (touch + mouse)');
    } catch (err) {
      Log.showError(TAG, `inputMonitor.on failed: ${JSON.stringify(err)}`);
    }
  }

  private stopMonitor(): void {
    if (!this.monitorActive) return;
    try {
      inputMonitor.off('touch', this.touchReceiver);
    } catch (err) {
      Log.showWarn(TAG, `inputMonitor.off(touch) failed: ${JSON.stringify(err)}`);
    }
    try {
      inputMonitor.off('mouse', this.mouseReceiver);
    } catch (err) {
      Log.showWarn(TAG, `inputMonitor.off(mouse) failed: ${JSON.stringify(err)}`);
    }
    Log.showInfo(TAG, 'inputMonitor unregistered');
    this.monitorActive = false;
    this.mouseButtonDown = false;
  }

  // ---- Touch / mouse handling -----------------------------------------

  private handleTouch(ev): boolean {
    const t = ev?.touch;
    if (!t) return false;
    const id = (t.id ?? 0) | 0;
    const x = t.screenX ?? 0;
    const y = t.screenY ?? 0;
    const timeMs = (ev.actionTime ?? 0) / 1000;
    return this.dispatch(ev.action, id, x, y, timeMs);
  }

  private handleMouse(ev): boolean {
    const action = ev?.action;
    const x = ev?.screenX ?? 0;
    const y = ev?.screenY;
    const timeMs = (ev?.actionTime ?? 0) / 1000;
    if (action === undefined || y === undefined) return false;
    if (action === MOUSE_BUTTON_DOWN) {
      if ((ev.button ?? MOUSE_BUTTON_LEFT) !== MOUSE_BUTTON_LEFT) return false;
      this.mouseButtonDown = true;
      return this.dispatch(TOUCH_DOWN, MOUSE_POINTER_ID, x, y, timeMs);
    }
    if (action === MOUSE_MOVE && this.mouseButtonDown) {
      return this.dispatch(TOUCH_MOVE, MOUSE_POINTER_ID, x, y, timeMs);
    }
    if (action === MOUSE_BUTTON_UP || action === MOUSE_CANCEL) {
      if (!this.mouseButtonDown) return false;
      this.mouseButtonDown = false;
      const mapped = action === MOUSE_CANCEL ? TOUCH_CANCEL : TOUCH_UP;
      return this.dispatch(mapped, MOUSE_POINTER_ID, x, y, timeMs);
    }
    return false;
  }

  /**
   * Swipe-up only. The recognizer's onPointerDown already rejects a DOWN
   * outside the bottom hot zone, so there's no separate zone check here. The
   * side-edge BACK gesture is NOT handled — it lives in systemui.
   */
  private dispatch(action: number, id: number, x: number, y: number, timeMs: number): boolean {
    const r = this.recognizer;
    if (!r) return false;
    if (this.checkAndSetPerationType() === PanGestureType.GAME_OPERATE) return false;

    if (action === TOUCH_DOWN) {
      // Defer to the dropdown panel when interactive (cross-process read, see
      // APP_KEY_DROPDOWN_PANEL_OPEN note — currently a no-op in this process).
      if (AppStorage.Get<boolean>(APP_KEY_DROPDOWN_PANEL_OPEN) === true) {
        return false;
      }
      const accepted = r.onPointerDown(id, x, y, timeMs);
      if (accepted) {
        // Pilfer the stream so the foreground app doesn't also scroll.
        this.consumingPointerId = id;
        return true;
      }
      return false;
    }

    if (action === TOUCH_MOVE) {
      if (this.consumingPointerId === id) {
        r.onPointerMove(id, x, y, timeMs);
        return true;
      }
      return false;
    }

    if (action === TOUCH_UP || action === TOUCH_CANCEL) {
      if (this.consumingPointerId === id) {
        r.onPointerEnd(id, x, y, timeMs, action === TOUCH_CANCEL);
        this.consumingPointerId = null;
        return true;
      }
      return false;
    }

    return false;
  }

  // ---- Commit dispatch -------------------------------------------------

  private handleCommit(target: GestureEndTarget, info: CommitInfo): void {
    Log.showInfo(TAG,
      `commit target=${GestureEndTarget[target]} deltaVp=${info.displacementVp.toFixed(1)} ` +
      `vVp/ms=${info.endVelocityVpPerMs.toFixed(3)} paused=${info.paused} ` +
      `elapsed=${info.elapsedMs.toFixed(0)}ms` +
      (info.rejection ? ` rejection=${info.rejection}` : ''));
    if (!this.dragShown || !this.dragController) {
      if (target === GestureEndTarget.HOME) {
        this.goHome();
      }
      this.recentsLoader.clear();
      return;
    }
    this.commitAnimating = true;
    const teardown = (): void => {
      this.dragController?.reset();
      this.hideDragOverlay();
      this.snapshotCapture.clear();
      this.recentsLoader.clear();
      this.commitAnimating = false;
    };
    // HOME: kick off the structural go-home IN PARALLEL with our shrink-spring
    // so the system's launcher-appear runs underneath our overlay. Hand the
    // outgoing app's icon rect to the controller first so the shrink lands ON
    // that icon (Phase 3); null ⇒ controller's bottom-centre fallback.
    if (target === GestureEndTarget.HOME) {
      this.dragController.setHomeTargetRect(this.computeHomeIconRect());
      this.goHome();
    }
    this.dragController.commit(target, () => {
      if (target === GestureEndTarget.RECENTS) {
        this.enterRecentsMode();
      } else {
        teardown();
      }
    });
  }

  private enterRecentsMode(): void {
    Log.showInfo(TAG, 'enterRecentsMode');
    this.inRecentsMode = true;
    this.commitAnimating = false;
    if (this.dragWindow) {
      this.dragWindow.setWindowFocusable(true).catch((e) => {
        Log.showWarn(TAG, `recents setFocusable failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow.setWindowTouchable(true).catch((e) => {
        Log.showWarn(TAG, `recents setTouchable failed: ${JSON.stringify(e)}`);
      });
    }
    this.pollForOverlayDismiss();
  }

  private pollForOverlayDismiss(): void {
    const check = (): void => {
      if (!this.inRecentsMode) return;
      const visible = AppStorage.Get<boolean>('OniroDragVisible');
      if (visible === false) {
        Log.showInfo(TAG, 'overlay dismissed by user — cleaning up');
        if (this.dragWindow) {
          this.dragWindow.setWindowFocusable(false).catch(() => {});
          this.dragWindow.setWindowTouchable(false).catch(() => {});
        }
        this.dragShown = false;
        this.inRecentsMode = false;
        this.dragController?.reset();
        this.snapshotCapture.clear();
        this.recentsLoader.clear();
        return;
      }
      setTimeout(check, 80);
    };
    setTimeout(check, 80);
  }

  /**
   * Phase 3: the icon rect (vp) to shrink the outgoing app's card into on a
   * HOME commit, or null for the controller's bottom-centre fallback. The
   * outgoing app's bundle/ability were recorded by RecentsLoader at gesture
   * start (the foreground mission). null when the gesture began on the
   * launcher (no app to shrink) or the app isn't on the current desktop page.
   */
  private computeHomeIconRect(): { xVp: number; yVp: number; wVp: number; hVp: number } | null {
    if (this.foregroundIsLauncher) {
      return null;
    }
    const bundle: string = AppStorage.Get<string>('OniroDragForegroundBundle') ?? '';
    const ability: string = AppStorage.Get<string>('OniroDragForegroundAbility') ?? '';
    if (!bundle) {
      return null;
    }
    return findIconRect(bundle, ability);
  }

  /**
   * Go home. Unlike systemui (which startAbility'd the launcher across
   * processes), the launcher minimizes all apps natively — the same path
   * MainAbility.onRequest uses for the HOME key. Optimistically flip the
   * foreground flag; the desktop WINDOW_ACTIVE push corrects it either way.
   */
  private goHome(): void {
    Log.showInfo(TAG, 'goHome (minimizeAllApps)');
    this.foregroundIsLauncher = true;
    try {
      windowManager.minimizeAllApps();
    } catch (err) {
      Log.showError(TAG, `goHome failed: ${JSON.stringify(err)}`);
    }
  }

  // Hook point for future IME-active / game-mode / anti-touch rules.
  private checkAndSetPerationType(): PanGestureType {
    return PanGestureType.DEFAULT;
  }

  // ---- Drag window plumbing -------------------------------------------

  private initDragWindow(): void {
    // TYPE_VOLUME_OVERLAY + non-touchable lets the overlay float above the
    // foreground app without intercepting touches — the recognizer reads them
    // off inputMonitor.
    const cfg: window.Configuration = {
      name: 'OniroDragOverlay',
      windowType: window.WindowType.TYPE_VOLUME_OVERLAY,
      ctx: this.context,
    };
    window.createWindow(cfg).then((win) => {
      this.dragWindow = win;
      win.resize(this.screenWidthPx, this.screenHeightPx).catch((e) => {
        Log.showWarn(TAG, `drag resize failed: ${JSON.stringify(e)}`);
      });
      win.moveWindowTo(0, 0).catch((e) => {
        Log.showWarn(TAG, `drag move failed: ${JSON.stringify(e)}`);
      });
      win.setUIContent('pages/DragOverlay').then(() => {
        win.setWindowBackgroundColor('#00000000');
        win.setWindowFocusable(false).catch((e) => {
          Log.showWarn(TAG, `drag setFocusable failed: ${JSON.stringify(e)}`);
        });
        win.setWindowTouchable(false).catch((e) => {
          Log.showWarn(TAG, `drag setTouchable failed: ${JSON.stringify(e)}`);
        });
        // Pre-show permanently (every visible layer in DragOverlay.ets is
        // gated on `visible && snap`) — keeps the ~1s cold showWindow() cost
        // off the gesture critical path.
        win.showWindow().catch((e) => {
          Log.showWarn(TAG, `drag pre-show failed: ${JSON.stringify(e)}`);
        });
      }).catch((e) => {
        Log.showError(TAG, `drag setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(drag) failed: ${JSON.stringify(e)}`);
    });
  }

  private showDragOverlay(): void {
    if (this.dragShown || !this.dragWindow) return;
    this.dragShown = true;
    // Window already shown (pre-show). DragController.show() flips
    // OniroDragVisible after the snapshot has resolved so every gated layer
    // appears in the same frame the snap Image has a texture.
    this.dragController?.show();
  }

  private hideDragOverlay(): void {
    if (!this.dragShown || !this.dragWindow) return;
    this.dragShown = false;
    // Window stays shown; DragController.reset() flips OniroDragVisible=false.
  }
}

export default GestureNavHost;
