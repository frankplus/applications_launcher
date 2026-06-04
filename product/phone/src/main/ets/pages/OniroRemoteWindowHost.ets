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

import { Log } from '@ohos/common';
import { RemoteWindowItem, REMOTE_WINDOW_LIST_KEY } from '../common/OniroRemoteWindowController';

const TAG = 'OniroRemoteWindowHost';

// How long the proxy stays rendered. The RemoteWindow restores the leash's
// context alpha (→ app visible); after FINISH_MS we tell the WMS the show is
// done (window becomes a normal composited window), and after REMOVE_MS we drop
// the proxy. REMOVE_MS > FINISH_MS so the app is permanent before the proxy goes.
const FINISH_MS: number = 100;
const REMOVE_MS: number = 450;

/**
 * Renders a `RemoteWindow` for every target queued by
 * OniroRemoteWindowController, full-screen at full opacity (instant appear).
 * Mounted inside EntryView on top of the desktop, non-interactive. See
 * OniroRemoteWindowController for the why.
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

  aboutToAppear(): void {
    const key: string = this.item.key;
    // The RemoteWindow mounts this frame and hands the leash a valid context
    // alpha (→ app visible). Let it settle, then complete the WMS show state,
    // then drop the proxy once the window composites on its own.
    setTimeout(() => {
      try {
        this.item.finishCallback?.onAnimationFinish();
      } catch (e) {
        Log.showError(TAG, `finish failed for ${key}: ${JSON.stringify(e)}`);
      }
    }, FINISH_MS);
    setTimeout(() => {
      const cur: RemoteWindowItem[] =
        (AppStorage.get<RemoteWindowItem[]>(REMOTE_WINDOW_LIST_KEY) ?? []);
      AppStorage.setOrCreate(REMOTE_WINDOW_LIST_KEY,
        cur.filter((i: RemoteWindowItem) => i.key !== key));
    }, REMOVE_MS);
  }

  build() {
    if (this.item.target) {
      // Map the proxy 1:1 onto the full display so the leash keeps its natural
      // WMS geometry (drawn under the status bar, nav bar reserved by the app's
      // own safe-area insets). Using target.windowBounds here is WRONG: that's
      // the *avoid rect* (top = status-bar height), so it would translate+clip
      // the app down by the status-bar height — a +72px offset that persists
      // after the proxy is removed (gap below the status bar, launcher behind
      // it, lost bottom inset). The host Stack is full-screen, so 100%/100% at
      // origin is the full display.
      RemoteWindow(this.item.target)
        .position({ x: 0, y: 0 })
        .width('100%')
        .height('100%')
        .opacity(1)
        .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
          [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
    }
  }
}
