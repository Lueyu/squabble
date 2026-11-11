import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataLibraryApi, dataLibraryKey } from '@/api/data-library';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { dataError } from './data-library-labels';
import DocumentPagePreview from './DocumentPagePreview';

export default function DocumentExtractionStatus({ sourceId, versionId, enabled, zh }: {
  sourceId: string; versionId: string; enabled: boolean; zh: boolean;
}) {
  const client = useQueryClient(), [extractor, setExtractor] = useState('');
  const state = useQuery({ queryKey: [...dataLibraryKey, 'document', sourceId, versionId],
    queryFn: () => dataLibraryApi.documentStatus(sourceId, versionId || undefined), retry: false,
    refetchInterval: query => ['submitting', 'submitted'].includes(query.state.data?.job?.state ?? '') ? 3000 : false });
  const job = state.data?.job;
  useEffect(() => {
    if (job?.state === 'completed') void client.invalidateQueries({ queryKey: [...dataLibraryKey, 'source', sourceId] });
  }, [client, sourceId, job?.id, job?.state]);
  const refresh = () => client.invalidateQueries({ queryKey: dataLibraryKey });
  const reparse = useMutation({ mutationFn: () => dataLibraryApi.reparseDocument(sourceId, extractor || state.data?.extractors[0]?.id || ''), retry: false, onSuccess: refresh });
  const cancel = useMutation({ mutationFn: () => dataLibraryApi.cancelDocument(job!.id), retry: false, onSuccess: refresh });
  const download = useMutation({ retry: false, mutationFn: async () => {
    const blob = await dataLibraryApi.artifact(state.data!.extraction!.artifactId), url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'extraction.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  const pending = ['submitting', 'submitted'].includes(job?.state ?? '');
  return <section className="space-y-3 border-t pt-4" aria-label={zh ? '文档解析' : 'Document extraction'}>
    <h3 className="font-medium">{zh ? '文档解析' : 'Document extraction'}</h3>
    {state.isPending ? <p role="status">{zh ? '正在读取解析状态…' : 'Loading extraction status…'}</p> : <>
      <p className="data-notice" role="status">{pending ? zh ? '正在后台解析，原件已保存。' : 'Parsing in the background; the original is saved.'
        : job?.state === 'provider_unknown' ? zh ? '提交结果尚不确定，系统不会自动重复提交。可取消后显式重解析。' : 'Submission outcome is unknown. It will not be resubmitted automatically; cancel before explicitly reparsing.'
        : job?.state === 'failed' ? zh ? '解析失败或已超时。原件已保留，可显式重解析。' : 'Extraction failed or timed out. The original is retained; you can explicitly reparse.'
        : job?.state === 'cancelled' ? zh ? '解析已取消；原件仍已保存。' : 'Extraction cancelled; the original remains saved.'
        : state.data?.extraction ? zh ? '解析已完成。数字核对：' : 'Extraction completed. Numeric validation: '
        : !state.data?.extractors.length ? zh ? '原件已保存；本地解析服务尚未配置。' : 'Original saved; no local parser is configured.'
        : zh ? '原件已保存，可以选择解析器重解析。' : 'Original saved. Choose a parser to reparse.'}
        {state.data?.extraction && ({ unknown: zh ? '未知' : 'unknown', verified: zh ? '已核对' : 'verified', needs_review: zh ? '需人工复核' : 'needs review' })[state.data.extraction.numericValidation]}</p>
      {state.data?.extraction && <><p className="text-xs text-muted-foreground">{state.data.extraction.extractor} {state.data.extraction.extractorVersion} · SHA-256 {state.data.extraction.originalHash}</p>
        <DocumentPagePreview extraction={state.data.extraction} zh={zh} />
        <Button variant="outline" disabled={download.isPending || !enabled} onClick={() => download.mutate()}>{zh ? '下载完整解析结果' : 'Download full extraction'}</Button></>}
      <div className="flex flex-wrap gap-2">
        {!!state.data?.extractors.length && <><NativeSelect aria-label={zh ? '解析器' : 'Parser'} value={extractor || state.data.extractors[0].id} onChange={event => setExtractor(event.target.value)} disabled={pending}>
          {state.data.extractors.map(item => <option value={item.id} key={item.id}>{item.id} {item.version}</option>)}
        </NativeSelect><Button variant="outline" disabled={!enabled || pending || job?.state === 'provider_unknown' || reparse.isPending} onClick={() => reparse.mutate()}>{zh ? '重解析为新版本' : 'Reparse into a new version'}</Button></>}
        {(pending || job?.state === 'provider_unknown') && <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{zh ? '取消解析' : 'Cancel extraction'}</Button>}
      </div>
    </>}
    {[state, reparse, cancel, download].some(item => item.isError) && <p role="alert" className="text-sm text-destructive">{dataError(state.error || reparse.error || cancel.error || download.error, zh)}</p>}
  </section>;
}
