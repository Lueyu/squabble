import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep return/save controls in the fixed shell while the conversation scrolls. */
export default function InterviewFlowNavigation({
  children,
}: {
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById('workspace-flow-controls'));
  }, []);
  const content = <div className="interview-inline-navigation">{children}</div>;
  return host ? createPortal(content, host) : content;
}
