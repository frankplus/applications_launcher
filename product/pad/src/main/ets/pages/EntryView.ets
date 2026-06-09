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

import app from '@system.app';
import mediaquery from '@ohos.mediaquery'
import { Log } from '@ohos/common';
import { Trace } from '@ohos/common';
import { CommonConstants } from '@ohos/common';
import { EventConstants } from '@ohos/common';
import { windowManager } from '@ohos/common';
import { localEventManager } from '@ohos/common';
import { SettingsModel, LayoutViewModel } from '@ohos/common';
import { WallpaperModel } from '@ohos/common';
import { SmartDock } from '@ohos/smartdock/component';
import { PageDesktopLayout } from '@ohos/pagedesktop/component';
import { BigFolderConstants, BigFolderStyleConfig } from '@ohos/bigfolder';
import { FolderOpenComponent } from '@ohos/bigfolder/component';
import PadStage from '../common/PadStage';
// No RemoteWindowWrapper: its windowAnimationManager.setController overrides the system app-transition and suppresses startWindowIcon splashes.
import StyleConstants from '../common/constants/StyleConstants';
import { FormStyleConfig } from '@ohos/form';
import AppCenterGridStyleConfig from '@ohos/appcenter/src/main/ets/default/common/AppCenterGridStyleConfig';
import PadPageDesktopGridStyleConfig from '../common/PadPageDesktopGridStyleConfig';
import { SmartDockStyleConfig } from '@ohos/smartdock';
import display from '@ohos.display';
import systemParameter from '@ohos.systemparameter';
import image from '@ohos.multimedia.image';
import windowAnimationManager from '@ohos.animation.windowAnimationManager';
import { OniroRemoteWindowController } from '@ohos/gesturenavigation';
import { OniroRemoteWindowHost } from '@ohos/gesturenavigation/component';

const RAW_IMAGE_CACHE_SIZE = 20000000;
const TAG = 'EntryView';

interface LocalEventListener {
  onReceiveEvent: (event: string, params: string) => void;
}

@Entry
@Component
struct EntryView {
  // System wallpaper from WallpaperModel (@ohos/common). Held in local @State —
  // a PixelMap routed via AppStorage to this window renders transparent, so the
  // model hands it to us directly. Updates live on wallpaper change.
  @State wallpaper: image.PixelMap | undefined = undefined;
  private wpListener: (pm: image.PixelMap) => void = (pm: image.PixelMap): void => {
    this.wallpaper = pm;
  };
  @StorageLink('screenWidth') screenWidth: number = 0;
  @StorageLink('screenHeight') @Watch('updateScreenInfo') screenHeight: number = 0;
  @StorageLink('deviceType') deviceType: string = CommonConstants.PAD_DEVICE_TYPE;
  @State workSpaceWidth: number = 0;
  @State workSpaceHeight: number = 0;
  @State dockHeight: number = 0;
  private mStage: PadStage = new PadStage();
  private navigationBarStatus: string | undefined;
  // Claims the WMS remote-animation slot: renders the appearing app via a
  // RemoteWindow (so apps open) and no-ops minimize/close (so the default
  // app-close zoom never plays). For the swipe-up-to-home gesture this removes
  // the duplicate WMS close zoom that played on top of our own shrink-to-icon
  // animation. Registration is param-gated (see registerWindowAnimationController).
  private animationController: OniroRemoteWindowController = new OniroRemoteWindowController();
  private mOrientationListener = mediaquery.matchMediaSync('(orientation: landscape)');
  @StorageLink('IsSetImageRawDataCacheSize') isSetImageRawDataCacheSize?: boolean = undefined;
  async onPortrait(mediaQueryResult: mediaquery.MediaQueryResult) {
    if (mediaQueryResult.matches) {
      Log.showInfo(TAG, 'screen change to landscape');
      AppStorage.setOrCreate('isPortrait', false);
    } else {
      Log.showInfo(TAG, 'screen change to portrait');
      AppStorage.setOrCreate('isPortrait', true);
    }
    let dis: display.Display | null = null;
    try {
      dis = display.getDefaultDisplaySync();
      Log.showInfo(TAG, `change to display: ${JSON.stringify(dis)}`);
      AppStorage.setOrCreate('screenWidth', px2vp(dis.width));
      AppStorage.setOrCreate('screenHeight', px2vp(dis.height));
      Log.showDebug(TAG, `screenWidth and screenHeight: ${AppStorage.get('screenWidth')},${AppStorage.get('screenHeight')}`);
    } catch (err) {
      Log.showError(TAG, `display.getDefaultDisplaySync err: ${JSON.stringify(err)}`)
    }
  }

  aboutToAppear(): void {
    Log.showInfo(TAG, 'aboutToAppear');
    WallpaperModel.getInstance().subscribe(this.wpListener);
    this.mStage.onCreate();
    this.navigationBarStatus = SettingsModel.getInstance().getValue();
    this.getWindowSize();
    this.updateScreenSize();
    this.mOrientationListener.on('change', this.onPortrait);
    this.registerPageDesktopNavigatorStatusChangeEvent(this.mLocalEventListener);

    this.registerWindowAnimationController();
  }

  // Register from the EntryView page (the launcher window's ArkUI thread),
  // NOT from MainAbility.onCreate: that's a ServiceExtensionAbility, and the
  // RS controller's callbacks are dispatched on the main event runner — so
  // an off-thread registration crashes in libace_napi at onScreenUnlock.
  //
  // Gated behind a param because the RS window-animation controller itself
  // has a thread-safety bug: `thread_local jsController_` in
  // rs_window_animation_controller.cpp is set on this (registering) thread
  // but the callbacks are posted to GetMainEventRunner(), so jsController_/
  // env_ are cross-thread and the FIRST onScreenUnlock SIGBUSes in
  // libace_napi.z.so+0x91728 — crash-looping the launcher. Enable ONLY on an
  // image that carries the graphic_2d fix (jsController_ as a class member +
  // napi_send_event dispatch):  param set persist.oniro.winanim_controller 1
  private registerWindowAnimationController(): void {
    if (systemParameter.getSync('persist.oniro.winanim_controller', '0') !== '1') {
      Log.showInfo(TAG, 'window animation controller disabled by param');
      return;
    }
    try {
      windowAnimationManager.setController(this.animationController);
      Log.showInfo(TAG, 'no-op window animation controller registered');
    } catch (err) {
      Log.showError(TAG, `setController failed: ${JSON.stringify(err)}`);
    }
  }

  registerPageDesktopNavigatorStatusChangeEvent(listener: LocalEventListener): void {
    localEventManager.registerEventListener(listener, [
      EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE
    ]);
  }

  private readonly mLocalEventListener: LocalEventListener = {
    onReceiveEvent: (event: string, params: string) => {
      Log.showInfo(TAG, `receive event: ${event}, params: ${params}`);
      if (event === EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE) {
        this.navigationBarStatus = params;
        this.updateScreenInfo();
      }
    }
  };

  private updateScreenInfo(): void {
    Log.showInfo(TAG, 'updateScreenInfo');
    if (this.screenWidth !== 0 && this.screenHeight !== 0) {
      LayoutViewModel.getInstance().initScreen(this.navigationBarStatus);
      SmartDockStyleConfig.getInstance();
      PadPageDesktopGridStyleConfig.getInstance();
      AppCenterGridStyleConfig.getInstance();
      BigFolderStyleConfig.getInstance();
      FormStyleConfig.getInstance();
      this.updateScreenSize();
    }
  }

  onPageShow(): void {
    Log.showInfo(TAG, 'onPageShow');
    if (typeof this.isSetImageRawDataCacheSize === 'undefined') {
      Log.showInfo(TAG, 'onPageShow setImageRawDataCacheSize');

      // If cannot compile this, comment next line or add following code into Class App in "@system.app.d.ts":
      // static setImageRawDataCacheSize(value: number): void;
      app.setImageRawDataCacheSize(RAW_IMAGE_CACHE_SIZE);
      app.setImageCacheCount(100);
      this.isSetImageRawDataCacheSize = true;
    }
    try {
      systemParameter.setSync('bootevent.launcher.ready', 'true');
      // Desktop's first frame is up → let MainAbility's deferred GestureNavHost
      // start (it polls this flag, then waits an 800ms grace). Starting the host
      // before the desktop is shown collapses the async grid build. Idempotent.
      AppStorage.setOrCreate('loaded', true);
    } catch (err) {
      Log.showError(TAG, `set bootevent.launcher.ready err, ${JSON.stringify(err)}`);
    }
  }

  private getWindowSize(): void {
    try {
      this.screenWidth = px2vp(windowManager.getWindowWidth());
      this.screenHeight = px2vp(windowManager.getWindowHeight());
      AppStorage.setOrCreate('screenWidth', this.screenWidth);
      AppStorage.setOrCreate('screenHeight', this.screenHeight);
    } catch (error) {
      Log.showError(TAG, `getWindowWidth or getWindowHeight error: ${error}`);
    }
  }

  private updateScreenSize(): void {
    this.workSpaceWidth = this.screenWidth;
    this.workSpaceHeight = LayoutViewModel.getInstance().getWorkSpaceHeight() as number;
    this.dockHeight = LayoutViewModel.getInstance().getDockHeight() as number;
    AppStorage.setOrCreate('workSpaceWidth', this.workSpaceWidth);
    AppStorage.setOrCreate('workSpaceHeight', this.workSpaceHeight);
    AppStorage.setOrCreate('dockHeight', this.dockHeight);
    Log.showDebug(TAG, `updateScreenSize product: ${this.deviceType}, screenWidth: ${this.screenWidth}, screenHeight: ${this.screenHeight}, workSpaceWidth: ${this.workSpaceWidth}, workSpaceHeight: ${this.workSpaceHeight}, dockHeight: ${this.dockHeight}`);
  }

  aboutToDisappear(): void {
    WallpaperModel.getInstance().unsubscribe(this.wpListener);
    this.mOrientationListener.off('change', this.onPortrait);
    this.mStage.onDestroy();
  }

  onBackPress(): boolean {
    Log.showInfo(TAG, 'onBackPress');
    ContextMenu.close();
    AppStorage.setOrCreate('overlayMode', CommonConstants.OVERLAY_TYPE_HIDE);
    AppStorage.setOrCreate('openFolderStatus', BigFolderConstants.OPEN_FOLDER_STATUS_CLOSE);
    AppStorage.setOrCreate('selectDesktopAppItem', '');
    this.closeRecentDockPopup();
    return true;
  }

  private closeRecentDockPopup(): void {
    let num: number = AppStorage.get('sysUiRecentOnClickEvent') as number;
    AppStorage.setOrCreate('sysUiRecentOnClickEvent', ++num);
  }

  private buildLog(): boolean {
    Log.showInfo(TAG, 'buildLog');
    return true;
  }

  build() {
    Stack() {
      // Managed system wallpaper (PixelMap from WallpaperModel) as an edge-to-
      // edge Image; until it loads the Stack's .backgroundImage default below
      // shows through (and remains the fallback if loading ever fails).
      if (this.wallpaper) {
        Image(this.wallpaper)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
            [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
      }
      if (this.buildLog()) {}
      Column() {
        Column() {
          PageDesktopLayout();
        }
        .alignItems(HorizontalAlign.Center)
        .justifyContent(FlexAlign.Center)
        .height(this.workSpaceHeight)
        .onAreaChange((oldValue: Area, newValue: Area) => {
          Log.showDebug(TAG, `onAreaChange navigationBarStatus: ${this.navigationBarStatus}`);
          if (JSON.stringify(oldValue) == JSON.stringify(newValue)) {
            return;
          }
          if (this.navigationBarStatus == '1') {
            setTimeout(() => {
              SettingsModel.getInstance().setValue(this.navigationBarStatus);
            }, 30);
          }
        })

        Column() {
          SmartDock({
            showAppCenter: () => {
              Trace.start(Trace.CORE_METHOD_START_APP_CENTER);
              windowManager.createWindowWithName(windowManager.APP_CENTER_WINDOW_NAME, windowManager.DESKTOP_RANK);
            }
          });
        }
        .height(this.dockHeight)
      }
      .width('100%')
      .height('100%')
      .onAreaChange((oldValue: Area, newValue: Area) => {
        const h = newValue.height as number;
        if (!h || h <= 0) {
          return;
        }
        const prev = AppStorage.get<number>('availableLayoutHeight');
        if (prev === h) {
          return;
        }
        AppStorage.setOrCreate('availableLayoutHeight', h);
        this.updateScreenInfo();
      })

      if ((AppStorage.get<number>('openFolderStatus') as number) !== BigFolderConstants.OPEN_FOLDER_STATUS_CLOSE) {
        FolderOpenComponent();
      }

      // Renders a RemoteWindow proxy for each appearing app and zooms it in.
      // Close/minimize are left as no-ops (see OniroRemoteWindowController).
      // On top of the desktop, non-interactive. Dormant unless the winanim
      // controller is registered (persist.oniro.winanim_controller=1).
      OniroRemoteWindowHost()
    }
    .backgroundImage(StyleConstants.DEFAULT_BACKGROUND_IMAGE)
    .backgroundImageSize(ImageSize.Cover)
    .backgroundImagePosition(Alignment.Center)
    .width('100%')
    .height('100%')
    .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
