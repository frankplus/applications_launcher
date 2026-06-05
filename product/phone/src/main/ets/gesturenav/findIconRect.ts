//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Reverse-lookup an app's on-screen icon rect (vp) for the icon-anchored
 * go-home shrink (Phase 3). The forward direction (icon rect → launch
 * animation) is PageDesktopStartAppHandler.calculateAppIconPosition; this is
 * the reverse: given a (bundle, ability) find WHERE its icon is on screen.
 *
 * Scope (first cut): the desktop workspace's CURRENTLY VISIBLE page only. An
 * app on another page, in a folder, or in the dock returns null — the caller
 * then uses its bottom-/hotseat-center fallback (mirrors AOSP
 * Launcher.getFirstMatchForAppClose's fallback). All coords vp, matching the
 * RemoteWindow / DragOverlay coordinate space (display origin top-left).
 */

import { Log, PageDesktopModel, CommonConstants } from '@ohos/common';
import { PageDesktopViewModel } from '@ohos/pagedesktop';
import { OniroIconRect } from '../common/OniroRemoteWindowController';

const TAG = 'findIconRect';

/**
 * @returns the icon rect (vp) if the app is a normal app icon on the current
 * desktop page, else null (caller falls back).
 */
export function findIconRect(bundleName: string, abilityName: string): OniroIconRect | null {
  if (!bundleName) {
    return null;
  }
  try {
    const appInfo = AppStorage.get('appListInfo');
    const grid = appInfo ? appInfo.appGridInfo : undefined;
    if (!grid || !Array.isArray(grid)) {
      return null;
    }
    const curPage: number = PageDesktopModel.getInstance().getPageIndex();
    const pageApps = grid[curPage];
    if (!pageApps || !Array.isArray(pageApps)) {
      return null;
    }
    // Match a normal app icon (TYPE_APP). Folders carry no bundleName; cards
    // share a bundle but a different ability/type, so require ability too.
    const item = pageApps.find((a) =>
      a && a.bundleName === bundleName &&
      (abilityName ? a.abilityName === abilityName : true) &&
      (a.typeId === undefined || a.typeId === CommonConstants.TYPE_APP) &&
      a.row !== undefined && a.column !== undefined);
    if (!item) {
      return null;
    }

    const vm = PageDesktopViewModel.getInstance();
    const gridConfig = vm.getGridConfig();
    const sc = vm.getPageDesktopStyleConfig();
    if (!gridConfig || !sc) {
      return null;
    }
    const column: number = gridConfig.column;
    const row: number = gridConfig.row;
    if (!(column > 0) || !(row > 0)) {
      return null;
    }
    // Same geometry as PageDesktopStartAppHandler.calculateAppIconPosition
    // (OVERLAY_TYPE_APP_ICON), all in vp.
    const gridItemHeight: number = (sc.mGridHeight + sc.mRowsGap) / row;
    const gridItemWidth: number = (sc.mGridWidth + sc.mColumnsGap) / column;
    const paddingTop: number = Math.floor(sc.mGridHeight / row) - sc.mAppItemSize;
    const y: number = sc.mDesktopMarginTop + paddingTop + item.row * gridItemHeight;
    const columnSize: number = (sc.mGridWidth - (column - 1) * sc.mColumnsGap) / column;
    const iconLeftMargin: number = (columnSize - sc.mIconSize) / 2;
    const x: number = sc.mMargin + iconLeftMargin + item.column * gridItemWidth;
    const rect: OniroIconRect = { xVp: x, yVp: y, wVp: sc.mIconSize, hVp: sc.mIconSize };
    Log.showInfo(TAG, `${bundleName} -> page ${curPage} r${item.row}c${item.column} rect=${JSON.stringify(rect)}`);
    return rect;
  } catch (e) {
    Log.showWarn(TAG, `findIconRect failed: ${JSON.stringify(e)}`);
    return null;
  }
}
