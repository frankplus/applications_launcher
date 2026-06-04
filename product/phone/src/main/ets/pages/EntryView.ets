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

import { Log } from '@ohos/common';
import { CommonConstants } from '@ohos/common';
import { EventConstants } from '@ohos/common';
import { windowManager } from '@ohos/common';
import { localEventManager } from '@ohos/common';
import { SettingsModel } from '@ohos/common';
import { LayoutViewModel } from '@ohos/common';
import { WallpaperModel } from '@ohos/common';
import { SmartDock } from '@ohos/smartdock/component';
import { PageDesktopLayout } from '@ohos/pagedesktop/component';
import { FolderOpenComponent } from '@ohos/bigfolder/component';
import { BigFolderConstants, BigFolderStyleConfig } from '@ohos/bigfolder';
import PhoneStage from '../common/PhoneStage';
import StyleConstants from '../common/constants/StyleConstants';
import { SmartDockStyleConfig } from '@ohos/smartdock';
import PhonePageDesktopGridStyleConfig from '../common/PhonePageDesktopGridStyleConfig';
import { FormStyleConfig } from '@ohos/form';
import systemParameter from '@ohos.systemparameter';
import image from '@ohos.multimedia.image';
import windowAnimationManager from '@ohos.animation.windowAnimationManager';
import OniroRemoteWindowController from '../common/OniroRemoteWindowController';
import { OniroRemoteWindowHost } from './OniroRemoteWindowHost';

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
  @StorageLink('deviceType') deviceType: string = CommonConstants.DEFAULT_DEVICE_TYPE;
  @StorageLink('loaded') loaded: boolean = false;
  @State workSpaceWidth: number = 0;
  @State workSpaceHeight: number = 0;
  @State dockHeight: number = 0;
  private mStage: PhoneStage = new PhoneStage();
  private navigationBarStatus: string | undefined;
  // Claims the WMS remote-animation slot: renders the appearing app via a
  // RemoteWindow (so apps open) and no-ops minimize/close (so the default
  // app-close zoom never plays). For the swipe-up-to-home gesture this removes
  // the duplicate WMS close zoom that played on top of systemui's own
  // shrink-to-bottom animation. See OniroRemoteWindowController.
  private animationController: OniroRemoteWindowController = new OniroRemoteWindowController();

  onPageShow(): void {
    Log.showInfo(TAG, 'onPageShow');
    let firstActivate:boolean | undefined = AppStorage.get('firstActivate');
    if (firstActivate) {
      this.voteBootEvent();
    }
  }

  onPageHide(): void {
    Log.showInfo(TAG, 'onPageHide');
  }

  aboutToAppear(): void {
    Log.showInfo(TAG, 'aboutToAppear');
    WallpaperModel.getInstance().subscribe(this.wpListener);
    this.mStage.onCreate();
    this.navigationBarStatus = SettingsModel.getInstance().getValue();
    this.getWindowSize();
    this.updateScreenSize();

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
    localEventManager.registerEventListener(listener, [EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE]);
  }

  private voteBootEvent(): void {
    Log.showInfo(TAG, 'voteBootEvent for launcher begin');
    try {
      AppStorage.setOrCreate('firstActivate', false);
      AppStorage.setOrCreate('loaded', true);
      systemParameter.setSync('bootevent.launcher.ready', 'true');
    } catch (err) {
      Log.showError(TAG, `set voteBootEvent err, ${JSON.stringify(err)}`);
    }
    Log.showInfo(TAG, 'voteBootEvent for launcher end');
  }

  private readonly mLocalEventListener: LocalEventListener = {
    onReceiveEvent: (event: string, params: string) => {
      Log.showDebug(TAG, `receive event: ${event}, params: ${params}`);
      if (event === EventConstants.EVENT_NAVIGATOR_BAR_STATUS_CHANGE) {
        this.navigationBarStatus = params;
        this.updateScreenInfo();
      }
    }
  };

  aboutToDisappear(): void {
    WallpaperModel.getInstance().unsubscribe(this.wpListener);
    this.mStage.onDestroy();
    Log.showInfo(TAG, 'aboutToDisappear');
  }

  onBackPress(): boolean {
    Log.showInfo(TAG, 'onBackPress');
    ContextMenu.close();
    AppStorage.setOrCreate('overlayMode', CommonConstants.OVERLAY_TYPE_HIDE);
    AppStorage.setOrCreate('openFolderStatus', BigFolderConstants.OPEN_FOLDER_STATUS_CLOSE);
    return true;
  }

  private updateScreenInfo(): void {
    Log.showDebug(TAG, 'updateScreenInfo');
    if (this.screenWidth != 0 && this.screenHeight != 0) {
      LayoutViewModel.getInstance().initScreen(this.navigationBarStatus);
      SmartDockStyleConfig.getInstance();
      PhonePageDesktopGridStyleConfig.getInstance();
      BigFolderStyleConfig.getInstance();
      FormStyleConfig.getInstance();
      this.updateScreenSize();
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
    Log.showDebug(TAG, `updateScreenSize product: ${this.deviceType}, screenWidth: ${this.screenWidth}, screenHeight: ${this.screenHeight},
      workSpaceWidth: ${this.workSpaceWidth}, workSpaceHeight: ${this.workSpaceHeight}, dockHeight: ${this.dockHeight}`);
  }

  build() {
    Stack() {
      // Managed system wallpaper (PixelMap from WallpaperModel) as an edge-to-
      // edge Image — .backgroundImage can't render a PixelMap on this build.
      // Only drawn once the PixelMap is in; until then the Stack's
      // .backgroundImage default below shows through (and stays as the fallback
      // if the wallpaper manager ever fails to provide one).
      if (this.wallpaper) {
        Image(this.wallpaper)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
            [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
      }
      if (this.loaded) {
        Flex({ direction: FlexDirection.Column, alignItems: ItemAlign.Center, justifyContent: FlexAlign.Start }) {
          Column() {
            PageDesktopLayout();
          }
          .height(this.workSpaceHeight)
          .onAreaChange((oldValue: Area, newValue: Area) => {
            Log.showDebug(TAG, `onAreaChange navigationBarStatus: ${this.navigationBarStatus}`);
            if (JSON.stringify(oldValue) == JSON.stringify(newValue)) {
              return;
            }
            if (this.navigationBarStatus == '1') {
              setTimeout(() => {
                SettingsModel.getInstance().setValue(this.navigationBarStatus);
              }, 50)
            }
          })

          Column() {
            SmartDock();
          }
          .height(this.dockHeight)
        }

        FolderOpenComponent();
      }

      // Renders RemoteWindow proxies for apps being opened (so they appear at
      // full), while OniroRemoteWindowController no-ops the close zoom. On top
      // of the desktop, non-interactive.
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
