/**
 * auto-update.mts — 判断当前平台/构建形态是否支持应用内自动更新。
 *
 * 职责边界：
 *  - 只提供一个纯判断函数 isAutomaticUpdateSupported，不执行任何更新动作。
 * 上下游：
 *  - 上游（谁调用）：desktop/main.mts 在窗口更新检查与烟测加载前用它分流；desktop/auto-update.spec.ts 直接测试。
 *  - 下游：为 true 时 main.mts 才加载 electron-updater 走 autoUpdater；为 false 时走
 *    update-check.mts 的 GitHub Releases 手动下载路径。
 */
export function isAutomaticUpdateSupported(
  platform: NodeJS.Platform,
  arch: string,
  packaged: boolean,
): boolean {
  // TODO(macOS)：在启用 autoUpdater 之前，需要先提供已签名并通过公证的 ZIP 发行包。
  return packaged && platform === 'win32' && arch === 'x64';
}
