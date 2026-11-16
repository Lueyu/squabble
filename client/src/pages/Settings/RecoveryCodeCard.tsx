/**
 * RecoveryCodeCard.tsx — 安全分区卡片：凭当前密码轮换（生成）账号恢复码。
 *
 * 职责边界：
 *  - 仅做恢复码轮换：密码校验交给 required，服务端验证密码；成功后落新 token 并展示新码。
 *  - 旧码是否立即失效由服务端语义决定，本组件不处理旧码展示。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage 的 security 分区。
 *  - 下游（调用哪些 hooks/api/组件）：useState/useTranslation；apiRotateRecoveryCode、
 *    tokenStore；Card 组件族、Button/Input/Label、toast。
 * 关键约定：
 *  - 轮换会重发 accessToken/refreshToken，必须同步 tokenStore，否则后续请求会用旧 token。
 *  - 新恢复码仅在本次响应中出现一次（服务端不回显），展示块随 code 状态出现/消失。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiRotateRecoveryCode } from '@/api';
import { tokenStore } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function RecoveryCodeCard() {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  // 最近一次轮换得到的新恢复码；空串表示尚未生成
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  // —— 事件处理区 ——
  // 轮换恢复码：提交当前密码 → 保存新 token → 展示新码并清空密码输入
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await apiRotateRecoveryCode(password);
      // 轮换接口同时刷新了登录态，必须落新 token
      tokenStore.save(result.accessToken, result.refreshToken);
      setCode(result.recoveryCode ?? '');
      setPassword('');
    } catch {
      toast.error(t('auth.recoveryGenerateFailed'));
    } finally {
      setLoading(false);
    }
  }

  // —— 渲染区 ——
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.recoverySettingsTitle')}</CardTitle>
        <CardDescription>{t('auth.recoverySettingsSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 什么时候走到这里：本次会话已生成过恢复码——展示新码与抄存警告 */}
        {code && (
          <div className="space-y-2">
            <Label>{t('auth.recoveryCodeLabel')}</Label>
            <div className="rounded-xl border border-border bg-muted p-4 font-mono text-sm break-all select-all">
              {code}
            </div>
            <p className="text-xs text-muted-foreground">{t('auth.recoveryCodeWarning')}</p>
          </div>
        )}
        {/* 轮换表单：当前密码 + 生成按钮 */}
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={generate}>
          <div className="flex-1 space-y-2">
            <Label htmlFor="current-password">{t('auth.password')}</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {t('auth.generateRecoveryCode')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
