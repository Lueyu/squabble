import axios from 'axios';
import { t } from 'i18next';

interface ApiErrorBody {
  error?: { message?: string; fieldErrors?: Array<{ message?: string }> };
  message?: string;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError<ApiErrorBody>(error)) return fallback;
  const body: ApiErrorBody | undefined = error.response?.data;
  const message = body?.error?.message
    || body?.error?.fieldErrors?.[0]?.message
    || body?.message
    || fallback;
  if (message === 'LOCAL_INVALID_CONFIGURATION') return t('council.localAgents.configurationInvalid');
  if (message === 'LOCAL_CONFIGURATION_UNSUPPORTED') return t('council.localAgents.configurationUnsupported');
  if (message === 'LOCAL_VERSION_UNSUPPORTED') return t('council.localAgents.versionUnsupported');
  if (message === 'LOCAL_LOGIN_REQUIRED') return t('council.localAgents.loginRequired');
  return message;
}
