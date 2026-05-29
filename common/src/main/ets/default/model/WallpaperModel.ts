/**
 * Copyright (c) 2026 Francesco Pham
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

import wallpaper from '@ohos.wallpaper';
import image from '@ohos.multimedia.image';
import { Log } from '../utils/Log';

const TAG = 'WallpaperModel';

// A bound page keeps rendering the previous PixelMap for a moment after it
// swaps to the new one; releasing it synchronously would free the native
// buffer out from under the Image. Wallpaper changes are rare, so defer.
const RELEASE_DELAY_MS = 3000;

type WallpaperListener = (pixelMap: image.PixelMap) => void;

/**
 * Single source of truth for the launcher's system (home) wallpaper.
 *
 * Loads the wallpaper once from the wallpaper manager
 * (`getImage(WALLPAPER_SYSTEM)`, gated behind `ohos.permission.GET_WALLPAPER`,
 * already declared by the launcher) and re-loads whenever the system wallpaper
 * changes. Pages subscribe and receive the `image.PixelMap` directly into a
 * local @State — NOT via AppStorage: a native PixelMap routed through AppStorage
 * to a window's UI instance renders transparent (the Image draws nothing). The
 * screenlock works for the same reason — it keeps the PixelMap in its own
 * ViewModel. Delivering the reference straight to each page mirrors that and
 * gives every system-UI surface the one managed wallpaper, live-updated.
 */
export class WallpaperModel {
  private pixelMap: image.PixelMap | null = null;
  private readonly listeners: Array<WallpaperListener> = [];
  private started: boolean = false;
  // Monotonic load token. A getImage() resolution whose token is no longer the
  // latest is stale (a newer load started after it) and is discarded, so
  // out-of-order async resolutions can't leave an older wallpaper as current.
  private loadSeq: number = 0;

  // Stable reference so wallpaper.off() can deregister exactly this listener.
  private readonly onWallpaperChange = (type: wallpaper.WallpaperType): void => {
    if (type === wallpaper.WallpaperType.WALLPAPER_SYSTEM) {
      Log.showInfo(TAG, 'wallpaperChange(SYSTEM): reloading');
      this.load();
    }
  };

  private constructor() {
  }

  static getInstance(): WallpaperModel {
    if (globalThis.WallpaperModelInstance == null) {
      globalThis.WallpaperModelInstance = new WallpaperModel();
    }
    return globalThis.WallpaperModelInstance;
  }

  /**
   * Pre-warm: begin loading + listening so the first page that subscribes gets
   * the wallpaper with minimal delay. Idempotent.
   */
  start(): void {
    this.ensureStarted();
  }

  /**
   * Subscribe a page. The listener is invoked immediately with the current
   * wallpaper if it is already loaded, and again on every (re)load.
   */
  subscribe(listener: WallpaperListener): void {
    if (this.listeners.indexOf(listener) < 0) {
      this.listeners.push(listener);
    }
    this.ensureStarted();
    if (this.pixelMap != null) {
      listener(this.pixelMap);
    }
  }

  unsubscribe(listener: WallpaperListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) {
      this.listeners.splice(idx, 1);
    }
  }

  private ensureStarted(): void {
    // The instance lives in globalThis for the launcher process's lifetime, and
    // this guard means `wallpaper.on` is registered exactly once even if the
    // ability is recreated — so there is no listener to `off`.
    if (this.started) {
      return;
    }
    this.started = true;
    this.load();
    try {
      wallpaper.on('wallpaperChange', this.onWallpaperChange);
    } catch (err) {
      Log.showError(TAG, `wallpaper.on failed: ${JSON.stringify(err)}`);
    }
  }

  private load(): void {
    const seq = ++this.loadSeq;
    wallpaper.getImage(wallpaper.WallpaperType.WALLPAPER_SYSTEM).then((pm: image.PixelMap): void => {
      if (seq !== this.loadSeq) {
        // A newer load started after this one — this result is stale and was
        // never published to any page, so free it immediately (safe: nothing
        // ever rendered it).
        pm.release().catch(
          (e: Object): void => Log.showError(TAG, `stale pixelMap.release failed: ${JSON.stringify(e)}`));
        return;
      }
      const old = this.pixelMap;
      this.pixelMap = pm;
      Log.showInfo(TAG, 'system wallpaper loaded');
      this.listeners.forEach((l: WallpaperListener): void => l(pm));
      if (old != null) {
        // Subscribers were just handed `pm` synchronously above; defer freeing
        // the superseded map so a bound Image isn't reading it mid-swap.
        setTimeout((): void => {
          old.release().catch(
            (e: Object): void => Log.showError(TAG, `pixelMap.release failed: ${JSON.stringify(e)}`));
        }, RELEASE_DELAY_MS);
      }
    }).catch((err: Object): void => {
      Log.showError(TAG, `getImage(WALLPAPER_SYSTEM) failed: ${JSON.stringify(err)}`);
    });
  }
}
