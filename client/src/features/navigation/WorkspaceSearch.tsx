import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { workspaceDestinations } from './workspace-navigation';

export function WorkspaceSearch() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  const results = workspaceDestinations(i18n.language).filter((item) =>
    (item.label + ' ' + item.path)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={zh ? '搜索功能' : 'Find a feature'}
      >
        <Search size={16} />
        <span className="hidden sm:inline">
          {zh ? '搜索功能' : 'Find a feature'}
        </span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setQuery('');
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {zh ? '你想做什么？' : 'What would you like to do?'}
            </DialogTitle>
            <DialogDescription>
              {zh ? '搜索页面与功能入口。' : 'Find a page or workspace tool.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            aria-label={zh ? '搜索页面与功能' : 'Search pages and tools'}
            placeholder={
              zh ? '例如：草稿、账本、通知' : 'Try drafts, ledger, alerts'
            }
          />
          <div className="workspace-search-results">
            {results.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                  navigate(item.path);
                }}
              >
                <span>{item.label}</span>
                <ArrowUpRight size={16} aria-hidden="true" />
              </button>
            ))}
            {!results.length && (
              <p role="status">
                {zh
                  ? '没有匹配的功能，试试其他关键词。'
                  : 'No matching feature. Try another keyword.'}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
