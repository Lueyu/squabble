# 🎨 Squabble appearance / 外观主题

Open the palette button in the top bar or the appearance card in Settings. Login and registration also offer the same picker. Changes apply immediately and are saved in this browser. Each visual style supports light and dark modes independently.

点击顶部调色盘按钮，或进入设置页的「外观」卡片。登录、注册页也可以切换主题。选择即时生效，并保存在当前浏览器；每套主题都支持浅色和深色。

| Theme / 主题 | Design / 设计语言 |
| --- | --- |
| Classic Studio / 经典工作室 | Refined original palette, restrained mint accents, soft surfaces / 原有基调、薄荷色点缀、柔和表面 |
| Pixel Arcade / 像素街机 | Pixel bull and bear, console typography, square panels, offset shadows / 像素牛熊、游戏终端字体、方角面板、像素阴影 |
| Comic Club / 漫画俱乐部 | Cream paper, ink outlines, sticker mascot, warm accents / 奶油纸张、墨线轮廓、贴纸吉祥物、暖色点缀 |
| Orbital Deck / 轨道空间站 | Blue plotting grid, orbital mark, navigation rails, cockpit panels / 蓝色星图、轨道标识、导航指示条、仪表面板 |

## Implementation

- `client/src/themes.css` supplies design tokens and shared shell treatments. `data-design-theme` on the HTML root selects the design; `.dark` selects its dark palette.
- `client/src/hooks/use-theme.ts` is the shared React external store. Keep using its existing `theme` / `setTheme` / `toggleTheme` API for light and dark; `designTheme` / `setDesignTheme` select the visual style.
- Browser storage keys are `pt-theme` (existing mode preference) and `sq-design-theme` (style). Changes sync between tabs. Blocked storage falls back to the current session. The small script in `client/index.html` applies saved preferences before first paint.
- `AppearancePicker` provides the accessible radio-card dialog; `AppearanceSettingsCard` provides its settings entry. Preview swatches live in `appearance-picker.css` and should stay aligned with theme tokens.
- `Mascot` uses the original vector mark or the pixel variant. No remote fonts, images, or new runtime packages are required.
- `useChartTheme` resolves CSS colors for ECharts and updates existing charts on appearance changes. Financial profit/loss semantics stay green/red across all themes.
- Layout motion respects `prefers-reduced-motion`. Theme choice never changes accounts, analysis, API credentials, or trading behavior.

## Verification

Run `node --test client/src/hooks/use-theme.test.cjs` for preference synchronization and startup coverage. Run `npm run lint` and `npm run build:client` for static validation and the production bundle. Visually check the dashboard, charts, settings, builder, and auth screens at desktop and phone widths in both languages; verify the picker by keyboard and after a reload.
