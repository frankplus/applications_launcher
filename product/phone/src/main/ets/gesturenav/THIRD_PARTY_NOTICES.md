# Third-party notices — launcher gesture navigation

The launcher's bottom-edge gesture navigation (the HOME / RECENTS / Overview
swipe-up) contains work **derived from the Android Open Source Project
(AOSP)**, which is licensed under the Apache License, Version 2.0. The
OpenHarmony launcher component is likewise Apache-2.0, so the combined work is
distributed under that same license.

> This code was moved here from systemui's phone_gestureNavigation (the
> launcher is where the app icon rects and the windowAnimationManager
> controller live, so the go-home shrink can target the real icon). The
> side-edge BACK gesture stays in systemui; its AOSP attribution remains in
> that module's THIRD_PARTY_NOTICES.

Per Apache-2.0 §4, each derivative source file below retains the original
`Copyright (C) <year> The Android Open Source Project` notice in its header
and states that it was modified. This file consolidates that attribution.

## Derivative works (ported AOSP source, translated and modified)

| File | Derived from (AOSP) | AOSP © |
|---|---|---|
| `recognizer/SwipeRecognizer.ts` | Launcher3 Quickstep `OtherActivityInputConsumer.java` + `AbsSwipeUpHandler.java` | 2018 |
| `recognizer/MotionPauseDetector.ts` | Launcher3 Quickstep `MotionPauseDetector.java` | 2019 |

AOSP source location:
- Launcher3 Quickstep: `packages/apps/Launcher3/quickstep/src/com/android/quickstep/`

## Independent implementations modeled on AOSP (no AOSP source code)

These files were written independently for OpenHarmony; their design or public
API is modeled on AOSP, but they contain no copied AOSP source and are the
original work of the launcher contributor:

- `recognizer/VelocityTracker.ts` — API modeled on `android.view.VelocityTracker`; uses a weighted moving average (not AOSP's least-squares solver).
- `animation/DragController.ts` — swipe-to-Overview transform behaviour modeled on Launcher3 `SwipeUpAnimationLogic.java` (© 2020); ArkUI/AppStorage implementation.
- `animation/WallpaperCache.ts` — wallpaper-under-Overview behaviour modeled on Launcher3 Quickstep; ArkUI implementation.
- `pages/DragOverlay.ets` — Overview surface behaviour modeled on Launcher3 Quickstep; ArkUI implementation.
- `animation/SnapshotCapture.ts`, `animation/RecentsLoader.ts` — original work using OHOS `screenshot` / `missionManager` APIs.

## License

```
Copyright (C) The Android Open Source Project
Copyright (c) 2026 Francesco Pham

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
