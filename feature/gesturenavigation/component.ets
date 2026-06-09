/**
 * Copyright (c) 2022 Huawei Device Co., Ltd.
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

// ArkUI components for the Oniro launcher gesture navigation, shared by every
// product entry. DragOverlay is hosted by a thin per-product `pages/DragOverlay`
// @Entry shell (the gesture-overlay window's content); OniroRemoteWindowHost is
// mounted inside each product's EntryView.
export { DragOverlay } from './src/main/ets/default/oniro/view/DragOverlay';
export { OniroRemoteWindowHost } from './src/main/ets/default/oniro/view/OniroRemoteWindowHost';
