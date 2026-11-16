/**
 * @file components/AppearancePicker.tsx
 * @description 外观（主题）选择器：深浅模式 + designTheme 的统一选择入口。
 * 三块导出共享同一套 useTheme 偏好（读写同一持久化存储）：
 *   - AppearanceControls      —— 纯控件区（模式单选 + 主题网格），供弹窗/设置页内嵌
 *   - AppearancePicker        —— 顶栏触发的 Dialog 弹窗（桌面与移动共用，焦点圈定）
 *   - AppearanceSettingsCard  —— 设置页的可选入口卡片（内嵌同一选择器）
 * 上游依赖 radix radio-group、ui/Dialog、ui/RadioGroup、hooks/use-theme；
 * 样式在同目录 appearance-picker.css（className 前缀 appearance-*）。
 */
import { useId } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Check, Moon, Palette, Sun, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { RadioGroup } from '@/components/ui/radio-group';
import {
  DESIGN_THEMES,
  isDesignTheme,
  useTheme,
  type DesignTheme,
  type Theme,
} from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import './appearance-picker.css';

interface AppearancePickerProps {
  /** 顶栏紧凑图标触发器；false 时附带文字标签。 */
  compact?: boolean;
  className?: string;
}

/**
 * 主题网格中的静态预览图：用少量 div 近似还原各 designTheme 在对应深浅模式下的
 * 工作台外观。所有视觉细节（配色、圆角、纹理、像素化）由 appearance-picker.css
 * 按 data-preview-theme / data-preview-mode 属性选择器驱动。
 */
function ThemePreview({ designTheme, mode }: { designTheme: DesignTheme; mode: Theme }) {
  // 结构自上而下：rail（品牌块 + 轨道条）、desk（顶栏 + 舞台内嵌吉祥物/信号柱 + 面板行）。
  return (
    <span
      className="appearance-preview"
      data-preview-theme={designTheme}
      data-preview-mode={mode}
      aria-hidden="true"
    >
      <span className="appearance-preview-rail">
        <span className="appearance-preview-brand" />
        <span />
        <span />
        <span />
      </span>
      <span className="appearance-preview-desk">
        <span className="appearance-preview-topline">
          <span />
          <span />
        </span>
        <span className="appearance-preview-stage">
          <span className="appearance-preview-orbit" />
          <span className="appearance-preview-mascot">
            <Image
              src={designTheme === 'arcade' ? '/logo-pixel.svg' : '/logo.svg'}
              alt=""
              className="bg-none"
              width={74}
              height={74}
              draggable={false}
            />
          </span>
          <span className="appearance-preview-signal">
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        </span>
        <span className="appearance-preview-panels">
          <span />
          <span />
          <span />
        </span>
      </span>
    </span>
  );
}

/**
 * 外观控件区（无弹窗外壳）：上半部为深浅模式单选行（light/dark），
 * 下半部为 designTheme 网格，每项含 ThemePreview 预览 + 名称/副标题，
 * 选中项右上角显示对勾徽标。表单可访问性由 aria-labelledby/describedby 串联。
 */
export function AppearanceControls() {
  const { t } = useTranslation();
  const { theme, designTheme, setTheme, setDesignTheme } = useTheme();
  const id: string = useId();

  return (
    <div className="appearance-controls">
      <div className="appearance-mode-row">
        <span id={`${id}-mode`} className="appearance-section-label">
          {t('appearance.modeLabel')}
        </span>
        <RadioGroup
          value={theme}
          onValueChange={(value: string) => {
            if (value === 'light' || value === 'dark') setTheme(value);
          }}
          className="appearance-mode-group"
          aria-labelledby={`${id}-mode`}
          orientation="horizontal"
        >
          <RadioGroupPrimitive.Item value="light" className="appearance-mode-option">
            <Sun size={15} aria-hidden="true" />
            {t('appearance.light')}
          </RadioGroupPrimitive.Item>
          <RadioGroupPrimitive.Item value="dark" className="appearance-mode-option">
            <Moon size={15} aria-hidden="true" />
            {t('appearance.dark')}
          </RadioGroupPrimitive.Item>
        </RadioGroup>
      </div>
      <span id={`${id}-design`} className="appearance-section-label">
        {t('appearance.designLabel')}
      </span>
      <RadioGroup
        className="appearance-theme-grid"
        value={designTheme}
        onValueChange={(value: string) => {
          if (isDesignTheme(value)) setDesignTheme(value);
        }}
        aria-labelledby={`${id}-design`}
      >
        {DESIGN_THEMES.map((design: DesignTheme) => (
          <RadioGroupPrimitive.Item
            key={design}
            value={design}
            className="appearance-theme-option"
            aria-labelledby={`${id}-${design}-name`}
            aria-describedby={`${id}-${design}-caption`}
          >
            <ThemePreview designTheme={design} mode={theme} />
            <span className="appearance-theme-copy">
              <span className="appearance-theme-kicker">
                {t(`appearance.themes.${design}.badge`)}
              </span>
              <span id={`${id}-${design}-name`} className="appearance-theme-name">
                {t(`appearance.themes.${design}.name`)}
              </span>
              <span id={`${id}-${design}-caption`} className="appearance-theme-caption">
                {t(`appearance.themes.${design}.caption`)}
              </span>
            </span>
            {designTheme === design && (
              <span className="appearance-selection" aria-hidden="true">
                <Check size={12} />
                <span>{t('appearance.selected')}</span>
              </span>
            )}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroup>
    </div>
  );
}

/** 焦点圈定、键盘可导航的主题选择弹窗，桌面端与移动端共用。 */
export function AppearancePicker({ compact = true, className }: AppearancePickerProps) {
  const { t } = useTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? 'icon' : 'sm'}
          className={cn('appearance-trigger', className)}
          aria-label={t('appearance.trigger')}
          title={t('appearance.trigger')}
        >
          <Palette aria-hidden="true" />
          {!compact && <span>{t('appearance.trigger')}</span>}
        </Button>
      </DialogTrigger>
      <DialogContent className="appearance-dialog" showCloseButton={false}>
        <DialogHeader className="appearance-dialog-header">
          <span className="appearance-eyebrow">
            <Palette size={14} aria-hidden="true" /> SQUABBLE / STYLE
          </span>
          <DialogTitle className="appearance-dialog-title">{t('appearance.title')}</DialogTitle>
          <DialogDescription className="appearance-dialog-description">
            {t('appearance.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            className="appearance-close"
            aria-label={t('appearance.close')}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogClose>
        <AppearanceControls />
        <p className="appearance-footer">
          <Check size={13} aria-hidden="true" />
          {t('appearance.footer')}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** 设置页可选入口卡片：复用同一选择器，偏好自动同步。 */
export function AppearanceSettingsCard({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, designTheme } = useTheme();
  const id: string = useId();

  return (
    <section className={cn('appearance-settings-card', className)} aria-labelledby={id}>
      <span className="appearance-settings-icon">
        <Palette size={20} aria-hidden="true" />
      </span>
      <div className="appearance-settings-copy">
        <h2 id={id}>{t('appearance.settingsTitle')}</h2>
        <p>{t('appearance.settingsDescription')}</p>
        <span className="appearance-settings-current">
          {t('appearance.current', {
            name: t(`appearance.themes.${designTheme}.name`),
            mode: t(`appearance.${theme}`),
          })}
        </span>
      </div>
      <AppearancePicker compact={false} />
    </section>
  );
}
