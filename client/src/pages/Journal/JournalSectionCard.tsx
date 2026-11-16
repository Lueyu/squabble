/**
 * JournalSectionCard.tsx — 交易日志五大分区（市场 / 组合 / 操作 / 计划 / 教训）的通用分区卡片。
 *
 * 职责边界：
 *  - 只负责"一个分区"的展示与编辑切换：页面处于编辑态时渲染 Textarea（草稿值由父组件托管），
 *    非编辑态时渲染只读文本（有内容显示内容，无内容显示占位文案）；
 *  - 不管理草稿状态、不发请求、不写库，编辑值与回调全部来自父组件 JournalPage。
 * 上下游：
 *  - 上游：JournalPage（编辑标记 editing、草稿 editValue、变更回调 onEditChange 均由它下发）；
 *    sections 数组也被 JournalPage 遍历使用，两处必须保持同一份字段清单；
 *  - 下游：@/components/ui 的 Card / Textarea、react-i18next（分区标题文案，key 前缀 journal.）。
 * 关键约定：
 *  - section.key 直接对应 JournalEntry 的五个可编辑字段名，改名会连带影响服务端字段与 i18n key。
 */
import { Globe, Target, ClipboardList, BookOpen, Lightbulb } from 'lucide-react';
import type { JournalEntry } from '@shared/api.interface';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from 'react-i18next';

/** 描述一个日志分区的元数据。 */
export interface JournalSection {
  /** 本分区映射到 JournalEntry 的哪个字段（五个分区各占一字段）。 */
  key: keyof Pick<
    JournalEntry,
    'marketSummary' | 'portfolioSummary' | 'actions' | 'plan' | 'lessons'
  >;
  /** i18n key 后缀（完整 key 为 `journal.${labelKey}`）。 */
  labelKey: string;
  /** 分区标题左侧的 Lucide 图标组件。 */
  icon: typeof Globe;
}

/** 五个日志分区，按展示顺序排列：市场 → 组合 → 操作 → 计划 → 教训。 */
export const sections: JournalSection[] = [
  { key: 'marketSummary', labelKey: 'marketSummary', icon: Globe },
  { key: 'portfolioSummary', labelKey: 'portfolioSummary', icon: Target },
  { key: 'actions', labelKey: 'actions', icon: ClipboardList },
  { key: 'plan', labelKey: 'plan', icon: BookOpen },
  { key: 'lessons', labelKey: 'lessons', icon: Lightbulb },
];

/** {@link JournalSectionCard} 的入参。 */
interface JournalSectionCardProps {
  /** 要渲染的分区元数据（图标 + 标题 key + 字段名）。 */
  section: JournalSection;
  /** 已保存的分区内容（只读态展示用）；可为 null / undefined（未写过）。 */
  content: string | null | undefined;
  /** 页面是否处于编辑模式（由 JournalPage 统一控制）。 */
  editing: boolean;
  /** 编辑态下的草稿值（状态由父组件托管）。 */
  editValue: string;
  /** 草稿变更回调（父组件写入其 state）。 */
  onEditChange: (value: string) => void;
}

/**
 * 渲染单个日志分区卡片：编辑态输出 Textarea，否则输出只读内容。
 * @param props - 见 {@link JournalSectionCardProps}。
 */
export function JournalSectionCard({
  section,
  content,
  editing,
  editValue,
  onEditChange,
}: JournalSectionCardProps) {
  const { t } = useTranslation();
  // 把图标组件取成局部变量以便 JSX 里作为标签使用。
  const SectionIcon = section.icon;
  // 分区标题文案（journal.<labelKey>）。
  const sectionLabel = t(`journal.${section.labelKey}`);

  // 编辑态：标题不变，正文换成可编辑的 Textarea（草稿值 / 回调均来自父组件）。
  if (editing) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <SectionIcon size={16} className="text-primary" />
            <CardTitle className="font-serif text-base">{sectionLabel}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Textarea
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            placeholder={t('ui.journal.recordSection', { section: sectionLabel })}
            className="min-h-[120px] text-sm leading-relaxed"
          />
        </CardContent>
      </Card>
    );
  }

  // 只读态：有内容按原文（保留换行）展示；没写过内容时显示占位提示。
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <SectionIcon size={16} className="text-primary" />
          <CardTitle className="font-serif text-base">{sectionLabel}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {content ? (
          // 有内容：whitespace-pre-wrap 保留用户手记里的换行与空格。
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {content}
          </div>
        ) : (
          // 无内容：显示"未记录"占位文案。
          <div className="py-4 text-center text-sm text-muted-foreground">
            {t('ui.journal.noRecord')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
