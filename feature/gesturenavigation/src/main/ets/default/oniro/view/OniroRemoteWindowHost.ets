/*
 * Copyright (c) 2026 Francesco Pham
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import curves from '@ohos.curves';
import { Log } from '@ohos/common';
import { RemoteWindowItem, REMOTE_WINDOW_LIST_KEY } from '../OniroRemoteWindowController';

const TAG = 'OniroRemoteWindowHost';

// Open (zoom-in): the appearing app scales up from a slightly shrunk, centered
// state to full screen, fading in. Scale uses a near-critically-damped spring
// (smooth, no overshoot); opacity ramps in over OPEN_ALPHA_MS so the app isn't
// a ghost mid-zoom. Larger spring response = slower / softer settle.
const OPEN_START_SCALE: number = 0.9;
const OPEN_ALPHA_MS: number = 180;
const OPEN_SPRING_RESPONSE: number = 0.4;
const OPEN_SPRING_DAMPING: number = 0.99;

// Pop-from-icon open (app launched from a desktop/dock icon — item.iconRect
// set): the window starts at the tapped icon's rect (a small square at the
// icon, non-uniform scale + translate so its center sits on the icon center)
// and springs out to fill the display. No fade — the window is opaque from the
// first frame and visibly grows out of the icon, with its corners rounded like
// the icon and squaring off as it fills the screen. A slightly snappier spring
// than the centered zoom so the pop feels responsive.
const ICON_SPRING_RESPONSE: number = 0.34;
const ICON_SPRING_DAMPING: number = 0.99;
// Pre-scale corner radius (vp). Multiplied by the (small) start scale, this
// reads as an icon-sized rounded corner at the start and animates to a square
// full-screen window. ~90 vp × (icon/screen ≈ 0.15) ≈ 13 vp visible corner.
const ICON_START_RADIUS: number = 90;

// After the zoom-in finishes we tell the WMS the show is done (the real window
// then composites on its own); drop the proxy a beat later so the handoff has
// no one-frame gap.
const DROP_DELAY_MS: number = 50;
// Backup trigger in case onAppear doesn't fire — by this point the component is
// mounted, so animateTo animates from the start state instead of snapping.
const PLAY_BACKUP_MS: number = 50;
// Last-resort: if the animation never runs at all, don't leave the WMS hanging
// in its animation state. Well past any real animation duration.
const FALLBACK_MS: number = 1500;

/**
 * Renders a `RemoteWindow` proxy for every appearing app queued by
 * OniroRemoteWindowController and zooms it in (scale + fade). Mounted inside
 * EntryView on top of the desktop, non-interactive. See
 * OniroRemoteWindowController for the routing and why.
 */
@Component
export struct OniroRemoteWindowHost {
  @StorageLink(REMOTE_WINDOW_LIST_KEY) list: RemoteWindowItem[] = [];

  build() {
    Stack() {
      ForEach(this.list, (item: RemoteWindowItem) => {
        OniroRemoteWindowCard({ item: item })
      }, (item: RemoteWindowItem) => item.key)
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(HitTestMode.None)
    .enabled(false)
    .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
      [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
  }
}

@Component
struct OniroRemoteWindowCard {
  // Plain (non-reactive) member: passed by reference, rendered once.
  item: RemoteWindowItem = new RemoteWindowItem('');
  // Animated render transforms on top of the proxy's 1:1 full-display layout.
  // Scale is non-uniform (X/Y separate) so a launch can start as the icon's
  // square at the icon rect (icon/screenW ≠ icon/screenH) and stretch to fill.
  // The centered fallback sets both axes equal.
  @State scaleXVal: number = OPEN_START_SCALE;
  @State scaleYVal: number = OPEN_START_SCALE;
  @State opacityVal: number = 0.0;
  // .scale() is about the component centre; .translate() (absolute vp) then
  // moves that centre. For pop-from-icon the start translate places the
  // shrunk window's centre on the tapped icon's centre.
  @State translateX: number = 0;
  @State translateY: number = 0;
  // Corner radius (vp), animated to 0. Non-zero only for the pop-from-icon open.
  @State radiusVal: number = 0;
  // True when the start pose was derived from item.iconRect (pop-from-icon).
  private fromIcon: boolean = false;
  private played: boolean = false;
  private done: boolean = false;

  aboutToAppear(): void {
    // Derive the pop-from-icon start pose before the first build (aboutToAppear
    // runs before build, so these @State writes are picked up by frame 1 — no
    // snap). Maps the icon rect (vp) onto the RemoteWindow, which the host lays
    // out 1:1 over the full display at (0,0): the window centre is (screenW/2,
    // screenH/2) in vp, so translate = iconCentre − screenCentre and scale =
    // iconSize / screenSize. Mirrors the stock RemoteWindowWrapper math.
    const t = this.item.target;
    const r = this.item.iconRect;
    if (t && r && t.windowBounds) {
      const screenWvp: number = px2vp(t.windowBounds.width);
      const screenHvp: number = px2vp(t.windowBounds.height);
      if (screenWvp > 0 && screenHvp > 0) {
        this.scaleXVal = r.wVp / screenWvp;
        this.scaleYVal = r.hVp / screenHvp;
        this.translateX = (r.xVp + r.wVp / 2) - screenWvp / 2;
        this.translateY = (r.yVp + r.hVp / 2) - screenHvp / 2;
        this.opacityVal = 1.0;          // opaque, grows out of the icon — no fade
        this.radiusVal = ICON_START_RADIUS;
        this.fromIcon = true;
      }
    }
    // Backup play trigger + a finish fallback so we never leave the WMS hanging.
    setTimeout(() => this.play(), PLAY_BACKUP_MS);
    setTimeout(() => this.finishAndDrop(), FALLBACK_MS);
  }

  // Zoom in from the start state to full screen. Idempotent (guarded), so it is
  // safe to call from both onAppear and the backup timer.
  private play(): void {
    if (this.played || !this.item.target) {
      return;
    }
    this.played = true;
    // Centered zoom fades in (it starts shrunk-but-centered, so a ghost would
    // show mid-zoom); the icon pop is already opaque from frame 1.
    if (!this.fromIcon) {
      animateTo({ duration: OPEN_ALPHA_MS, curve: Curve.Friction }, () => {
        this.opacityVal = 1.0;
      });
    }
    // springMotion inlined at the call site (storing it in a typed field breaks
    // ArkTS type inference for the curve param); response/damping are tunable
    // consts above.
    const response: number = this.fromIcon ? ICON_SPRING_RESPONSE : OPEN_SPRING_RESPONSE;
    const damping: number = this.fromIcon ? ICON_SPRING_DAMPING : OPEN_SPRING_DAMPING;
    animateTo({ curve: curves.springMotion(response, damping, 0),
      onFinish: () => this.finishAndDrop() }, () => {
      this.scaleXVal = 1.0;
      this.scaleYVal = 1.0;
      this.translateX = 0;
      this.translateY = 0;
      this.radiusVal = 0;
    });
  }

  // Tell the WMS the show is done, then drop the proxy. Runs once.
  private finishAndDrop(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    const key: string = this.item.key;
    try {
      this.item.finishCallback?.onAnimationFinish();
    } catch (e) {
      Log.showError(TAG, `finish failed for ${key}: ${JSON.stringify(e)}`);
    }
    setTimeout(() => {
      const cur: RemoteWindowItem[] =
        (AppStorage.get<RemoteWindowItem[]>(REMOTE_WINDOW_LIST_KEY) ?? []);
      AppStorage.setOrCreate(REMOTE_WINDOW_LIST_KEY,
        cur.filter((i: RemoteWindowItem) => i.key !== key));
    }, DROP_DELAY_MS);
  }

  build() {
    if (this.item.target) {
      // Map the proxy 1:1 onto the full display (position 0,0 + 100%/100% +
      // expandSafeArea) so the leash keeps its natural WMS geometry; scale/
      // translate/opacity are render transforms layered on top. The end state
      // (scale 1, translate 0, opacity 1) is exactly this 1:1 mapping, so the
      // handoff to the real composited window after finish is pixel-identical.
      // scale() defaults to the component centre → a centred zoom.
      RemoteWindow(this.item.target)
        .position({ x: 0, y: 0 })
        .width('100%')
        .height('100%')
        .scale({ x: this.scaleXVal, y: this.scaleYVal })
        .translate({ x: this.translateX, y: this.translateY })
        .opacity(this.opacityVal)
        .borderRadius(this.radiusVal)
        .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
          [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
        .onAppear(() => this.play())
    }
  }
}
