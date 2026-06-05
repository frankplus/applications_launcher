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
import { RemoteWindowItem, REMOTE_WINDOW_LIST_KEY } from '../common/OniroRemoteWindowController';

const TAG = 'OniroRemoteWindowHost';

// Open (zoom-in): the appearing app scales up from a slightly shrunk, centered
// state to full screen, fading in. Scale uses a near-critically-damped spring
// (smooth, no overshoot); opacity ramps in over OPEN_ALPHA_MS so the app isn't
// a ghost mid-zoom. Larger spring response = slower / softer settle.
const OPEN_START_SCALE: number = 0.9;
const OPEN_ALPHA_MS: number = 180;
const OPEN_SPRING_RESPONSE: number = 0.4;
const OPEN_SPRING_DAMPING: number = 0.99;

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
  @State scaleVal: number = OPEN_START_SCALE;
  @State opacityVal: number = 0.0;
  // Reserved for the future pop-from-icon open: animate translate from the
  // tapped icon's offset (with .scale center at the icon) instead of a centered
  // zoom. Kept at 0 for the basic centered zoom.
  @State translateX: number = 0;
  @State translateY: number = 0;
  private played: boolean = false;
  private done: boolean = false;

  aboutToAppear(): void {
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
    animateTo({ duration: OPEN_ALPHA_MS, curve: Curve.Friction }, () => {
      this.opacityVal = 1.0;
    });
    // springMotion inlined at the call site (storing it in a typed field breaks
    // ArkTS type inference for the curve param); response/damping are tunable
    // consts above.
    animateTo({ curve: curves.springMotion(OPEN_SPRING_RESPONSE, OPEN_SPRING_DAMPING, 0),
      onFinish: () => this.finishAndDrop() }, () => {
      this.scaleVal = 1.0;
      this.translateX = 0;
      this.translateY = 0;
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
        .scale({ x: this.scaleVal, y: this.scaleVal })
        .translate({ x: this.translateX, y: this.translateY })
        .opacity(this.opacityVal)
        .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
          [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
        .onAppear(() => this.play())
    }
  }
}
