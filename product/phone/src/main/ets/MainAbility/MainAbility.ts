/**
 * Copyright (c) 2021-2022 Huawei Device Co., Ltd.
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

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import display from '@ohos.display';
import Want from '@ohos.app.ability.Want';
import {
  Log,
  CommonConstants,
  windowManager,
  RdbStoreManager,
  FormConstants,
  FormListInfoCacheManager,
  ResourceManager,
  launcherAbilityManager,
  navigationBarCommonEventManager,
  localEventManager,
  EventConstants,
  DisplayManager,
  WallpaperModel
} from '@ohos/common';
import { GestureNavigationManager } from '@ohos/gesturenavigation';
import StyleConstants from '../common/constants/StyleConstants';
import { PageDesktopViewModel } from '@ohos/pagedesktop';
import Window from '@ohos.window';
import inputConsumer from '@ohos.multimodalInput.inputConsumer';
import { KeyCode } from '@ohos.multimodalInput.keyCode';
import window from '@ohos.window';
import commonEventManager from '@ohos.commonEventManager';
import { PreferencesHelper } from '@ohos/common/src/main/ets/default/manager/PreferencesHelper';
import { GestureNavHost } from '../gesturenav/GestureNavHost';

// Published whenever the desktop window gains/loses focus, so systemui's
// side-edge BACK gesture can suppress itself on the home screen WITHOUT a
// getTopAbility sync binder (the ~1.2s-stall source). The launcher is the
// authority on its own focus → it PUSHES instead of systemui PULLING. code:
// 1 = launcher (desktop) foreground, 0 = an app foreground. See the migration
// plan §7. Must match OniroBackFocus in systemui's ServiceExtAbility.
const DESKTOP_FOCUS_EVENT = 'com.ohos.oniro.desktop.focus_changed';

const TAG = 'LauncherMainAbility';

export default class MainAbility extends ServiceExtension {
  private displayManager: DisplayManager = undefined
  // Bottom-edge swipe-up gesture host (HOME / RECENTS / Overview). The
  // launcher owns this gesture because the go-home shrink targets the real
  // app icon rect, which only the launcher knows. The side-edge BACK gesture
  // stays in systemui. See the migration plan.
  private gestureNavHost: GestureNavHost | undefined = undefined

  onCreate(want: Want): void {
    Log.showInfo(TAG,'onCreate start');
    this.context.area = 0;
    this.initLauncher();
  }

  async initLauncher(): Promise<void> {
    // init Launcher context
    globalThis.desktopContext = this.context;
    // Pre-warm the system wallpaper from the wallpaper manager so the home
    // screen (EntryView) shows the one managed wallpaper instead of a hardcoded
    // asset; pages subscribe and keep it live.
    WallpaperModel.getInstance().start();
    // init rdb
    let dbStore = RdbStoreManager.getInstance();
    await dbStore.initRdbConfig();
    await dbStore.createTable();

    let registerWinEvent = (win: window.Window) => {
      win.on('windowEvent', (stageEventType) => {
        // 桌面获焦或失焦时，通知桌面的卡片变为可见状态
        if (stageEventType === window.WindowEventType.WINDOW_ACTIVE) {
          launcherAbilityManager.checkBundleMonitor();
          localEventManager.sendLocalEventSticky(EventConstants.EVENT_REQUEST_FORM_ITEM_VISIBLE, null);
          Log.showInfo(TAG, `lifeCycleEvent change: ${stageEventType}`);
          // Push launcher-foreground to the gesture host (used to decide
          // swipe-from-launcher → recents-only). Replaces a getTopAbility
          // sync binder / abilityForegroundState observer.
          this.gestureNavHost?.setForegroundIsLauncher(true);
          // …and to systemui (BACK suppression on home) via CommonEvent. Runs
          // regardless of the gesture owner — back stays in systemui either way.
          this.publishDesktopFocus(true);
        } else if (stageEventType === window.WindowEventType.WINDOW_INACTIVE) {
          this.gestureNavHost?.setForegroundIsLauncher(false);
          this.publishDesktopFocus(false);
        }
      })
    };
    // create Launcher entry view
    windowManager.createWindow(globalThis.desktopContext, windowManager.DESKTOP_WINDOW_NAME,
      windowManager.DESKTOP_RANK, 'pages/' + windowManager.DESKTOP_WINDOW_NAME, true, registerWinEvent);

    await PreferencesHelper.getInstance().initPreference(this.context);
    AppStorage.setOrCreate('firstActivate', true);
    // init global const
    this.initGlobalConst();
    this.displayManager = DisplayManager.getInstance();

    // The stock launcher swipe-up monitor (startGestureNavigation) is left
    // disabled: it would fire on the same swipe-up as our GestureNavHost and
    // open a second, overlapping RecentView window.
    // this.startGestureNavigation();
    windowManager.registerWindowEvent();
    navigationBarCommonEventManager.registerNavigationBarEvent();

    // load recent
    windowManager.createRecentWindow();
    this.registerInputConsumer();

    // Bottom-edge swipe-up gesture host (HOME / RECENTS / Overview).
    // Defer it until the desktop has finished its first build: creating the
    // overlay window + starting the gesture engine WHILE the desktop's async
    // grid build is in flight collapses the workspace (icons never render).
    // Gate on the 'loaded' AppStorage flag (set by EntryView once the desktop
    // is up), with a timeout fallback so the gesture still comes up even if
    // that flag never flips.
    this.startGestureNavWhenDesktopReady(0);
  }

  private startGestureNavWhenDesktopReady(attempt: number): void {
    const MAX_ATTEMPTS = 40;   // ~40 × 150ms = 6s fallback ceiling
    const loaded: boolean | undefined = AppStorage.get('loaded');
    if (loaded !== true && attempt < MAX_ATTEMPTS) {
      setTimeout(() => this.startGestureNavWhenDesktopReady(attempt + 1), 150);
      return;
    }
    // One more grace beat after 'loaded' so the grid swiper has laid out.
    setTimeout(() => {
      try {
        this.gestureNavHost = new GestureNavHost(this.context);
        this.gestureNavHost.start();
        Log.showInfo(TAG, `launcher gesture-nav host started (desktop ready, attempt=${attempt})`);
      } catch (err) {
        Log.showError(TAG, `start gesture-nav host failed: ${JSON.stringify(err)}`);
      }
    }, 800);
  }

  /**
   * Broadcast the desktop's focus state so systemui's BACK gesture can
   * suppress itself on the home screen without a getTopAbility sync binder.
   * Fire-and-forget; latency is fine (the worst case of a late event is a
   * harmless BACK on the home screen, never a dead BACK in an app).
   */
  private publishDesktopFocus(focused: boolean): void {
    try {
      // Sticky so systemui gets the CURRENT focus the moment it subscribes,
      // even if it subscribes after the boot-time publish (otherwise the very
      // first home view after boot wouldn't suppress BACK until the next
      // focus transition). Each publish overwrites the sticky value.
      commonEventManager.publish(DESKTOP_FOCUS_EVENT,
        { code: focused ? 1 : 0, isSticky: true }, (err) => {
        if (err) {
          Log.showWarn(TAG, `publishDesktopFocus(${focused}) failed: ${JSON.stringify(err)}`);
        }
      });
    } catch (e) {
      Log.showWarn(TAG, `publishDesktopFocus(${focused}) threw: ${JSON.stringify(e)}`);
    }
  }

  private registerInputConsumer(): void {
    let onKeyCodeHome = {
      preKeys: [],
      finalKey: KeyCode.KEYCODE_HOME,
      finalKeyDownDuration: 0,
      isFinalKeyDown: true
    }
    // register/unregister HOME inputConsumer
    inputConsumer.on('key', onKeyCodeHome, () => {
      Log.showInfo(TAG, 'HOME inputConsumer homeEvent start');
      globalThis.desktopContext.startAbility({
        bundleName: CommonConstants.LAUNCHER_BUNDLE,
        abilityName: CommonConstants.LAUNCHER_ABILITY
      })
        .then(() => {
          Log.showDebug(TAG, 'HOME inputConsumer startAbility Promise in service successful.');
        })
        .catch(() => {
          Log.showDebug(TAG, 'HOME inputConsumer startAbility Promise in service failed.');
        });
    });
    let onKeyCodeFunction = {
      preKeys: [],
      finalKey: KeyCode.KEYCODE_FUNCTION,
      finalKeyDownDuration: 0,
      isFinalKeyDown: true
    }
    // register/unregister RECENT inputConsumer
    inputConsumer.on('key', onKeyCodeFunction, () => {
      Log.showInfo(TAG, 'RECENT inputConsumer recentEvent start');
      windowManager.createWindowWithName(windowManager.RECENT_WINDOW_NAME, windowManager.RECENT_RANK);
    });
  }

  private unregisterInputConsumer(): void {
    let offKeyCodeHome = {
      preKeys: [],
      finalKey: KeyCode.KEYCODE_HOME,
      finalKeyDownDuration: 0,
      isFinalKeyDown: true
    }
    // unregister HOME inputConsumer
    inputConsumer.off('key', offKeyCodeHome);
    let offKeyCodeFunction = {
      preKeys: [],
      finalKey: KeyCode.KEYCODE_FUNCTION,
      finalKeyDownDuration: 0,
      isFinalKeyDown: true
    }
    // unregister RECENT inputConsumer
    inputConsumer.off('key', offKeyCodeFunction);
  }

  private initGlobalConst(): void {
    // init create window global function
    globalThis.createWindowWithName = ((windowName: string, windowRank: number): void => {
      Log.showInfo(TAG, `createWindowWithName begin windowName: ${windowName}`);
      if (windowName === windowManager.RECENT_WINDOW_NAME) {
        windowManager.createRecentWindow();
      } else {
        windowManager.createWindowIfAbsent(globalThis.desktopContext, windowName, windowRank, 'pages/' + windowName);
      }
    });
  }

  private startGestureNavigation(): void {
    const gestureNavigationManage = GestureNavigationManager.getInstance();
    let dis: display.Display = display.getDefaultDisplaySync();
    dis && gestureNavigationManage.initWindowSize(dis);
  }

  onDestroy(): void {
    windowManager.unregisterWindowEvent();
    this.unregisterInputConsumer();
    navigationBarCommonEventManager.unregisterNavigationBarEvent();
    windowManager.destroyWindow(windowManager.DESKTOP_WINDOW_NAME);
    windowManager.destroyRecentWindow();
    this.displayManager?.destroySubDisplayWindow();
    this.gestureNavHost?.destroy();
    this.gestureNavHost = undefined;
    Log.showInfo(TAG, 'onDestroy success');
  }

  onRequest(want: Want, startId: number): void {
    Log.showInfo(TAG,`onRequest, want:${want.abilityName}`);
    // if app publish card to launcher
    if(want.action === FormConstants.ACTION_PUBLISH_FORM) {
      PageDesktopViewModel.getInstance().publishCardToDesktop(want.parameters);
    }
    if (startId !== 1) {
      windowManager.minimizeAllApps();
    }
    windowManager.hideWindow(windowManager.RECENT_WINDOW_NAME);
    localEventManager.sendLocalEventSticky(EventConstants.EVENT_OPEN_FOLDER_TO_CLOSE, null);
  }

  onConfigurationUpdate(config): void {
    Log.showInfo(TAG, 'onConfigurationUpdated, config:' + JSON.stringify(config));
    const systemLanguage = AppStorage.get('systemLanguage');
    if(systemLanguage && systemLanguage !== config.language) {
      this.clearCacheWhenLanguageChange();
    }
    AppStorage.setOrCreate('systemLanguage', config.language);
  }

  private clearCacheWhenLanguageChange(): void {
    FormListInfoCacheManager.getInstance().clearCache();
    ResourceManager.getInstance().clearAppResourceCache();
    launcherAbilityManager.cleanAppMapCache();
    PageDesktopViewModel.getInstance().updateDesktopInfo();
    PageDesktopViewModel.getInstance().updateForms();
  }
}
