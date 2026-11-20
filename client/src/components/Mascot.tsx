/**
 * @file components/Mascot.tsx
 * @description 品牌吉祥物组件：按当前 designTheme 选择像素风（arcade 用
 * /logo-pixel.svg）或常规 logo（/logo.svg），渲染为 64×64 图片。
 * 上游依赖 `hooks/use-theme`（读取 designTheme）与 `lib/utils` 的 `cn`；
 * 下游被 Layout 品牌区等处复用。
 */
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

/** 牛熊对话形象在所有视觉世界里都是我们的签名元素。 */
export function Mascot({
  className,
  decorative = true,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const { designTheme } = useTheme();
  return (
    <span className={cn('squabble-mascot', className)} aria-hidden={decorative || undefined}>
      <img
        src={designTheme === 'arcade' ? '/logo-pixel.svg' : '/logo.svg'}
        alt={decorative ? '' : 'Squabble'}
        width="64"
        height="64"
        draggable={false}
      />
    </span>
  );
}
