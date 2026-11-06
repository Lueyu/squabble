import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Wide evidence belongs to its own scroll container, never the whole room. */
export default function ResearchMarkdown({ children }: { children: string }) {
  return <div className="research-prose prose prose-sm min-w-0 max-w-none dark:prose-invert [overflow-wrap:anywhere]"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    table: ({ children: content }) => <div className="research-table-scroll" tabIndex={0}><table>{content}</table></div>,
    pre: ({ children: content }) => <pre tabIndex={0}>{content}</pre>,
  }}>{children}</ReactMarkdown></div>;
}
