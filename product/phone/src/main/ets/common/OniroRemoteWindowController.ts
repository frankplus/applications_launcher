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

import windowAnimationManager from '@ohos.animation.windowAnimationManager';
import { Log } from '@ohos/common';

const TAG = 'OniroRemoteWindowController';

// AppStorage key shared with OniroRemoteWindowHost (rendered in EntryView).
export const REMOTE_WINDOW_LIST_KEY = 'OniroRemoteWindowList';

/**
 * One appearing app. Holds the RemoteWindow target and the WMS "animation
 * finished" callback. The host component renders a `RemoteWindow` for `target`
 * (which restores the leash's context alpha → the app becomes visible), plays
 * the zoom-in, then calls `finishCallback` and drops the item.
 */
export class RemoteWindowItem {
  key: string;
  // Optional so a placeholder `new RemoteWindowItem('')` can satisfy the host
  // component's default member init; real items always carry both.
  target?: windowAnimationManager.WindowAnimationTarget;
  finishCallback?: windowAnimationManager.WindowAnimationFinishedCallback;

  constructor(key: string, target?: windowAnimationManager.WindowAnimationTarget,
    finishCallback?: windowAnimationManager.WindowAnimationFinishedCallback) {
    this.key = key;
    this.target = target;
    this.finishCallback = finishCallback;
  }
}

/**
 * Oniro phone launcher window-animation controller.
 *
 * Registering ANY controller makes the WMS route window transitions through it
 * (and hide the appearing app's leash, context alpha 0, until a proxy renders
 * it back). This controller:
 *  - START / app-transition (OPEN): hands the appearing target to
 *    OniroRemoteWindowHost, which renders a `RemoteWindow` for it and ZOOMS IT
 *    IN (scale + fade) to full screen. Rendering the proxy is the contract a
 *    controller must satisfy (else the appearing app stays invisible); the
 *    zoom-in is the launch animation. The hook for a future pop-from-icon open
 *    is here — animate from the tapped icon's rect instead of a centered scale.
 *  - MINIMIZE / CLOSE / SCREEN-UNLOCK: NO-OP (finish only, no render, no
 *    animation). This removes the window without the legacy WMS default zoom
 *    (which used to duplicate the systemui swipe-up-to-home gesture). We must
 *    NOT render a proxy for a disappearing window: rendering the leash of a
 *    window heading to background makes the WMS treat it as foreground again →
 *    it re-launches, AMS re-minimizes, and it oscillates, leaving the app
 *    invisible on reopen. A close/minimize zoom would need a snapshot, not the
 *    live leash proxy.
 *
 * Must be registered from the EntryView page thread (see EntryView) and needs the
 * graphic_2d rs_window_animation_controller thread/napi fix. See project memory
 * winanim_controller_native_boot.
 */
export default class OniroRemoteWindowController
  implements windowAnimationManager.WindowAnimationController {

  private static keyOf(target: windowAnimationManager.WindowAnimationTarget): string {
    return `${target.bundleName}#${target.abilityName}#${target.missionId}`;
  }

  // Queue the appearing target for the host to render+zoom-in via RemoteWindow.
  private show(target: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    if (!target) {
      finishCallback.onAnimationFinish();
      return;
    }
    const key: string = OniroRemoteWindowController.keyOf(target);
    const list: RemoteWindowItem[] =
      (AppStorage.get<RemoteWindowItem[]>(REMOTE_WINDOW_LIST_KEY) ?? []);
    if (list.some((i: RemoteWindowItem) => i.key === key)) {
      // Already being shown — don't double-render; just complete this callback.
      finishCallback.onAnimationFinish();
      return;
    }
    const next: RemoteWindowItem[] = list.slice();
    next.push(new RemoteWindowItem(key, target, finishCallback));
    AppStorage.setOrCreate(REMOTE_WINDOW_LIST_KEY, next);
    Log.showInfo(TAG, `show ${key} (pending=${next.length})`);
  }

  onStartAppFromLauncher(startingWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    this.show(startingWindowTarget, finishCallback);
  }

  onStartAppFromRecent(startingWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    this.show(startingWindowTarget, finishCallback);
  }

  onStartAppFromOther(startingWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    this.show(startingWindowTarget, finishCallback);
  }

  onAppTransition(fromWindowTarget: windowAnimationManager.WindowAnimationTarget,
    toWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    // Show (zoom in) the incoming app; the outgoing one is removed by the WMS
    // (isPlayAnimationHide) with no zoom.
    this.show(toWindowTarget, finishCallback);
  }

  onMinimizeWindow(minimizingWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    // No-op: the window is removed without a zoom (see class doc — never render
    // a proxy for a backgrounding window).
    finishCallback.onAnimationFinish();
  }

  onCloseWindow(closingWindowTarget: windowAnimationManager.WindowAnimationTarget,
    finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    finishCallback.onAnimationFinish();
  }

  onScreenUnlock(finishCallback: windowAnimationManager.WindowAnimationFinishedCallback): void {
    finishCallback.onAnimationFinish();
  }

  onWindowAnimationTargetsUpdate(fullScreenWindowTarget: windowAnimationManager.WindowAnimationTarget,
    floatingWindowTargets: Array<windowAnimationManager.WindowAnimationTarget>): void {
  }
}
