/**
 * @file pages/Journal/JournalSectionCard.tsx
 * @description One of the five journal sections (market, portfolio, actions,
 * plan, lessons). Switches between a read-only card and an editable textarea
 * based on the page's editing flag.
 */
import { Globe, Target, ClipboardList, BookOpen, Lightbulb } from 'lucide-react';
import type { JournalEntry } from '@shared/api.interface';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from 'react-i18next';

/** Metadata describing one journal section. */
export interface JournalSection {
  /** Which JournalEntry field this section maps to. */
  key: keyof Pick<
    JournalEntry,
    'marketSummary' | 'portfolioSummary' | 'actions' | 'plan' | 'lessons'
  >;
  /** Translation key suffix. */
  labelKey: string;
  /** Lucide icon component. */
  icon: typeof Globe;
}

/** The five journal sections, in display order. */
export const sections: JournalSection[] = [
  { key: 'marketSummary', labelKey: 'marketSummary', icon: Globe },
  { key: 'portfolioSummary', labelKey: 'portfolioSummary', icon: Target },
  { key: 'actions', labelKey: 'actions', icon: ClipboardList },
  { key: 'plan', labelKey: 'plan', icon: BookOpen },
  { key: 'lessons', labelKey: 'lessons', icon: Lightbulb },
];

/** Props for {@link JournalSectionCard}. */
interface JournalSectionCardProps {
  section: JournalSection;
  /** Current saved content (read mode). */
  content: string | null | undefined;
  /** Whether the page is in edit mode. */
  editing: boolean;
  /** Current draft value (edit mode). */
  editValue: string;
  /** Draft change handler. */
  onEditChange: (value: string) => void;
}

/**
 * Render a journal section card; textarea when editing, otherwise read-only.
 */
export function JournalSectionCard({
  section,
  content,
  editing,
  editValue,
  onEditChange,
}: JournalSectionCardProps) {
  const { t } = useTranslation();
  const SectionIcon = section.icon;
  const sectionLabel = t(`journal.${section.labelKey}`);

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
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {content}
          </div>
        ) : (
          <div className="py-4 text-center text-sm text-muted-foreground">
            {t('ui.journal.noRecord')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
