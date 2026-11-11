import type { DataDocumentStatus } from '@shared/data-library.interface';

export default function DocumentPagePreview({ extraction, zh }: {
  extraction: NonNullable<DataDocumentStatus['extraction']>; zh: boolean;
}) {
  return <section className="space-y-3" aria-label={zh ? '原件定位' : 'Original document locations'}>
    <p className="text-xs text-muted-foreground">{zh ? '定位来自解析器。未知坐标与 OCR 置信度保持未知；提取文本不代表经审计事实。' : 'Locations come from the parser. Unknown coordinates and OCR confidence remain unknown; extracted text is not audited financial data.'}</p>
    {extraction.elements.length > 100 && <p className="data-notice">{zh ? `当前显示前 100 项，共 ${extraction.elements.length} 项；完整结果可下载。` : `Showing 100 of ${extraction.elements.length} elements; download the full result for all elements.`}</p>}
    {extraction.elements.slice(0,100).map((element, index) => {
      const locator = element.locator;
      return <article className="rounded border p-3" key={`${locator.elementId}-${index}`}>
        <p className="text-xs text-muted-foreground break-all">{locator.kind === 'pdf'
          ? `${zh ? '物理页' : 'Physical page'} ${locator.physicalPage}${locator.pageLabel ? ` · ${zh ? '印刷页' : 'Printed label'} ${locator.pageLabel}` : ''}`
          : zh ? 'DOCX 元素（无固有页码）' : 'DOCX element (no intrinsic page number)'} · {locator.elementId}</p>
        {locator.kind === 'pdf' && <p className="text-xs text-muted-foreground">{locator.bbox
          ? `${locator.bbox.origin} · ${locator.bbox.x},${locator.bbox.y} · ${locator.bbox.width}×${locator.bbox.height}`
          : zh ? '坐标未知' : 'Coordinates unknown'}{locator.pageSize ? ` · ${locator.pageSize.width}×${locator.pageSize.height} ${locator.pageSize.unit}` : ''}</p>}
        <p className="whitespace-pre-wrap break-words text-sm">{element.text}</p>
      </article>;
    })}
  </section>;
}
