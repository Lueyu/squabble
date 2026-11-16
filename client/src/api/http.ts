/**
 * @file api/http.ts
 * @description Squabble 后端的第一方 HTTP 客户端（axios 单例）。
 *
 * 在 axios 实例上注入 Bearer token（会话存于 localStorage），并挂 401 拦截器：
 * 会话过期时清空会话并跳转登录页；对 /api/auth/* 的请求豁免跳转，
 * 避免一次登录失败就把用户弹走。
 *
 * 是已退役平台 `axiosForBackend` 的直接替代品：以 `{ url, method, data }`
 * 方式调用，读取 `response.data`。
 *
 * 职责边界：
 *  - 只负责请求基础设施（token 注入、语言头、401 刷新/跳转），不含业务接口
 *  - 各业务域接口封装在 api/index.ts、api/council.ts 等兄弟模块中
 * 上下游：
 *  - 上游（谁调用这里）：client/src/api 下全部业务封装模块，以及 use-market-quotes、agent-api 等
 *  - 下游（本文件调用谁）：axios；localStorage（token 与语言偏好读写）
 * 关键约定：
 *  - token 键名 'sq-at'/'sq-rt'、语言键名 'sq-lang' 与登录页/布局页共享，禁止改动
 *  - 401 时先尝试用 refresh token 静默续期并重放原请求一次；失败才清会话跳登录
 */
import axios, { type AxiosInstance } from 'axios';

/** JWT 会话在 localStorage 中的键名。 */
export const ACCESS_TOKEN_KEY = 'sq-at';
export const REFRESH_TOKEN_KEY = 'sq-rt';

/** 与登录页共享的 token 存取助手。 */
export const tokenStore = {
  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  save(accessToken: string, refreshToken: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

/** 是否存在会话（仅检查 token 是否存在；有效性由服务端判定）。 */
export function hasSession(): boolean {
  return tokenStore.getAccessToken() !== null;
}

const http: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 30000,
});

// 请求拦截器：注入认证头与语言头。
http.interceptors.request.use((config) => {
  // 步骤 1：有 token 就附带 Bearer 认证头。
  const token = tokenStore.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // 步骤 2：告知服务端客户端当前语言（便于返回双语错误文案）。
  const lang = localStorage.getItem('sq-lang') ?? 'zh-CN';
  config.headers['X-Lang'] = lang;
  return config;
});

/** 公开的认证端点：在这里收到 401 只说明"凭据错误"，不是会话失效 —— 绝不清 token、绝不跳转。 */
const PUBLIC_AUTH_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/recover',
];

// 正在进行的刷新请求（单例 Promise）：并发 401 只触发一次刷新。
let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

/** 用 refresh token 换取新的 token 对；并发调用共享同一个 Promise。 */
function refreshSession(refreshToken: string) {
  if (!refreshPromise) {
    refreshPromise = http
      .post('/api/auth/refresh', { refreshToken })
      .then((response) => response.data as { accessToken: string; refreshToken: string })
      .finally(() => {
        // 刷新结束后清空单例，下一次 401 可以重新发起。
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// 响应拦截器：统一处理 401（刷新重试 → 清会话 → 跳登录）。
http.interceptors.response.use(
  (response) => response,
  async (error) => {
    // 步骤 1：读取状态码与请求 URL，判断是否公开认证端点。
    const status = error?.response?.status;
    const url: string = error?.config?.url ?? '';
    const isPublicAuth = PUBLIC_AUTH_PATHS.some((p) => url.includes(p));

    // 步骤 2：非公开端点的 401 才走会话恢复流程。
    if (status === 401 && !isPublicAuth) {
      const retryConfig = error?.config;
      const refreshToken = tokenStore.getRefreshToken();

      // 步骤 2a：有 refresh token 且本请求尚未重试过 —— 静默续期并重放原请求。
      if (refreshToken && retryConfig && !retryConfig._sessionRetried) {
        retryConfig._sessionRetried = true;
        try {
          const fresh = await refreshSession(refreshToken);
          tokenStore.save(fresh.accessToken, fresh.refreshToken);
          return http(retryConfig);
        } catch {
          // refresh token 无效或已被吊销：落入下方清会话逻辑。
        }
      }

      // 步骤 2b：会话过期或 token 失效（例如服务端重建、数据库重置之后）：
      // 丢弃过期会话并跳转登录页。/api/auth/me 也在覆盖范围内，
      // 保证过期 token 绝不会把应用困进重定向死循环。
      tokenStore.clear();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  },
);

export default http;
